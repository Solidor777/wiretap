import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { replaceDocument } from '~/bridge/scripts/writeReplace.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} The live actor to replace; it carries a Wiretap record and another module's flag. */
let actor;

/** @type {object} An item of that actor that carries a Wiretap record. */
let sword;

beforeEach(() => {
   world = installWriteWorld(vi.fn, {
      users: [
         {
            id: 'MOCKGM0000000001',
            role: 4,
            name: 'MOCK_gm',
         },
      ],
      userId: 'MOCKGM0000000001',
   });
   gates = {
      allowDelete: true,
      allowReplace: true,
   };
   globalThis.game.settings.get = (module, key) => gates[key];
   actor = world.add('Actor', {
      name: 'MOCK_actor',
      type: 'npc',
      flags: {
         wiretap: { idem: { k: 'MOCK_key' } },
         other: { a: 1 },
      },
   });
   sword = world.addChild(actor, 'Item', {
      name: 'MOCK_sword',
      type: 'weapon',
      flags: { wiretap: { idem: { k: 'MOCK_item_key' } } },
   });
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
 * Run `replaceDocument` and return what it threw.
 * @param {object} params - The parameters.
 * @returns {Promise<Error>} The error.
 */
async function failure(params) {
   try {
      await replaceDocument(params);
   } catch (error) {
      return error;
   }
   throw new Error('replaceDocument did not throw');
}

describe('replaceDocument: User documents', () => {
   it('refuses to replace a User and points to update_documents', async () => {
      gates.allowUserWrites = true;
      const user = world.add('User', {
         name: 'MOCK_user',
         role: 1,
      });
      const error = await failure({
         uuid: user.uuid,
         data: {
            name: 'MOCK_renamed',
            role: 4,
         },
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('update_documents');
      expect(user.update).not.toHaveBeenCalled();
      expect(world.classes.User.fromImport).not.toHaveBeenCalled();
   });
});

describe('replaceDocument: the guard judges what is written', () => {
   it('refuses a replacement whose schema defaults carry a gated value, though the data had none', async () => {
      world.importDefaults.img = 'data:image/png;base64,AAAA';
      const error = await failure({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
         },
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowFileUpload');
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('lets the same replacement through when the gate is open', async () => {
      world.importDefaults.img = 'data:image/png;base64,AAAA';
      gates.allowFileUpload = true;
      await replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
         },
      });
      expect(actor.update).toHaveBeenCalledTimes(1);
   });
});

describe('replaceDocument: the flags.wiretap records survive', () => {
   it('carries the live Wiretap record over when the data omits flags, and drops the other scopes', async () => {
      await replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
         },
      });
      expect(actor.update.mock.calls[0][0].flags).toEqual({ wiretap: { idem: { k: 'MOCK_key' } } });
   });

   it('ignores a Wiretap record in the data and keeps the live one, so a full read round-trips', async () => {
      const row = await replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
            flags: {
               wiretap: { idem: { k: 'MOCK_forged' } },
               other: { b: 2 },
            },
         },
      });
      expect(actor.update.mock.calls[0][0].flags).toEqual({
         other: { b: 2 },
         wiretap: { idem: { k: 'MOCK_key' } },
      });
      expect(row.changed).toContain('flags');
   });

   it('carries the record of an embedded document that stays and drops a forged record on a new one', async () => {
      await replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
            items: [
               {
                  _id: sword.id,
                  name: 'MOCK_sword',
                  type: 'weapon',
                  flags: { wiretap: { idem: { k: 'MOCK_forged' } } },
               },
               {
                  _id: 'MOCKNEWITEM00001',
                  name: 'MOCK_new',
                  type: 'weapon',
                  flags: { wiretap: { idem: { k: 'MOCK_forged' } } },
               },
            ],
         },
      });
      const [kept, added] = actor.update.mock.calls[0][0].items;
      expect(kept.flags).toEqual({ wiretap: { idem: { k: 'MOCK_item_key' } } });
      expect(added.flags ?? {}).toEqual({});
   });

   it('still refuses a dotted form that reaches the scope, and a flags value that is not an object', async () => {
      for (const data of [
         { 'flags.wiretap.idem': 1 },
         { flags: null },
      ]) {
         const error = await failure({
            uuid: actor.uuid,
            data: {
               name: 'MOCK_replaced',
               type: 'npc',
               ...data,
            },
         });
         expect(error.code, JSON.stringify(data)).toBe(GATE_DENIED);
      }
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('refuses an operator form of the flags as an operator', async () => {
      for (const data of [
         { '-=flags': null },
         { flags: { '-=wiretap': null } },
         { '==flags': {} },
      ]) {
         const error = await failure({
            uuid: actor.uuid,
            data: {
               name: 'MOCK_replaced',
               type: 'npc',
               ...data,
            },
         });
         expect(error.code, JSON.stringify(data)).toBe('PATH_OPERATOR');
      }
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('does not alter the data the caller passed', async () => {
      const data = {
         name: 'MOCK_replaced',
         type: 'npc',
         flags: { wiretap: { idem: {} } },
      };
      const copy = structuredClone(data);
      await replaceDocument({
         uuid: actor.uuid,
         data,
      });
      expect(data).toEqual(copy);
   });
});

describe('replaceDocument: import errors', () => {
   it('stamps the running core version whatever the data says, so Foundry never migrates over the socket', async () => {
      await replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
            _stats: { coreVersion: '9.280' },
         },
      });
      expect(world.classes.Actor.fromImport.mock.calls[0][0]._stats.coreVersion).toBe(game.version);
   });

   it('reports only a validation error as VALIDATION_FAILED', async () => {
      const error = await failure({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
            invalid: { name: 'is invalid' },
         },
      });
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('lets any other import error through unchanged', async () => {
      world.classes.Actor.fromImport.mockImplementationOnce(async () => {
         throw new Error('MOCK socket closed');
      });
      const error = await failure({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
         },
      });
      expect(error.code).not.toBe('VALIDATION_FAILED');
      expect(error.message).toContain('MOCK socket closed');
      expect(actor.update).not.toHaveBeenCalled();
   });
});
