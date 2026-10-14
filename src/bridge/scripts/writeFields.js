/**
 * What a write does to embedded documents and to the Wiretap flag scope, judged from the schema field a change lands
 * on and from the data after Foundry's own cleaning, never from the spelling of a key. Foundry honours an operator
 * (`ForcedReplacement`, `ForcedDeletion`) on any field, and an embedded collection or embedded document is removed or
 * rewritten by it (MEASURED on 14.364: `new ForcedReplacement([])` on `items` deleted every item, on an item's
 * `effects` its effects, and `==flags` and a `flags` operator erased every flag scope). So the gates follow the
 * field type:
 *
 * - `reachesEmbedded` resolves a path with `schema.getField(path, { source })` and tells whether an operator at the
 * path replaces or deletes embedded documents: the field is an `EmbeddedCollectionField` (the delta collection
 * included), an `EmbeddedDataField` (an `EmbeddedDocumentField` such as the token delta included), or an ancestor of
 * one, or the path ends at an element of an embedded collection.
 * - `cleanChanges` runs the cleaning the database backend runs before it applies an update
 * (`client/data/client-backend.mjs`, `documentClass.cleanData` with `partial`, `migrate` and `sanitize`), so dotted
 * keys are expanded and every operator spelling has become an operator object.
 * - `analyzeChanges` walks the cleaned changes for operator objects and reports the operations on embedded documents
 * and whether the reserved flag scope is rewritten.
 * - `walkEmbedded` pairs the embedded documents of live data with those of replacement data through the schema, for
 * the drops of `replace_document` and the carrying of the Wiretap records.
 */

import { cleanForLog } from '$shared/logText.js';
import { FLAG_SCOPE, FLAGS_KEY } from '$shared/writeKeys.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * Deepest schema or change nesting the walks follow; past it they fail closed.
 * @type {number}
 */
const DEPTH_MAX = 64;

/**
 * Most nodes `analyzeChanges` visits; past it the result reports every operation.
 * @type {number}
 */
const NODES_MAX = 200_000;

/**
 * @typedef {'delete' | 'replace'} RiskyOperation
 */

/**
 * @typedef {object} ChangeAnalysis
 * @property {Set<RiskyOperation>} operations - The operations the changes perform on embedded documents.
 * @property {boolean} reservedFlags - Whether an operator or a non-object value rewrites `flags` as a whole or the
 * reserved `flags.wiretap` scope.
 */

/**
 * Tell whether a value is an update operator object (`ForcedReplacement`, `ForcedDeletion`).
 * @param {unknown} value - The value to test.
 * @returns {boolean} True for an instance of `DataFieldOperator`.
 */
export function isOperatorObject(value) {
   /** @type {Function | undefined} The operator base class of this Foundry. */
   const base = globalThis.foundry?.data?.operators?.DataFieldOperator;
   return base !== undefined && value instanceof base;
}

/**
 * Tell whether a field is an instance of a Foundry field class. A class this Foundry lacks matches nothing.
 * @param {unknown} field - A value that may be a schema field.
 * @param {string} className - The name in `foundry.data.fields`.
 * @returns {boolean} True when the field is an instance.
 */
function isKind(field, className) {
   /** @type {Function | undefined} The class registered under that name; absent in a Foundry that lacks it. */
   const fieldClass = foundry.data.fields[className];
   return fieldClass !== undefined && field instanceof fieldClass;
}

/**
 * Tell whether a field is an embedded document field: a collection of embedded documents (also the token delta
 * collection, a subclass) or a single embedded document or data model (also the token delta, a subclass).
 * @param {unknown} field - A schema field.
 * @returns {boolean} True for an `EmbeddedCollectionField` or an `EmbeddedDataField`.
 */
export function isEmbeddedField(field) {
   return isKind(field, 'EmbeddedCollectionField') || isKind(field, 'EmbeddedDataField');
}

/**
 * @typedef {object} ChildField
 * @property {object} field - A field below a composite field.
 * @property {'name' | 'same' | 'elements' | 'typed'} project - How the data of the parent maps to the data of the
 * child: the property `name`, the same value, each array element or object value, or the value whose `type` is `name`.
 * @property {string} [name] - The property or the type name.
 */

/**
 * The fields below a composite field, the one traversal both `containsEmbedded` (schema only) and `walkEmbedded`
 * (schema and data) follow: schema fields, the system data model chosen by the document type, typed schemas, and the
 * element of an array or typed object. An embedded field is not entered here; callers test `isEmbeddedField` first.
 * @param {object} field - A schema field.
 * @param {string | undefined} type - The document type, which selects the system data model.
 * @returns {ChildField[]} The child fields, none for a leaf.
 */
function childrenOf(field, type) {
   if (isKind(field, 'TypeDataField')) {
      /** @type {{ schema?: object } | null} The data model of the type. */
      const model = field.getModelForType(type);
      return model?.schema === undefined
         ? []
         : [{
            field: model.schema,
            project: 'same',
         }];
   }
   if (isKind(field, 'SchemaField')) {
      return Object.entries(field.fields).map(([name, child]) => ({
         field: child,
         project: 'name',
         name,
      }));
   }
   if (isKind(field, 'TypedSchemaField')) {
      return Object.entries(field.types).map(([name, child]) => ({
         field: child,
         project: 'typed',
         name,
      }));
   }
   if (isKind(field, 'ArrayField') || isKind(field, 'TypedObjectField')) {
      return [{
         field: field.element,
         project: 'elements',
      }];
   }
   return [];
}

/**
 * Tell whether a field is, or holds anywhere below it, an embedded document field. A nesting the walk will not follow
 * counts as holding one, so the answer fails closed.
 * @param {unknown} field - A schema field.
 * @param {string | undefined} type - The document type, which selects the system data model.
 * @param {number} [depth] - How deep the walk is.
 * @returns {boolean} True when an operator on the field can remove or rewrite embedded documents.
 */
export function containsEmbedded(field, type, depth = 0) {
   if (depth > DEPTH_MAX || isEmbeddedField(field)) {
      return true;
   }
   return childrenOf(field, type).some((child) => containsEmbedded(child.field, type, depth + 1));
}

/**
 * Read the value a path names inside source data.
 * @param {unknown} source - The source data.
 * @param {string[]} names - The segments.
 * @returns {unknown} The value, or undefined.
 */
function valueAt(source, names) {
   /** @type {unknown} The value reached so far. */
   let current = source;
   for (const name of names) {
      if (typeof current !== 'object' || current === null) {
         return undefined;
      }
      current = current[name];
   }
   return current;
}

/**
 * Tell whether an operator at a path replaces or deletes embedded documents. The path is resolved one prefix at a
 * time with `schema.getField`, because an element id inside an embedded collection is not a field name: a prefix that
 * is a collection hands the rest to the schema of its documents, a prefix that is a single embedded document hands
 * the rest to its own schema. A path below a system data model whose document type is unknown cannot be resolved, so it
 * counts as reaching embedded documents (fail closed).
 * @param {{ schema: { getField: Function } }} model - The document class (or data model) the path is relative to.
 * @param {object | undefined} source - The source data of the document, for the type of its system data.
 * @param {string[]} names - The segments of the path, operator prefixes already removed.
 * @param {number} [depth] - How deep the resolution is.
 * @returns {boolean} True when the path is, holds or addresses an element of an embedded field.
 */
export function reachesEmbedded(model, source, names, depth = 0) {
   if (depth > DEPTH_MAX) {
      return true;
   }
   for (let length = 1; length <= names.length; length += 1) {
      /** @type {object | undefined} The field the first `length` segments name. */
      const field = model.schema.getField(names.slice(0, length), { source });
      if (field === undefined) {
         return false;
      }
      if (length === names.length) {
         return containsEmbedded(field, source?.type);
      }
      if (isKind(field, 'TypeDataField') && (typeof source?.type !== 'string' || source.type === '')) {
         // The data model is chosen by the document type; without a type the path below cannot be resolved.
         return true;
      }
      if (isKind(field, 'EmbeddedCollectionField')) {
         if (length + 1 === names.length) {
            return true;
         }
         /** @type {unknown} The live data of the element the next segment names, which carries its type. */
         const collection = valueAt(source, names.slice(0, length));
         return reachesEmbedded(
            field.model,
            Array.isArray(collection) ? collection.find((element) => element?._id === names[length]) : undefined,
            names.slice(length + 1),
            depth + 1,
         );
      }
      if (isKind(field, 'EmbeddedDataField')) {
         return reachesEmbedded(field.model, valueAt(source, names.slice(0, length)), names.slice(length), depth + 1);
      }
   }
   return false;
}

/**
 * Tell whether an operator at a path rewrites the reserved flag scope: it sits on a `flags` object (of the document or
 * of an embedded one, at any depth) or on the `wiretap` scope inside one.
 * @param {string[]} names - The segments of the path.
 * @returns {boolean} True when `flags` ends the path or `flags` is followed by `wiretap`.
 */
function rewritesFlagScope(names) {
   return names.some(
      (name, index) => name === FLAGS_KEY && (index === names.length - 1 || names[index + 1] === FLAG_SCOPE),
   );
}

/**
 * Tell whether a value is a non-null, non-array object.
 * @param {unknown} value - The value to test.
 * @returns {boolean} True for a plain-looking object.
 */
export function isPlainObject(value) {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk cleaned changes for operator objects. An operator at a path that reaches embedded documents is a risky
 * operation (replace: both; delete: delete); an operator at a `flags` object or on its `wiretap` scope (the document's
 * or an embedded one's), and a `flags` value that is not an object, rewrite the reserved scope. The walk is iterative
 * and bounded; past its bounds it reports everything.
 * @param {{ constructor: { schema: object }, _source?: object }} document - The live document the changes apply to.
 * @param {Record<string, unknown>} changes - The changes after `cleanChanges`, nested by field.
 * @returns {ChangeAnalysis} The operations and whether the reserved scope is rewritten.
 */
export function analyzeChanges(document, changes) {
   /** @type {ChangeAnalysis} The findings. */
   const found = {
      operations: new Set(),
      reservedFlags: false,
   };
   /** @type {Array<{ node: unknown, names: string[] }>} Nodes still to visit. */
   const pending = [{
      node: changes,
      names: [],
   }];
   /** @type {number} How many nodes the walk has taken from the pending list, bounded by `NODES_MAX`. */
   let visited = 0;
   while (pending.length > 0) {
      const { node, names } = pending.pop();
      visited += 1;
      if (visited > NODES_MAX || names.length > DEPTH_MAX) {
         return {
            operations: new Set([
               'delete',
               'replace',
            ]),
            reservedFlags: true,
         };
      }
      if (isOperatorObject(node)) {
         if (reachesEmbedded(document.constructor, document._source, names)) {
            found.operations.add('delete');
            if (!(node instanceof foundry.data.operators.ForcedDeletion)) {
               found.operations.add('replace');
            }
         }
         if (rewritesFlagScope(names)) {
            found.reservedFlags = true;
         }
         pending.push({
            node: foundry.data.operators.DataFieldOperator.get(node),
            names,
         });
         continue;
      }
      if (names.at(-1) === FLAGS_KEY && !isPlainObject(node)) {
         found.reservedFlags = true;
      }
      if (Array.isArray(node)) {
         for (const [index, member] of node.entries()) {
            pending.push({
               node: member,
               names: [
                  ...names,
                  String(index),
               ],
            });
         }
      } else if (isPlainObject(node)) {
         for (const key of Object.keys(node)) {
            pending.push({
               node: node[key],
               names: [
                  ...names,
                  key,
               ],
            });
         }
      }
   }
   return found;
}

/**
 * Clean the changes of an update the way the database backend does before it applies them
 * (`client/data/client-backend.mjs`): dotted keys become nested objects and serialized operators and operator keys
 * become operator objects. The input is not changed.
 * @param {{ constructor: { cleanData: Function }, _source?: object }} document - The live document.
 * @param {Record<string, unknown>} changes - The changes by dotted key, operator objects as built from `op`.
 * @returns {Record<string, unknown>} The cleaned changes.
 * @throws {ScriptError} `ARGS_INVALID` when Foundry cannot clean the changes.
 */
export function cleanChanges(document, changes) {
   try {
      return document.constructor.cleanData(
         foundry.utils.deepClone(changes),
         {
            partial: true,
            migrate: true,
            sanitize: true,
         },
         {
            creation: false,
            model: document,
            source: document._source,
         },
      );
   } catch (error) {
      throw new ScriptError(
         'ARGS_INVALID',
         `The changes cannot be cleaned: ${cleanForLog(String(error?.message), 120)}.`,
      );
   }
}

/**
 * Pair the embedded documents of live data with those of replacement data through the schema, every depth, single
 * embedded documents and the token delta included, and call a visitor for each live document: first the root, then
 * the embedded ones. A document the replacement has no element with the same `_id` for (or no value at all, for a
 * single embedded document) is visited with an undefined replacement, as is everything inside it.
 * @param {{ schema: { fields: object }, documentName?: string }} model - The class of both root data objects.
 * @param {Record<string, unknown>} live - `toObject()` of the live document.
 * @param {Record<string, unknown> | undefined} replacement - The replacement data for the same document.
 * @param {Function} visit - Called as `visit(model, live, replacement)` with the class, the live data and the matching
 * replacement data, if any.
 * @returns {void}
 */
export function walkEmbedded(model, live, replacement, visit) {
   walkModel(model, live, replacement, visit, 0);
}

/**
 * Visit one document and everything embedded in it.
 * @param {{ schema: object }} model - The class of the document.
 * @param {Record<string, unknown>} live - The live data.
 * @param {Record<string, unknown> | undefined} replacement - The matching replacement data, if any.
 * @param {Function} visit - The visitor of `walkEmbedded`.
 * @param {number} depth - How deep the walk is.
 * @returns {void}
 * @throws {ScriptError} `ARGS_INVALID` past the depth the walk follows: a replacement it cannot judge is refused.
 */
function walkModel(model, live, replacement, visit, depth) {
   visit(model, live, replacement);
   walkField(model.schema, live, replacement, visit, depth + 1, live.type);
}

/**
 * Follow the data through a field by the same children `containsEmbedded` follows, and visit the documents of every
 * embedded field met.
 * @param {object} field - The schema field the data belongs to.
 * @param {unknown} live - The live data of the field.
 * @param {unknown} replacement - The matching replacement data, if any.
 * @param {Function} visit - The visitor of `walkEmbedded`.
 * @param {number} depth - How deep the walk is.
 * @param {string | undefined} type - The type of the document being walked.
 * @returns {void}
 * @throws {ScriptError} `ARGS_INVALID` past the depth the walk follows.
 */
function walkField(field, live, replacement, visit, depth, type) {
   if (depth > DEPTH_MAX) {
      throw new ScriptError('ARGS_INVALID', 'The document nests embedded documents deeper than a replace can judge.');
   }
   if (live === undefined || live === null) {
      return;
   }
   if (isKind(field, 'EmbeddedCollectionField')) {
      /** @type {Map<unknown, Record<string, unknown>>} The replacement elements by `_id`. */
      const kept = new Map(
         (Array.isArray(replacement) ? replacement : []).map((element) => [element?._id, element]),
      );
      for (const element of Array.isArray(live) ? live : []) {
         walkModel(field.model, element, kept.get(element._id), visit, depth);
      }
      return;
   }
   if (isKind(field, 'EmbeddedDataField')) {
      if (isPlainObject(live)) {
         walkModel(field.model, live, isPlainObject(replacement) ? replacement : undefined, visit, depth);
      }
      return;
   }
   for (const child of childrenOf(field, type)) {
      if (child.project === 'same') {
         walkField(child.field, live, replacement, visit, depth + 1, type);
      } else if (child.project === 'name') {
         if (isPlainObject(live)) {
            walkField(
               child.field,
               live[child.name],
               isPlainObject(replacement) ? replacement[child.name] : undefined,
               visit,
               depth + 1,
               type,
            );
         }
      } else if (child.project === 'typed') {
         if (isPlainObject(live) && live.type === child.name) {
            walkField(child.field, live, replacement, visit, depth + 1, type);
         }
      } else if (Array.isArray(live)) {
         for (const [index, member] of live.entries()) {
            walkField(
               child.field,
               member,
               Array.isArray(replacement) ? replacement[index] : undefined,
               visit,
               depth + 1,
               type,
            );
         }
      } else if (isPlainObject(live)) {
         for (const [key, member] of Object.entries(live)) {
            walkField(
               child.field,
               member,
               isPlainObject(replacement) ? replacement[key] : undefined,
               visit,
               depth + 1,
               type,
            );
         }
      }
   }
}
