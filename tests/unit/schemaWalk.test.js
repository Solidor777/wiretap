import { describe, it, expect, afterEach } from 'vitest';
import {
   SCHEMA_DEPTH_MAX,
   SCHEMA_NODES_MAX,
   createWalkState,
   describeField,
   outlineFields,
   stepInto,
} from '~/bridge/scripts/schemaWalk.js';
import * as F from './mockFields.js';

afterEach(() => {
   delete globalThis.CONFIG;
});

/**
 * Describe a field with a fresh walk state.
 * @param {object} field - A mock field instance.
 * @param {object} [options] - Walk state options.
 * @returns {{ node: any, state: any }} The node and the state used.
 */
function walk(field, options = {}) {
   const state = createWalkState({
      documentName: 'Actor',
      subtype: 'player',
      ...options,
   });
   return {
      node: describeField(field, state, 0),
      state,
   };
}

describe('describeField: leaf classes and constraints', () => {
   it('reports the class and only the constraints that are set', () => {
      expect(walk(new F.StringField({
         required: true,
         blank: true,
         nullable: true,
      })).node).toEqual({
         class: 'StringField',
         required: true,
         nullable: true,
         blank: true,
      });
      expect(walk(new F.StringField()).node).toEqual({ class: 'StringField' });
      expect(
         walk(new F.NumberField({
            min: 0,
            max: 10,
            integer: true,
            step: 1,
            positive: true,
            required: true,
         })).node,
      ).toEqual({
         class: 'NumberField',
         required: true,
         integer: true,
         positive: true,
         min: 0,
         max: 10,
         step: 1,
      });
      expect(walk(new F.BooleanField({ required: true })).node).toEqual({
         class: 'BooleanField',
         required: true,
      });
   });

   it('lists choices from an array or an object, marks a function as dynamic and caps the list', () => {
      expect(walk(new F.StringField({ choices: [
         'a',
         'b',
      ] })).node.choices).toEqual([
         'a',
         'b',
      ]);
      expect(walk(new F.NumberField({ choices: {
         1: 'One',
         2: 'Two',
      } })).node.choices).toEqual([
         '1',
         '2',
      ]);
      expect(walk(new F.StringField({ choices: () => ['x'] })).node.choices).toBe('dynamic');
      const choices = Array.from({ length: 40 }, (_, index) => `choice${index}`);
      const many = walk(new F.StringField({ choices })).node;
      expect(many.choices).toHaveLength(16);
      expect(many.choicesMore).toBe(24);
      expect(walk(new F.StringField({ choices: ['x'.repeat(100)] })).node.choices[0].length).toBeLessThanOrEqual(32);
   });

   it('keeps the class of every specialised string and id field, with categories for a file path', () => {
      for (const name of [
         'DocumentIdField',
         'DocumentUUIDField',
         'ColorField',
         'HTMLField',
      ]) {
         expect(walk(new F[name]()).node).toEqual({ class: name });
      }
      expect(walk(new F.FilePathField({ categories: [
         'IMAGE',
         'AUDIO',
      ] })).node).toEqual({
         class: 'FilePathField',
         categories: [
            'IMAGE',
            'AUDIO',
         ],
      });
      const foreign = new F.ForeignDocumentField();
      foreign.model = { documentName: 'Actor' };
      expect(walk(foreign).node).toEqual({
         class: 'ForeignDocumentField',
         document: 'Actor',
      });
   });

   it('treats a subclass of a known class by the nearest known ancestor', () => {
      class CustomNumber extends F.NumberField {}
      expect(walk(new CustomNumber({ min: 1 })).node).toEqual({
         class: 'CustomNumber',
         min: 1,
      });
      class CustomSchema extends F.SchemaField {}
      expect(walk(new CustomSchema({ a: new F.BooleanField() })).node.fields.a).toEqual({ class: 'BooleanField' });
   });
});

describe('describeField: free-form fields are marked, never expanded', () => {
   it('marks ObjectField, AnyField, JSONField, TypedObjectField and DocumentFlagsField free-form', () => {
      for (const name of [
         'ObjectField',
         'AnyField',
         'JSONField',
         'TypedObjectField',
         'DocumentFlagsField',
      ]) {
         const node = walk(new F[name]()).node;
         expect(node.class).toBe(name);
         expect(node.free).toBe(true);
         expect(node.fields).toBeUndefined();
      }
   });

   it('names the element class of a typed object and the types of a typed schema field', () => {
      expect(walk(new F.TypedObjectField({}, {})).node.free).toBe(true);
      const typed = new F.TypedObjectField();
      typed.element = new F.NumberField();
      expect(walk(typed).node.element).toBe('NumberField');
      const schemaTyped = new F.TypedSchemaField();
      schemaTyped.types = {
         one: new F.SchemaField({}),
         two: new F.SchemaField({}),
      };
      expect(walk(schemaTyped).node).toEqual({
         class: 'TypedSchemaField',
         free: true,
         types: [
            'one',
            'two',
         ],
      });
   });
});

describe('describeField: containers and references', () => {
   it('expands a SchemaField into its children and an ArrayField or SetField into its element', () => {
      const field = new F.SchemaField({
         hp: new F.SchemaField({ value: new F.NumberField({ integer: true }) }),
         tags: new F.SetField(new F.StringField()),
         list: new F.ArrayField(new F.NumberField()),
      });
      const node = walk(field).node;
      expect(node.fields.hp.fields.value).toEqual({
         class: 'NumberField',
         integer: true,
      });
      expect(node.fields.tags).toEqual({
         class: 'SetField',
         element: { class: 'StringField' },
      });
      expect(node.fields.list.element.class).toBe('NumberField');
   });

   it('refers to embedded collections and documents by document name instead of inlining them', () => {
      const collection = new F.EmbeddedCollectionField({ documentName: 'Item' });
      const delta = new F.EmbeddedCollectionDeltaField({ documentName: 'Item' });
      const embedded = new F.EmbeddedDocumentField({}, { required: true });
      embedded.model = { documentName: 'ActorDelta' };
      embedded.fields = { huge: new F.StringField() };
      expect(walk(collection).node).toEqual({
         class: 'EmbeddedCollectionField',
         document: 'Item',
      });
      expect(walk(delta).node).toEqual({
         class: 'EmbeddedCollectionDeltaField',
         document: 'Item',
      });
      expect(walk(embedded).node).toEqual({
         class: 'EmbeddedDocumentField',
         required: true,
         document: 'ActorDelta',
      });
   });

   it('resolves a TypeDataField by subtype from the registered data models', () => {
      globalThis.CONFIG = {
         Actor: {
            dataModels: {
               player: { schema: new F.SchemaField({ xp: new F.NumberField({ min: 0 }) }) },
            },
         },
      };
      const field = new F.TypeDataField();
      field.document = { documentName: 'Actor' };
      const node = walk(field, { subtype: 'player' }).node;
      expect(node).toEqual({
         class: 'TypeDataField',
         type: 'player',
         fields: {
            xp: {
               class: 'NumberField',
               min: 0,
            },
         },
      });
      expect(walk(field, { subtype: 'npc' }).node).toEqual({
         class: 'TypeDataField',
         type: 'npc',
         free: true,
      });
   });

   it('guards schema cycles', () => {
      const loop = new F.SchemaField({});
      loop.fields.self = loop;
      loop.fields.leaf = new F.BooleanField();
      const node = walk(loop).node;
      expect(node.fields.leaf.class).toBe('BooleanField');
      expect(node.fields.self).toEqual({
         class: 'SchemaField',
         cycle: true,
      });
   });

   it('stops expanding at the depth limit and says there is more', () => {
      let schema = new F.BooleanField();
      for (let level = 0; level < 10; level += 1) {
         schema = new F.SchemaField({ next: schema });
      }
      const node = walk(schema).node;
      let depth = 0;
      let cursor = node;
      while (cursor.fields?.next !== undefined) {
         cursor = cursor.fields.next;
         depth += 1;
      }
      expect(depth).toBeLessThanOrEqual(SCHEMA_DEPTH_MAX);
      expect(cursor.more).toBe(true);
   });

   it('stops at the node limit however wide the schema is and marks the walk cut', () => {
      const wide = new F.SchemaField(
         Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
            `f${index}`,
            new F.StringField(),
         ])),
      );
      /** @type {{ node: any, state: any }} The node and the walk state. */
      const { node, state } = walk(wide);
      expect(state.nodes).toBeLessThanOrEqual(SCHEMA_NODES_MAX);
      expect(state.cut).toBe(true);
      expect(Object.keys(node.fields).length).toBeLessThanOrEqual(SCHEMA_NODES_MAX);
   });

   it('leaves out the password fields of a User at the top of the document only', () => {
      const user = new F.SchemaField({
         name: new F.StringField(),
         password: new F.StringField(),
         passwordSalt: new F.StringField(),
         permissions: new F.SchemaField({ password: new F.BooleanField() }),
      });
      /** @type {{ node: any }} The described node. */
      const { node } = walk(user, {
         documentName: 'User',
         topLevel: true,
      });
      expect(Object.keys(node.fields)).toEqual([
         'name',
         'permissions',
      ]);
      expect(node.fields.permissions.fields.password.class).toBe('BooleanField');
      const actor = walk(user, {
         documentName: 'Actor',
         topLevel: true,
      }).node;
      expect(Object.keys(actor.fields)).toContain('password');
   });
});

describe('outlineFields', () => {
   it('lists the name and class of each field, with the document name of a reference', () => {
      const schema = new F.SchemaField({
         name: new F.StringField(),
         items: new F.EmbeddedCollectionField({ documentName: 'Item' }),
         system: new F.TypeDataField(),
         flags: new F.DocumentFlagsField(),
      });
      const state = createWalkState({
         documentName: 'Actor',
         subtype: 'player',
      });
      expect(outlineFields(schema, state)).toEqual([
         [
            'name',
            'StringField',
         ],
         [
            'items',
            'EmbeddedCollectionField',
            'Item',
         ],
         [
            'system',
            'TypeDataField',
         ],
         [
            'flags',
            'DocumentFlagsField',
         ],
      ]);
   });

   it('skips the excluded fields of a User and caps the list', () => {
      const user = new F.SchemaField({
         password: new F.StringField(),
         passwordSalt: new F.StringField(),
         ...Object.fromEntries(Array.from({ length: 200 }, (_, index) => [
            `f${index}`,
            new F.StringField(),
         ])),
      });
      const outline = outlineFields(
         user,
         createWalkState({
            documentName: 'User',
            subtype: 'base',
            topLevel: true,
         }),
      );
      expect(outline.map((entry) => entry[0])).not.toContain('password');
      expect(outline.map((entry) => entry[0])).not.toContain('passwordSalt');
      expect(outline.length).toBeLessThanOrEqual(80);
   });
});

describe('stepInto', () => {
   const state = () =>
      createWalkState({
         documentName: 'Actor',
         subtype: 'player',
      });

   it('moves through schema children, array elements and a resolved TypeDataField', () => {
      globalThis.CONFIG = {
         Actor: { dataModels: { player: { schema: new F.SchemaField({ xp: new F.NumberField() }) } } },
      };
      const typeData = new F.TypeDataField();
      typeData.document = { documentName: 'Actor' };
      const root = new F.SchemaField({
         system: typeData,
         tags: new F.ArrayField(new F.StringField()),
      });
      const system = stepInto(root, 'system', state());
      expect(system.ok).toBe(true);
      expect(stepInto(system.field, 'xp', state()).field.constructor.name).toBe('NumberField');
      expect(stepInto(root.fields.tags, '0', state()).field.constructor.name).toBe('StringField');
      expect(stepInto(root.fields.tags, '*', state()).ok).toBe(true);
      expect(stepInto(root.fields.tags, '12', state()).ok).toBe(true);
   });

   it('accepts only an integer index or a wildcard below a list', () => {
      const tags = new F.ArrayField(new F.StringField());
      for (const segment of [
         'name',
         'abc',
         '1.5',
         '-1',
         '01',
         '1e3',
         ' 1',
         '',
      ]) {
         expect(stepInto(tags, segment, state()), segment).toMatchObject({
            ok: false,
            code: 'PATH_NOT_FOUND',
         });
      }
   });

   it('refuses a step below a list that has no element field instead of returning an undefined field', () => {
      const bare = new F.ArrayField(new F.StringField());
      bare.element = undefined;
      expect(stepInto(bare, '0', state())).toMatchObject({
         ok: false,
         code: 'PATH_NOT_FOUND',
      });
   });

   it('refuses a missing field, an unsafe name, a free-form field and an embedded collection', () => {
      const root = new F.SchemaField({
         flags: new F.DocumentFlagsField(),
         items: new F.EmbeddedCollectionField({ documentName: 'Item' }),
      });
      expect(stepInto(root, 'nope', state())).toMatchObject({
         ok: false,
         code: 'PATH_NOT_FOUND',
      });
      expect(stepInto(root, '__proto__', state())).toMatchObject({
         ok: false,
         code: 'PATH_UNSAFE_SEGMENT',
      });
      expect(stepInto(root, 'constructor', state())).toMatchObject({
         ok: false,
         code: 'PATH_UNSAFE_SEGMENT',
      });
      expect(stepInto(root.fields.flags, 'x', state())).toMatchObject({
         ok: false,
         code: 'PATH_FREE_FORM',
      });
      expect(stepInto(root.fields.items, '0', state())).toMatchObject({
         ok: false,
         code: 'PATH_EMBEDDED',
      });
      expect(stepInto(root, 'hasOwnProperty', state()).ok).toBe(false);
   });
});
