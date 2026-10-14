import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { guardWrite } from '~/bridge/scripts/writeGuard.js';
import {
   analyzeChanges,
   containsEmbedded,
   reachesEmbedded,
   walkEmbedded,
} from '~/bridge/scripts/writeFields.js';
import { replaceDocument } from '~/bridge/scripts/writeReplace.js';
import { createDocuments, updateDocuments } from '~/bridge/scripts/writes.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

beforeEach(() => {
   world = installWriteWorld(vi.fn, { userId: 'MOCKGM0000000001' });
   gates = {};
   globalThis.game.settings.get = (module, key) => gates[key];
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
 * Build a forced deletion.
 * @returns {object} The operator.
 */
function deletion() {
   return new foundry.data.operators.ForcedDeletion();
}

/**
 * Build a forced replacement.
 * @param {unknown} value - The new value.
 * @returns {object} The operator.
 */
function replacement(value) {
   return foundry.data.operators.ForcedReplacement.create(value);
}

/**
 * Nest a leaf field in plain schema fields.
 * @param {number} levels - How many schema fields wrap the leaf.
 * @param {object} leaf - The innermost field.
 * @returns {object} The outermost schema field.
 */
function nested(levels, leaf) {
   const { SchemaField } = foundry.data.fields;
   let field = leaf;
   for (let level = 0; level < levels; level += 1) {
      field = new SchemaField({ child: field });
   }
   return field;
}

describe('a path below a system data model of an unknown type', () => {
   it('fails closed when the document has no type, and does not when it has one', () => {
      const typed = world.add('Actor', {
         name: 'MOCK_typed',
         type: 'npc',
      });
      const untyped = world.add('Actor', { name: 'MOCK_untyped' });
      const changes = { system: { hp: deletion() } };
      expect(analyzeChanges(typed, changes).operations.size).toBe(0);
      expect(analyzeChanges(untyped, changes).operations).toEqual(
         new Set([
            'delete',
         ]),
      );
   });
});

describe('the depth bounds fail closed', () => {
   it('containsEmbedded answers true for a schema nested deeper than it will walk', () => {
      const { DataField, EmbeddedDataField, SchemaField } = foundry.data.fields;
      expect(containsEmbedded(nested(10, new DataField()), 'npc')).toBe(false);
      expect(containsEmbedded(nested(80, new DataField()), 'npc')).toBe(true);
      expect(containsEmbedded(nested(3, new EmbeddedDataField({ schema: new SchemaField({}) })), 'npc')).toBe(true);
   });

   it('reachesEmbedded answers true for a path through more embedded models than it will follow', () => {
      const { DataField, EmbeddedDataField, SchemaField } = foundry.data.fields;
      /**
       * Build a chain of embedded models, each holding the next under `child`.
       * @param {number} depth - How many models.
       * @returns {{ schema: object }} The outermost model.
       */
      const chain = (depth) => {
         let model = { schema: new SchemaField({ leaf: new DataField() }) };
         for (let level = 0; level < depth; level += 1) {
            model = { schema: new SchemaField({ child: new EmbeddedDataField(model) }) };
         }
         return model;
      };
      const names = (depth) => [
         ...Array.from({ length: depth }, () => 'child'),
         'leaf',
      ];
      expect(reachesEmbedded(chain(3), {}, names(3))).toBe(false);
      expect(reachesEmbedded(chain(80), {}, names(80))).toBe(true);
   });
});

describe('analyzeChanges walks the value of an operator', () => {
   it('finds an operator nested in a replacement, below a field of a kind it cannot enumerate', () => {
      const { DataField, EmbeddedCollectionField, SchemaField } = foundry.data.fields;
      /** The children of this field are reachable only through `_getField`, as a system's custom field may do. */
      class OpaqueField extends DataField {
         /** @override */
         _getField(parts, options) {
            if (parts.length === 0) {
               return this;
            }
            return new EmbeddedCollectionField(world.classes.Item)._getField(parts, options);
         }
      }
      const document = {
         constructor: { schema: new SchemaField({ opaque: new OpaqueField() }) },
         _source: {},
      };
      expect(analyzeChanges(document, { opaque: replacement({ docs: deletion() }) }).operations).toEqual(
         new Set([
            'delete',
         ]),
      );
      expect(analyzeChanges(document, { opaque: replacement({ docs: 1 }) }).operations.size).toBe(0);
   });
});

describe('analyzeChanges finds the flag scope at any depth', () => {
   it('flags an operator on the flags of an embedded document, in an array or an object', () => {
      const scene = world.add('Scene', { name: 'MOCK_scene' });
      const token = world.addChild(scene, 'Token', { name: 'MOCK_token' });
      for (const changes of [
         { delta: { items: [{ _id: 'MOCKITEM00000001', flags: deletion() }] } },
         { delta: { flags: replacement({}) } },
         { delta: { flags: { wiretap: deletion() } } },
         { delta: { flags: 'text' } },
      ]) {
         expect(analyzeChanges(token, changes).reservedFlags, JSON.stringify(changes)).toBe(true);
      }
      expect(analyzeChanges(token, { delta: { flags: { other: replacement({}) } } }).reservedFlags).toBe(false);
      expect(analyzeChanges(token, { delta: { items: [{ _id: 'MOCKITEM00000001', name: 'x' }] } }).reservedFlags)
         .toBe(false);
   });
});

describe('guardWrite judges the cleaned targets by themselves', () => {
   it('refuses the flag scope in a target even when the raw values hold nothing', () => {
      const actor = world.add('Actor', {
         name: 'MOCK_actor',
         type: 'npc',
      });
      expect(() => guardWrite({
         documentName: 'Actor',
         targets: [{
            document: actor,
            changes: { flags: { wiretap: { k: 1 } } },
         }],
      })).toThrow(expect.objectContaining({ code: GATE_DENIED }));
   });
});

describe('cleaning the changes', () => {
   it('turns a cleaning failure into ARGS_INVALID and writes nothing', async () => {
      const actor = world.add('Actor', {
         name: 'MOCK_actor',
         type: 'npc',
      });
      world.classes.Actor.cleanData.mockImplementationOnce(() => {
         throw new Error('cannot clean');
      });
      await expect(updateDocuments({
         updates: [{
            uuid: actor.uuid,
            patches: [{
               path: 'name',
               value: 'MOCK_x',
            }],
         }],
      })).rejects.toMatchObject({ code: 'ARGS_INVALID' });
      expect(actor.update).not.toHaveBeenCalled();
   });
});

describe('an idempotencyKey needs a flags field to carry the record', () => {
   it('is refused for a class whose schema has no flags, instead of losing the record', async () => {
      gates = { allowSettingWrites: true };
      await expect(createDocuments({
         documentName: 'Setting',
         data: [{
            key: 'mock.idem',
            value: '1',
         }],
         idempotencyKey: 'key-one',
      })).rejects.toMatchObject({
         code: 'ARGS_INVALID',
         message: expect.stringContaining('flags'),
      });
      expect(world.calls).toEqual([]);
   });
});

describe('a Setting is judged by the key it leaves', () => {
   it('lets op replace rename a setting to a key outside the Wiretap namespace', async () => {
      gates = { allowSettingWrites: true };
      const setting = world.add('Setting', {
         key: 'mock.thing',
         value: '1',
      });
      await updateDocuments({
         updates: [{
            uuid: setting.uuid,
            patches: [{
               path: 'key',
               op: 'replace',
               value: 'mock.other',
            }],
         }],
      });
      expect(setting.update).toHaveBeenCalledTimes(1);
   });
});

describe('walkEmbedded and containsEmbedded share one traversal', () => {
   it('finds embedded documents under an array field and under a typed-object field', () => {
      const { ArrayField, EmbeddedCollectionField, SchemaField, TypedObjectField } = foundry.data.fields;
      const inner = () => new SchemaField({ docs: new EmbeddedCollectionField(world.classes.Item) });
      const schema = new SchemaField({
         list: new ArrayField(inner()),
         map: new TypedObjectField(inner()),
      });
      expect(containsEmbedded(schema, 'npc')).toBe(true);
      const live = {
         list: [{ docs: [{ _id: 'MOCKITEM00000001' }] }],
         map: {
            a: { docs: [{ _id: 'MOCKITEM00000002' }] },
            b: { docs: [{ _id: 'MOCKITEM00000003' }] },
         },
      };
      /** @type {string[]} The ids visited as dropped. */
      const dropped = [];
      walkEmbedded({ schema }, live, {}, (model, data, matched) => {
         if (data._id !== undefined && matched === undefined) {
            dropped.push(data._id);
         }
      });
      expect(dropped.sort()).toEqual([
         'MOCKITEM00000001',
         'MOCKITEM00000002',
         'MOCKITEM00000003',
      ]);
   });

   it('follows a typed schema only for the type the data names', () => {
      const { EmbeddedCollectionField, SchemaField, TypedSchemaField } = foundry.data.fields;
      const schema = new SchemaField({
         part: new TypedSchemaField({
            a: new SchemaField({ docs: new EmbeddedCollectionField(world.classes.Item) }),
            b: new SchemaField({ docs: new EmbeddedCollectionField(world.classes.ActiveEffect) }),
         }),
      });
      expect(containsEmbedded(schema, 'npc')).toBe(true);
      const live = {
         part: {
            type: 'b',
            docs: [{ _id: 'MOCKEFFECT000001' }],
         },
      };
      /** @type {string[]} The class names of the embedded documents visited. */
      const seen = [];
      walkEmbedded({ schema }, live, undefined, (model) => {
         if (model.documentName !== undefined) {
            seen.push(model.documentName);
         }
      });
      expect(seen).toEqual(['ActiveEffect']);
   });

   it('keeps the documents the replacement still holds under an array field', () => {
      const { ArrayField, EmbeddedCollectionField, SchemaField } = foundry.data.fields;
      const schema = new SchemaField({
         list: new ArrayField(new SchemaField({ docs: new EmbeddedCollectionField(world.classes.Item) })),
      });
      const live = { list: [{ docs: [{ _id: 'MOCKITEM00000001' }, { _id: 'MOCKITEM00000002' }] }] };
      const replacement = { list: [{ docs: [{ _id: 'MOCKITEM00000001' }] }] };
      /** @type {string[]} The ids with no matching replacement. */
      const dropped = [];
      walkEmbedded({ schema }, live, replacement, (model, data, matched) => {
         if (data._id !== undefined && matched === undefined) {
            dropped.push(data._id);
         }
      });
      expect(dropped).toEqual(['MOCKITEM00000002']);
   });

   it('fails closed on data nested deeper than it will follow, with a refusal', () => {
      const { DataField } = foundry.data.fields;
      let live = {};
      for (let level = 0; level < 80; level += 1) {
         live = { child: live };
      }
      expect(() => walkEmbedded({ schema: nested(80, new DataField()) }, live, {}, () => undefined)).toThrow(
         expect.objectContaining({ code: 'ARGS_INVALID' }),
      );
    });
});

describe('walkEmbedded', () => {
   it('finds embedded collections inside a plain schema field and inside the system data model', () => {
      const { EmbeddedCollectionField, SchemaField } = foundry.data.fields;
      const model = {
         documentName: 'Host',
         schema: new SchemaField({
            type: new foundry.data.fields.DataField(),
            group: new SchemaField({ docs: new EmbeddedCollectionField(world.classes.Item) }),
            system: new foundry.data.fields.TypeDataField(() => ({
               schema: new SchemaField({ more: new EmbeddedCollectionField(world.classes.ActiveEffect) }),
            })),
         }),
      };
      const live = {
         type: 'npc',
         group: {
            docs: [{
               _id: 'MOCKITEM00000001',
               type: 'weapon',
            }],
         },
         system: { more: [{ _id: 'MOCKEFFECT000001' }] },
      };
      /** @type {string[]} The class names visited, with whether a replacement matched. */
      const seen = [];
      walkEmbedded(model, live, undefined, (visited, data, matched) => {
         seen.push(`${visited.documentName}:${matched === undefined ? 'dropped' : 'kept'}`);
      });
      expect(seen).toEqual([
         'Host:dropped',
         'Item:dropped',
         'ActiveEffect:dropped',
      ]);
   });
});

describe('replace_document counts what the schema says it drops', () => {
   it('counts a token delta with its items and effects, and each smaller omission exactly', async () => {
      gates = {
         allowReplace: true,
         allowDelete: true,
      };
      const scene = world.add('Scene', {
         _id: 'MOCKSCENE0000001',
         name: 'MOCK_scene',
      });
      world.addChild(scene, 'Token', {
         _id: 'MOCKTOKEN0000001',
         name: 'MOCK_token',
         delta: {
            _id: 'MOCKTOKEN0000001',
            name: 'MOCK_delta',
            items: [{
               _id: 'MOCKDELTAITEM001',
               name: 'MOCK_item',
            }],
            effects: [{
               _id: 'MOCKDELTAEFFECT1',
               name: 'MOCK_effect',
            }],
         },
      });
      const full = () => {
         const data = structuredClone(scene.toObject());
         delete data._id;
         return data;
      };
      /**
       * Preview a replacement of the scene and return how many documents it drops.
       * @param {(data: Record<string, any>) => void} change - Edits the full data.
       * @returns {Promise<number | undefined>} The `dropped` count of the ack.
       */
      const dropped = async (change) => {
         const data = full();
         change(data);
         return (await replaceDocument({
            uuid: scene.uuid,
            data,
            dryRun: true,
         })).dropped;
      };
      expect(await dropped(() => undefined)).toBeUndefined();
      expect(await dropped((data) => delete data.tokens[0].delta.items)).toBe(1);
      expect(await dropped((data) => delete data.tokens[0].delta.effects)).toBe(1);
      expect(await dropped((data) => delete data.tokens[0].delta)).toBe(3);
      expect(await dropped((data) => delete data.tokens)).toBe(4);
   });
});
