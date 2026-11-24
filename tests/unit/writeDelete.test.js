import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { getBudget } from '$shared/budgets.js';
import { deleteDocuments } from '~/bridge/scripts/writes.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} A live actor holding two items (one with an effect) and an effect. */
let actor;

/** @type {object} The first item of the actor. */
let sword;

/** @type {object} The second item of the actor. */
let shield;

/** @type {object} The effect of the actor. */
let glow;

/** @type {object} The effect of the sword. */
let edge;

/** @type {object[]} The users of the world: two game masters and a player. */
const USERS = [
   {
      id: 'MOCKGM0000000001',
      role: 4,
      name: 'MOCK_gm_one',
   },
   {
      id: 'MOCKGM0000000002',
      role: 4,
      name: 'MOCK_gm_two',
   },
   {
      id: 'MOCKPLAYER000001',
      role: 1,
      name: 'MOCK_player',
   },
];

beforeEach(() => {
   world = installWriteWorld(vi.fn, {
      users: USERS,
      userId: 'MOCKGM0000000001',
   });
   gates = {
      allowDelete: true,
      allowReplace: true,
   };
   globalThis.game.settings.get = (module, key) => gates[key];
   actor = world.add('Actor', {
      name: 'MOCK_actor',
      type: 'npc'
   });
   sword = world.addChild(actor, 'Item', {
      name: 'MOCK_sword',
      type: 'weapon'
   });
   shield = world.addChild(actor, 'Item', {
      name: 'MOCK_shield',
      type: 'armor'
   });
   glow = world.addChild(actor, 'ActiveEffect', { name: 'MOCK_glow' });
   edge = world.addChild(sword, 'ActiveEffect', { name: 'MOCK_edge' });
});

afterEach(() => {
   for (const name of [
      'CONST',
      'CONFIG',
      'fromUuid',
      'game',
   ]) {
      delete globalThis[name];
   }
});

/**
 * Run `deleteDocuments` and return what it threw.
 * @param {object} params - The parameters.
 * @returns {Promise<Error>} The error.
 */
async function failure(params) {
   try {
      await deleteDocuments(params);
   } catch (error) {
      return error;
   }
   throw new Error('deleteDocuments did not throw');
}

/**
 * Add a user document that mirrors one of the world users.
 * @param {number} index - The index in `USERS`.
 * @returns {object} A mock User document.
 */
function userDocument(index) {
   return world.add('User', {
      _id: USERS[index].id,
      name: USERS[index].name,
      role: USERS[index].role,
   });
}

describe('deleteDocuments: deleting', () => {
   it('deletes a world document through its class and acks uuid, name and type', async () => {
      const rows = await deleteDocuments({ uuids: [actor.uuid] });
      expect(world.classes.Actor.deleteDocuments).toHaveBeenCalledTimes(1);
      expect(world.classes.Actor.deleteDocuments.mock.calls[0][0]).toEqual([actor.id]);
      expect(rows).toEqual([
         {
            uuid: actor.uuid,
            name: 'MOCK_actor',
            type: 'npc',
         },
      ]);
   });

   it('deletes embedded documents through their parent, one call per class', async () => {
      const rows = await deleteDocuments({ uuids: [shield.uuid, sword.uuid, glow.uuid] });
      expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledTimes(2);
      expect(actor.deleteEmbeddedDocuments.mock.calls[0]).toEqual([
         'Item',
         [
            shield.id,
            sword.id,
         ],
      ]);
      expect(actor.deleteEmbeddedDocuments.mock.calls[1][0]).toBe('ActiveEffect');
      expect(world.classes.Item.deleteDocuments).not.toHaveBeenCalled();
      expect(rows.map((row) => row.uuid)).toEqual([
         shield.uuid,
         sword.uuid,
         glow.uuid,
      ]);
   });

   it('deletes only the ancestor when a document and its descendant are both named', async () => {
      const rows = await deleteDocuments({ uuids: [sword.uuid, actor.uuid] });
      expect(world.classes.Actor.deleteDocuments).toHaveBeenCalledTimes(1);
      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
      expect(rows).toHaveLength(2);
   });

   it('refuses a missing document, a compendium pack uuid and a non-document', async () => {
      expect((await failure({ uuids: ['Actor.AAAAAAAAAAAAAAAA'] })).code).toBe('DOC_NOT_FOUND');
      expect((await failure({ uuids: ['Compendium.world.items'] })).code).toBe('ARGS_INVALID');
      globalThis.fromUuid = vi.fn(async () => ({ collection: 'world.items' }));
      expect((await failure({ uuids: ['Actor.AAAAAAAAAAAAAAAA'] })).code).toBe('ARGS_INVALID');
      expect(world.calls).toEqual([]);
   });

   it('refuses an empty list and a repeated uuid', async () => {
      expect((await failure({ uuids: [] })).code).toBe('ARGS_INVALID');
      expect((await failure({ uuids: [actor.uuid, actor.uuid] })).code).toBe('ARGS_INVALID');
      expect(world.calls).toEqual([]);
   });

   it('deletes more documents in one call than the best-practice size', async () => {
      const count = getBudget('WRITE_DOCUMENTS_MAX').value + 1;
      const actors = Array.from({ length: count }, (_, index) => world.add('Actor', {
         name: `MOCK_actor_${index}`,
         type: 'npc',
      }));
      const rows = await deleteDocuments({ uuids: actors.map((entry) => entry.uuid) });
      expect(world.classes.Actor.deleteDocuments).toHaveBeenCalledTimes(1);
      expect(world.classes.Actor.deleteDocuments.mock.calls[0][0]).toHaveLength(count);
      expect(rows).toHaveLength(count);
   });

   it('reports a shortfall when a hook cancelled the deletion', async () => {
      world.cancel.cancelDelete = true;
      const error = await failure({ uuids: [actor.uuid] });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('0 of 1');
   });
});

describe('deleteDocuments: dryRun', () => {
   it('lists the documents that would go, cascades included, and calls no write API', async () => {
      const result = await deleteDocuments({
         uuids: [actor.uuid],
         dryRun: true,
      });
      expect(result.dryRun).toBe(true);
      expect(result.total).toBe(5);
      expect(result.rows).toEqual([
         [
            actor.uuid,
            'MOCK_actor',
            'npc',
         ],
         [
            sword.uuid,
            'MOCK_sword',
            'weapon',
         ],
         [
            edge.uuid,
            'MOCK_edge',
            '',
         ],
         [
            shield.uuid,
            'MOCK_shield',
            'armor',
         ],
         [
            glow.uuid,
            'MOCK_glow',
            '',
         ],
      ]);
      expect(world.calls).toEqual([]);
      expect(world.classes.Actor.deleteDocuments).not.toHaveBeenCalled();
      expect(actor.delete).not.toHaveBeenCalled();
      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
   });

   it('lists a document once when it is named and also a descendant of another', async () => {
      const result = await deleteDocuments({
         uuids: [actor.uuid, sword.uuid],
         dryRun: true,
      });
      expect(result.total).toBe(5);
   });

   it('keeps the row list within the preview bound and still reports the true total', async () => {
      for (let index = 0; index < 600; index += 1) {
         world.addChild(actor, 'Item', { name: `MOCK_item${index}` });
      }
      const result = await deleteDocuments({
         uuids: [actor.uuid],
         dryRun: true,
      });
      expect(result.rows).toHaveLength(500);
      expect(result.total).toBe(605);
      expect(result.cut).toBe(true);
   });

   it('still applies the gates and the user rules', async () => {
      expect(
         (await failure({
            uuids: [userDocument(1).uuid],
            dryRun: true
         })).code,
      ).toBe(GATE_DENIED);
      gates.allowUserWrites = true;
      expect((await failure({
         uuids: [userDocument(0).uuid],
         dryRun: true
      })).code).toBe('DELETE_REFUSED');
   });
});

describe('deleteDocuments: User documents', () => {
   it('denies a User deletion while allowUserWrites is closed and deletes once open', async () => {
      const player = userDocument(2);
      const denied = await failure({ uuids: [player.uuid] });
      expect(denied.code).toBe(GATE_DENIED);
      expect(denied.message).toContain('allowUserWrites');
      expect(world.classes.User.deleteDocuments).not.toHaveBeenCalled();
      gates.allowUserWrites = true;
      const rows = await deleteDocuments({ uuids: [player.uuid] });
      expect(rows[0].uuid).toBe(player.uuid);
   });

   it('never deletes the signed-in user', async () => {
      gates.allowUserWrites = true;
      const own = userDocument(0);
      const error = await failure({ uuids: [own.uuid] });
      expect(error.code).toBe('DELETE_REFUSED');
      expect(error.message).toContain('signed-in');
      expect(world.classes.User.deleteDocuments).not.toHaveBeenCalled();
   });

   it('deletes a game master while another remains, and never the last one', async () => {
      gates.allowUserWrites = true;
      const second = userDocument(1);
      world.classes.User.deleteDocuments.mockClear();
      await deleteDocuments({ uuids: [second.uuid] });
      expect(world.classes.User.deleteDocuments).toHaveBeenCalledTimes(1);
   });

   it('never deletes every game master in one call', async () => {
      gates.allowUserWrites = true;
      world = installWriteWorld(vi.fn, {
         users: USERS,
         userId: 'MOCKPLAYER000001',
      });
      globalThis.game.settings.get = (module, key) => gates[key];
      const first = userDocument(0);
      const second = userDocument(1);
      const error = await failure({ uuids: [first.uuid, second.uuid] });
      expect(error.code).toBe('DELETE_REFUSED');
      expect(error.message).toContain('game master');
      expect(world.classes.User.deleteDocuments).not.toHaveBeenCalled();
   });

   it('never deletes the only game master', async () => {
      gates.allowUserWrites = true;
      world = installWriteWorld(vi.fn, {
         users: [
            USERS[0],
            USERS[2],
         ],
         userId: 'MOCKPLAYER000001',
      });
      globalThis.game.settings.get = (module, key) => gates[key];
      const only = userDocument(0);
      expect((await failure({ uuids: [only.uuid] })).code).toBe('DELETE_REFUSED');
   });
});

describe('deleteDocuments: Setting documents', () => {
   it('denies a Setting deletion while allowSettingWrites is closed and deletes once open', async () => {
      const setting = world.add('Setting', {
         key: 'mock.setting',
         value: '1'
      });
      const denied = await failure({ uuids: [setting.uuid] });
      expect(denied.message).toContain('allowSettingWrites');
      gates.allowSettingWrites = true;
      await deleteDocuments({ uuids: [setting.uuid] });
      expect(world.classes.Setting.deleteDocuments).toHaveBeenCalledTimes(1);
   });

   it('refuses a wiretap Setting with the gate open', async () => {
      gates.allowSettingWrites = true;
      const setting = world.add('Setting', {
         key: 'wiretap.allowUserWrites',
         value: 'true'
      });
      const error = await failure({ uuids: [setting.uuid] });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('Wiretap settings');
      expect(world.classes.Setting.deleteDocuments).not.toHaveBeenCalled();
   });

   it('needs allowModuleConfigWrites for the module configuration setting', async () => {
      gates.allowSettingWrites = true;
      const setting = world.add('Setting', {
         key: 'core.moduleConfiguration',
         value: '{}'
      });
      const error = await failure({ uuids: [setting.uuid] });
      expect(error.message).toContain('allowModuleConfigWrites');
   });
});

describe('deleteDocuments: compendium documents', () => {
   it('needs allowCompendiumWrites for a document that lives in a pack', async () => {
      const packed = world.add('Actor', { name: 'MOCK_packed' }, { pack: 'world.actors' });
      const error = await failure({ uuids: [packed.uuid] });
      expect(error.message).toContain('allowCompendiumWrites');
      expect(world.classes.Actor.deleteDocuments).not.toHaveBeenCalled();
      gates.allowCompendiumWrites = true;
      await deleteDocuments({ uuids: [packed.uuid] });
      expect(world.classes.Actor.deleteDocuments.mock.calls[0][1]).toMatchObject({ pack: 'world.actors' });
   });
});

describe('deleteDocuments: nothing is deleted when any target is refused', () => {
   it('writes nothing when a later uuid is gated', async () => {
      const player = userDocument(2);
      const error = await failure({ uuids: [actor.uuid, player.uuid] });
      expect(error.code).toBe(GATE_DENIED);
      expect(world.calls).toEqual([]);
   });
});
