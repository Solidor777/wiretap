import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCallTool } from '~/bridge/scripts/callTool.js';
import { registerShippedScripts } from '~/bridge/scripts/index.js';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';
import { BEST_PRACTICE, longest, SizeNotes, totalBytes } from '~/bridge/scripts/sizeNotes.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {string[]} The lines the script log received during one test. */
let lines;

/** @type {(params: unknown) => Promise<any>} The callTool handler over a registry whose log is recorded. */
let callTool;

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {object} A live actor. */
let actor;

beforeEach(() => {
   lines = [];
   const registry = createScriptRegistry({ log: (line) => lines.push(line) });
   registerShippedScripts(registry);
   callTool = createCallTool({ registry });
   world = installWriteWorld(vi.fn, {
      users: [
         {
            id: 'MOCKGM0000000001',
            role: 4,
         },
      ],
      userId: 'MOCKGM0000000001',
   });
   globalThis.game.settings.get = (module, key) => key === 'allowDelete' || key === 'allowReplace';
   actor = world.add('Actor', {
      name: 'MOCK_actor',
      type: 'npc',
   });
   // Registration lines are not under test.
   lines.length = 0;
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
 * Call a registered tool.
 * @param {string} name - The tool name.
 * @param {Record<string, unknown>} args - The arguments.
 * @returns {Promise<any>} The result.
 */
function call(name, args) {
   return callTool({
      name,
      arguments: args,
   });
}

/**
 * One part of a warning line.
 * @param {number} measured - What the call carried.
 * @param {string} measure - What is counted.
 * @param {number} size - The best-practice size.
 * @returns {string} The part as the line spells it.
 */
function part(measured, measure, size) {
   return `${measured} ${measure}, over the ${size} best-practice size`;
}

/**
 * The JSON text of one actor that is exactly the given number of characters long.
 * @param {number} chars - The length of the text.
 * @returns {string} An actor whose `system.t` padding makes up the length.
 */
function actorText(chars) {
   /** @type {string} The text without its padding. */
   const empty = '{"name":"MOCK_big","type":"npc","system":{"t":""}}';
   return `{"name":"MOCK_big","type":"npc","system":{"t":"${'a'.repeat(chars - empty.length)}"}}`;
}

/**
 * Read-back paths, each a distinct field.
 * @param {number} count - How many paths.
 * @returns {string[]} `system.f0`, `system.f1` and so on.
 */
function readPaths(count) {
   return Array.from({ length: count }, (_, index) => `system.f${index}`);
}

describe('SizeNotes', () => {
   it('writes nothing when no size was passed, and nothing at a size', () => {
      const log = vi.fn();
      const notes = new SizeNotes('create_documents');
      notes.note(50, 'documents in one call', 50);
      notes.write(log);
      expect(log).not.toHaveBeenCalled();
   });

   it('joins every size passed into one line in the order noted, then forgets them', () => {
      const log = vi.fn();
      const notes = new SizeNotes('create_documents');
      notes.note(120, 'documents in one call', 50);
      notes.note(3, 'paths in one call', 20);
      notes.note(30, 'paths in one call', 20);
      notes.write(log);
      notes.write(log);
      expect(log.mock.calls).toEqual([
         [
            'Wiretap | create_documents: 120 documents in one call, over the 50 best-practice size; ' +
               '30 paths in one call, over the 20 best-practice size',
         ],
      ]);
   });

   it('measures the longest text and the total bytes, counting a non-string as empty', () => {
      expect(longest([])).toBe(0);
      expect(longest([
         'ab',
         'abcd',
         7,
      ])).toBe(4);
      expect(longest([
         'é',
         'ab',
      ], (text) => new TextEncoder().encode(text).length)).toBe(2);
      expect(totalBytes([
         'é',
         'ab',
         null,
      ])).toBe(4);
   });
});

describe('create_documents size warnings', () => {
   it('logs nothing for 50 documents and 20 read-back paths', async () => {
      await call('create_documents', {
         documentName: 'Actor',
         data: Array.from({ length: BEST_PRACTICE.documents }, (_, index) => `{"name":"MOCK_${index}"}`),
         paths: readPaths(BEST_PRACTICE.paths),
      });
      expect(lines).toEqual([]);
   });

   it('logs one line for 51 documents and 21 read-back paths', async () => {
      await call('create_documents', {
         documentName: 'Actor',
         data: Array.from({ length: BEST_PRACTICE.documents + 1 }, (_, index) => `{"name":"MOCK_${index}"}`),
         paths: readPaths(BEST_PRACTICE.paths + 1),
      });
      expect(lines).toEqual([
         'Wiretap | create_documents: ' +
            [
               part(BEST_PRACTICE.documents + 1, 'documents in one call', BEST_PRACTICE.documents),
               part(BEST_PRACTICE.paths + 1, 'paths in one call', BEST_PRACTICE.paths),
            ].join('; '),
      ]);
   });

   it('logs a document text one character past the size, and not one at it', async () => {
      await call('create_documents', {
         documentName: 'Actor',
         data: [actorText(BEST_PRACTICE.textChars)],
      });
      expect(lines).toEqual([]);
      await call('create_documents', {
         documentName: 'Actor',
         data: [actorText(BEST_PRACTICE.textChars + 1)],
      });
      expect(lines).toEqual([
         'Wiretap | create_documents: ' +
            part(BEST_PRACTICE.textChars + 1, 'characters in one document text', BEST_PRACTICE.textChars),
      ]);
   });

   it('logs a fromUuids entry past the size even when the copy is refused, and not one at it', async () => {
      for (const length of [
         BEST_PRACTICE.uuidChars,
         BEST_PRACTICE.uuidChars + 1,
      ]) {
         await expect(call('create_documents', {
            documentName: 'Actor',
            fromUuids: [`Actor.${'x'.repeat(length - 'Actor.'.length)}`],
         })).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' });
      }
      expect(lines).toEqual([
         'Wiretap | create_documents: ' +
            part(BEST_PRACTICE.uuidChars + 1, 'characters in one fromUuids entry', BEST_PRACTICE.uuidChars),
      ]);
   });

   it('logs data one byte past the call size, and not at it', async () => {
      /** @type {number} The length of each of four texts that together make the size. */
      const quarter = BEST_PRACTICE.dataBytes / 4;
      /** @type {string[]} Three of the four texts. */
      const three = Array.from({ length: 3 }, () => actorText(quarter));
      await call('create_documents', {
         documentName: 'Actor',
         data: [
            ...three,
            actorText(quarter),
         ],
      });
      expect(lines).toEqual([]);
      await call('create_documents', {
         documentName: 'Actor',
         data: [
            ...three,
            actorText(quarter + 1),
         ],
      });
      expect(lines).toEqual([
         'Wiretap | create_documents: ' +
            part(BEST_PRACTICE.dataBytes + 1, 'bytes of data in one call', BEST_PRACTICE.dataBytes),
      ]);
   });
});

describe('update_documents size warnings', () => {
   /**
    * Add world items.
    * @param {number} count - How many items.
    * @returns {object[]} The new world items, named `MOCK_item<index>`.
    */
   function items(count) {
      return Array.from({ length: count }, (_, index) => world.add('Item', { name: `MOCK_item${index}` }));
   }

   it('logs nothing for 200 entries over 50 documents and 20 read-back paths', async () => {
      await call('update_documents', {
         updates: items(BEST_PRACTICE.documents).flatMap((item) =>
            Array.from({ length: BEST_PRACTICE.updateEntries / BEST_PRACTICE.documents }, (_, index) => ({
               uuid: item.uuid,
               path: `system.f${index}`,
               value: '1',
            })),
         ),
         paths: readPaths(BEST_PRACTICE.paths),
      });
      expect(lines).toEqual([]);
   });

   it('logs one line for 201 entries on one document: the entries and the patches on it', async () => {
      await call('update_documents', {
         updates: Array.from({ length: BEST_PRACTICE.updateEntries + 1 }, (_, index) => ({
            uuid: actor.uuid,
            path: `system.f${index}`,
            value: '1',
         })),
      });
      expect(lines).toEqual([
         'Wiretap | update_documents: ' +
            [
               part(BEST_PRACTICE.updateEntries + 1, 'update entries in one call', BEST_PRACTICE.updateEntries),
               part(BEST_PRACTICE.updateEntries + 1, 'patches on one document', BEST_PRACTICE.paths),
            ].join('; '),
      ]);
   });

   it('logs 51 documents, 21 patches on one document and 21 read-back paths in one line', async () => {
      /** @type {object[]} The items updated. */
      const updated = items(BEST_PRACTICE.documents + 1);
      await call('update_documents', {
         updates: [
            ...updated.map((item) => ({
               uuid: item.uuid,
               path: 'name',
               value: '"MOCK_x"',
            })),
            ...Array.from({ length: BEST_PRACTICE.paths }, (_, index) => ({
               uuid: updated[0].uuid,
               path: `system.f${index}`,
               value: '1',
            })),
         ],
         paths: readPaths(BEST_PRACTICE.paths + 1),
      });
      expect(lines).toEqual([
         'Wiretap | update_documents: ' +
            [
               part(BEST_PRACTICE.paths + 1, 'paths in one call', BEST_PRACTICE.paths),
               part(BEST_PRACTICE.documents + 1, 'documents in one call', BEST_PRACTICE.documents),
               part(BEST_PRACTICE.paths + 1, 'patches on one document', BEST_PRACTICE.paths),
            ].join('; '),
      ]);
   });

   it('logs an update value one character past the size, and not one at it', async () => {
      /**
       * A JSON string value of exactly the given length.
       * @param {number} chars - The length.
       * @returns {string} A quoted run of `v` characters.
       */
      const value = (chars) => JSON.stringify('v'.repeat(chars - 2));
      await call('update_documents', {
         updates: [{
            uuid: actor.uuid,
            path: 'system.note',
            value: value(BEST_PRACTICE.textChars),
         }],
      });
      expect(lines).toEqual([]);
      await call('update_documents', {
         updates: [{
            uuid: actor.uuid,
            path: 'system.note',
            value: value(BEST_PRACTICE.textChars + 1),
         }],
      });
      expect(lines).toEqual([
         'Wiretap | update_documents: ' +
            part(BEST_PRACTICE.textChars + 1, 'characters in one update value', BEST_PRACTICE.textChars),
      ]);
   });
});

describe('delete_documents size warnings', () => {
   it('logs nothing for 50 documents and one line for 51', async () => {
      /**
       * Add world items and return their uuids.
       * @param {number} count - How many items.
       * @returns {string[]} The uuid of each new item.
       */
      const uuids = (count) =>
         Array.from({ length: count }, (_, index) => world.add('Item', { name: `MOCK_item${index}` }).uuid);
      await call('delete_documents', { uuids: uuids(BEST_PRACTICE.documents) });
      expect(lines).toEqual([]);
      await call('delete_documents', { uuids: uuids(BEST_PRACTICE.documents + 1) });
      expect(lines).toEqual([
         'Wiretap | delete_documents: ' +
            part(BEST_PRACTICE.documents + 1, 'documents in one call', BEST_PRACTICE.documents),
      ]);
   });
});

describe('replace_document size warnings', () => {
   it('logs nothing at the sizes and one line for a text and read-back paths past them', async () => {
      await call('replace_document', {
         uuid: actor.uuid,
         data: actorText(BEST_PRACTICE.textChars),
         paths: readPaths(BEST_PRACTICE.paths),
      });
      expect(lines).toEqual([]);
      await call('replace_document', {
         uuid: actor.uuid,
         data: actorText(BEST_PRACTICE.textChars + 1),
         paths: readPaths(BEST_PRACTICE.paths + 1),
      });
      expect(lines).toEqual([
         'Wiretap | replace_document: ' +
            [
               part(BEST_PRACTICE.textChars + 1, 'characters in one document text', BEST_PRACTICE.textChars),
               part(BEST_PRACTICE.paths + 1, 'paths in one call', BEST_PRACTICE.paths),
            ].join('; '),
      ]);
   });
});
