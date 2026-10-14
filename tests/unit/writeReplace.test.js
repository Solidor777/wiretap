import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { replaceDocument } from '~/bridge/scripts/writeReplace.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} The live actor to replace. */
let actor;

beforeEach(() => {
   world = installWriteWorld(vi.fn, {
      users: [
         {
            id: 'MOCKGM0000000001',
            role: 4,
            name: 'MOCK_gm',
         },
         {
            id: 'MOCKPLAYER00001',
            role: 1,
            name: 'MOCK_player',
         },
      ],
      userId: 'MOCKGM0000000001',
   });
   gates = {
      allowDelete: true,
      allowReplace: true,
   };
   globalThis.game.settings.get = (module, key) => gates[key];
   globalThis.game.version = '14.364';
   globalThis.CONST.PRIMARY_DOCUMENT_TYPES = [
      'Actor',
      'Item',
      'ActiveEffect',
      'Setting',
      'User',
      'JournalEntry',
      'Scene',
   ];
   actor = world.add('Actor', {
      name: 'MOCK_actor',
      type: 'npc',
      sort: 5,
      folder: 'MOCKFOLDER000001',
      ownership: { default: 0 },
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

describe('replaceDocument: the replace semantics', () => {
   it('imports strictly, drops the preserved fields and updates with hooks and without merging', async () => {
      // The ownership key in the data is judged by the guard even though the import drops it.
      gates.allowOwnershipWrites = true;
      const rows = await replaceDocument({
         uuid: actor.uuid,
         data: {
            _id: 'OTHERID000000001',
            name: 'MOCK_replaced',
            type: 'npc',
            sort: 99,
            folder: 'OTHERFOLDER00001',
            ownership: { default: 3 },
            system: { hp: 7 },
         },
      });
      expect(world.classes.Actor.fromImport).toHaveBeenCalledTimes(1);
      expect(actor.update).toHaveBeenCalledTimes(1);
      const [sent, operation] = actor.update.mock.calls[0];
      expect(sent).toEqual({
         name: 'MOCK_replaced',
         type: 'npc',
         system: { hp: 7 },
      });
      expect(operation).toEqual({
         diff: false,
         recursive: false,
      });
      expect(rows).toEqual({
         uuid: actor.uuid,
         changed: [
            'name',
            'type',
            'system',
         ],
      });
   });

   it('stamps the running core version on data that has none, so Foundry does not migrate it', async () => {
      await replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
         },
      });
      expect(world.classes.Actor.fromImport.mock.calls[0][0]._stats.coreVersion).toBe('14.364');
   });

   it('clears ownership out of embedded data', async () => {
      gates.allowOwnershipWrites = true;
      await replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
            items: [
               {
                  name: 'MOCK_item',
                  ownership: { default: 3 },
               },
            ],
         },
      });
      expect(actor.update.mock.calls[0][0].items).toEqual([{ name: 'MOCK_item' }]);
   });

   it('does not mutate the data the caller passed', async () => {
      const data = {
         name: 'MOCK_replaced',
         type: 'npc',
         system: { hp: 7 },
      };
      const copy = structuredClone(data);
      await replaceDocument({
         uuid: actor.uuid,
         data,
      });
      expect(data).toEqual(copy);
   });

   it('reports a hook that cancelled the update', async () => {
      world.cancel.cancelUpdate = true;
      const error = await failure({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
         },
      });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
   });

   it('adds the canonical export when read-back is asked for', async () => {
      const row = await replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
         },
         readback: true,
      });
      expect(row.exported).toBeDefined();
   });
});

describe('replaceDocument: targets', () => {
   it('refuses a pack uuid, a value that is not a document and a class that cannot be imported', async () => {
      const pack = await failure({
         uuid: 'Compendium.mock.pack',
         data: { name: 'MOCK_x' },
      });
      expect(pack.code).toBe('ARGS_INVALID');
      globalThis.fromUuid = vi.fn(async () => ({ uuid: 'Mock.thing' }));
      const thing = await failure({
         uuid: 'Mock.thing',
         data: { name: 'MOCK_x' },
      });
      expect(thing.code).toBe('ARGS_INVALID');
      const wall = world.add('Scene', {
         name: 'MOCK_scene',
         type: 'base',
      });
      wall.documentName = 'Wall';
      globalThis.fromUuid = vi.fn(async () => wall);
      const wallError = await failure({
         uuid: wall.uuid,
         data: { name: 'MOCK_x' },
      });
      expect(wallError.code).toBe('ARGS_INVALID');
      expect(world.calls).toEqual([]);
   });

   it('refuses data that is not an object', async () => {
      for (const data of [
         null,
         [],
         'text',
         5,
      ]) {
         const error = await failure({
            uuid: actor.uuid,
            data,
         });
         expect(error.code).toBe('ARGS_INVALID');
      }
   });

   it('refuses unsafe keys in the data', async () => {
      const error = await failure({
         uuid: actor.uuid,
         data: JSON.parse('{"name":"MOCK_x","a.__proto__.b":1}'),
      });
      expect(error.code).toBe('PATH_UNSAFE_VALUE');
      expect(actor.update).not.toHaveBeenCalled();
   });
});

describe('replaceDocument: validation and dryRun', () => {
   it('returns the failures of invalid data and writes nothing', async () => {
      const error = await failure({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_x',
            invalid: { 'system.hp': 'must be a number' },
         },
      });
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.failures).toEqual([
         {
            path: 'system.hp',
            message: 'must be a number',
         },
      ]);
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('validates and reports the would-be result without updating', async () => {
      const row = await replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
         },
         dryRun: true,
      });
      expect(row).toEqual({
         uuid: actor.uuid,
         changed: [
            'name',
            'type',
         ],
         dryRun: true,
      });
      expect(actor.update).not.toHaveBeenCalled();
      expect(world.calls).toEqual([]);
   });

   it('still refuses invalid data on a dry run', async () => {
      const error = await failure({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_x',
            invalid: { name: 'bad' },
         },
         dryRun: true,
      });
      expect(error.code).toBe('VALIDATION_FAILED');
   });
});

describe('replaceDocument: the write guard', () => {
   it('refuses a wiretap Setting by the key of the document and by the key of the data', async () => {
      gates.allowSettingWrites = true;
      const gate = world.add('Setting', {
         key: 'wiretap.allowUserWrites',
         value: 'false',
      });
      const byDocument = await failure({
         uuid: gate.uuid,
         data: { value: 'true' },
      });
      expect(byDocument.code).toBe(GATE_DENIED);
      expect(byDocument.message).toContain('Wiretap settings');
      const ordinary = world.add('Setting', {
         key: 'mock.setting',
         value: '1',
      });
      for (const data of [
         {
            key: 'wiretap.allowUserWrites',
            value: 'true'
         },
         {
            key: { value: 'wiretap.x' },
            value: 'true'
         },
         {
            key: 'wiretap.x',
            namespace: 'zzz',
            value: 'true'
         },
      ]) {
         const error = await failure({
            uuid: ordinary.uuid,
            data,
         });
         expect(error.code, JSON.stringify(data)).toBe(GATE_DENIED);
      }
      expect(gate.update).not.toHaveBeenCalled();
      expect(ordinary.update).not.toHaveBeenCalled();
   });

   it('needs allowSettingWrites for any Setting and allowModuleConfigWrites for the module configuration', async () => {
      const setting = world.add('Setting', {
         key: 'mock.setting',
         value: '1',
      });
      const closed = await failure({
         uuid: setting.uuid,
         data: { value: '2' },
      });
      expect(closed.message).toContain('allowSettingWrites');
      gates.allowSettingWrites = true;
      const config = world.add('Setting', {
         key: 'core.moduleConfiguration',
         value: '{}',
      });
      const denied = await failure({
         uuid: config.uuid,
         data: { value: '{}' },
      });
      expect(denied.message).toContain('allowModuleConfigWrites');
   });

   it('needs allowOwnershipWrites for an ownership key, dotted or not', async () => {
      for (const data of [
         {
            name: 'MOCK_x',
            ownership: { default: 3 }
         },
         {
            name: 'MOCK_x',
            'ownership.default': 3
         },
      ]) {
         const error = await failure({
            uuid: actor.uuid,
            data,
         });
         expect(error.message).toContain('allowOwnershipWrites');
      }
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('needs allowFileUpload for a data URI', async () => {
      const error = await failure({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_x',
            img: 'data:image/png;base64,AAAA',
         },
      });
      expect(error.message).toContain('allowFileUpload');
   });

   it('needs allowCompendiumWrites for a document inside a pack', async () => {
      const inPack = world.add(
         'Actor',
         {
            name: 'MOCK_packed',
            type: 'npc',
         },
         { pack: 'mock.pack' },
      );
      const error = await failure({
         uuid: inPack.uuid,
         data: { name: 'MOCK_x' },
      });
      expect(error.message).toContain('allowCompendiumWrites');
   });

   it('refuses a dotted key that reaches the reserved wiretap flag scope', async () => {
      const error = await failure({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_x',
            'flags.wiretap.idem': {},
         },
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('flags.wiretap');
   });
});

describe('replaceDocument: actAs', () => {
   it('refuses a user who may not update, also on a dry run, and writes nothing', async () => {
      for (const dryRun of [
         false,
         true,
      ]) {
         const error = await failure({
            uuid: actor.uuid,
            data: {
               name: 'MOCK_x',
               type: 'npc',
            },
            actAs: 'MOCKPLAYER00001',
            dryRun,
         });
         expect(error.code).toBe('ACT_AS_DENIED');
      }
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('lets a game master through', async () => {
      const row = await replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_x',
            type: 'npc',
         },
         actAs: 'MOCKGM0000000001',
      });
      expect(row.changed).toEqual([
         'name',
         'type',
      ]);
   });
});
