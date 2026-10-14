/**
 * Cases for the operator grid, generated from the field schemas of the mock world (never listed by hand), so a field
 * that the schema gains is covered at once. The oracle walks the schema by enumeration; the code under test resolves
 * one path at a time, so the two share no traversal. Not a test file (vitest only collects `*.test.js`).
 */

import { OPERATOR_IDENTIFIER } from '$shared/writeKeys.js';

/**
 * @typedef {object} Target
 * @property {object} root - The live root document a tool addresses.
 * @property {string} path - The patch path, relative to the root (embedded ids included).
 * @property {string[]} names - The segments of the path.
 * @property {'collection' | 'single' | 'contains' | 'element' | 'plain'} kind - What the field is.
 * @property {unknown} sample - A value that fits the field.
 * @property {boolean} [document] - Whether the field holds embedded documents (not a plain embedded data model).
 */

/**
 * Tell whether a field is an embedded document field.
 * @param {object} field - A mock field.
 * @returns {boolean} True for an embedded collection, a single embedded document or data model.
 */
function isEmbedded(field) {
   const { EmbeddedCollectionField, EmbeddedDataField } = foundry.data.fields;
   return field instanceof EmbeddedCollectionField || field instanceof EmbeddedDataField;
}

/**
 * Tell whether a field holds an embedded field anywhere below it.
 * @param {object} field - A mock field.
 * @param {string} type - The document type, for the system data model.
 * @returns {boolean} True when an embedded field is a descendant.
 */
function holdsEmbedded(field, type) {
   const { SchemaField, TypeDataField } = foundry.data.fields;
   if (field instanceof TypeDataField) {
      return holdsEmbedded(field.getModelForType(type).schema, type);
   }
   if (!(field instanceof SchemaField)) {
      return false;
   }
   return Object.values(field.fields).some((child) => isEmbedded(child) || holdsEmbedded(child, type));
}

/**
 * Enumerate the patch targets of a schema, depth first.
 * @param {object} root - The live root document.
 * @param {object} schema - The schema to enumerate (of the root or of an embedded document).
 * @param {string[]} prefix - The segments leading to the schema, element ids included.
 * @param {object} source - The source data of the document the schema belongs to.
 * @param {boolean} top - Whether the schema is the root's own: a top-level collection cannot be addressed by a path.
 * @param {Target[]} out - Receives the targets.
 * @param {boolean} withTop - Whether the top-level collections are listed too (data can carry them, a path cannot).
 * @returns {void}
 */
function enumerate(root, schema, prefix, source, top, out, withTop) {
   const { EmbeddedCollectionField, EmbeddedDataField, SchemaField, TypeDataField } = foundry.data.fields;
   for (const [name, field] of Object.entries(schema.fields)) {
      /** @type {string[]} The segments of this field. */
      const names = [...prefix, name];
      if (field instanceof EmbeddedCollectionField) {
         if (!top || withTop) {
            out.push({
               root,
               path: names.join('.'),
               names,
               kind: 'collection',
               sample: [],
               document: true,
            });
         }
         /** @type {object[]} The element data of the collection. */
         const elements = top
            ? [...root.getEmbeddedCollection(field.model.documentName).values()].map((child) => child.toObject())
            : (source[name] ?? []);
         for (const element of elements) {
            /** @type {string[]} The segments of the element. */
            const elementNames = [...names, element._id];
            if (!top) {
               out.push({
                  root,
                  path: elementNames.join('.'),
                  names: elementNames,
                  kind: 'element',
                  sample: {},
                  document: true,
               });
            }
            enumerate(root, field.model.schema, elementNames, element, false, out, withTop);
         }
      } else if (field instanceof EmbeddedDataField) {
         out.push({
            root,
            path: names.join('.'),
            names,
            kind: 'single',
            sample: {},
            document: field.model.documentName !== undefined,
         });
         enumerate(root, field.model.schema, names, source[name] ?? {}, false, out, withTop);
      } else if (field instanceof TypeDataField) {
         out.push({
            root,
            path: names.join('.'),
            names,
            kind: holdsEmbedded(field, source.type) ? 'contains' : 'plain',
            sample: {},
         });
         enumerate(root, field.getModelForType(source.type).schema, names, source[name] ?? {}, false, out, withTop);
      } else if (field instanceof SchemaField) {
         out.push({
            root,
            path: names.join('.'),
            names,
            kind: holdsEmbedded(field, source.type) ? 'contains' : 'plain',
            sample: {},
         });
         enumerate(root, field, names, source[name] ?? {}, false, out, withTop);
      } else {
         out.push({
            root,
            path: names.join('.'),
            names,
            kind: 'plain',
            sample: 1,
         });
      }
   }
}

/**
 * Every patch target reachable from a root document, generated from the schemas.
 * @param {object} root - A live document.
 * @param {boolean} [withTop] - Whether to list the top-level collections, which data can carry and a path cannot.
 * @returns {Target[]} The targets, embedded paths included.
 */
export function targetsOf(root, withTop = false) {
   /** @type {Target[]} The targets found. */
   const out = [];
   enumerate(root, root.constructor.schema, [], root._source, true, out, withTop);
   return out;
}

/**
 * The gates an operation needs on a target kind. A `set` needs none; replacing or deleting embedded documents (or a
 * field that holds them) needs the delete gate, and a replace the replace gate as well.
 * @param {Target['kind']} kind - The target kind.
 * @param {'set' | 'replace' | 'delete'} op - The operation.
 * @returns {string[]} The gate names.
 */
export function gatesFor(kind, op) {
   if (kind === 'plain' || op === 'set') {
      return [];
   }
   return op === 'replace'
      ? [
         'allowReplace',
         'allowDelete',
      ]
      : ['allowDelete'];
}

/**
 * Build the patch of a target in the explicit `op` representation.
 * @param {Target} target - The field the case addresses.
 * @param {'set' | 'replace' | 'delete'} op - The operation.
 * @returns {object} The patch for a tool call.
 */
export function opPatch(target, op) {
   return op === 'delete'
      ? {
         path: target.path,
         op,
      }
      : {
         path: target.path,
         op,
         value: structuredClone(target.sample),
      };
}

/**
 * Build the patch that spells an operator as a key prefix on the last path segment.
 * @param {Target} target - The field the case addresses.
 * @param {'replace' | 'delete'} op - The operation.
 * @returns {object} The patch for a tool call.
 */
export function prefixPatch(target, op) {
   /** @type {string[]} The segments with the prefix on the last one. */
   const names = [...target.names];
   names[names.length - 1] = `${op === 'replace' ? '==' : '-='}${names.at(-1)}`;
   return {
      path: names.join('.'),
      value: op === 'replace' ? structuredClone(target.sample) : null,
   };
}

/**
 * Build the patch that carries a serialized operator as its value.
 * @param {Target} target - The field the case addresses.
 * @param {'replace' | 'delete'} op - The operation.
 * @returns {object} The patch for a tool call.
 */
export function wrapperPatch(target, op) {
   return {
      path: target.path,
      value: {
        [OPERATOR_IDENTIFIER]: op === 'replace' ? 'ForcedReplacement' : 'ForcedDeletion',
         value: structuredClone(target.sample),
      },
   };
}

/**
 * Build the patch that spells the serialized operator with a dotted key: the identifier as the last path segment.
 * @param {Target} target - The field the case addresses.
 * @param {'replace' | 'delete'} op - The operation.
 * @returns {object} The patch for a tool call.
 */
export function dottedWrapperPatch(target, op) {
   return {
      path: `${target.path}.${OPERATOR_IDENTIFIER}`,
      value: op === 'replace' ? 'ForcedReplacement' : 'ForcedDeletion',
   };
}

/**
 * Step into data by a key segment: a key of an object, or the `_id` of an array element.
 * @param {unknown} node - The data node.
 * @param {string} segment - A key or an element `_id`.
 * @returns {unknown} The child, or undefined.
 */
function step(node, segment) {
   return Array.isArray(node) ? node.find((element) => element._id === segment) : node?.[segment];
}

/**
 * Build create or replace data that carries an operator at a target: the live data of the root with the field
 * replaced by the representation.
 * @param {Target} target - The field the case addresses.
 * @param {'prefix' | 'wrapper' | 'dotted' | 'dottedWrapper'} representation - How the operator is spelled.
 * @param {'replace' | 'delete'} op - The operation.
 * @returns {Record<string, unknown> | null} The data, or null when the target is an array element, which data cannot
 * carry an operator for.
 */
export function dataWith(target, representation, op) {
   /** @type {Record<string, unknown>} The live data, as a full read gives it. */
   const data = structuredClone(target.root.toObject());
   delete data._id;
   /** @type {unknown} The parent object of the field. */
   let parent = data;
   for (const segment of target.names.slice(0, -1)) {
      parent = step(parent, segment);
   }
   /** @type {string} The last segment. */
   const last = target.names.at(-1);
   if (Array.isArray(parent) || typeof parent !== 'object' || parent === null) {
      return null;
   }
   /** @type {unknown} The value in place. */
   const value = parent[last];
   delete parent[last];
   if (representation === 'wrapper') {
      parent[last] = {
         [OPERATOR_IDENTIFIER]: op === 'replace' ? 'ForcedReplacement' : 'ForcedDeletion',
         value: value ?? target.sample,
      };
   } else if (representation === 'dottedWrapper') {
      /** @type {string} The dotted key of the field. */
      const dotted = target.names.join('.');
      data[`${dotted}.${OPERATOR_IDENTIFIER}`] = op === 'replace' ? 'ForcedReplacement' : 'ForcedDeletion';
      data[`${dotted}.value`] = value ?? target.sample;
   } else if (representation === 'prefix') {
      parent[`${op === 'replace' ? '==' : '-='}${last}`] = op === 'replace' ? (value ?? target.sample) : null;
   } else {
      data[`${target.names.slice(0, -1).join('.')}${target.names.length > 1 ? '.' : ''}${
         op === 'replace' ? '==' : '-='
      }${last}`] = op === 'replace' ? (value ?? target.sample) : null;
   }
   return data;
}

/**
 * Tell whether a target holds at least one live embedded document, so omitting it from replace data drops something.
 * @param {Target} target - The field the case addresses.
 * @returns {boolean} True when the live value is a non-empty collection, a present document or an existing element.
 */
export function holdsDocuments(target) {
   /** @type {unknown} The live value at the path. */
   let value = target.root.toObject();
   for (const segment of target.names) {
      value = step(value, segment);
   }
   if (Array.isArray(value)) {
      return value.length > 0;
   }
   return typeof value === 'object' && value !== null;
}

/**
 * Build replace data that omits a field of the live data, so a replacement drops what it held.
 * @param {Target} target - The field the case addresses.
 * @returns {Record<string, unknown>} The full live data without the field.
 */
export function dataWithout(target) {
   /** @type {Record<string, unknown>} The live data. */
   const data = structuredClone(target.root.toObject());
   delete data._id;
   /** @type {unknown} The parent object of the field. */
   let parent = data;
   for (const segment of target.names.slice(0, -1)) {
      parent = step(parent, segment);
   }
   if (Array.isArray(parent)) {
      const index = parent.findIndex((element) => element._id === target.names.at(-1));
      parent.splice(index, 1);
   } else {
      delete parent[target.names.at(-1)];
   }
   return data;
}
