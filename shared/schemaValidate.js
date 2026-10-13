/**
 * Dependency-free validation of tool arguments against the JSON Schema subset that the sidecar converts to zod
 * (`jsonSchemaToZodShape` in `server/toolRegistry.ts`). The Foundry client uses it to judge the arguments of a
 * `callTool` before a script handler runs, so a call that bypassed the sidecar's check still meets the script's own
 * declared schema. Plain JS because both sides can import it.
 *
 * Supported constructs (anything else refuses the schema): a root `object` schema whose properties are `string`
 * (`enum`, `minLength`, `maxLength`), `number` and `integer` (`minimum`, `maximum`), `boolean`, `array` (`items`,
 * `minItems`, `maxItems`) or nested `object` (`properties`, `required`, `additionalProperties: false`), each with an
 * optional single-line `description`. Limits: object and array nesting of 4 levels (the root is level 1), 64 schema
 * nodes, 32 properties per object, 32 enum values of at most 64 characters, string and item-count bounds of at most
 * 100,000, an array must declare `maxItems` of at most `SCHEMA_ARRAY_ITEMS_MAX` (a budget), property names of
 * `[A-Za-z_][A-Za-z0-9_]{0,63}` that are not `Object.prototype` members. The sidecar imports these limits from here.
 *
 * Semantics follow zod's default object handling: an undeclared property is dropped from the validated copy (never an
 * error), a property absent or `undefined` is allowed unless listed in `required`, and `null` is a value of no type.
 * `tests/unit/schemaValidate.test.js` holds the fixtures that both implementations must judge alike; a drift fails it.
 *
 * Value bound: a validation visits at most `VALUE_NODES_MAX` values, so an enormous array costs bounded work.
 */

import { getBudget } from './budgets.js';
import { CONTROL_PATTERN } from './logText.js';

/**
 * @typedef {{ ok: false, error: string }} ValueFailure
 * A failed validation: the first problem, naming the argument path, at most 256 bytes and never caller text.
 */

/**
 * @typedef {{ ok: true, value: Record<string, unknown> } | ValueFailure} ValidationOutcome
 * The result of validating arguments: a fresh copy that holds only the declared properties, or the first problem.
 */

/**
 * @typedef {(value: unknown) => ValidationOutcome} ArgumentValidator
 * Validates one arguments value; never throws.
 */

/**
 * @typedef {{ ok: true, validate: ArgumentValidator, listed: Record<string, unknown> } | { ok: false, reason: string }}
 * CompileOutcome
 * The result of compiling a schema: its validator and listed form, or the short reason the schema is outside the
 * supported subset.
 */

/**
 * The most values one validation visits (the root, every property and every array element each count one); a larger
 * tree is refused as too large.
 * @type {number}
 */
export const VALUE_NODES_MAX = 10_000;

/**
 * The longest error text, in bytes. Errors are ASCII (schema property names, indexes and fixed phrases), so characters
 * equal bytes.
 * @type {number}
 */
export const VALIDATION_ERROR_MAX_BYTES = 256;

/**
 * Deepest object and array nesting of a schema; the root object is level 1 and scalar leaves are not counted.
 * @type {number}
 */
export const SCHEMA_DEPTH_MAX = 4;

/**
 * Most schema nodes in one schema.
 * @type {number}
 */
export const SCHEMA_NODES_MAX = 64;

/**
 * Most properties of one object schema.
 * @type {number}
 */
export const SCHEMA_PROPERTIES_MAX = 32;

/**
 * Most values of one string enum.
 * @type {number}
 */
export const SCHEMA_ENUM_MAX = 32;

/**
 * Longest value of a string enum, in characters.
 * @type {number}
 */
export const SCHEMA_ENUM_VALUE_MAX_CHARS = 64;

/**
 * Largest `minLength`, `maxLength`, `minItems` or `maxItems` a schema may declare.
 * @type {number}
 */
export const SCHEMA_BOUND_MAX = 100_000;

/**
 * Longest keyword echoed in a refusal reason; the reason is logged for the script author.
 * @type {number}
 */
export const KEYWORD_LABEL_MAX_CHARS = 48;

/**
 * A schema property name.
 * @type {RegExp}
 */
export const PROPERTY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * The keywords allowed on every node.
 * @type {readonly string[]}
 */
export const COMMON_KEYWORDS = Object.freeze([
   'type',
   'description',
]);

/**
 * The extra keywords allowed per `type`; a keyword outside the union with the common ones refuses the schema.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const TYPE_KEYWORDS = Object.freeze({
   string: [
      'enum',
      'minLength',
      'maxLength',
   ],
   number: [
      'minimum',
      'maximum',
   ],
   integer: [
      'minimum',
      'maximum',
   ],
   boolean: [],
   array: [
      'items',
      'minItems',
      'maxItems',
   ],
   object: [
      'properties',
      'required',
      'additionalProperties',
   ],
});

/**
 * @typedef {object} CheckState
 * @property {number} nodes - Values visited so far in this validation.
 */

/**
 * @typedef {(value: unknown, path: string, state: CheckState) => { error: string } | { value: unknown }} CompiledNode
 * A compiled schema node: returns the first problem, or the cleaned copy of the value.
 */

/** Thrown while compiling for a construct outside the subset; carries the short reason. */
class SchemaRefusal extends Error {}

/**
 * Read an own property only, so an inherited or polluted field is never taken for data.
 * @param {object} source - The object to read.
 * @param {string} key - The property name.
 * @returns {unknown} The own value, or undefined when the property is absent or inherited.
 */
function ownValue(source, key) {
   return Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * Check that a value is a plain object: not null, not an array.
 * @param {unknown} value - The candidate to check.
 * @returns {boolean} Whether it is.
 */
function isRecord(value) {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check a non-negative integer length or item bound.
 * @param {unknown} value - The candidate.
 * @returns {value is number} Whether it is an integer from 0 to the bound maximum.
 */
export function isBound(value) {
   return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= SCHEMA_BOUND_MAX;
}

/**
 * Check a description: a string within the hard description budget without control characters.
 * @param {unknown} value - The candidate.
 * @returns {value is string} Whether it is acceptable.
 */
export function isValidDescription(value) {
   return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= getBudget('DESCRIPTION_MAX_CHARS').value &&
      !CONTROL_PATTERN.test(value)
   );
}

/**
 * Build a failure for a path.
 * @param {string} path - The argument path, `arguments` for the root.
 * @param {string} reason - The fixed phrase.
 * @returns {{ error: string }} The failure.
 */
function problem(path, reason) {
   return { error: `${path}: ${reason}` };
}

/**
 * Join a path and a child segment.
 * @param {string} path - The parent path; empty for the root.
 * @param {string | number} segment - A property name or an array index.
 * @returns {string} The child path.
 */
function child(path, segment) {
   return path === '' ? String(segment) : `${path}.${segment}`;
}

/**
 * Count one visited value against the value bound.
 * @param {CheckState} state - The counter of this validation.
 * @param {string} path - The path of the value.
 * @returns {{ error: string } | null} The failure when the bound is passed, else null.
 */
function visit(state, path) {
   state.nodes += 1;
   return state.nodes > VALUE_NODES_MAX ? problem(path || 'arguments', 'the arguments are too large') : null;
}

/**
 * Compile a string node.
 * @param {Record<string, unknown>} node - The JSON Schema node to compile.
 * @returns {CompiledNode} The compiled node.
 * @throws {SchemaRefusal} When the node uses a construct outside the supported subset.
 */
function compileString(node) {
   /** @type {unknown} The declared minimum length. */
   const minLength = ownValue(node, 'minLength');
   /** @type {unknown} The declared maximum length. */
   const maxLength = ownValue(node, 'maxLength');
   if (minLength !== undefined && !isBound(minLength)) {
      throw new SchemaRefusal('minLength must be a non-negative integer');
   }
   if (maxLength !== undefined && !isBound(maxLength)) {
      throw new SchemaRefusal('maxLength must be a non-negative integer');
   }
   /** @type {unknown} The declared enum. */
   const values = ownValue(node, 'enum');
   if (values !== undefined) {
      if (
         !Array.isArray(values) ||
         values.length === 0 ||
         values.length > SCHEMA_ENUM_MAX ||
         !values.every((value) => typeof value === 'string' && value.length <= SCHEMA_ENUM_VALUE_MAX_CHARS)
      ) {
         throw new SchemaRefusal(`enum must hold 1 to ${SCHEMA_ENUM_MAX} short strings`);
      }
      // The length bounds do not apply to an enum: the sidecar's zod enum ignores them, and so does this validator.
      /** @type {Set<string>} The allowed values. */
      const allowed = new Set(values);
      return (value, path) => {
         if (typeof value !== 'string') {
            return problem(path, 'expected a string');
         }
         return allowed.has(value) ? { value } : problem(path, 'is not an allowed value');
      };
   }
   return (value, path) => {
      if (typeof value !== 'string') {
         return problem(path, 'expected a string');
      }
      if (minLength !== undefined && value.length < minLength) {
         return problem(path, `needs at least ${minLength} characters`);
      }
      if (maxLength !== undefined && value.length > maxLength) {
         return problem(path, `allows at most ${maxLength} characters`);
      }
      return { value };
   };
}

/**
 * Compile a number or integer node.
 * @param {Record<string, unknown>} node - The JSON Schema node to compile.
 * @param {boolean} integer - Whether the node is an integer.
 * @returns {CompiledNode} The compiled node.
 * @throws {SchemaRefusal} When the node uses a construct outside the supported subset.
 */
function compileNumber(node, integer) {
   /** @type {unknown} The declared minimum. */
   const minimum = ownValue(node, 'minimum');
   /** @type {unknown} The declared maximum. */
   const maximum = ownValue(node, 'maximum');
   if (minimum !== undefined && (typeof minimum !== 'number' || !Number.isFinite(minimum))) {
      throw new SchemaRefusal('minimum must be a finite number');
   }
   if (maximum !== undefined && (typeof maximum !== 'number' || !Number.isFinite(maximum))) {
      throw new SchemaRefusal('maximum must be a finite number');
   }
   return (value, path) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
         return problem(path, integer ? 'expected an integer' : 'expected a number');
      }
      if (integer && !Number.isSafeInteger(value)) {
         return problem(path, 'expected an integer');
      }
      if (minimum !== undefined && value < minimum) {
         return problem(path, `must be at least ${minimum}`);
      }
      if (maximum !== undefined && value > maximum) {
         return problem(path, `must be at most ${maximum}`);
      }
      return { value };
   };
}

/**
 * Compile an array node.
 * @param {Record<string, unknown>} node - The JSON Schema node to compile.
 * @param {number} depth - The nesting level of this node.
 * @param {{ nodes: number }} counter - The schema node counter.
 * @returns {CompiledNode} The compiled node.
 * @throws {SchemaRefusal} When the node uses a construct outside the supported subset.
 */
function compileArray(node, depth, counter) {
   if (!Object.hasOwn(node, 'items')) {
      throw new SchemaRefusal('an array schema needs items');
   }
   /** @type {CompiledNode} The compiled element schema. */
   const element = compileNode(ownValue(node, 'items'), depth + 1, counter);
   /** @type {unknown} The declared minimum item count. */
   const minItems = ownValue(node, 'minItems');
   /** @type {unknown} The declared maximum item count. */
   const maxItems = ownValue(node, 'maxItems');
   if (minItems !== undefined && !isBound(minItems)) {
      throw new SchemaRefusal('minItems must be a non-negative integer');
   }
   /** @type {number} The most items any array may allow. */
   const itemsCap = getBudget('SCHEMA_ARRAY_ITEMS_MAX').value;
   if (!isBound(maxItems) || maxItems > itemsCap) {
      throw new SchemaRefusal(`an array schema needs a maxItems of 0 to ${itemsCap}`);
   }
   return (value, path, state) => {
      if (!Array.isArray(value)) {
         return problem(path, 'expected a list');
      }
      /** @type {number} The element count, read once. */
      const length = value.length;
      if (minItems !== undefined && length < minItems) {
         return problem(path, `needs at least ${minItems} items`);
      }
      if (length > maxItems) {
         return problem(path, `allows at most ${maxItems} items`);
      }
      /** @type {unknown[]} The cleaned elements. */
      const cleaned = [];
      for (let index = 0; index < length; index += 1) {
         /** @type {string} The dotted path used in error texts. */
         const elementPath = child(path, index);
         const counted = visit(state, elementPath);
         if (counted !== null) {
            return counted;
         }
         /** @type {ReturnType<CompiledNode>} The element's verdict. */
         const verdict = element(value[index], elementPath, state);
         if ('error' in verdict) {
            return verdict;
         }
         cleaned.push(verdict.value);
      }
      return { value: cleaned };
   };
}

/**
 * Compile an object node.
 * @param {Record<string, unknown>} node - The JSON Schema node to compile.
 * @param {number} depth - The nesting level of this node.
 * @param {{ nodes: number }} counter - The schema node counter.
 * @returns {CompiledNode} The compiled node.
 * @throws {SchemaRefusal} When the node uses a construct outside the supported subset.
 */
function compileObject(node, depth, counter) {
   /** @type {unknown} The declared additionalProperties. */
   const additional = ownValue(node, 'additionalProperties');
   if (additional !== undefined && additional !== false) {
      throw new SchemaRefusal('additionalProperties may only be false');
   }
   /** @type {unknown} The declared properties; none when the schema declares no `properties`. */
   const properties = ownValue(node, 'properties') ?? {};
   if (!isRecord(properties)) {
      throw new SchemaRefusal('properties must be an object');
   }
   /** @type {string[]} The property names, own and enumerable. */
   const names = Object.keys(properties);
   if (names.length > SCHEMA_PROPERTIES_MAX) {
      throw new SchemaRefusal(`an object schema has more than ${SCHEMA_PROPERTIES_MAX} properties`);
   }
   /** @type {unknown} The declared required list. */
   const requiredList = ownValue(node, 'required') ?? [];
   if (!Array.isArray(requiredList) || !requiredList.every((name) => typeof name === 'string')) {
      throw new SchemaRefusal('required must be an array of property names');
   }
   for (const name of requiredList) {
      if (!names.includes(name)) {
         throw new SchemaRefusal('required names a property that is not declared');
      }
   }
   /** @type {Array<{ name: string, required: boolean, check: CompiledNode }>} The compiled properties. */
   const fields = [];
   for (const name of names) {
      if (!PROPERTY_NAME_PATTERN.test(name) || name in Object.prototype) {
         throw new SchemaRefusal('a property name is not allowed');
      }
      fields.push({
         name,
         required: requiredList.includes(name),
         check: compileNode(properties[name], depth + 1, counter),
      });
   }
   return (value, path, state) => {
      if (!isRecord(value)) {
         return problem(path || 'arguments', 'expected an object');
      }
      /** @type {Record<string, unknown>} The cleaned copy: declared properties only. */
      const cleaned = {};
      for (const field of fields) {
         /** @type {unknown} The property value; an inherited one is not an argument. */
         const present = Object.hasOwn(value, field.name) ? value[field.name] : undefined;
         /** @type {string} The property's path. */
         const fieldPath = child(path, field.name);
         if (present === undefined) {
            if (field.required) {
               return problem(fieldPath, 'is required');
            }
            continue;
         }
         const counted = visit(state, fieldPath);
         if (counted !== null) {
            return counted;
         }
         /** @type {ReturnType<CompiledNode>} The property's verdict. */
         const verdict = field.check(present, fieldPath, state);
         if ('error' in verdict) {
            return verdict;
         }
         cleaned[field.name] = verdict.value;
      }
      return { value: cleaned };
   };
}

/**
 * Compile one schema node; throws a SchemaRefusal for anything outside the supported subset.
 * @param {unknown} node - The JSON Schema node.
 * @param {number} depth - The nesting level of this node (the root object is 1).
 * @param {{ nodes: number }} counter - The schema node counter.
 * @returns {CompiledNode} The compiled node.
 * @throws {SchemaRefusal} When the node uses a construct outside the supported subset.
 */
function compileNode(node, depth, counter) {
   counter.nodes += 1;
   if (counter.nodes > SCHEMA_NODES_MAX) {
      throw new SchemaRefusal(`schema has more than ${SCHEMA_NODES_MAX} nodes`);
   }
   if (!isRecord(node)) {
      throw new SchemaRefusal('a schema node is not an object');
   }
   /** @type {unknown} The node's declared type. */
   const type = ownValue(node, 'type');
   if (typeof type !== 'string' || !Object.hasOwn(TYPE_KEYWORDS, type)) {
      throw new SchemaRefusal('type must be one of string, number, integer, boolean, array or object');
   }
   if ((type === 'object' || type === 'array') && depth > SCHEMA_DEPTH_MAX) {
      throw new SchemaRefusal(`schema nests objects and arrays deeper than ${SCHEMA_DEPTH_MAX} levels`);
   }
   /** @type {string[]} The keywords this type allows. */
   const allowed = [
      ...COMMON_KEYWORDS,
      ...TYPE_KEYWORDS[type],
   ];
   for (const keyword of Object.keys(node)) {
      if (!allowed.includes(keyword)) {
         throw new SchemaRefusal(`unsupported schema keyword "${keyword.slice(0, KEYWORD_LABEL_MAX_CHARS)}"`);
      }
   }
   /** @type {CompiledNode} The compiled node under construction. */
   let compiled;
   switch (type) {
      case 'string':
         compiled = compileString(node);
         break;
      case 'number':
      case 'integer':
         compiled = compileNumber(node, type === 'integer');
         break;
      case 'boolean':
         compiled = (value, path) => {
            return typeof value === 'boolean' ? { value } : problem(path, 'expected true or false');
         };
         break;
      case 'array':
         compiled = compileArray(node, depth, counter);
         break;
      default:
         compiled = compileObject(node, depth, counter);
         break;
   }
   /** @type {unknown} The node's description, validated on every node. */
   const description = ownValue(node, 'description');
   if (description !== undefined && !isValidDescription(description)) {
      throw new SchemaRefusal('description must be a short single-line string');
   }
   return compiled;
}

/**
 * The largest and smallest safe integers, which the sidecar's zod conversion lists as the default bounds of an integer.
 * @type {number}
 */
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Build the listed form of one schema node: the JSON Schema the sidecar's tool listing shows for it (zod's JSON Schema
 * output), without the `description` of a non-property node, which that output drops. The node must have compiled.
 * @param {Record<string, unknown>} node - A compiled schema node.
 * @returns {Record<string, unknown>} The listed form.
 */
function listedNode(node) {
   /** @type {unknown} The node's type. */
   const type = ownValue(node, 'type');
   /** @type {Record<string, unknown>} The listed form under construction. */
   const listed = { type };
   /**
    * Copy a keyword the node declares.
    * @param {string} keyword - The schema keyword whose value is copied when the node has it.
    * @returns {void}
    */
   const copy = (keyword) => {
      if (ownValue(node, keyword) !== undefined) {
         listed[keyword] = ownValue(node, keyword);
      }
   };
   switch (type) {
      case 'string':
         if (ownValue(node, 'enum') !== undefined) {
            copy('enum');
         } else {
            copy('minLength');
            copy('maxLength');
         }
         break;
      case 'number':
         copy('minimum');
         copy('maximum');
         break;
      case 'integer':
         listed.minimum = ownValue(node, 'minimum') ?? -SAFE_INTEGER_MAX;
         listed.maximum = ownValue(node, 'maximum') ?? SAFE_INTEGER_MAX;
         break;
      case 'array':
         listed.items = listedNode(ownValue(node, 'items'));
         copy('minItems');
         copy('maxItems');
         break;
      case 'object': {
         /** @type {Record<string, Record<string, unknown>>} The listed properties. */
         const properties = {};
         /** @type {Record<string, unknown>} The declared properties. */
         const declared = ownValue(node, 'properties') ?? {};
         for (const name of Object.keys(declared)) {
            properties[name] = listedNode(declared[name]);
            if (ownValue(declared[name], 'description') !== undefined) {
               properties[name].description = ownValue(declared[name], 'description');
            }
         }
         listed.properties = properties;
         /** @type {string[]} The required names. */
         const required = ownValue(node, 'required') ?? [];
         if (required.length > 0) {
            listed.required = required;
         }
         break;
      }
      default:
         break;
   }
   return listed;
}

/**
 * Compile a tool argument schema to a validator. The schema is judged by the same rules as the sidecar's conversion, so
 * a schema that compiles here converts there. `listed` is the schema as the sidecar lists it (what the agent's context
 * pays for): the client checks the size of that form, not of the raw schema, so it refuses what the sidecar refuses.
 * `tests/unit/schemaValidate.test.js` asserts `listed` equals the sidecar's listing for the parity fixtures.
 * @param {unknown} schema - The JSON Schema of the arguments.
 * @returns {CompileOutcome} The validator and listed form, or the short reason the schema is refused. Never throws.
 */
export function compileSchema(schema) {
   try {
      if (!isRecord(schema) || ownValue(schema, 'type') !== 'object') {
         throw new SchemaRefusal('the schema root must be an object schema');
      }
      /** @type {CompiledNode} The compiled root. */
      const root = compileNode(schema, 1, { nodes: 0 });
      return {
         ok: true,
         listed: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            ...listedNode(schema),
         },
         validate: (value) => {
            try {
               /** @type {CheckState} The value counter of this validation. */
               const state = { nodes: 1 };
               /** @type {ReturnType<CompiledNode>} The verdict on the whole value. */
               const verdict = root(value, '', state);
               if ('error' in verdict) {
                  return {
                     ok: false,
                     error: verdict.error.slice(0, VALIDATION_ERROR_MAX_BYTES),
                  };
               }
               return {
                  ok: true,
                  value: verdict.value,
               };
            } catch {
               return {
                  ok: false,
                  error: 'arguments: could not be read',
               };
            }
         },
      };
   } catch (cause) {
      return {
         ok: false,
         reason: cause instanceof SchemaRefusal ? cause.message : 'the schema is unreadable',
      };
   }
}
