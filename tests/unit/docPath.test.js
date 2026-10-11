// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { getBudget } from '../../shared/budgets.js';
import { groupWrites, parsePath, resolvePath, resolvePaths } from '../../shared/docPath.js';

/**
 * UTF-8 encoder used to measure message sizes.
 * @type {TextEncoder}
 */
const ENCODER = new TextEncoder();

/**
 * Every Object.prototype member name that a path segment must never reach.
 * @type {string[]}
 */
const INHERITED_NAMES = [
   '__proto__',
   'constructor',
   'prototype',
   'toString',
   'valueOf',
   '__defineGetter__',
   'hasOwnProperty',
   'isPrototypeOf',
];

/**
 * Builds the expected result of a resolution that found a value.
 * @param {*} value - The resolved value.
 * @returns {{found: true, value: *}} The expected resolution.
 */
function found(value) {
   return {
      found: true,
      value,
   };
}

/**
 * The expected result of a resolution that found nothing.
 * @type {{found: false}}
 */
const NOT_FOUND = { found: false };

/**
 * Builds a synthetic actor export with embedded items, in the canonical shape (ids kept).
 * @returns {Record<string, any>} A fresh export that tests may read without sharing state.
 */
function makeExport() {
   return {
      _id: 'ACTOR0000000001',
      name: 'MOCK_ACTOR',
      system: {
         attributes: {
            hp: {
               value: 7,
               max: 10,
            },
         },
         traits: {
            languages: {
               value: ['common', 'elvish'],
            },
         },
         zero: 0,
         empty: '',
         nothing: null,
      },
      items: [
         {
            _id: 'ITEM00000000001',
            name: 'MOCK_ITEM_1',
            system: { uses: { value: 1 } },
         },
         {
            _id: 'ITEM00000000002',
            name: 'MOCK_ITEM_2',
            system: { uses: { value: 2 } },
         },
         {
            _id: 'ITEM00000000003',
            name: 'MOCK_ITEM_3',
         },
      ],
      effects: [],
   };
}

/**
 * Measures a message in UTF-8 bytes.
 * @param {string} message - The text to measure.
 * @returns {number} Size of the text once encoded.
 */
function byteLength(message) {
   return ENCODER.encode(message).length;
}

/**
 * Parses and resolves in one step.
 * @param {Record<string, any>} doc - The export to read.
 * @param {string} path - Dotted path text to parse and resolve.
 * @returns {{found: boolean, value?: any, code?: string}} Whether the path resolved and what it resolved to.
 */
function run(doc, path) {
   return resolvePath(doc, parsePath(path).segments);
}

describe('parsePath', () => {
   it('splits a dotted path into key segments', () => {
      expect(parsePath('system.attributes.hp')).toEqual({
         ok: true,
         segments: [
            {
               type: 'key',
               name: 'system',
            },
            {
               type: 'key',
               name: 'attributes',
            },
            {
               type: 'key',
               name: 'hp',
            },
         ],
      });
   });

   it('parses a single wildcard segment', () => {
      expect(parsePath('items.*.name')).toEqual({
         ok: true,
         segments: [
            {
               type: 'key',
               name: 'items',
            },
            { type: 'wildcard' },
            {
               type: 'key',
               name: 'name',
            },
         ],
      });
   });

   it.each(INHERITED_NAMES)('refuses the Object.prototype member %s anywhere in the path', (name) => {
      for (const path of [name, `${name}.x`, `system.${name}`, `system.${name}.x`, `items.*.${name}`]) {
         const result = parsePath(path);
         expect(result.ok).toBe(false);
         expect(result.error.code).toBe('PATH_UNSAFE_SEGMENT');
         expect(result.error.message).toContain(name);
         expect(byteLength(result.error.message)).toBeLessThanOrEqual(getBudget('PATH_ERROR_MAX_BYTES').value);
      }
   });

   it('matches Object.prototype member names exactly, not as substrings', () => {
      expect(parsePath('system.constructors.prototypes').ok).toBe(true);
      expect(parsePath('my__proto__').ok).toBe(true);
      expect(parsePath('toStrings.valueOfs').ok).toBe(true);
   });

   it('refuses a second wildcard', () => {
      const result = parsePath('items.*.system.*');
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PATH_INVALID');
   });

   it.each(['', '.', 'a..b', '.a', 'a.', 42, null, undefined, {}])('refuses the malformed path %j', (path) => {
      const result = parsePath(path);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PATH_INVALID');
   });

   it('treats a partial wildcard such as it* as a plain key', () => {
      expect(parsePath('it*').segments).toEqual([
         {
            type: 'key',
            name: 'it*',
         },
      ]);
   });

   it('cannot address a key that contains a literal dot: the dot always splits segments', () => {
      expect(parsePath('flags.a.b').segments.map((segment) => segment.name)).toEqual(['flags', 'a', 'b']);
      expect(run({ flags: { 'a.b': 1 } }, 'flags.a.b')).toEqual(NOT_FOUND);
   });

   it('accepts a path of exactly PATH_BYTES_MAX bytes and refuses one more with PATH_LIMIT', () => {
      const max = getBudget('PATH_BYTES_MAX').value;
      expect(parsePath('a'.repeat(max)).ok).toBe(true);
      const result = parsePath('a'.repeat(max + 1));
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PATH_LIMIT');
   });

   it('measures the path limit in UTF-8 bytes, not characters', () => {
      const max = getBudget('PATH_BYTES_MAX').value;
      const twoByte = 'é'.repeat(max / 2 + 1);
      expect(twoByte.length).toBeLessThan(max);
      expect(parsePath(twoByte).error.code).toBe('PATH_LIMIT');
   });

   it('accepts exactly PATH_SEGMENTS_MAX segments and refuses one more with PATH_LIMIT', () => {
      const max = getBudget('PATH_SEGMENTS_MAX').value;
      expect(parsePath(Array.from({ length: max }, () => 'a').join('.')).ok).toBe(true);
      const result = parsePath(Array.from({ length: max + 1 }, () => 'a').join('.'));
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PATH_LIMIT');
   });

   it('refuses a multi-megabyte path with PATH_LIMIT and a bounded message', () => {
      const result = parsePath('a'.repeat(4 * 1024 * 1024));
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PATH_LIMIT');
      expect(byteLength(result.error.message)).toBeLessThanOrEqual(getBudget('PATH_ERROR_MAX_BYTES').value);
   });

   it('refuses a 10,000-segment path with PATH_LIMIT', () => {
      const result = parsePath(Array.from({ length: 10000 }, () => 'a').join('.'));
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PATH_LIMIT');
   });

   it('checks the byte limit before anything else: an over-long path with an unsafe segment is a limit error', () => {
      const result = parsePath(`__proto__.${'a'.repeat(getBudget('PATH_BYTES_MAX').value)}`);
      expect(result.error.code).toBe('PATH_LIMIT');
   });
});

describe('resolvePath', () => {
   it('resolves dot segments over objects', () => {
      expect(run(makeExport(), 'system.attributes.hp')).toEqual(
         found({
            value: 7,
            max: 10,
         }),
      );
      expect(run(makeExport(), 'system.attributes.hp.max')).toEqual(found(10));
   });

   it('finds falsy leaves: 0, empty string and null', () => {
      expect(run(makeExport(), 'system.zero')).toEqual(found(0));
      expect(run(makeExport(), 'system.empty')).toEqual(found(''));
      expect(run(makeExport(), 'system.nothing')).toEqual(found(null));
   });

   it('resolves an embedded document by _id, not by array order', () => {
      expect(run(makeExport(), 'items.ITEM00000000002.name')).toEqual(found('MOCK_ITEM_2'));
      expect(run(makeExport(), 'items.ITEM00000000003.name')).toEqual(found('MOCK_ITEM_3'));
   });

   it('resolves the plan example items.<id>.system.uses', () => {
      expect(run(makeExport(), 'items.ITEM00000000001.system.uses')).toEqual(found({ value: 1 }));
   });

   it('resolves a plain array element by integer index', () => {
      expect(run(makeExport(), 'system.traits.languages.value.0')).toEqual(found('common'));
      expect(run(makeExport(), 'system.traits.languages.value.1')).toEqual(found('elvish'));
   });

   it('resolves an embedded document by index on read', () => {
      expect(run(makeExport(), 'items.1.name')).toEqual(found('MOCK_ITEM_2'));
   });

   it('resolves a digit-only _id outside the index range by _id', () => {
      const doc = {
         items: [
            {
               _id: '123456',
               name: 'A',
            },
            {
               _id: 'b',
               name: 'B',
            },
         ],
      };
      expect(run(doc, 'items.123456.name')).toEqual(found('A'));
   });

   it('reports missing keys, ids, out-of-range indexes and non-canonical indexes as not found', () => {
      const doc = makeExport();
      for (const path of [
         'system.nope',
         'nope.x',
         'items.NOSUCHID.name',
         'items.3.name',
         'items.-1.name',
         'items.01.name',
         'items.1.5.name',
         'system.attributes.hp.max.deeper',
         'items.ITEM00000000003.system.uses',
         'name.length',
         'items.length',
      ]) {
         expect(run(doc, path)).toEqual(NOT_FOUND);
      }
   });

   it('steps only own properties, never inherited ones, even for hand-built segments', () => {
      const doc = makeExport();
      for (const name of ['toString', 'hasOwnProperty', 'valueOf', 'map']) {
         expect(resolvePath(doc, [{ type: 'key', name }])).toEqual(NOT_FOUND);
         expect(resolvePath(doc.items, [{ type: 'key', name }])).toEqual(NOT_FOUND);
      }
   });

   it('reports a path ambiguous between an index and another element _id as not found', () => {
      const doc = {
         items: [{ _id: 'a' }, { _id: '0' }],
      };
      expect(run(doc, 'items.0._id')).toEqual(NOT_FOUND);
      expect(run({ items: [{ _id: '0' }, { _id: 'b' }] }, 'items.0._id')).toEqual(found('0'));
   });

   it('reads an own _id only: an inherited _id does not name an element', () => {
      const inherited = Object.create({ _id: 'INHERITED' });
      inherited.name = 'X';
      expect(resolvePath({ items: [inherited] }, parsePath('items.INHERITED.name').segments)).toEqual(NOT_FOUND);
   });

   it('returns a wildcard over an embedded collection keyed by _id', () => {
      expect(run(makeExport(), 'items.*.name')).toEqual(
         found({
            ITEM00000000001: 'MOCK_ITEM_1',
            ITEM00000000002: 'MOCK_ITEM_2',
            ITEM00000000003: 'MOCK_ITEM_3',
         }),
      );
   });

   it('omits elements the rest of a wildcard path does not resolve for', () => {
      expect(run(makeExport(), 'items.*.system.uses.value')).toEqual(
         found({
            ITEM00000000001: 1,
            ITEM00000000002: 2,
         }),
      );
   });

   it('returns a wildcard over a plain array keyed by index', () => {
      expect(run(makeExport(), 'system.traits.languages.value.*')).toEqual(
         found({
            0: 'common',
            1: 'elvish',
         }),
      );
   });

   it('returns an empty object for a wildcard over an empty collection', () => {
      expect(run(makeExport(), 'effects.*.name')).toEqual(found({}));
   });

   it('reports a wildcard as not found when no element resolves the rest of the path', () => {
      expect(run(makeExport(), 'items.*.nope')).toEqual(NOT_FOUND);
   });

   it('reports a wildcard over a non-array as not found', () => {
      expect(run(makeExport(), 'system.attributes.*')).toEqual(NOT_FOUND);
      expect(run(makeExport(), 'name.*')).toEqual(NOT_FOUND);
   });

   it('keeps an element whose _id is __proto__ as an own key of the wildcard result', () => {
      const doc = {
         items: [
            {
               _id: '__proto__',
               name: 'A',
            },
         ],
      };
      const result = run(doc, 'items.*.name');
      expect(Object.keys(result.value)).toEqual(['__proto__']);
      expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
   });

   it('reports a wildcard as ambiguous when two resolved elements share an _id', () => {
      const doc = {
         items: [
            {
               _id: 'DUP',
               name: 'A',
            },
            {
               _id: 'DUP',
               name: 'B',
            },
         ],
      };
      expect(run(doc, 'items.*.name')).toEqual({
         found: false,
         code: 'PATH_AMBIGUOUS',
      });
   });

   it('reports a wildcard as ambiguous when an element without _id collides with another element _id', () => {
      const doc = {
         items: [
            {
               _id: '1',
               name: 'A',
            },
            { name: 'B' },
         ],
      };
      expect(run(doc, 'items.*.name')).toEqual({
         found: false,
         code: 'PATH_AMBIGUOUS',
      });
   });

   it('does not call elements that collide only through an unresolved path ambiguous', () => {
      const doc = {
         items: [
            {
               _id: 'DUP',
               name: 'A',
            },
            { _id: 'DUP' },
         ],
      };
      expect(run(doc, 'items.*.name')).toEqual(found({ DUP: 'A' }));
   });

   it('ignores a non-own _id when keying a wildcard result', () => {
      const inherited = Object.create({ _id: 'INHERITED' });
      inherited.name = 'X';
      expect(run({ items: [inherited] }, 'items.*.name')).toEqual(found({ 0: 'X' }));
   });

   it('resolves a deep path iteratively without recursion per segment', () => {
      let deep = { leaf: 'end' };
      for (let depth = 0; depth < 50000; depth++) {
         deep = { a: deep };
      }
      const segments = Array.from({ length: 50000 }, () => ({
         type: 'key',
         name: 'a',
      }));
      segments.push({
         type: 'key',
         name: 'leaf',
      });
      expect(resolvePath(deep, segments)).toEqual(found('end'));
   });

   it('treats a second wildcard in hand-built segments as not found instead of recursing', () => {
      const doc = {
         rows: [[1], [2]],
      };
      const segments = [
         {
            type: 'key',
            name: 'rows',
         },
         { type: 'wildcard' },
         { type: 'wildcard' },
      ];
      expect(resolvePath(doc, segments)).toEqual(NOT_FOUND);
   });
});

describe('resolvePaths', () => {
   it('returns values keyed by path and an empty missing list', () => {
      const result = resolvePaths(makeExport(), ['system.attributes.hp.max', 'name']);
      expect(result).toEqual({
         ok: true,
         values: {
            'system.attributes.hp.max': 10,
            name: 'MOCK_ACTOR',
         },
         missing: [],
      });
   });

   it('lists missing paths in request order and keeps them out of values', () => {
      const result = resolvePaths(makeExport(), ['name', 'system.nope', 'items.NOSUCHID.name', 'system.zero']);
      expect(result).toEqual({
         ok: true,
         values: {
            name: 'MOCK_ACTOR',
            'system.zero': 0,
         },
         missing: ['system.nope', 'items.NOSUCHID.name'],
      });
   });

   it('returns ok with every path missing', () => {
      expect(resolvePaths(makeExport(), ['a', 'b.c'])).toEqual({
         ok: true,
         values: {},
         missing: ['a', 'b.c'],
      });
   });

   it('resolves a wildcard path to a keyed object', () => {
      const result = resolvePaths(makeExport(), ['items.*.name']);
      expect(result.values['items.*.name']).toEqual({
         ITEM00000000001: 'MOCK_ITEM_1',
         ITEM00000000002: 'MOCK_ITEM_2',
         ITEM00000000003: 'MOCK_ITEM_3',
      });
   });

   it('lists an ambiguous wildcard path as missing', () => {
      const doc = {
         items: [
            {
               _id: 'DUP',
               name: 'A',
            },
            {
               _id: 'DUP',
               name: 'B',
            },
         ],
      };
      expect(resolvePaths(doc, ['items.*.name'])).toEqual({
         ok: true,
         values: {},
         missing: ['items.*.name'],
      });
   });

   it('reads each repeated path once and keeps the first occurrence', () => {
      const result = resolvePaths(makeExport(), ['name', 'system.nope', 'name', 'system.nope', 'system.zero']);
      expect(result).toEqual({
         ok: true,
         values: {
            name: 'MOCK_ACTOR',
            'system.zero': 0,
         },
         missing: ['system.nope'],
      });
   });

   it('refuses the whole call when any path has an unsafe segment, returning no values', () => {
      const result = resolvePaths(makeExport(), ['name', 'system.__proto__.polluted']);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PATH_UNSAFE_SEGMENT');
      expect(result.error.message).toContain('__proto__');
      expect(result.values).toBeUndefined();
   });

   it.each(['toString', 'valueOf', '__defineGetter__'])('refuses the inherited member %s on the read path', (name) => {
      for (const path of [`${name}.x`, `system.${name}`, name]) {
         const result = resolvePaths(makeExport(), ['name', path]);
         expect(result.ok).toBe(false);
         expect(result.error.code).toBe('PATH_UNSAFE_SEGMENT');
         expect(result.values).toBeUndefined();
      }
   });

   it('refuses the whole call when any path is malformed', () => {
      expect(resolvePaths(makeExport(), ['name', 'a..b']).error.code).toBe('PATH_INVALID');
   });

   it('accepts the maximum number of paths and refuses one more', () => {
      const max = getBudget('PATHS_PER_CALL_MAX').value;
      const paths = Array.from({ length: max }, () => 'name');
      expect(resolvePaths(makeExport(), paths).ok).toBe(true);
      const over = resolvePaths(makeExport(), [...paths, 'name']);
      expect(over.ok).toBe(false);
      expect(over.error.code).toBe('PATH_LIMIT');
   });

   it('refuses a paths argument that is not an array of strings', () => {
      expect(resolvePaths(makeExport(), 'name').error.code).toBe('PATH_INVALID');
      expect(resolvePaths(makeExport(), []).error.code).toBe('PATH_INVALID');
   });

   it('refuses an over-long path without echoing it', () => {
      const result = resolvePaths(makeExport(), ['a'.repeat(4 * 1024 * 1024)]);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PATH_LIMIT');
      expect(byteLength(JSON.stringify(result))).toBeLessThanOrEqual(getBudget('PATH_ERROR_MAX_BYTES').value + 64);
   });

   it('keeps every echoed path within PATH_BYTES_MAX', () => {
      const max = getBudget('PATH_BYTES_MAX').value;
      const longest = 'a'.repeat(max);
      const result = resolvePaths(makeExport(), [longest]);
      expect(result.missing).toEqual([longest]);
      expect(byteLength(result.missing[0])).toBeLessThanOrEqual(max);
   });
});

describe('groupWrites', () => {
   /**
    * The embedded collection names of the synthetic document.
    * @type {string[]}
    */
   const COLLECTIONS = ['items', 'effects'];

   it('puts paths on the document itself in the document group', () => {
      const result = groupWrites([{ path: 'system.attributes.hp.value', value: 3 }], COLLECTIONS);
      expect(result).toEqual({
         ok: true,
         document: [
            {
               path: 'system.attributes.hp.value',
               value: 3,
               op: 'set',
            },
         ],
         embedded: [],
      });
   });

   it('groups embedded paths per collection and per embedded id, relative to the embedded document', () => {
      const result = groupWrites(
         [
            { path: 'items.ITEM1.system.uses.value', value: 2 },
            { path: 'name', value: 'MOCK_RENAMED' },
            { path: 'items.ITEM2.name', value: 'MOCK_B', op: 'replace' },
            { path: 'items.ITEM1.name', value: 'MOCK_A' },
            { path: 'effects.EFF1.disabled', value: true },
         ],
         COLLECTIONS,
      );
      expect(result).toEqual({
         ok: true,
         document: [
            {
               path: 'name',
               value: 'MOCK_RENAMED',
               op: 'set',
            },
         ],
         embedded: [
            {
               collection: 'items',
               entries: [
                  {
                     _id: 'ITEM1',
                     changes: [
                        {
                           path: 'system.uses.value',
                           value: 2,
                           op: 'set',
                        },
                        {
                           path: 'name',
                           value: 'MOCK_A',
                           op: 'set',
                        },
                     ],
                  },
                  {
                     _id: 'ITEM2',
                     changes: [
                        {
                           path: 'name',
                           value: 'MOCK_B',
                           op: 'replace',
                        },
                     ],
                  },
               ],
            },
            {
               collection: 'effects',
               entries: [
                  {
                     _id: 'EFF1',
                     changes: [
                        {
                           path: 'disabled',
                           value: true,
                           op: 'set',
                        },
                     ],
                  },
               ],
            },
         ],
      });
   });

   it('carries the delete op and drops its value', () => {
      const result = groupWrites([{ path: 'items.ITEM1.flags.x', value: 'ignored', op: 'delete' }], COLLECTIONS);
      expect(result.embedded[0].entries[0].changes).toEqual([
         {
            path: 'flags.x',
            op: 'delete',
         },
      ]);
   });

   it('treats a collection name that is not declared embedded as a document path', () => {
      const result = groupWrites([{ path: 'items.ITEM1.name', value: 'x' }], []);
      expect(result.document).toEqual([
         {
            path: 'items.ITEM1.name',
            value: 'x',
            op: 'set',
         },
      ]);
      expect(result.embedded).toEqual([]);
   });

   it('names the collection, not the document type, in the group', () => {
      const result = groupWrites([{ path: 'items.ITEM1.name', value: 'x' }], COLLECTIONS);
      expect(result.embedded[0].collection).toBe('items');
   });

   it('refuses a wildcard in a write path, in the document and in an embedded path', () => {
      for (const path of ['items.*.name', 'system.*', '*']) {
         const result = groupWrites([{ path, value: 1 }], COLLECTIONS);
         expect(result.ok).toBe(false);
         expect(result.error.code).toBe('PATH_WILDCARD_WRITE');
      }
   });

   it('refuses an unsafe segment in a write path, including in the embedded id position', () => {
      for (const path of ['system.__proto__.x', 'items.__proto__.name', 'items.ITEM1.constructor.x']) {
         const result = groupWrites([{ path, value: 1 }], COLLECTIONS);
         expect(result.ok).toBe(false);
         expect(result.error.code).toBe('PATH_UNSAFE_SEGMENT');
      }
   });

   it.each(['toString', 'valueOf', '__defineGetter__'])('refuses the inherited member %s on the write path', (name) => {
      for (const path of [`${name}.x`, `system.${name}`, `items.ITEM1.${name}.x`, `items.${name}.name`]) {
         const result = groupWrites([{ path, value: 1 }], COLLECTIONS);
         expect(result.ok).toBe(false);
         expect(result.error.code).toBe('PATH_UNSAFE_SEGMENT');
      }
   });

   it('refuses an over-long write path with PATH_LIMIT', () => {
      const result = groupWrites([{ path: 'a'.repeat(4 * 1024 * 1024), value: 1 }], COLLECTIONS);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PATH_LIMIT');
   });

   it('refuses an embedded path that names no field inside the embedded document', () => {
      for (const path of ['items', 'items.ITEM1']) {
         const result = groupWrites([{ path, value: 1 }], COLLECTIONS);
         expect(result.ok).toBe(false);
         expect(result.error.code).toBe('PATH_INVALID');
      }
   });

   it('refuses a numeric second segment on an embedded write: embedded writes address documents by _id', () => {
      for (const path of ['items.0.name', 'items.12.system.uses.value', 'effects.007.disabled']) {
         const result = groupWrites([{ path, value: 1 }], COLLECTIONS);
         expect(result.ok).toBe(false);
         expect(result.error.code).toBe('PATH_INVALID');
         expect(result.error.message).toContain('_id');
         expect(byteLength(result.error.message)).toBeLessThanOrEqual(getBudget('PATH_ERROR_MAX_BYTES').value);
      }
   });

   it('accepts a numeric segment beyond the embedded id and an id that only contains digits and letters', () => {
      expect(groupWrites([{ path: 'items.ITEM1.system.list.0', value: 1 }], COLLECTIONS).ok).toBe(true);
      expect(groupWrites([{ path: 'items.1a2b.name', value: 1 }], COLLECTIONS).ok).toBe(true);
   });

   it('does not treat a numeric second segment of a non-embedded path as an embedded index', () => {
      expect(groupWrites([{ path: 'system.list.0', value: 1 }], COLLECTIONS).ok).toBe(true);
   });

   it('refuses an unknown op', () => {
      const result = groupWrites([{ path: 'name', value: 'x', op: 'merge' }], COLLECTIONS);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PATH_INVALID_OP');
   });

   it('refuses the same path twice', () => {
      const result = groupWrites(
         [
            { path: 'name', value: 'a' },
            { path: 'name', value: 'b' },
         ],
         COLLECTIONS,
      );
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PATH_DUPLICATE');
   });

   it('refuses a path that is a prefix of another patch path, in either order', () => {
      for (const [first, second] of [
         ['system.a', 'system.a.b'],
         ['system.a.b', 'system.a'],
         ['items.A.system', 'items.A.system.x'],
         ['items.A.system.x', 'items.A.system'],
      ]) {
         const result = groupWrites(
            [
               { path: first, value: 1 },
               { path: second, value: 2 },
            ],
            COLLECTIONS,
         );
         expect(result.ok).toBe(false);
         expect(result.error.code).toBe('PATH_CONFLICT');
         expect(byteLength(result.error.message)).toBeLessThanOrEqual(getBudget('PATH_ERROR_MAX_BYTES').value);
      }
   });

   it('refuses a prefix conflict even when one of the patches deletes', () => {
      const result = groupWrites(
         [
            { path: 'system.a', op: 'delete' },
            { path: 'system.a.b', value: 2 },
         ],
         COLLECTIONS,
      );
      expect(result.error.code).toBe('PATH_CONFLICT');
   });

   it('accepts sibling paths that only share a string prefix', () => {
      const result = groupWrites(
         [
            { path: 'system.a', value: 1 },
            { path: 'system.ab', value: 2 },
            { path: 'items.A.system', value: 3 },
            { path: 'items.B.system.x', value: 4 },
         ],
         COLLECTIONS,
      );
      expect(result.ok).toBe(true);
   });

   it('refuses an embeddedCollections argument that is not an array of strings without throwing', () => {
      for (const bad of [undefined, null, 'items', { items: true }, [1], ['items', null], [['items']]]) {
         const result = groupWrites([{ path: 'name', value: 'x' }], bad);
         expect(result.ok).toBe(false);
         expect(result.error.code).toBe('PATH_INVALID');
      }
   });

   it('refuses an empty or non-array patch list and a malformed patch', () => {
      expect(groupWrites([], COLLECTIONS).error.code).toBe('PATH_INVALID');
      expect(groupWrites('name', COLLECTIONS).error.code).toBe('PATH_INVALID');
      expect(groupWrites([null], COLLECTIONS).error.code).toBe('PATH_INVALID');
      expect(groupWrites([{ value: 1 }], COLLECTIONS).error.code).toBe('PATH_INVALID');
   });

   it('refuses a set or replace patch without a value but accepts an explicit null', () => {
      expect(groupWrites([{ path: 'name' }], COLLECTIONS).error.code).toBe('PATH_INVALID');
      expect(groupWrites([{ path: 'name', op: 'replace' }], COLLECTIONS).error.code).toBe('PATH_INVALID');
      expect(groupWrites([{ path: 'name', value: null }], COLLECTIONS).ok).toBe(true);
      expect(groupWrites([{ path: 'name', op: 'delete' }], COLLECTIONS).ok).toBe(true);
   });

   it('refuses more patches than the per-call path limit', () => {
      const max = getBudget('PATHS_PER_CALL_MAX').value;
      const patches = Array.from({ length: max + 1 }, (_, index) => ({
         path: `flags.k${index}`,
         value: index,
      }));
      expect(groupWrites(patches, COLLECTIONS).error.code).toBe('PATH_LIMIT');
      expect(groupWrites(patches.slice(0, max), COLLECTIONS).ok).toBe(true);
   });

   describe('unsafe values', () => {
      /**
       * Builds an object that has an own data property with the given key, the way `JSON.parse` does.
       * @param {string} key - The key to define as an own property.
       * @param {*} value - The value stored under the key.
       * @returns {Record<string, any>} The object.
       */
      function withOwnKey(key, value) {
         return JSON.parse(`{${JSON.stringify(key)}: ${JSON.stringify(value)}}`);
      }

      it.each(['__proto__', 'constructor', 'prototype'])('refuses a value with an own key named %s', (key) => {
         const result = groupWrites([{ path: 'flags.x', value: withOwnKey(key, { polluted: true }) }], COLLECTIONS);
         expect(result.ok).toBe(false);
         expect(result.error.code).toBe('PATH_UNSAFE_VALUE');
         expect(byteLength(result.error.message)).toBeLessThanOrEqual(getBudget('PATH_ERROR_MAX_BYTES').value);
      });

      it('finds the key nested in objects and in arrays', () => {
         const nested = {
            a: [
               1,
               {
                  b: withOwnKey('__proto__', 1),
               },
            ],
         };
         const result = groupWrites([{ path: 'flags.x', value: nested }], COLLECTIONS);
         expect(result.error.code).toBe('PATH_UNSAFE_VALUE');
      });

      it('checks embedded writes and replace ops too', () => {
         const value = withOwnKey('__proto__', 1);
         expect(groupWrites([{ path: 'items.A.flags', value }], COLLECTIONS).error.code).toBe('PATH_UNSAFE_VALUE');
         expect(groupWrites([{ path: 'flags.x', value, op: 'replace' }], COLLECTIONS).error.code).toBe(
            'PATH_UNSAFE_VALUE',
         );
      });

      it('ignores the value of a delete', () => {
         const value = withOwnKey('__proto__', 1);
         const result = groupWrites([{ path: 'flags.x', value, op: 'delete' }], COLLECTIONS);
         expect(result.ok).toBe(true);
      });

      it('accepts a value whose keys merely resemble unsafe names', () => {
         const value = {
            constructors: 1,
            my__proto__: 2,
            toString: 3,
         };
         expect(groupWrites([{ path: 'flags.x', value }], COLLECTIONS).ok).toBe(true);
      });

      it('accepts a value nested exactly 32 levels deep and refuses one more level', () => {
         const build = (levels) => {
            let value = { leaf: 1 };
            for (let level = 1; level < levels; level++) {
               value = { next: value };
            }
            return value;
         };
         expect(groupWrites([{ path: 'flags.x', value: build(32) }], COLLECTIONS).ok).toBe(true);
         const result = groupWrites([{ path: 'flags.x', value: build(33) }], COLLECTIONS);
         expect(result.ok).toBe(false);
         expect(result.error.code).toBe('PATH_UNSAFE_VALUE');
      });

      it('terminates on a cyclic value', () => {
         const cyclic = {};
         cyclic.self = cyclic;
         expect(groupWrites([{ path: 'flags.x', value: cyclic }], COLLECTIONS).ok).toBe(true);
      });
   });
});

describe('error messages', () => {
   it('stay within PATH_ERROR_MAX_BYTES for every failing input', () => {
      const hugePath = 'a'.repeat(4 * 1024 * 1024);
      const manySegments = Array.from({ length: 10000 }, () => 'a').join('.');
      /**
       * Calls that each fail with an error message.
       * @type {Array<() => {ok: boolean, error?: {code: string, message: string}}>}
       */
      const failing = [
         () => parsePath(''),
         () => parsePath(42),
         () => parsePath('a..b'),
         () => parsePath('*.*'),
         () => parsePath('__proto__'),
         () => parsePath('system.hasOwnProperty'),
         () => parsePath(hugePath),
         () => parsePath(manySegments),
         () => resolvePaths({}, 'name'),
         () => resolvePaths({}, []),
         () => resolvePaths({}, Array.from({ length: 21 }, () => 'a')),
         () => resolvePaths({}, [hugePath]),
         () => groupWrites('x', []),
         () => groupWrites([], []),
         () => groupWrites([{ path: 'a', value: 1 }], undefined),
         () => groupWrites([null], []),
         () => groupWrites([{ path: 'a', value: 1, op: 'x'.repeat(100000) }], []),
         () => groupWrites([{ path: 'a' }], []),
         () => groupWrites([{ path: 'a.*', value: 1 }], []),
         () => groupWrites([{ path: hugePath, value: 1 }], []),
         () => groupWrites([{ path: manySegments, value: 1 }], []),
         () => groupWrites([{ path: 'items', value: 1 }], ['items']),
         () => groupWrites([{ path: 'items.0.name', value: 1 }], ['items']),
         () => groupWrites(
            [
               { path: 'a', value: 1 },
               { path: 'a', value: 1 },
            ],
            [],
         ),
         () => groupWrites(
            [
               { path: 'a', value: 1 },
               { path: 'a.b', value: 1 },
            ],
            [],
         ),
         () => groupWrites([{ path: 'a', value: JSON.parse('{"__proto__": 1}') }], []),
      ];
      expect(failing.length).toBeGreaterThan(20);
      for (const attempt of failing) {
         const result = attempt();
         expect(result.ok).toBe(false);
         expect(byteLength(result.error.message)).toBeLessThanOrEqual(getBudget('PATH_ERROR_MAX_BYTES').value);
      }
   });
});
