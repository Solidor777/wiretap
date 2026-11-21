import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { deletePackHandler } from '~/bridge/scripts/deletePack.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/** @type {Record<string, boolean>} The gate values the stubbed settings return. */
let gates;
/** @type {Map<string, object>} The world's mock packs by id. */
let packs;
/** @type {object} The unlocked world pack most tests act on. */
let pack;

/**
 * Build a mock compendium pack with a spy on every method a handler could call.
 * @param {object} [overrides] - Fields that replace the defaults.
 * @returns {object} A world pack of three Actors with spies on deleteCompendium, configure and setFolder.
 */
function mockPack(overrides = {}) {
   return {
      collection: 'world.mock-pack',
      title: 'MOCK Pack',
      documentName: 'Actor',
      locked: false,
      metadata: {
         packageType: 'world',
      },
      index: {
         size: 3,
      },
      deleteCompendium: vi.fn(async () => {}),
      configure: vi.fn(),
      setFolder: vi.fn(),
      ...overrides,
   };
}

/**
 * Add a pack to the mock world under its id.
 * @param {object} added - The mock pack.
 * @returns {object} The same pack.
 */
function addPack(added) {
   packs.set(added.collection, added);
   return added;
}

/**
 * Run the handler and return what it threw.
 * @param {{ id: string, dryRun?: boolean }} args - The arguments.
 * @returns {Promise<ScriptError>} The thrown error.
 */
async function refusal(args) {
   /** @type {unknown} What the handler threw, or null. */
   let thrown = null;
   try {
      await deletePackHandler(args, {});
   } catch (error) {
      thrown = error;
   }
   expect(thrown).toBeInstanceOf(ScriptError);
   return /** @type {ScriptError} */ (thrown);
}

/**
 * Measure text in UTF-8 bytes.
 * @param {string} text - The text to measure.
 * @returns {number} Its byte length.
 */
function utf8Length(text) {
   return new TextEncoder().encode(text).length;
}

beforeEach(() => {
   gates = {};
   packs = new Map();
   pack = addPack(mockPack());
   globalThis.game = {
      settings: {
         get: (module, key) => {
            if (key === 'allowedPluginModules') {
               return '';
            }
            return gates[key] ?? false;
         },
      },
      packs: {
         get: vi.fn((id) => packs.get(id)),
      },
   };
});

afterEach(() => {
   delete globalThis.game;
});

describe('deletePackHandler', () => {
   it('deletes an unlocked world pack through deleteCompendium and returns { id, deleted: true }', async () => {
      gates.allowPackDeletion = true;
      expect(await deletePackHandler({ id: 'world.mock-pack' }, {})).toEqual({
         id: 'world.mock-pack',
         deleted: true,
      });
      expect(pack.deleteCompendium).toHaveBeenCalledTimes(1);
   });

   it('is denied naming allowPackDeletion while the gate is closed, before looking up the pack', async () => {
      /** @type {ScriptError} The refusal. */
      const error = await refusal({ id: 'world.mock-pack' });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowPackDeletion');
      expect(game.packs.get).not.toHaveBeenCalled();
      expect(pack.deleteCompendium).not.toHaveBeenCalled();
   });

   it('a dry run with the gate closed returns the pack, its type and its document count, and deletes nothing',
      async () => {
         expect(await deletePackHandler({
            id: 'world.mock-pack',
            dryRun: true,
         }, {})).toEqual({
            dryRun: true,
            id: 'world.mock-pack',
            label: 'MOCK Pack',
            type: 'Actor',
            documents: 3,
         });
         expect(pack.deleteCompendium).not.toHaveBeenCalled();
      });

   it.each([
      [
         'missing',
         'world.nope',
      ],
      [
         'a bare name',
         'mock-pack',
      ],
   ])('is PACK_NOT_FOUND for %s', async (label, id) => {
      gates.allowPackDeletion = true;
      /** @type {ScriptError} The refusal. */
      const error = await refusal({ id });
      expect(error.code).toBe('PACK_NOT_FOUND');
      expect(error.message.startsWith('No pack with that id.')).toBe(true);
      expect(error.message).toContain(id);
      expect(pack.deleteCompendium).not.toHaveBeenCalled();
   });

   it.each([
      'system',
      'module',
   ])('refuses a %s pack as ARGS_INVALID "Only world packs can be deleted."', async (packageType) => {
      gates.allowPackDeletion = true;
      /** @type {object} The non-world pack. */
      const other = addPack(mockPack({
         collection: `${packageType}.mock-other`,
         metadata: {
            packageType,
         },
      }));
      /** @type {ScriptError} The refusal. */
      const error = await refusal({ id: other.collection });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toBe('Only world packs can be deleted.');
      expect(other.deleteCompendium).not.toHaveBeenCalled();
   });

   it('refuses a locked world pack as PACK_LOCKED and neither deletes it nor changes its lock', async () => {
      gates.allowPackDeletion = true;
      pack.locked = true;
      /** @type {ScriptError} The refusal. */
      const error = await refusal({ id: 'world.mock-pack' });
      expect(error.code).toBe('PACK_LOCKED');
      expect(error.message).toBe('The pack is locked; unlock it in Foundry first.');
      expect(pack.deleteCompendium).not.toHaveBeenCalled();
      expect(pack.configure).not.toHaveBeenCalled();
      expect(pack.locked).toBe(true);
   });

   it('a dry run still refuses a missing, a non-world and a locked pack', async () => {
      addPack(mockPack({
         collection: 'system.mock-other',
         metadata: {
            packageType: 'system',
         },
      }));
      addPack(mockPack({
         collection: 'world.mock-locked',
         locked: true,
      }));
      expect((await refusal({
         id: 'world.nope',
         dryRun: true,
      })).code).toBe('PACK_NOT_FOUND');
      expect((await refusal({
         id: 'system.mock-other',
         dryRun: true,
      })).code).toBe('ARGS_INVALID');
      expect((await refusal({
         id: 'world.mock-locked',
         dryRun: true,
      })).code).toBe('PACK_LOCKED');
   });

   it('checks a system pack before its lock', async () => {
      gates.allowPackDeletion = true;
      addPack(mockPack({
         collection: 'system.mock-locked',
         locked: true,
         metadata: {
            packageType: 'system',
         },
      }));
      expect((await refusal({ id: 'system.mock-locked' })).code).toBe('ARGS_INVALID');
   });

   it('keeps the preview within 256 bytes for a 128-character id and a long label of 4-byte characters', async () => {
      /** @type {string} A 128-character pack id. */
      const id = `world.${'a'.repeat(122)}`;
      addPack(mockPack({
         collection: id,
         title: '😀'.repeat(200),
         documentName: 'JournalEntry',
         index: {
            size: 99999,
         },
      }));
      /** @type {Record<string, unknown>} What the dry run returned. */
      const preview = await deletePackHandler({
         id,
         dryRun: true,
      }, {});
      expect(utf8Length(JSON.stringify(preview))).toBeLessThanOrEqual(256);
      expect(preview.id).toBe(id);
      expect(preview.type).toBe('JournalEntry');
      expect(preview.documents).toBe(99999);
      expect(preview.label.endsWith('…')).toBe(true);
   });

   it('keeps every refusal message within 256 bytes and bounds the echoed id', async () => {
      gates.allowPackDeletion = true;
      /** @type {string} An id of 320 bytes mixing 4-byte characters and newlines. */
      const id = '😀\n'.repeat(64);
      /** @type {ScriptError} The not-found refusal. */
      const notFound = await refusal({ id });
      expect(utf8Length(notFound.message)).toBeLessThanOrEqual(256);
      expect(notFound.message).not.toContain('\n');
      // The echoed id is at most 64 bytes, so the message is at most the fixed text plus 64 bytes and its framing.
      expect(utf8Length(notFound.message)).toBeLessThanOrEqual(utf8Length('No pack with that id.') + 64 + 16);
      pack.locked = true;
      expect(utf8Length((await refusal({ id: 'world.mock-pack' })).message)).toBeLessThanOrEqual(256);
      addPack(mockPack({
         collection: 'module.mock-other',
         metadata: {
            packageType: 'module',
         },
      }));
      expect(utf8Length((await refusal({ id: 'module.mock-other' })).message)).toBeLessThanOrEqual(256);
      gates.allowPackDeletion = false;
      expect(utf8Length((await refusal({ id: 'world.mock-pack' })).message)).toBeLessThanOrEqual(256);
   });

   it('calls no pack method but deleteCompendium', async () => {
      gates.allowPackDeletion = true;
      await deletePackHandler({
         id: 'world.mock-pack',
         dryRun: true,
      }, {});
      await deletePackHandler({ id: 'world.mock-pack' }, {});
      expect(pack.deleteCompendium).toHaveBeenCalledTimes(1);
      expect(pack.configure).not.toHaveBeenCalled();
      expect(pack.setFolder).not.toHaveBeenCalled();
   });
});
