import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { z, type ZodRawShape, type ZodType } from 'zod';
import { getBudget } from '../shared/budgets.js';
import {
   RESERVED_SCRIPT_NAMES,
   definitionBytes,
   parseRegistryPayload,
   validateScriptDefinition,
} from '../shared/scripts.js';
import {
   KEYWORD_LABEL_MAX_CHARS,
   PROPERTY_NAME_PATTERN,
   SCHEMA_DEPTH_MAX,
   SCHEMA_ENUM_MAX,
   SCHEMA_ENUM_VALUE_MAX_CHARS,
   SCHEMA_NODES_MAX,
   SCHEMA_PROPERTIES_MAX,
   COMMON_KEYWORDS,
   TYPE_KEYWORDS,
   isBound,
   isValidDescription,
} from '../shared/schemaValidate.js';
import type { RequiredGate } from './endpoints.ts';
import { cleanForLog } from './logText.ts';

/** Where a registered script runs; `none` scripts run on the sidecar and are never registered by a client. */
export type RegistryRequires = 'api' | 'dom';

/**
 * A script a Foundry client registered with `bridge:registry`, after sanitizing. The MCP layer lists it as a tool to
 * the sessions routed to that client and forwards its calls back to it.
 */
export interface RegistryTool {
   /** The MCP tool name: lowercase letters, digits, `_` and `-`, starting with a letter; within the name budget. */
   name: string;
   /** The script's version string. */
   version: string;
   /** The one-line description the client lists. */
   description: string;
   /** The argument shape converted from the received JSON Schema. */
   shape: ZodRawShape;
   /** The script's own result budget in bytes. */
   budgetBytes: number;
   /** Where the script runs: any client endpoint, or only a DOM-capable one. */
   requires: RegistryRequires;
   /** Whether the script changes the world; listed to the client as the inverse of `readOnlyHint`. */
   mutates: boolean;
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
type ToolOutcome =
   | { ok: true; tool: RegistryTool; warnings: string[]; listedBytes: number }
   | { ok: false; reason: string };

/** The node counter shared by one schema conversion. */
interface ConvertState {
   /** Schema nodes converted so far, the root included. */
   nodes: number;
}

// Longest tool label written to a log line, in UTF-8 bytes.
const LOG_LABEL_BYTES: number = 48;

// Longest refusal reason written to a log line, in UTF-8 bytes.
const LOG_REASON_BYTES: number = 200;

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
         throw new SchemaRefusal(`unsupported schema keyword "${cleanForLog(keyword, KEYWORD_LABEL_MAX_CHARS)}"`);
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
         // Every array declares its own item cap, at most the shared budget, so an argument array is bounded.
         const itemsCap: number = getBudget('SCHEMA_ARRAY_ITEMS_MAX').value;
         if (!isBound(maxItems) || maxItems > itemsCap) {
            throw new SchemaRefusal(`an array schema needs a maxItems of 0 to ${itemsCap}`);
         }
         list = list.max(maxItems);
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
 * Validate one registry entry with the shared script validator (shipped route), then convert its argument schema. Reads
 * own properties only; nothing of the received object is kept.
 * @param {unknown} entry - The untrusted entry.
 * @param {Set<string>} seen - The names accepted so far in this payload.
 * @returns {ToolOutcome} The tool and any warnings, or the reason the entry is refused.
 */
function sanitizeTool(entry: unknown, seen: Set<string>, bytesLeft: number): ToolOutcome {
   // The shared validator's verdict on the definition; every script a client registers is a shipped script.
   const validated: ReturnType<typeof validateScriptDefinition> = validateScriptDefinition(entry, 'shipped');
   if (!validated.ok) {
      return validated;
   }
   // The normalized definition.
   const { name, version, description, inputSchema, result, requires, mutates, gate } = validated.definition;
   if (requires === 'none') {
      return {
         ok: false,
         reason: 'requires none scripts run on the sidecar; a client cannot register them',
      };
   }
   if (seen.has(name)) {
      return {
         ok: false,
         reason: 'duplicate name in this registry',
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
   const maxDefinition: number = getBudget('DEFINITION_MAX_BYTES').value;
   if (listed > maxDefinition) {
      return {
         ok: false,
         reason: `listed definition is ${listed} bytes, at most ${maxDefinition} bytes`,
      };
   }
   if (listed > bytesLeft) {
      return {
         ok: false,
         reason: `all definitions together may take at most ${getBudget('ALL_DEFINITIONS_MAX_BYTES').value} bytes`,
      };
   }
   // The risk gate the script declared, when it declared one.
   const requiredGate: RequiredGate | undefined = gate === undefined ? undefined : { gate };
   seen.add(name);
   return {
      ok: true,
      warnings: validated.warnings,
      listedBytes: listed,
      tool: {
         name,
         version,
         description,
         shape: converted.shape,
         budgetBytes: result.budgetBytes,
         requires,
         mutates,
         ...(requiredGate === undefined ? {} : { gate: requiredGate }),
         signature: JSON.stringify([
            name,
            version,
            description,
            listedSchema,
            result.budgetBytes,
            requires,
            mutates,
            requiredGate ?? null,
         ]),
         schemaSignature: JSON.stringify(listedSchema),
      },
   };
}

/**
 * Reduce an untrusted `bridge:registry` payload to the scripts that pass every budget. The payload must be
 * `{ apiVersion, scripts }`; entries are judged one by one: a refused entry is logged with its reason and dropped, the
 * others are kept. At most `ALWAYS_LISTED_TOOLS_MAX` less the sidecar's own tool count entries are accepted, and at
 * most twice `ALWAYS_LISTED_TOOLS_MAX` are examined; the rest are refused with one summary line, so a hostile payload
 * costs bounded work and bounded log output. The accepted tools' listed definitions, with the room kept for the
 * sidecar's own definitions, fit `ALL_DEFINITIONS_MAX_BYTES`; a tool that would overflow it is refused.
 * @param {unknown} payload - The untrusted payload.
 * @param {(line: string) => void} log - Receives one line per refusal or warning; callers pass a throttled logger.
 * @returns {RegistryOutcome} The accepted tools and the number of refused entries, or a failure when the payload is
 *          not a registry object of the current api version.
 */
export function sanitizeRegistry(payload: unknown, log: (line: string) => void): RegistryOutcome {
   // The payload opened to its raw entries.
   const opened: ReturnType<typeof parseRegistryPayload> = parseRegistryPayload(payload);
   if (!opened.ok) {
      return {
         ok: false,
         reason: opened.reason,
      };
   }
   // The raw entries.
   const entries: unknown[] = opened.scripts;
   // The most tools the always-listed budget leaves room for beside the sidecar's own tools.
   const room: number = getBudget('ALWAYS_LISTED_TOOLS_MAX').value - RESERVED_SCRIPT_NAMES.length;
   // The most entries examined, so an enormous array costs bounded work.
   const examineMax: number = 2 * getBudget('ALWAYS_LISTED_TOOLS_MAX').value;
   // The accepted tools.
   const tools: RegistryTool[] = [];
   // The listed bytes the accepted tools may still take: the total budget less the room kept for the sidecar's tools.
   let bytesLeft: number =
      getBudget('ALL_DEFINITIONS_MAX_BYTES').value -
      RESERVED_SCRIPT_NAMES.length * getBudget('DEFINITION_MAX_BYTES').value;
   // The names accepted so far, so a repeated name is refused.
   const seen: Set<string> = new Set();
   // The entries refused or never examined.
   let refused: number = 0;
   // The position of the entry being examined.
   let index: number = 0;
   for (; index < Math.min(entries.length, examineMax) && tools.length < room; index += 1) {
      // The entry's label in log lines: its name when it is a string, else its position.
      let label: string = `#${index}`;
      try {
         const entry: unknown = entries[index];
         if (isRecord(entry) && typeof ownValue(entry, 'name') === 'string') {
            label = cleanForLog(ownValue(entry, 'name') as string, LOG_LABEL_BYTES);
         }
         const outcome: ToolOutcome = sanitizeTool(entry, seen, bytesLeft);
         if (outcome.ok) {
            tools.push(outcome.tool);
            bytesLeft -= outcome.listedBytes;
            for (const warning of outcome.warnings) {
               log(
                  `Wiretap sidecar | registry warning for tool ${JSON.stringify(label)}: ` +
                     cleanForLog(warning, LOG_REASON_BYTES),
               );
            }
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
   const skipped: number = entries.length - index;
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
