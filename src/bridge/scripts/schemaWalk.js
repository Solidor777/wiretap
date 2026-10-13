/**
 * The schema field walker behind `describe_schema`. It reads Foundry's DataField objects by their class name chain and
 * public properties, so it works on the real classes and on stand-ins with the same names. Every output is bounded by
 * construction: a depth limit, a node limit, a cycle guard and capped lists. Free-form fields (ObjectField, AnyField,
 * JSONField, TypedObjectField and their subclasses) are marked instead of expanded, embedded collections and documents
 * are referred to by document name instead of inlined, and a TypeDataField is resolved by the requested subtype.
 */

import { cleanForLog } from '$shared/logText.js';
import { truncateUtf8 } from '$shared/utf8.js';
import { USER_EXCLUDED_FIELDS } from '~/bridge/scripts/canonical.js';

/**
 * Deepest nesting the walker expands below the described field; a container at this depth is marked `more`.
 * @type {number}
 */
export const SCHEMA_DEPTH_MAX = 3;

/**
 * Most nodes one walk describes; the walk is marked cut when it stops there.
 * @type {number}
 */
export const SCHEMA_NODES_MAX = 150;

/**
 * Most entries of an outline.
 * @type {number}
 */
export const OUTLINE_MAX = 80;

/**
 * Most choices listed for one field; the rest are counted in `choicesMore`.
 * @type {number}
 */
const CHOICES_MAX = 16;

/**
 * Longest choice shown, in UTF-8 bytes.
 * @type {number}
 */
const CHOICE_MAX_BYTES = 32;

/**
 * Most file categories or typed-schema type names listed.
 * @type {number}
 */
const NAMES_MAX = 12;

/**
 * Longest segment echoed in an error, in UTF-8 bytes.
 * @type {number}
 */
const ECHO_MAX_BYTES = 48;

/**
 * How the walker treats each field class. A field takes the kind of the first class name in its prototype chain that
 * is listed here (the most derived wins), so a subclass such as EmbeddedCollectionDeltaField (an
 * EmbeddedCollectionField) or TypedObjectField (an ObjectField) needs no entry; any other field is a leaf that only
 * reports its class and constraints.
 * @type {Readonly<Record<string, 'collection' | 'document' | 'typeData' | 'free' | 'array' | 'typed' | 'schema'>>}
 */
const KIND_BY_CLASS = Object.freeze({
   EmbeddedCollectionField: 'collection',
   EmbeddedDocumentField: 'document',
   TypeDataField: 'typeData',
   ObjectField: 'free',
   AnyField: 'free',
   JSONField: 'free',
   SetField: 'array',
   ArrayField: 'array',
   TypedSchemaField: 'typed',
   SchemaField: 'schema',
});

/**
 * @typedef {object} WalkState
 * @property {string} documentName - The described document class.
 * @property {string | undefined} subtype - The subtype used to resolve a TypeDataField.
 * @property {number} depthMax - The deepest level expanded.
 * @property {number} nodesMax - The most nodes described.
 * @property {number} nodes - The nodes described so far.
 * @property {boolean} cut - Whether the walk stopped at a limit.
 * @property {Set<object>} seen - The schemas being expanded now, for the cycle guard.
 * @property {boolean} topLevel - Whether the first field walked is the document's own schema, whose excluded fields
 * are skipped.
 */

/**
 * Create the state of one walk.
 * @param {object} options - The class, subtype, limits and top-level flag of the walk.
 * @param {string} options.documentName - The described document class.
 * @param {string} [options.subtype] - The subtype that resolves a TypeDataField.
 * @param {number} [options.depthMax] - The deepest level expanded; defaults to `SCHEMA_DEPTH_MAX`.
 * @param {number} [options.nodesMax] - The most nodes described; defaults to `SCHEMA_NODES_MAX`.
 * @param {boolean} [options.topLevel] - Whether the first field walked is the document's own schema.
 * @returns {WalkState} A fresh state with no nodes described.
 */
export function createWalkState({
   documentName,
   subtype,
   depthMax = SCHEMA_DEPTH_MAX,
   nodesMax = SCHEMA_NODES_MAX,
   topLevel = false,
}) {
   return {
      documentName,
      subtype,
      depthMax,
      nodesMax,
      nodes: 0,
      cut: false,
      seen: new Set(),
      topLevel,
   };
}

/**
 * Name the class of a field.
 * @param {object} field - A Foundry DataField or a stand-in.
 * @returns {string} Its constructor name.
 */
function classOf(field) {
   return typeof field?.constructor?.name === 'string' ? field.constructor.name : 'DataField';
}

/**
 * Find the kind of a field from its prototype chain.
 * @param {object} field - A Foundry DataField or a stand-in.
 * @returns {string} The kind, or `leaf`.
 */
function kindOf(field) {
   /** @type {object | null} The prototype being examined. */
   let proto = Object.getPrototypeOf(field);
   while (proto !== null && proto !== Object.prototype) {
      /** @type {string} The class name at this level. */
      const name = proto.constructor?.name;
      if (typeof name === 'string' && Object.hasOwn(KIND_BY_CLASS, name)) {
         return KIND_BY_CLASS[name];
      }
      proto = Object.getPrototypeOf(proto);
   }
   return 'leaf';
}

/**
 * Whether a field of the described document's own schema is excluded from every output.
 * @param {WalkState} state - The walk state.
 * @param {string} name - The field name.
 * @returns {boolean} True for a User password field at the top of the User schema.
 */
function excluded(state, name) {
   return state.topLevel && state.documentName === 'User' && USER_EXCLUDED_FIELDS.includes(name);
}

/**
 * Whether a segment is refused as unsafe.
 * @param {string} name - The segment or field name.
 * @returns {boolean} True for `prototype` and members of `Object.prototype`.
 */
function unsafe(name) {
   return name === 'prototype' || name in Object.prototype;
}

/**
 * Read the document name a field refers to.
 * @param {object} field - A TypeDataField.
 * @returns {string | undefined} The document name, when the field refers to one.
 */
function referencedDocument(field) {
   /** @type {unknown} The name found on the element or the model. */
   const name = field.element?.documentName ?? field.model?.documentName;
   return typeof name === 'string' ? name : undefined;
}

/**
 * Find the schema that describes the `system` of the walked subtype.
 * @param {object} field - A TypeDataField.
 * @param {WalkState} state - The walk state.
 * @returns {{ fields: Record<string, object> } | undefined} The schema, when the subtype registered a data model.
 */
function typeSchema(field, state) {
   /** @type {string} The document class whose data models apply. */
   const documentName =
      typeof field.document?.documentName === 'string' ? field.document.documentName : state.documentName;
   /** @type {unknown} The subtype's schema. */
   const schema = globalThis.CONFIG?.[documentName]?.dataModels?.[state.subtype]?.schema;
   return schema !== null && typeof schema === 'object' && typeof schema.fields === 'object' ? schema : undefined;
}

/**
 * Normalize the choices of a field into a short list.
 * @param {unknown} choices - The field's `choices`.
 * @param {Record<string, unknown>} node - The node to add `choices` and `choicesMore` to.
 * @returns {void}
 */
function addChoices(choices, node) {
   if (typeof choices === 'function') {
      node.choices = 'dynamic';
      return;
   }
   if (choices === null || typeof choices !== 'object') {
      return;
   }
   /** @type {unknown[]} The choice values: array entries or object keys. */
   const values = Array.isArray(choices) ? choices : Object.keys(choices);
   node.choices = values.slice(0, CHOICES_MAX).map((value) => truncateUtf8(String(value), CHOICE_MAX_BYTES));
   if (values.length > CHOICES_MAX) {
      node.choicesMore = values.length - CHOICES_MAX;
   }
}

/**
 * Add the constraints a field declares to its node. Only constraints that are set appear.
 * @param {object} field - A Foundry DataField or a stand-in.
 * @param {Record<string, unknown>} node - The node that receives the constraints.
 * @returns {void}
 */
function addConstraints(field, node) {
   for (const flag of [
      'required',
      'nullable',
      'readonly',
      'blank',
      'integer',
      'positive',
   ]) {
      if (field[flag] === true) {
         node[flag] = true;
      }
   }
   for (const bound of [
      'min',
      'max',
      'step',
   ]) {
      if (Number.isFinite(field[bound])) {
         node[bound] = field[bound];
      }
   }
   addChoices(field.choices, node);
   if (Array.isArray(field.categories)) {
      node.categories = field.categories
         .slice(0, NAMES_MAX)
         .map((category) => truncateUtf8(String(category), CHOICE_MAX_BYTES));
   }
}

/**
 * Describe the children of a schema into `node.fields`, stopping at the node limit.
 * @param {Record<string, object>} fields - The child fields by name.
 * @param {Record<string, unknown>} node - The node to fill.
 * @param {WalkState} state - The walk state.
 * @param {number} depth - The level of the parent.
 * @returns {void}
 */
function addChildren(fields, node, state, depth) {
   /** @type {Record<string, unknown>} The described children. */
   const children = {};
   for (const [name, child] of Object.entries(fields)) {
      if (depth === 0 && excluded(state, name)) {
         continue;
      }
      if (state.nodes >= state.nodesMax) {
         state.cut = true;
         break;
      }
      Object.defineProperty(children, name, {
         value: describeField(child, state, depth + 1),
         enumerable: true,
         writable: true,
         configurable: true,
      });
   }
   node.fields = children;
}

/**
 * Describe one field and, within the limits, its children.
 * @param {object} field - A Foundry DataField or a stand-in.
 * @param {WalkState} state - The walk state.
 * @param {number} [depth] - The level of the field; the walked root is 0.
 * @returns {Record<string, unknown>} The node: its class, the constraints that are set and its children or reference.
 */
export function describeField(field, state, depth = 0) {
   /** @type {Record<string, unknown>} The node under construction. */
   const node = { class: classOf(field) };
   if (state.nodes >= state.nodesMax) {
      state.cut = true;
      return node;
   }
   state.nodes += 1;
   /** @type {string} How the field is treated. */
   const kind = kindOf(field);
   if (kind !== 'typeData') {
      addConstraints(field, node);
   } else {
      for (const flag of [
         'required',
         'nullable',
      ]) {
         if (field[flag] === true) {
            node[flag] = true;
         }
      }
   }
   /** @type {string | undefined} The document name the field refers to. */
   const reference = referencedDocument(field);
   if (kind === 'free') {
      node.free = true;
      /** @type {string} The element class of a typed object. */
      const element = field.element !== null && typeof field.element === 'object' ? classOf(field.element) : '';
      if (element !== '' && element !== 'Object') {
         node.element = element;
      }
   } else if (kind === 'collection' || kind === 'document') {
      if (reference !== undefined) {
         node.document = reference;
      }
   } else if (kind === 'typed') {
      node.free = true;
      node.types = Object.keys(field.types ?? {}).slice(0, NAMES_MAX);
   } else if (kind === 'array') {
      if (depth >= state.depthMax) {
         node.more = true;
      } else {
         node.element = describeField(field.element, state, depth + 1);
      }
   } else if (kind === 'typeData') {
      node.type = state.subtype;
      /** @type {{ fields: Record<string, object> } | undefined} The subtype's schema. */
      const schema = typeSchema(field, state);
      if (schema === undefined) {
         node.free = true;
      } else if (depth >= state.depthMax) {
         node.more = true;
      } else if (state.seen.has(schema)) {
         node.cycle = true;
      } else {
         state.seen.add(schema);
         addChildren(schema.fields, node, state, depth);
         state.seen.delete(schema);
      }
   } else if (kind === 'schema') {
      if (state.seen.has(field)) {
         node.cycle = true;
      } else if (depth >= state.depthMax) {
         node.more = true;
      } else {
         state.seen.add(field);
         addChildren(field.fields ?? {}, node, state, depth);
         state.seen.delete(field);
      }
   } else if (reference !== undefined) {
      node.document = reference;
   }
   return node;
}

/**
 * List the fields of a schema one level deep as `[name, class]`, with the referenced document name as a third entry
 * for a collection, document or foreign key.
 * @param {{ fields: Record<string, object> }} schema - A SchemaField.
 * @param {WalkState} state - The walk state; its `topLevel` flag skips the excluded fields of a User.
 * @returns {Array<[string, string] | [string, string, string]>} At most `OUTLINE_MAX` entries.
 */
export function outlineFields(schema, state) {
   /** @type {Array<[string, string] | [string, string, string]>} The outline entries in schema order. */
   const entries = [];
   for (const [name, field] of Object.entries(schema?.fields ?? {})) {
      if (excluded(state, name)) {
         continue;
      }
      if (entries.length >= OUTLINE_MAX) {
         break;
      }
      /** @type {string | undefined} The document the field refers to. */
      const reference = referencedDocument(field);
      entries.push(reference === undefined ? [
         name,
         classOf(field),
      ] : [
         name,
         classOf(field),
         reference,
      ]);
   }
   return entries;
}

/**
 * @typedef {{ ok: true, field: object } | { ok: false, code: string, message: string }} StepOutcome
 */

/**
 * The segments that address an element of a list: an integer index without a leading zero, or `*` for every element.
 * @type {RegExp}
 */
const LIST_SEGMENT = /^(?:0|[1-9]\d*|\*)$/;

/**
 * Move from a field to the child a path segment names.
 * @param {object} field - The field to step into.
 * @param {string} segment - The path segment.
 * @param {WalkState} state - The walk state; its subtype resolves a TypeDataField.
 * @returns {StepOutcome} The child field, or the coded refusal.
 */
export function stepInto(field, segment, state) {
   /**
    * Build a refusal.
    * @param {string} code - The error code.
    * @param {string} message - The refusal text.
    * @returns {StepOutcome} The refusal.
    */
   const refuse = (code, message) => ({
      ok: false,
      code,
      message,
   });
   /** @type {string} The segment as shown in an error. */
   const shown = cleanForLog(segment, ECHO_MAX_BYTES);
   if (unsafe(segment)) {
      return refuse('PATH_UNSAFE_SEGMENT', `The segment '${shown}' is not allowed.`);
   }
   /** @type {string} How the field is treated. */
   const kind = kindOf(field);
   if (kind === 'array') {
      if (!LIST_SEGMENT.test(segment) || field.element === undefined) {
         return refuse('PATH_NOT_FOUND', `There is no element '${shown}' in this list; use an index or '*'.`);
      }
      return {
         ok: true,
         field: field.element,
      };
   }
   if (kind === 'collection' || kind === 'document') {
      return refuse(
         'PATH_EMBEDDED',
         `This is an embedded ${referencedDocument(field) ?? 'document'}; describe that class instead.`,
      );
   }
   if (kind === 'free' || kind === 'typed') {
      return refuse('PATH_FREE_FORM', `The field holds free-form data; nothing below '${shown}' is described.`);
   }
   /** @type {Record<string, object> | undefined} The children to choose from. */
   let children;
   if (kind === 'typeData') {
      children = typeSchema(field, state)?.fields;
      if (children === undefined) {
         return refuse('PATH_FREE_FORM', `The field holds free-form data; nothing below '${shown}' is described.`);
      }
   } else if (kind === 'schema') {
      children = field.fields;
   }
   if (children === undefined) {
      return refuse('PATH_NOT_FOUND', `There is no field below a ${classOf(field)} to look up '${shown}'.`);
   }
   if (segment === '*') {
      return refuse('PATH_INVALID', 'A wildcard is only allowed after a list.');
   }
   if (!Object.hasOwn(children, segment)) {
      return refuse('PATH_NOT_FOUND', `There is no field '${shown}' here.`);
   }
   return {
      ok: true,
      field: children[segment],
   };
}
