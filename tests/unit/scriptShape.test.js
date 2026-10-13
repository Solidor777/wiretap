import { describe, it, expect } from 'vitest';
import { getBudget } from '$shared/budgets.js';
import { shape } from '~/bridge/scripts/shape.js';

/** @type {TextEncoder} Measures serialized sizes in UTF-8 bytes. */
const ENCODER = new TextEncoder();

/**
 * Measure a value as the serialized text a tool returns.
 * @param {unknown} value - The value to measure.
 * @returns {number} The UTF-8 byte length of its JSON.
 */
function bytes(value) {
   return ENCODER.encode(JSON.stringify(value)).length;
}

/**
 * Build a synthetic actor export (MOCK_ data only) with embedded items.
 * @param {object} [options] - Fixture options.
 * @param {number} [options.items] - How many embedded items to include.
 * @param {number} [options.nameLength] - The length each item name is padded to.
 * @param {boolean} [options.shortNames] - Whether item names are the short `i<index>` form.
 * @returns {object} The export: uuid, name, type, a system tree and an `items` collection.
 */
function mockActor({ items = 120, nameLength = 9, shortNames = false } = {}) {
   return {
      _id: 'MOCKACTOR0000001',
      uuid: 'Actor.MOCKACTOR0000001',
      name: 'MOCK_Actor',
      type: 'character',
      system: {
         attributes: {
            hp: {
               value: 31,
               max: 40,
            },
            level: 7,
            speed: 30,
            notes: 'MOCK_notes',
         },
         details: {
            biography: 'MOCK_bio',
            alignment: 'neutral',
         },
      },
      items: Array.from({ length: items }, (_, index) => ({
         _id: `MOCKITEM${String(index).padStart(8, '0')}`,
         name: shortNames ? `i${index}` : `MOCK_item_${String(index).padStart(3, '0')}`.padEnd(nameLength, 'x'),
         type: index % 2 === 0 ? 'weapon' : 'armor',
         system: { quantity: index },
      })),
      effects: [],
   };
}

describe('shape.compact', () => {
   it('returns uuid, name and type, the key leaves and the capped tuples with the total', () => {
      const view = shape.compact(mockActor({ shortNames: true }));
      expect(view.uuid).toBe('Actor.MOCKACTOR0000001');
      expect(view.name).toBe('MOCK_Actor');
      expect(view.type).toBe('character');
      expect(view.fields['system.attributes.hp.value']).toBe(31);
      expect(view.fields['system.attributes.hp.max']).toBe(40);
      expect(view.fields['system.attributes.level']).toBe(7);
      expect(view.embedded.items.total).toBe(120);
      expect(view.embedded.items.rows).toHaveLength(getBudget('COMPACT_EMBEDDED_TUPLES_MAX').value);
      expect(view.embedded.items.rows[0]).toEqual([
         'MOCKITEM00000000',
         'i0',
         'weapon',
      ]);
   });

   it('shows fewer than 40 tuples when long names would take the view past 2 KB, and says so', () => {
      const view = shape.compact(mockActor({ items: 120, nameLength: 18 }));
      expect(view.embedded.items.rows.length).toBeLessThan(40);
      expect(view.embedded.items.rows.length).toBeGreaterThanOrEqual(30);
      expect(view.embedded.items.total).toBe(120);
      expect(view.cut).toBe(true);
      expect(bytes(view)).toBeLessThanOrEqual(getBudget('COMPACT_VIEW_MAX_BYTES').value);
   });

   it('holds 120 embedded items to 40 tuples and 2 KB', () => {
      const view = shape.compact(mockActor({ items: 120, shortNames: true }));
      expect(view.embedded.items.rows).toHaveLength(40);
      expect(view.embedded.items.total).toBe(120);
      expect(bytes(view)).toBeLessThanOrEqual(getBudget('COMPACT_VIEW_MAX_BYTES').value);
   });

   it('shows every tuple and no cap marker for a small collection', () => {
      const view = shape.compact(mockActor({ items: 3 }));
      expect(view.embedded.items.rows).toHaveLength(3);
      expect(view.embedded.items.total).toBe(3);
      expect(view.cut).toBeUndefined();
   });

   it('lists an empty collection with its zero total and no rows', () => {
      const view = shape.compact(mockActor({ items: 0 }), { embedded: ['items'] });
      expect(view.embedded.items).toEqual({
         total: 0,
         rows: [],
      });
   });

   it('stays within 2 KB when every field is at its longest', () => {
      const long = 'M'.repeat(1000);
      const actor = mockActor({ items: 500, nameLength: 500 });
      actor.uuid = `Actor.${long}`;
      actor.name = long;
      actor.type = long;
      actor.system = Object.fromEntries(
         Array.from({ length: 60 }, (_, index) => [
            `value${index}`,
            long,
         ]),
      );
      actor.items.forEach((item) => {
         item._id = long;
         item.type = long;
      });
      const view = shape.compact(actor, { keyPattern: /^value\d+$/ });
      expect(bytes(view)).toBeLessThanOrEqual(getBudget('COMPACT_VIEW_MAX_BYTES').value);
      expect(view.cut).toBe(true);
      expect(view.embedded.items.total).toBe(500);
   });

   it('caps the tuples at 40 in all, across collections, and reports each total', () => {
      const actor = mockActor({ items: 30, shortNames: true });
      actor.effects = Array.from({ length: 30 }, (_, index) => ({
         _id: `MOCKEFFECT${index}`,
         name: `e${index}`,
         type: 'base',
      }));
      const view = shape.compact(actor);
      expect(view.embedded.items.rows).toHaveLength(30);
      expect(view.embedded.effects.rows).toHaveLength(10);
      expect(view.embedded.items.total).toBe(30);
      expect(view.embedded.effects.total).toBe(30);
   });

   it('limits the leaves to 24 matching the key pattern', () => {
      const actor = mockActor({ items: 0 });
      actor.system = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`value${index}`, index]));
      const view = shape.compact(actor, { keyPattern: /^value\d+$/ });
      expect(Object.keys(view.fields)).toHaveLength(24);
      expect(Object.keys(view.fields)[0]).toBe('system.value0');
   });

   it('takes only scalar leaves and skips arrays, objects and keys that do not match', () => {
      const actor = mockActor({ items: 0 });
      actor.system = {
         value: { nested: 1 },
         max: [
            1,
            2,
         ],
         level: null,
         rank: 'MOCK',
         other: 5,
      };
      const view = shape.compact(actor, { keyPattern: /^(value|max|level|rank)$/ });
      expect(view.fields).toEqual({ 'system.rank': 'MOCK' });
   });

   it('truncates long strings and names', () => {
      const actor = mockActor({ items: 1 });
      actor.name = 'N'.repeat(500);
      actor.system = { value: 'V'.repeat(500) };
      actor.items[0].name = 'I'.repeat(500);
      const view = shape.compact(actor, { keyPattern: /^value$/ });
      expect(view.name.length).toBeLessThan(80);
      expect(view.fields['system.value'].length).toBeLessThan(80);
      expect(view.embedded.items.rows[0][1].length).toBeLessThan(40);
   });

   it('enters the system tree to level 6 and no deeper', () => {
      const actor = mockActor({ items: 0 });
      actor.system = { a: { b: { c: { d: { e: { value: 1, f: { value: 2 } } } } } } };
      expect(shape.compact(actor, { keyPattern: /^value$/ }).fields).toEqual({ 'system.a.b.c.d.e.value': 1 });
   });

   it('leaves out a leaf whose path is over 96 characters', () => {
      const actor = mockActor({ items: 0 });
      const long = 'k'.repeat(50);
      actor.system = { [long]: { [long]: { value: 1 } }, value: 2 };
      expect(shape.compact(actor, { keyPattern: /^value$/ }).fields).toEqual({ 'system.value': 2 });
   });

   it('visits at most 2000 objects of the system tree', () => {
      const actor = mockActor({ items: 0 });
      const system = Object.fromEntries(Array.from({ length: 2500 }, (_, index) => [`n${index}`, { x: 1 }]));
      system.n2400 = { value: 9 };
      actor.system = system;
      expect(shape.compact(actor, { keyPattern: /^value$/ }).fields).toBeUndefined();
      system.n5 = { value: 8 };
      expect(shape.compact(actor, { keyPattern: /^value$/ }).fields).toEqual({ 'system.n5.value': 8 });
   });

   it('accepts a global key pattern without skipping matches', () => {
      const actor = mockActor({ items: 0 });
      actor.system = { value0: 0, value1: 1, value2: 2, value3: 3 };
      const view = shape.compact(actor, { keyPattern: /^value\d$/g });
      expect(Object.keys(view.fields)).toEqual(['system.value0', 'system.value1', 'system.value2', 'system.value3']);
   });

   it('trims the larger of the leaves and the tuples first, keeping some of each', () => {
      const actor = mockActor({ items: 3, shortNames: true });
      actor.system = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`value${index}`, 'V'.repeat(60)]));
      const view = shape.compact(actor, { keyPattern: /^value\d+$/ });
      expect(view.cut).toBe(true);
      expect(view.embedded.items.rows).toHaveLength(3);
      expect(Object.keys(view.fields).length).toBeGreaterThan(5);
      expect(Object.keys(view.fields).length).toBeLessThan(24);
      expect(bytes(view)).toBeLessThanOrEqual(getBudget('COMPACT_VIEW_MAX_BYTES').value);
   });

   it('terminates on a cyclic or very deep system tree', () => {
      const actor = mockActor({ items: 0 });
      const cyclic = { value: 1 };
      cyclic.self = cyclic;
      actor.system = cyclic;
      expect(shape.compact(actor, { keyPattern: /^value$/ }).fields).toEqual({ 'system.value': 1 });
      let deep = { value: 2 };
      for (let index = 0; index < 5000; index += 1) {
         deep = { down: deep };
      }
      actor.system = deep;
      expect(shape.compact(actor, { keyPattern: /^value$/ }).fields).toBeUndefined();
   });

   it('does not read inherited properties or throw for a missing or hostile document', () => {
      expect(shape.compact(null)).toEqual({});
      expect(shape.compact('text')).toEqual({});
      const hostile = {
         get uuid() {
            throw new Error('boom');
         },
      };
      expect(() => shape.compact(hostile)).not.toThrow();
      const inherited = Object.create({
         name: 'inherited',
         type: 'npc',
      });
      expect(shape.compact(inherited)).toEqual({});
   });

   it('includes the default key leaves for a system tree with common names', () => {
      const view = shape.compact(mockActor({ items: 0 }));
      expect(Object.keys(view.fields).length).toBeGreaterThan(0);
      expect(view.fields['system.attributes.notes']).toBeUndefined();
   });
});

describe('shape.compact: the size bound holds for any data', () => {
   /** @type {number} The view budget. */
   const budget = getBudget('COMPACT_VIEW_MAX_BYTES').value;

   it('lists as many 18-character-name tuples as the budget holds and marks the view cut', () => {
      const view = shape.compact(mockActor({ items: 120, nameLength: 18 }));
      const rows = view.embedded.items.rows;
      // 35 of the 40 allowed tuples fit with 18-character names; 40 fit only with short names.
      expect(rows).toHaveLength(35);
      expect(view.embedded.items.total).toBe(120);
      expect(view.cut).toBe(true);
      expect(bytes(view)).toBeLessThanOrEqual(budget);
      /** @type {object} The same view with one more tuple, which the budget cannot hold. */
      const longer = structuredClone(view);
      longer.embedded.items.rows.push(rows.at(-1));
      expect(bytes(longer)).toBeGreaterThan(budget);
   });

   it('caps the collection count and shortens a long collection name', () => {
      const doc = mockActor({ items: 0 });
      for (let index = 0; index < 100; index += 1) {
         doc[`${'long'.repeat(100)}${index}`] = [{ _id: `MOCKITEM${String(index).padStart(8, '0')}` }];
      }
      const view = shape.compact(doc);
      const names = Object.keys(view.embedded);
      expect(names.length).toBeLessThanOrEqual(8);
      expect(names.every((name) => ENCODER.encode(name).length <= 32)).toBe(true);
      expect(view.cut).toBe(true);
      expect(bytes(view)).toBeLessThanOrEqual(budget);
   });

   it('holds many empty collections named by the caller to the bound', () => {
      const doc = mockActor({ items: 0 });
      /** @type {string[]} A thousand collection names. */
      const named = Array.from({ length: 1000 }, (_, index) => {
         doc[`c${index}`] = [];
         return `c${index}`;
      });
      const view = shape.compact(doc, { embedded: named });
      expect(Object.keys(view.embedded)).toHaveLength(8);
      expect(view.cut).toBe(true);
      expect(bytes(view)).toBeLessThanOrEqual(budget);
   });

   it('drops entries down to the header when every part is at its worst, and still fits', () => {
      const doc = {
         uuid: '\u0001'.repeat(96),
         name: '\u0001'.repeat(64),
         type: '\u0001'.repeat(32),
         system: { value: 'x'.repeat(64) },
      };
      for (let index = 0; index < 8; index += 1) {
         doc[`${String.fromCharCode(1).repeat(31)}${index}`] = Array.from({ length: 5 }, () => ({
            _id: '\u0001'.repeat(16),
            name: '\u0001'.repeat(24),
            type: '\u0001'.repeat(16),
         }));
      }
      const view = shape.compact(doc);
      expect(view.cut).toBe(true);
      expect(bytes(view)).toBeLessThanOrEqual(budget);
   });

   it('fits for 200 shapes of random sizes and never throws', () => {
      let seed = 12345;
      const next = (max) => {
         seed = (seed * 1103515245 + 12345) % 2147483648;
         return seed % max;
      };
      for (let round = 0; round < 200; round += 1) {
         const doc = {
            uuid: 'u'.repeat(next(200)),
            name: '\u0002'.repeat(next(100)),
            type: 't'.repeat(next(60)),
            system: Object.fromEntries(
               Array.from({ length: next(40) }, (_, index) => [`value${index}`, 'v'.repeat(next(90))]),
            ),
         };
         for (let index = next(12); index > 0; index -= 1) {
            doc[`"c${'z'.repeat(next(60))}${index}`] = Array.from({ length: next(80) }, () => ({
               _id: 'i'.repeat(next(30)),
               name: '"'.repeat(next(50)),
               type: 'p'.repeat(next(30)),
            }));
         }
         const view = shape.compact(doc, { keyPattern: /^value\d+$/ });
         expect(bytes(view), `round ${round}`).toBeLessThanOrEqual(budget);
      }
   });
});

describe('shape.project', () => {
   it('returns the requested fields in nested form and lists the missing ones', () => {
      const outcome = shape.project(mockActor(), [
         'name',
         'system.attributes.hp.value',
         'system.nope',
         'items.MOCKITEM00000001.name',
      ]);
      expect(outcome).toEqual({
         ok: true,
         value: {
            name: 'MOCK_Actor',
            system: { attributes: { hp: { value: 31 } } },
            items: { MOCKITEM00000001: { name: 'MOCK_item_001' } },
         },
         missing: ['system.nope'],
      });
   });

   it('replaces an earlier narrower field when a wider one follows, and skips a narrower one after a wider', () => {
      const wide = shape.project(mockActor(), [
         'system.attributes.hp.value',
         'system.attributes',
      ]);
      expect(wide.value.system.attributes.level).toBe(7);
      const narrow = shape.project(mockActor(), [
         'system.attributes',
         'system.attributes.hp.value',
      ]);
      expect(narrow.value.system.attributes.level).toBe(7);
      expect(narrow.value.system.attributes.hp).toEqual({
         value: 31,
         max: 40,
      });
   });

   it('refuses a wildcard, an unsafe segment, too many fields and a non-list', () => {
      expect(shape.project(mockActor(), ['items.*.name'])).toMatchObject({
         ok: false,
         error: expect.stringContaining('wildcard'),
      });
      expect(shape.project(mockActor(), ['__proto__.x']).ok).toBe(false);
      expect(shape.project(mockActor(), ['constructor']).ok).toBe(false);
      expect(shape.project(mockActor(), Array.from({ length: 21 }, (_, index) => `system.v${index}`)).ok).toBe(false);
      expect(shape.project(mockActor(), 'name').ok).toBe(false);
      expect(shape.project(mockActor(), []).ok).toBe(false);
      expect(shape.project(mockActor(), [1]).ok).toBe(false);
   });

   it('keeps every error within 256 bytes', () => {
      const outcome = shape.project(mockActor(), ['x'.repeat(10_000)]);
      expect(outcome.ok).toBe(false);
      expect(ENCODER.encode(outcome.error).length).toBeLessThanOrEqual(256);
   });

   it('builds a prototype-safe object', () => {
      const outcome = shape.project(JSON.parse('{"a":{"b":1}}'), ['a.b']);
      expect(Object.getPrototypeOf(outcome.value)).toBe(Object.prototype);
      expect(Object.keys(outcome.value)).toEqual(['a']);
   });

   it('keeps a 10-field projection of the fixture within 1 KB', () => {
      const outcome = shape.project(mockActor(), [
         'name',
         'type',
         'system.attributes.hp.value',
         'system.attributes.hp.max',
         'system.attributes.level',
         'system.attributes.speed',
         'system.details.alignment',
         'items.MOCKITEM00000000.name',
         'items.MOCKITEM00000000.type',
         'items.MOCKITEM00000000.system.quantity',
      ]);
      expect(outcome.ok).toBe(true);
      expect(bytes(outcome.value)).toBeLessThanOrEqual(getBudget('PROJECTION_BYTES_PER_10_FIELDS').value);
   });
});

describe('shape.paths', () => {
   it('returns values keyed by path and the missing paths', () => {
      expect(shape.paths(mockActor({ items: 2 }), ['system.attributes.hp', 'items.*.name', 'nope'])).toEqual({
         ok: true,
         values: {
            'system.attributes.hp': {
               value: 31,
               max: 40,
            },
            'items.*.name': {
               MOCKITEM00000000: 'MOCK_item_000',
               MOCKITEM00000001: 'MOCK_item_001',
            },
         },
         missing: ['nope'],
      });
   });

   it('turns a path error into a bounded text naming the code', () => {
      const outcome = shape.paths(mockActor(), ['a.__proto__']);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/^PATH_UNSAFE_SEGMENT: /);
      expect(ENCODER.encode(outcome.error).length).toBeLessThanOrEqual(256);
      expect(shape.paths(mockActor(), []).ok).toBe(false);
      expect(shape.paths(mockActor(), Array.from({ length: 21 }, () => 'name')).error).toMatch(/PATH_LIMIT/);
   });
});

describe('shape.ack', () => {
   it('returns the scalar fields as given when they fit', () => {
      expect(
         shape.ack({
            uuid: 'Actor.MOCKACTOR0000001',
            name: 'MOCK_Actor',
            type: 'character',
         }),
      ).toEqual({
         uuid: 'Actor.MOCKACTOR0000001',
         name: 'MOCK_Actor',
         type: 'character',
      });
   });

   it('keeps a worst-case ack within 256 bytes', () => {
      const long = '😀'.repeat(5000);
      const ack = shape.ack({
         uuid: long,
         name: long,
         type: long,
         extra: long,
      });
      expect(bytes(ack)).toBeLessThanOrEqual(getBudget('ACK_MAX_BYTES').value);
      expect(Object.keys(ack).length).toBeGreaterThan(0);
   });

   it('drops fields that are not scalars and bounds the key count', () => {
      const ack = shape.ack({
         ok: true,
         count: 3,
         nothing: null,
         list: [1],
         nested: { a: 1 },
         fn: () => 1,
         missing: undefined,
      });
      expect(ack).toEqual({
         ok: true,
         count: 3,
         nothing: null,
      });
      const many = shape.ack(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${index}`, index])));
      expect(Object.keys(many).length).toBeLessThanOrEqual(16);
      expect(bytes(many)).toBeLessThanOrEqual(256);
   });

   it('leaves out keys that are members of Object.prototype', () => {
      const ack = shape.ack({
         toString: 'x',
         valueOf: 1,
         hasOwnProperty: true,
         name: 'ok',
      });
      expect(ack).toEqual({ name: 'ok' });
   });

   it('keeps every field of a long-string ack, shortened, rather than dropping fields', () => {
      const long = 'M'.repeat(5000);
      const ack = shape.ack({
         uuid: long,
         name: long,
         type: long,
         extra: long,
      });
      expect(Object.keys(ack)).toEqual(['uuid', 'name', 'type', 'extra']);
      expect(ack.uuid.endsWith('…')).toBe(true);
   });

   it('drops trailing fields when numbers and keys alone exceed the budget', () => {
      const wide = Object.fromEntries(
         Array.from({ length: 16 }, (_, index) => [
            `${'k'.repeat(30)}${String(index).padStart(2, '0')}`,
            1_000_000 + index,
         ]),
      );
      const ack = shape.ack(wide);
      expect(bytes(ack)).toBeLessThanOrEqual(256);
      expect(Object.keys(ack).length).toBeGreaterThan(0);
      expect(Object.keys(ack).length).toBeLessThan(16);
      expect(Object.keys(ack)[0]).toBe(`${'k'.repeat(30)}00`);
   });

   it('returns an empty ack for a non-object', () => {
      expect(shape.ack(null)).toEqual({});
      expect(shape.ack('text')).toEqual({});
      expect(shape.ack([1])).toEqual({});
   });

   it('is a fresh object with no prototype pollution', () => {
      const input = JSON.parse('{"__proto__":{"x":1},"a":1}');
      const ack = shape.ack(input);
      expect(Object.getPrototypeOf(ack)).toBe(Object.prototype);
      expect(ack.x).toBeUndefined();
   });
});
