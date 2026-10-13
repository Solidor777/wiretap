import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { z, type ZodRawShape, type ZodType } from 'zod';
import { getBudget } from '../shared/budgets.js';
import { GATES, isModuleId } from '../shared/gates.js';
import type { RequiredGate } from './endpoints.ts';
import { CONTROL_PATTERN, cleanForLog } from './logText.ts';
import { truncateUtf8 } from './utf8.ts';

/**
 * A tool a Foundry client registered with `bridge:registry`, after sanitizing. The MCP layer lists it to the sessions
 * routed to that client and forwards its calls back to it.
 */
export interface RegistryTool {
   /** The MCP tool name: lowercase letters, digits, `_` and `-`, starting with a letter; within the name budget. */
   name: string;
   /** The one-line description the client lists. */
   description: string;
   /** The argument shape converted from the received JSON Schema. */
   shape: ZodRawShape;
   /** The tool's own result budget in bytes, when it declared one. */
   budgetBytes?: number;
   /** The risk gate the tool declared; the sidecar pre-checks it against the routed endpoint's snapshot. */
   gate?: RequiredGate;
   /** A string that differs whenever any listed or routed property of the tool differs; used to detect changes. */
   signature: string;
   /** The argument schema as the SDK lists it; a call is refused when the picked endpoint declares another one. */
   schemaSignature: string;
}

/** The outcome of sanitizing a registry payload. */
export type RegistryOutcome =
   | {
        /** The payload was an array; `tools` holds the accepted entries. */
        ok: true;
        tools: RegistryTool[];
        /** Entries that were refused or never examined. */
        refused: number;
     }
   | {
        /** The payload was not an array; no tool is accepted. */
        ok: false;
        reason: string;
     };

/** The outcome of converting a JSON Schema. */
export type ShapeOutcome = { ok: true; shape: ZodRawShape } | { ok: false; reason: string };

/** The outcome of sanitizing one entry. */
type ToolOutcome = { ok: true; tool: RegistryTool } | { ok: false; reason: string };

/** The node counter shared by one schema conversion. */
interface ConvertState {
   /** Schema nodes converted so far, the root included. */
   nodes: number;
}

// The tool names the sidecar registers itself; a client may not register them.
export const RESERVED_TOOL_NAMES: readonly string[] = [
   'create_actor',
   'read_handle',
];

// A tool name: lowercase letters, digits, `_` and `-`, starting with a letter.
const TOOL_NAME_PATTERN: RegExp = /^[a-z][a-z0-9_-]*$/;

// A schema property name; names of `Object.prototype` members are refused separately.
const PROPERTY_NAME_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// Longest tool label written to a log line, in UTF-8 bytes.
const LOG_LABEL_BYTES: number = 48;

// Longest refusal reason written to a log line, in UTF-8 bytes.
const LOG_REASON_BYTES: number = 200;

// Deepest object and array nesting of a schema; the root object is level 1 and scalar leaves are not counted.
const SCHEMA_DEPTH_MAX: number = 4;

// Most schema nodes in one schema; bounds the conversion work whatever the client sends.
const SCHEMA_NODES_MAX: number = 64;

// Most properties of one object schema.
const SCHEMA_PROPERTIES_MAX: number = 32;

// Most values of one string enum.
const SCHEMA_ENUM_MAX: number = 32;

// Longest value of a string enum, in characters.
const SCHEMA_ENUM_VALUE_MAX_CHARS: number = 64;

// Largest `minLength`, `maxLength`, `minItems` or `maxItems` a schema may declare.
const SCHEMA_BOUND_MAX: number = 100_000;

// The keywords allowed on every node.
const COMMON_KEYWORDS: readonly string[] = [
   'type',
   'description',
];

// The extra keywords allowed per `type`. A keyword outside the union of the two lists refuses the schema.
const TYPE_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
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
};

/** Thrown by the converter for a construct it does not support; carries the short reason. */
class SchemaRefusal extends Error {}

/**
 * Read an own property only, so an inherited or polluted field is never taken for client data.
 * @param {object} source - The object to read.
 * @param {string} key - The property name.
 * @returns {unknown} The own value, or undefined when the property is absent or inherited.
 */
function ownValue(source: object, key: string): unknown {
   return Object.hasOwn(source, key) ? (source as Record<string, unknown>)[key] : undefined;
}

/**
 * Check that a value is a plain object: not null, not an array.
 * @param {unknown} value - The value.
 * @returns {boolean} Whether it is.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check a description: a string within the hard description budget without control characters.
 * @param {unknown} value - The candidate.
 * @returns {boolean} Whether it is acceptable.
 */
function isValidDescription(value: unknown): value is string {
   return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= getBudget('DESCRIPTION_MAX_CHARS').value &&
      !CONTROL_PATTERN.test(value)
   );
}

/**
 * Check a non-negative integer length or item bound.
 * @param {unknown} value - The candidate.
 * @returns {boolean} Whether it is an integer from 0 to the bound maximum.
 */
function isBound(value: unknown): value is number {
   return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= SCHEMA_BOUND_MAX;
}

/**
 * Convert one schema node to a zod type; throws a SchemaRefusal for anything outside the supported subset.
 * @param {unknown} node - The JSON Schema node.
 * @param {number} depth - The nesting level of this node (the root object is 1).
 * @param {ConvertState} state - The node counter.
 * @returns {ZodType} The zod type.
 */
function convertNode(node: unknown, depth: number, state: ConvertState): ZodType {
   state.nodes += 1;
   if (state.nodes > SCHEMA_NODES_MAX) {
      throw new SchemaRefusal(`schema has more than ${SCHEMA_NODES_MAX} nodes`);
   }
   if (!isRecord(node)) {
      throw new SchemaRefusal('a schema node is not an object');
   }
   // The node's declared type.
   const type: unknown = ownValue(node, 'type');
   if (typeof type !== 'string' || !Object.hasOwn(TYPE_KEYWORDS, type)) {
      throw new SchemaRefusal('type must be one of string, number, integer, boolean, array or object');
   }
   if ((type === 'object' || type === 'array') && depth > SCHEMA_DEPTH_MAX) {
      throw new SchemaRefusal(`schema nests objects and arrays deeper than ${SCHEMA_DEPTH_MAX} levels`);
   }
   // The keywords this type allows.
   const allowed: readonly string[] = [
      ...COMMON_KEYWORDS,
      ...TYPE_KEYWORDS[type],
   ];
   for (const keyword of Object.keys(node)) {
      if (!allowed.includes(keyword)) {
         throw new SchemaRefusal(`unsupported schema keyword "${cleanForLog(keyword, LOG_LABEL_BYTES)}"`);
      }
   }
   // The zod type under construction.
   let result: ZodType;
   switch (type) {
      case 'string': {
         // The string schema, extended by the declared bounds.
         let text: z.ZodString = z.string();
         const minLength: unknown = ownValue(node, 'minLength');
         const maxLength: unknown = ownValue(node, 'maxLength');
         if (minLength !== undefined) {
            if (!isBound(minLength)) {
               throw new SchemaRefusal('minLength must be a non-negative integer');
            }
            text = text.min(minLength);
         }
         if (maxLength !== undefined) {
            if (!isBound(maxLength)) {
               throw new SchemaRefusal('maxLength must be a non-negative integer');
            }
            text = text.max(maxLength);
         }
         const values: unknown = ownValue(node, 'enum');
         if (values === undefined) {
            result = text;
            break;
         }
         if (
            !Array.isArray(values) ||
            values.length === 0 ||
            values.length > SCHEMA_ENUM_MAX ||
            !values.every((value) => typeof value === 'string' && value.length <= SCHEMA_ENUM_VALUE_MAX_CHARS)
         ) {
            throw new SchemaRefusal(`enum must hold 1 to ${SCHEMA_ENUM_MAX} short strings`);
         }
         result = z.enum(values as [string, ...string[]]);
         break;
      }
      case 'number':
      case 'integer': {
         // The number schema, an integer one for type integer.
         let numeric: z.ZodNumber = type === 'integer' ? z.number().int() : z.number();
         const minimum: unknown = ownValue(node, 'minimum');
         const maximum: unknown = ownValue(node, 'maximum');
         if (minimum !== undefined) {
            if (typeof minimum !== 'number' || !Number.isFinite(minimum)) {
               throw new SchemaRefusal('minimum must be a finite number');
            }
            numeric = numeric.min(minimum);
         }
         if (maximum !== undefined) {
            if (typeof maximum !== 'number' || !Number.isFinite(maximum)) {
               throw new SchemaRefusal('maximum must be a finite number');
            }
            numeric = numeric.max(maximum);
         }
         result = numeric;
         break;
      }
      case 'boolean':
         result = z.boolean();
         break;
      case 'array': {
         if (!Object.hasOwn(node, 'items')) {
            throw new SchemaRefusal('an array schema needs items');
         }
         // The array schema, extended by the declared bounds.
         let list: z.ZodArray = z.array(convertNode(ownValue(node, 'items'), depth + 1, state));
         const minItems: unknown = ownValue(node, 'minItems');
         const maxItems: unknown = ownValue(node, 'maxItems');
         if (minItems !== undefined) {
            if (!isBound(minItems)) {
               throw new SchemaRefusal('minItems must be a non-negative integer');
            }
            list = list.min(minItems);
         }
         if (maxItems !== undefined) {
            if (!isBound(maxItems)) {
               throw new SchemaRefusal('maxItems must be a non-negative integer');
            }
            list = list.max(maxItems);
         }
         result = list;
         break;
      }
      default:
         result = z.object(convertObjectShape(node, depth, state));
         break;
   }
   // Every node's description is validated here. Only an object property's description is attached (by
   // `convertObjectShape`, which owns the optional wrapper); a description on the root or on array items is validated
   // and not listed.
   const description: unknown = ownValue(node, 'description');
   if (description !== undefined && !isValidDescription(description)) {
      throw new SchemaRefusal('description must be a short single-line string');
   }
   return result;
}

/**
 * Convert an object schema's properties to a zod shape: each property is required only when `required` lists it.
 * @param {Record<string, unknown>} node - The object schema node.
 * @param {number} depth - The nesting level of the object.
 * @param {ConvertState} state - The node counter.
 * @returns {ZodRawShape} The shape.
 */
function convertObjectShape(node: Record<string, unknown>, depth: number, state: ConvertState): ZodRawShape {
   const additional: unknown = ownValue(node, 'additionalProperties');
   if (additional !== undefined && additional !== false) {
      throw new SchemaRefusal('additionalProperties may only be false');
   }
   // The declared properties; none when the schema declares no `properties`.
   const properties: unknown = ownValue(node, 'properties') ?? {};
   if (!isRecord(properties)) {
      throw new SchemaRefusal('properties must be an object');
   }
   // The property names, own and enumerable.
   const names: string[] = Object.keys(properties);
   if (names.length > SCHEMA_PROPERTIES_MAX) {
      throw new SchemaRefusal(`an object schema has more than ${SCHEMA_PROPERTIES_MAX} properties`);
   }
   const requiredList: unknown = ownValue(node, 'required') ?? [];
   if (!Array.isArray(requiredList) || !requiredList.every((name) => typeof name === 'string')) {
      throw new SchemaRefusal('required must be an array of property names');
   }
   for (const name of requiredList as string[]) {
      if (!names.includes(name)) {
         throw new SchemaRefusal('required names a property that is not declared');
      }
   }
   // The shape being built; every key was vetted, so none can be `__proto__` or an inherited member.
   const shape: Record<string, ZodType> = {};
   for (const name of names) {
      if (!PROPERTY_NAME_PATTERN.test(name) || name in Object.prototype) {
         throw new SchemaRefusal(`property name "${cleanForLog(name, LOG_LABEL_BYTES)}" is not allowed`);
      }
      // The property's zod type, optional unless required.
      let type: ZodType = convertNode(properties[name], depth + 1, state);
      if (!(requiredList as string[]).includes(name)) {
         type = type.optional();
      }
      // The description sits on the outermost type so the SDK lists it.
      const description: unknown = ownValue(properties[name] as object, 'description');
      shape[name] = typeof description === 'string' ? type.describe(description) : type;
   }
   return shape;
}

/**
 * Convert the JSON Schema of a tool's arguments to a zod shape. Only a small, documented subset is supported: a root
 * `object` whose properties are `string` (with `enum`, `minLength`, `maxLength`), `number`, `integer` (with `minimum`,
 * `maximum`), `boolean`, `array` (with `items`, `minItems`, `maxItems`) or nested `object`, each with an optional
 * `description`; `required`; and `additionalProperties: false`. Every other keyword (references, combinators,
 * patterns, formats, defaults, constants) refuses the schema: a pattern is attacker-supplied regular-expression work
 * and a combinator or reference cannot be bounded by the definition budget.
 * @param {unknown} schema - The untrusted JSON Schema.
 * @returns {ShapeOutcome} The shape, or the short reason the schema is refused.
 */
export function jsonSchemaToZodShape(schema: unknown): ShapeOutcome {
   try {
      if (!isRecord(schema) || ownValue(schema, 'type') !== 'object') {
         throw new SchemaRefusal('the schema root must be an object schema');
      }
      // Run the whole-node checks once on the root, then take its property shape.
      const state: ConvertState = { nodes: 0 };
      const root: ZodType = convertNode(schema, 1, state);
      return {
         ok: true,
         shape: (root as z.ZodObject).shape,
      };
   } catch (cause) {
      if (cause instanceof SchemaRefusal) {
         return {
            ok: false,
            reason: cause.message,
         };
      }
      throw cause;
   }
}

/**
 * Measure a tool definition as the client lists it: UTF-8 bytes of `{name, description, inputSchema}`.
 * @param {string} name - The tool name.
 * @param {string} description - The description.
 * @param {unknown} inputSchema - The JSON Schema.
 * @returns {number} The byte length.
 */
function definitionBytes(name: string, description: string, inputSchema: unknown): number {
   return Buffer.byteLength(
      JSON.stringify({
         name,
         description,
         inputSchema,
      }),
      'utf8',
   );
}

/**
 * Validate one registry entry. Reads own properties only and copies the known fields; nothing of the received object
 * is kept.
 * @param {unknown} entry - The untrusted entry.
 * @param {Set<string>} seen - The names accepted so far in this payload.
 * @returns {ToolOutcome} The tool, or the reason the entry is refused.
 */
function sanitizeTool(entry: unknown, seen: Set<string>): ToolOutcome {
   if (!isRecord(entry)) {
      return {
         ok: false,
         reason: 'the entry is not an object',
      };
   }
   const name: unknown = ownValue(entry, 'name');
   const description: unknown = ownValue(entry, 'description');
   const inputSchema: unknown = ownValue(entry, 'inputSchema');
   const budgetBytes: unknown = ownValue(entry, 'budgetBytes');
   const gate: unknown = ownValue(entry, 'gate');
   const moduleId: unknown = ownValue(entry, 'moduleId');
   const nameMax: number = getBudget('CORE_TOOL_NAME_MAX_CHARS').value;
   if (typeof name !== 'string' || name.length > nameMax || !TOOL_NAME_PATTERN.test(name)) {
      return {
         ok: false,
         reason: `name must be 1 to ${nameMax} characters of a-z, 0-9, _ or -, starting with a letter`,
      };
   }
   if (RESERVED_TOOL_NAMES.includes(name) || name in Object.prototype) {
      return {
         ok: false,
         reason: 'name is reserved',
      };
   }
   if (seen.has(name)) {
      return {
         ok: false,
         reason: 'duplicate name in this registry',
      };
   }
   if (!isValidDescription(description)) {
      return {
         ok: false,
         reason: `description must be 1 to ${getBudget('DESCRIPTION_MAX_CHARS').value} characters on one line`,
      };
   }
   if (!isRecord(inputSchema)) {
      return {
         ok: false,
         reason: 'inputSchema must be an object',
      };
   }
   if (
      budgetBytes !== undefined &&
      (typeof budgetBytes !== 'number' ||
         !Number.isInteger(budgetBytes) ||
         budgetBytes < 1 ||
         budgetBytes > getBudget('RESULT_HARD_CAP_MAX_BYTES').value)
   ) {
      return {
         ok: false,
         reason: `budgetBytes must be an integer from 1 to ${getBudget('RESULT_HARD_CAP_MAX_BYTES').value}`,
      };
   }
   // The risk gate the tool declared, when it declared one.
   let requiredGate: RequiredGate | undefined;
   if (gate !== undefined) {
      if (typeof gate !== 'string' || !Object.hasOwn(GATES, gate)) {
         return {
            ok: false,
            reason: 'gate is not a registered gate',
         };
      }
      if (gate === 'allowedPluginModules') {
         if (!isModuleId(moduleId)) {
            return {
               ok: false,
               reason: 'moduleId must be a module id for the allowedPluginModules gate',
            };
         }
         requiredGate = {
            gate,
            moduleId: moduleId as string,
         };
      } else if (moduleId !== undefined) {
         return {
            ok: false,
            reason: 'moduleId is only allowed with the allowedPluginModules gate',
         };
      } else {
         requiredGate = { gate };
      }
   } else if (moduleId !== undefined) {
      return {
         ok: false,
         reason: 'moduleId is only allowed with the allowedPluginModules gate',
      };
   }
   const maxDefinition: number = getBudget('DEFINITION_MAX_BYTES').value;
   const received: number = definitionBytes(name, description, inputSchema);
   if (received > maxDefinition) {
      return {
         ok: false,
         reason: `definition is ${received} bytes, at most ${maxDefinition} bytes`,
      };
   }
   const converted: ShapeOutcome = jsonSchemaToZodShape(inputSchema);
   if (!converted.ok) {
      return converted;
   }
   // The schema as the SDK lists it, which is what the client's context pays for.
   const listedSchema: unknown = toJsonSchemaCompat(z.object(converted.shape), {
      strictUnions: true,
      pipeStrategy: 'input',
   });
   const listed: number = definitionBytes(name, description, listedSchema);
   if (listed > maxDefinition) {
      return {
         ok: false,
         reason: `listed definition is ${listed} bytes, at most ${maxDefinition} bytes`,
      };
   }
   seen.add(name);
   return {
      ok: true,
      tool: {
         name,
         description,
         shape: converted.shape,
         ...(budgetBytes === undefined ? {} : { budgetBytes: budgetBytes as number }),
         ...(requiredGate === undefined ? {} : { gate: requiredGate }),
         signature: JSON.stringify([name, description, listedSchema, budgetBytes ?? null, requiredGate ?? null]),
         schemaSignature: JSON.stringify(listedSchema),
      },
   };
}

/**
 * Reduce an untrusted `bridge:registry` payload to the tools that pass every budget. Entries are judged one by one:
 * a refused entry is logged with its reason and dropped, the others are kept. At most `ALWAYS_LISTED_TOOLS_MAX` less
 * the built-in tool count entries are accepted, and at most twice `ALWAYS_LISTED_TOOLS_MAX` are examined; the rest
 * are refused with one summary line, so a hostile payload costs bounded work and bounded log output.
 * @param {unknown} payload - The untrusted payload; an array of tool definitions.
 * @param {(line: string) => void} log - Receives one line per refusal; callers pass a throttled logger.
 * @returns {RegistryOutcome} The accepted tools and the number of refused entries, or a failure when the payload is
 *          not an array.
 */
export function sanitizeRegistry(payload: unknown, log: (line: string) => void): RegistryOutcome {
   if (!Array.isArray(payload)) {
      return {
         ok: false,
         reason: 'the registry payload must be an array of tool definitions',
      };
   }
   // The most tools the always-listed budget leaves room for beside the built-in tools.
   const room: number = getBudget('ALWAYS_LISTED_TOOLS_MAX').value - RESERVED_TOOL_NAMES.length;
   // The most entries examined, so an enormous array costs bounded work.
   const examineMax: number = 2 * getBudget('ALWAYS_LISTED_TOOLS_MAX').value;
   // The accepted tools.
   const tools: RegistryTool[] = [];
   // The names accepted so far, so a repeated name is refused.
   const seen: Set<string> = new Set();
   // The entries refused or never examined.
   let refused: number = 0;
   // The position of the entry being examined.
   let index: number = 0;
   for (; index < Math.min(payload.length, examineMax) && tools.length < room; index += 1) {
      // The entry's label in log lines: its name when it is a string, else its position.
      let label: string = `#${index}`;
      try {
         const entry: unknown = payload[index];
         if (isRecord(entry) && typeof ownValue(entry, 'name') === 'string') {
            label = cleanForLog(ownValue(entry, 'name') as string, LOG_LABEL_BYTES);
         }
         const outcome: ToolOutcome = sanitizeTool(entry, seen);
         if (outcome.ok) {
            tools.push(outcome.tool);
            continue;
         }
         refused += 1;
         // The refusal reason, made safe for one log line.
         const reason: string = cleanForLog(outcome.reason, LOG_REASON_BYTES);
         log(`Wiretap sidecar | registry refused tool ${JSON.stringify(label)}: ${reason}`);
      } catch {
         refused += 1;
         log(`Wiretap sidecar | registry refused tool ${JSON.stringify(label)}: the entry is unreadable`);
      }
   }
   // Entries never examined: past the examine bound or past the room for tools.
   const skipped: number = payload.length - index;
   if (skipped > 0) {
      refused += skipped;
      log(`Wiretap sidecar | registry refused ${skipped} tools: tool count budget of ${room} reached`);
   }
   return {
      ok: true,
      tools,
      refused,
   };
}
