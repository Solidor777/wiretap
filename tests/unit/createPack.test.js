import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { createPackHandler } from '~/bridge/scripts/createPack.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/** @type {string[]} Foundry's compendium document types (`common/constants.mjs` COMPENDIUM_DOCUMENT_TYPES). */
const COMPENDIUM_TYPES = [
   'ActiveEffect',
   'Actor',
   'Adventure',
   'Cards',
   'Item',
   'JournalEntry',
   'Macro',
   'Playlist',
   'RollTable',
   'Scene',
];

/** @type {Record<string, boolean>} The gate values the stubbed settings return. */
let gates;

/** @type {import('vitest').Mock} The stubbed `CompendiumCollection.createCompendium`. */
let createCompendium;

/** @type {PropertyDescriptor | undefined} The `slugify` property the test environment had before the stand-in. */
let previousSlugify;

/**
 * A stand-in for Foundry's `String.prototype.slugify` with `strict: true`: trims, lowercases, collapses whitespace and
 * `-` runs to `-`, and removes every character outside `[a-zA-Z0-9-]`.
 * @returns {string} The slug.
 * @this {string}
 */
function slugifyStandIn() {
   return this.trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '-')
      .replace(/[^a-zA-Z0-9-]/g, '');
}

/**
 * Measure text or a row as UTF-8 bytes (a row as its JSON).
 * @param {unknown} value - A string, or a value measured as JSON.
 * @returns {number} How many UTF-8 bytes the text or JSON takes.
 */
function byteLength(value) {
   return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

/**
 * Run the handler and return what it threw.
 * @param {Record<string, unknown>} args - The handler arguments.
 * @returns {Promise<ScriptError>} The thrown error; the test fails when nothing is thrown.
 */
async function refusal(args) {
   /** @type {unknown} What the handler threw. */
   let thrown = null;
   try {
      await createPackHandler(args, {});
   } catch (error) {
      thrown = error;
   }
   expect(thrown).toBeInstanceOf(ScriptError);
   return /** @type {ScriptError} */ (thrown);
}

beforeEach(() => {
   gates = {};
   createCompendium = vi.fn(async (metadata) => ({
      collection: `world.${metadata.name}`,
      metadata: { label: metadata.label },
      documentName: metadata.type,
   }));
   globalThis.game = {
      settings: {
         get: (module, key) => {
            if (key === 'allowedPluginModules') {
               return '';
            }
            return gates[key] ?? false;
         },
      },
      packs: new Map(),
   };
   globalThis.CONST = { COMPENDIUM_DOCUMENT_TYPES: Object.freeze([...COMPENDIUM_TYPES]) };
   globalThis.foundry = { documents: { collections: { CompendiumCollection: { createCompendium } } } };
   previousSlugify = Object.getOwnPropertyDescriptor(String.prototype, 'slugify');
   Object.defineProperty(String.prototype, 'slugify', {
      value: slugifyStandIn,
      configurable: true,
      writable: true,
   });
});

afterEach(() => {
   delete globalThis.game;
   delete globalThis.CONST;
   delete globalThis.foundry;
   if (previousSlugify === undefined) {
      delete String.prototype.slugify;
   } else {
      Object.defineProperty(String.prototype, 'slugify', previousSlugify);
   }
});

describe('createPackHandler', () => {
   it('creates the pack with the label, type and derived name, and returns { id, label, type }', async () => {
      gates.allowCompendiumWrites = true;
      /** @type {Record<string, unknown>} The ack. */
      const result = await createPackHandler(
         {
            label: 'MOCK Pack One',
            type: 'Actor',
         },
         {},
      );
      expect(createCompendium).toHaveBeenCalledTimes(1);
      expect(createCompendium).toHaveBeenCalledWith({
         label: 'MOCK Pack One',
         type: 'Actor',
         name: 'mock-pack-one',
      });
      expect(result).toEqual({
         id: 'world.mock-pack-one',
         label: 'MOCK Pack One',
         type: 'Actor',
      });
   });

   it('passes an explicit name through', async () => {
      gates.allowCompendiumWrites = true;
      /** @type {Record<string, unknown>} The ack. */
      const result = await createPackHandler(
         {
            label: 'MOCK Pack Two',
            type: 'Item',
            name: 'my_pack-2',
         },
         {},
      );
      expect(createCompendium).toHaveBeenCalledWith({
         label: 'MOCK Pack Two',
         type: 'Item',
         name: 'my_pack-2',
      });
      expect(result.id).toBe('world.my_pack-2');
   });

   it('is denied naming allowCompendiumWrites while the gate is closed, and calls Foundry zero times', async () => {
      /** @type {import('vitest').MockInstance} A spy on the pack lookup. */
      const keys = vi.spyOn(game.packs, 'keys');
      /** @type {ScriptError} The refusal. */
      const error = await refusal({
         label: 'MOCK Pack One',
         type: 'Actor',
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowCompendiumWrites');
      expect(keys).not.toHaveBeenCalled();
      expect(createCompendium).not.toHaveBeenCalled();
   });

   it(
      'a dry run with the gate closed returns { dryRun: true, id, label, type } and calls Foundry zero times',
      async () => {
         /** @type {Record<string, unknown>} The preview. */
         const result = await createPackHandler(
            {
               label: 'MOCK Pack One',
               type: 'JournalEntry',
               dryRun: true,
            },
            {},
         );
         expect(result).toEqual({
            dryRun: true,
            id: 'world.mock-pack-one',
            label: 'MOCK Pack One',
            type: 'JournalEntry',
         });
         expect(createCompendium).not.toHaveBeenCalled();
      },
   );

   it.each([
      '',
      '   ',
   ])('refuses the blank label %j', async (label) => {
      gates.allowCompendiumWrites = true;
      /** @type {ScriptError} The refusal. */
      const error = await refusal({
         label,
         type: 'Actor',
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('label must not be blank');
   });

   it.each([
      'actor',
      'Wall',
      '',
      'Actor ',
   ])('refuses the type %j naming the allowed list', async (type) => {
      gates.allowCompendiumWrites = true;
      /** @type {ScriptError} The refusal. */
      const error = await refusal({
         label: 'MOCK Pack One',
         type,
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('type must be one of');
      expect(error.message).toContain(COMPENDIUM_TYPES.join(', '));
   });

   it.each([
      'my pack',
      'a.b',
      '../x',
      'é',
      'a/b',
   ])('refuses the name %j', async (name) => {
      gates.allowCompendiumWrites = true;
      /** @type {ScriptError} The refusal. */
      const error = await refusal({
         label: 'MOCK Pack One',
         type: 'Actor',
         name,
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('name may hold only letters, digits, - and _');
   });

   it.each([
      'con',
      'PRN',
      'aux',
      'nul',
      'com1',
      'LPT9',
   ])('refuses the reserved name %s', async (name) => {
      gates.allowCompendiumWrites = true;
      /** @type {ScriptError} The refusal. */
      const error = await refusal({
         label: 'MOCK Pack One',
         type: 'Actor',
         name,
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('name is a reserved name');
   });

   it.each([
      '日本語',
      '!!!',
   ])('refuses the label %s with no name, because its slug is empty', async (label) => {
      gates.allowCompendiumWrites = true;
      /** @type {ScriptError} The refusal. */
      const error = await refusal({
         label,
         type: 'Actor',
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('label has no letters or digits to name the pack; give a name');
   });

   it('creates a derived or given name of any length, warning once past 64 characters and not at 64', async () => {
      gates.allowCompendiumWrites = true;
      /** @type {string[]} The log lines of the calls. */
      const logs = [];
      /** @type {{ log: (line: string) => void }} A context that records log lines. */
      const ctx = { log: (line) => logs.push(line) };
      /** @type {Record<string, unknown>} The ack of a derived name of exactly 64 characters. */
      const atGuideline = await createPackHandler(
         {
            label: 'a'.repeat(64),
            type: 'Actor',
         },
         ctx,
      );
      expect(atGuideline.id).toBe(`world.${'a'.repeat(64)}`);
      expect(logs).toEqual([]);
      /** @type {Record<string, unknown>} The ack of a derived name of 65 characters. */
      const derived = await createPackHandler(
         {
            label: 'c'.repeat(65),
            type: 'Actor',
         },
         ctx,
      );
      expect(derived.id).toBe(`world.${'c'.repeat(65)}`);
      /** @type {Record<string, unknown>} The dry run of a given name of 500 characters. */
      const given = await createPackHandler(
         {
            label: 'MOCK Pack One',
            type: 'Actor',
            name: 'b'.repeat(500),
            dryRun: true,
         },
         ctx,
      );
      expect(given.id).toBe(`world.${'b'.repeat(500)}`);
      expect(logs).toEqual([
         'Wiretap | create_pack warning: name characters 65 is over the 64 guideline',
         'Wiretap | create_pack warning: name characters 500 is over the 64 guideline',
      ]);
      expect(createCompendium).toHaveBeenCalledTimes(2);
   });

   it('refuses a collision with world.<name>, on a real run and on a dry run', async () => {
      gates.allowCompendiumWrites = true;
      game.packs.set('world.mock-pack-one', {});
      /** @type {ScriptError} The refusal of the real run. */
      const real = await refusal({
         label: 'MOCK Pack One',
         type: 'Actor',
      });
      expect(real.code).toBe('ARGS_INVALID');
      expect(real.message).toContain('already exists');
      /** @type {ScriptError} The refusal of the dry run. */
      const dry = await refusal({
         label: 'MOCK Pack One',
         type: 'Actor',
         dryRun: true,
      });
      expect(dry.code).toBe('ARGS_INVALID');
      expect(dry.message).toContain('already exists');
      expect(createCompendium).not.toHaveBeenCalled();
   });

   it('refuses a name that equals a world pack name when case is ignored, on a real run and on a dry run', async () => {
      gates.allowCompendiumWrites = true;
      game.packs.set('world.foo', {});
      /** @type {ScriptError} The refusal of the real run. */
      const real = await refusal({
         label: 'MOCK Pack One',
         type: 'Actor',
         name: 'Foo',
      });
      expect(real.code).toBe('ARGS_INVALID');
      expect(real.message).toContain('already exists');
      /** @type {ScriptError} The refusal of the dry run. */
      const dry = await refusal({
         label: 'MOCK Pack One',
         type: 'Actor',
         name: 'Foo',
         dryRun: true,
      });
      expect(dry.code).toBe('ARGS_INVALID');
      expect(dry.message).toContain('already exists');
      expect(createCompendium).not.toHaveBeenCalled();
   });

   it('does not treat a system pack of the same bare name as a collision', async () => {
      gates.allowCompendiumWrites = true;
      game.packs.set('mysystem.mock-pack-one', {});
      /** @type {Record<string, unknown>} The ack. */
      const result = await createPackHandler(
         {
            label: 'MOCK Pack One',
            type: 'Actor',
         },
         {},
      );
      expect(result.id).toBe('world.mock-pack-one');
      expect(createCompendium).toHaveBeenCalledTimes(1);
   });

   it('every refusal calls createCompendium zero times', async () => {
      gates.allowCompendiumWrites = true;
      game.packs.set('world.taken', {});
      /** @type {Record<string, unknown>[]} One argument set per refusal. */
      const cases = [
         {
            label: ' ',
            type: 'Actor',
         },
         {
            label: 'MOCK',
            type: 'Wall',
         },
         {
            label: '!!!',
            type: 'Actor',
         },
         {
            label: 'MOCK',
            type: 'Actor',
            name: 'a b',
         },
         {
            label: 'MOCK',
            type: 'Actor',
            name: 'con',
         },
         {
            label: 'MOCK',
            type: 'Actor',
            name: 'taken',
         },
      ];
      for (const args of cases) {
         /** @type {ScriptError} The refusal. */
         const error = await refusal(args);
         expect(error.code).toBe('ARGS_INVALID');
      }
      gates.allowCompendiumWrites = false;
      /** @type {ScriptError} The gate refusal. */
      const denied = await refusal({
         label: 'MOCK',
         type: 'Actor',
      });
      expect(denied.code).toBe(GATE_DENIED);
      expect(createCompendium).not.toHaveBeenCalled();
   });

   it('keeps the ack within 256 bytes for a 128-character label of 4-byte characters, real and dry', async () => {
      gates.allowCompendiumWrites = true;
      /** @type {string} A label of 128 four-byte characters. */
      const label = '😀'.repeat(128);
      /** @type {Record<string, unknown>} The real ack. */
      const real = await createPackHandler(
         {
            label,
            type: 'JournalEntry',
            name: 'd'.repeat(64),
         },
         {},
      );
      expect(byteLength(real)).toBeLessThanOrEqual(256);
      expect(real.id).toBe(`world.${'d'.repeat(64)}`);
      expect(real.type).toBe('JournalEntry');
      /** @type {Record<string, unknown>} The dry-run ack. */
      const dry = await createPackHandler(
         {
            label,
            type: 'JournalEntry',
            name: 'e'.repeat(64),
            dryRun: true,
         },
         {},
      );
      expect(byteLength(dry)).toBeLessThanOrEqual(256);
      expect(dry.dryRun).toBe(true);
      expect(dry.id).toBe(`world.${'e'.repeat(64)}`);
      expect(dry.type).toBe('JournalEntry');
   });

   it('keeps every refusal message within 256 bytes and bounds the echoed caller text', async () => {
      gates.allowCompendiumWrites = true;
      /** @type {ScriptError} The refusal of a 5,000-character type. */
      const typeError = await refusal({
         label: 'MOCK',
         type: 'x'.repeat(5000),
      });
      expect(byteLength(typeError.message)).toBeLessThanOrEqual(256);
      expect(typeError.message).not.toContain('x'.repeat(65));
      /** @type {ScriptError} The refusal of a 5,000-character name of 4-byte characters. */
      const nameError = await refusal({
         label: 'MOCK',
         type: 'Actor',
         name: '😀'.repeat(5000),
      });
      expect(byteLength(nameError.message)).toBeLessThanOrEqual(256);
      /** @type {ScriptError} The refusal of a 64-character name that breaks the pattern. */
      const patternError = await refusal({
         label: 'MOCK',
         type: 'Actor',
         name: `${'é'.repeat(63)}\n`,
      });
      expect(byteLength(patternError.message)).toBeLessThanOrEqual(256);
      expect(patternError.message).not.toContain('\n');
   });
});
