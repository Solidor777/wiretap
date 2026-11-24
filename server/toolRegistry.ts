import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { z, type ZodRawShape, type ZodType } from 'zod';
import { getBudget } from '../shared/budgets.js';
import {
   USER_INTERACTION_TOOLS,
   definitionBytes,
   parseRegistryPayload,
   validateScriptDefinition,
} from '../shared/scripts.js';
import {
   KEYWORD_LABEL_MAX_CHARS,
   PROPERTY_NAME_PATTERN,
   SCHEMA_BOUND_MAX,
   SCHEMA_DEPTH_MAX,
   SCHEMA_ENUM_MAX,
   SCHEMA_ENUM_VALUE_MAX_CHARS,
   SCHEMA_EXPANDED_NODES_MAX,
   SCHEMA_GUIDELINES,
   SCHEMA_NODES_MAX,
   SCHEMA_PLUGIN_DEPTH_MAX,
   SCHEMA_PROPERTIES_MAX,
   COMMON_KEYWORDS,
   TYPE_KEYWORDS,
   guidelineWarning,
   isWellFormedDescription,
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
   /**
    * The MCP tool name: a shipped name of at most 32 characters of lowercase letters, digits, `_` and `-` starting with a
    * letter, or a plugin name `<moduleId>__<tool>` of at most 50 characters.
    */
   name: string;
   /** The script's version string. */
   version: string;
   /** The one-line description the client lists. */
   description: string;
   /** The argument shape converted from the received JSON Schema. */
   shape: ZodRawShape;
   /** Whether the root declared `additionalProperties: false`, so an undeclared argument is refused, not dropped. */
   strict: boolean;
   /** The script's own result budget in bytes. */
   budgetBytes: number;
   /** Where the script runs: any client endpoint, or only a DOM-capable one. */
   requires: RegistryRequires;
   /** Whether the script changes the world; listed to the client as the inverse of `readOnlyHint`. */
   mutates: boolean;
   /**
    * The gates a call must pass, judged in order against the routed endpoint's snapshot. A shipped tool has none or the
    * one it declared; a plugin tool has its module's `allowedPluginModules` entry first, then the gate it declared.
    */
   gates: RequiredGate[];
   /** The text arguments that may be given as a handle reference; empty when the tool takes none. */
   handleArgs: string[];
   /**
    * Whether the tool is listed with the user-interaction meta entry: the definition set the flag or the name is in
    * `USER_INTERACTION_TOOLS`.
    */
   requiresUserInteraction: boolean;
   /** A string that differs whenever any listed or routed property of the tool differs; used to detect changes. */
   signature: string;
   /** The argument schema as the SDK lists it; a call is refused when the picked endpoint declares another one. */
   schemaSignature: string;
}

/** The outcome of sanitizing a registry payload. */
export type RegistryOutcome =
   | {
        /** The payload was a registry object; `tools` holds the accepted entries. */
        ok: true;
        tools: RegistryTool[];
        /** Entries that were refused. */
        refused: number;
     }
   | {
        /** The payload was not a registry object of the current api version; no tool is accepted. */
        ok: false;
        reason: string;
     };

/** Who wrote a schema: Wiretap itself, or a plugin module; a plugin schema over a guideline warns instead of refusing. */
export type SchemaSource = 'shipped' | 'plugin';

/** The outcome of converting a JSON Schema; `warnings` is always empty for a shipped schema. */
export type ShapeOutcome =
   | { ok: true; shape: ZodRawShape; strict: boolean; warnings: string[] }
   | { ok: false; reason: string };

/** The outcome of sanitizing one entry. */
type ToolOutcome = { ok: true; tool: RegistryTool; warnings: string[] } | { ok: false; reason: string };

/** The state shared by one schema conversion. */
interface ConvertState {
   /** Schema nodes converted so far, the root included. */
   nodes: number;
   /** Whether every object below the root refuses an undeclared key, without saying so in the listed schema. */
   strictNested: boolean;
   /** Who wrote the schema; decides whether a guideline refuses or warns. */
   source: SchemaSource;
   /** The largest measured value of each guideline a plugin schema passed. */
   measured: Map<string, number>;
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
 * Hold a schema to one complexity guideline: a shipped schema over it is refused, and a plugin schema over it records
 * the measured value, keeping the largest, for one warning after the walk. Mirrors `holdGuideline` of
 * `shared/schemaValidate.js`.
 * @param {ConvertState} state - The conversion state.
 * @param {string} guideline - A name from `SCHEMA_GUIDELINES`.
 * @param {number} measured - The measured value.
 * @param {number} limit - The guideline's largest allowed value.
 * @param {string} refusal - The reason a shipped schema is refused with.
 * @returns {void}
 */
function holdGuideline(
   state: ConvertState,
   guideline: string,
   measured: number,
   limit: number,
   refusal: string,
): void {
   if (measured <= limit) {
      return;
   }
   if (state.source !== 'plugin') {
      throw new SchemaRefusal(refusal);
   }
   state.measured.set(guideline, Math.max(measured, state.measured.get(guideline) ?? measured));
}

/**
 * Read a length or item bound: absent, or a non-negative integer held to the bound guideline.
 * @param {Record<string, unknown>} node - The schema node.
 * @param {string} keyword - `minLength`, `maxLength`, `minItems` or `maxItems`.
 * @param {ConvertState} state - The conversion state.
 * @param {string} [overGuideline] - The reason a shipped bound over the guideline is refused with; by default it names
 * the guideline's limit.
 * @returns {number | undefined} The bound, or undefined when the node does not declare it.
 */
function readBound(
   node: Record<string, unknown>,
   keyword: string,
   state: ConvertState,
   overGuideline: string = `${keyword} must be at most ${SCHEMA_BOUND_MAX}`,
): number | undefined {
   // The declared bound.
   const value: unknown = ownValue(node, keyword);
   if (value === undefined) {
      return undefined;
   }
   if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new SchemaRefusal(`${keyword} must be a non-negative integer`);
   }
   holdGuideline(state, 'bound', value, SCHEMA_BOUND_MAX, overGuideline);
   return value;
}

/**
 * Convert one schema node to a zod type; throws a SchemaRefusal for anything outside the supported subset.
 * @param {unknown} node - The JSON Schema node.
 * @param {number} depth - The nesting level of this node (the root object is 1).
 * @param {ConvertState} state - The conversion state.
 * @returns {ZodType} The zod type.
 */
function convertNode(node: unknown, depth: number, state: ConvertState): ZodType {
   state.nodes += 1;
   if (state.nodes > SCHEMA_EXPANDED_NODES_MAX) {
      // Checked before anything else of the node, so a reused object costs at most this many node visits.
      throw new SchemaRefusal(
         `schema expands to more than ${SCHEMA_EXPANDED_NODES_MAX} nodes, more than one registry message can carry`,
      );
   }
   holdGuideline(state, 'nodes', state.nodes, SCHEMA_NODES_MAX, `schema has more than ${SCHEMA_NODES_MAX} nodes`);
   if (!isRecord(node)) {
      throw new SchemaRefusal('a schema node is not an object');
   }
   // The node's declared type.
   const type: unknown = ownValue(node, 'type');
   if (typeof type !== 'string' || !Object.hasOwn(TYPE_KEYWORDS, type)) {
      throw new SchemaRefusal('type must be one of string, number, integer, boolean, array or object');
   }
   if (type === 'object' || type === 'array') {
      // Checked before descending, so the recursion never nests more than one level past the ceiling.
      if (depth > SCHEMA_PLUGIN_DEPTH_MAX) {
         throw new SchemaRefusal(`schema nests objects and arrays deeper than ${SCHEMA_PLUGIN_DEPTH_MAX} levels`);
      }
      holdGuideline(
         state,
         'depth',
         depth,
         SCHEMA_DEPTH_MAX,
         `schema nests objects and arrays deeper than ${SCHEMA_DEPTH_MAX} levels`,
      );
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
         const minLength: number | undefined = readBound(node, 'minLength', state);
         const maxLength: number | undefined = readBound(node, 'maxLength', state);
         if (minLength !== undefined) {
            text = text.min(minLength);
         }
         if (maxLength !== undefined) {
            text = text.max(maxLength);
         }
         const values: unknown = ownValue(node, 'enum');
         if (values === undefined) {
            result = text;
            break;
         }
         if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === 'string')) {
            throw new SchemaRefusal('enum must be a non-empty list of strings');
         }
         // The reason a shipped enum over a guideline is refused with.
         const enumReason: string = `enum must hold 1 to ${SCHEMA_ENUM_MAX} short strings`;
         holdGuideline(state, 'enumValues', values.length, SCHEMA_ENUM_MAX, enumReason);
         holdGuideline(
            state,
            'enumValueChars',
            (values as string[]).reduce((longest, value) => Math.max(longest, value.length), 0),
            SCHEMA_ENUM_VALUE_MAX_CHARS,
            enumReason,
         );
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
         const minItems: number | undefined = readBound(node, 'minItems', state);
         if (minItems !== undefined) {
            list = list.min(minItems);
         }
         // The item cap guideline, which binds every shipped array.
         const itemsCap: number = getBudget('SCHEMA_ARRAY_ITEMS_MAX').value;
         // The reason a shipped array over the item guideline is refused with.
         const capReason: string = `an array schema needs a maxItems of 0 to ${itemsCap}`;
         // The declared item cap; a plugin array may leave it out and is then listed and parsed without one. A shipped
         // maxItems over the bound guideline is also over the tighter item cap, so it is refused with the cap text.
         const maxItems: number | undefined = readBound(node, 'maxItems', state, capReason);
         if (maxItems === undefined) {
            // A missing cap counts as one array over the guideline; its warning carries no measured value.
            holdGuideline(state, 'maxItemsMissing', 1, 0, capReason);
         } else {
            holdGuideline(state, 'maxItems', maxItems, itemsCap, capReason);
            list = list.max(maxItems);
         }
         result = list;
         break;
      }
      default: {
         // An object that declares `additionalProperties: false` refuses what it does not declare; any other drops it.
         const object: z.ZodObject = z.object(convertObjectShape(node, depth, state));
         if (ownValue(node, 'additionalProperties') === false) {
            result = object.strict();
         } else if (state.strictNested && depth > 1) {
            // Strict to parse, but the listed schema omits `additionalProperties: false`, which would cost definition
            // bytes in every entry object. Overriding the key with undefined drops it from the JSON output.
            result = object.strict().meta({ additionalProperties: undefined } as never);
         } else {
            result = object;
         }
         break;
      }
   }
   // Every node's description is validated here. Only an object property's description is attached (by
   // `convertObjectShape`, which owns the optional wrapper); a description on the root or on array items is validated
   // and not listed.
   const description: unknown = ownValue(node, 'description');
   if (description !== undefined) {
      if (!isWellFormedDescription(description)) {
         throw new SchemaRefusal('description must be a non-empty single-line string');
      }
      holdGuideline(
         state,
         'descriptionChars',
         description.length,
         getBudget('DESCRIPTION_MAX_CHARS').value,
         'description must be a short single-line string',
      );
   }
   return result;
}

/**
 * Convert an object schema's properties to a zod shape: each property is required only when `required` lists it.
 * @param {Record<string, unknown>} node - The object schema node.
 * @param {number} depth - The nesting level of the object.
 * @param {ConvertState} state - The conversion state.
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
   // The property names, for constant-time lookups that keep the conversion linear in the schema.
   const declared: Set<string> = new Set(names);
   holdGuideline(
      state,
      'properties',
      names.length,
      SCHEMA_PROPERTIES_MAX,
      `an object schema has more than ${SCHEMA_PROPERTIES_MAX} properties`,
   );
   const requiredList: unknown = ownValue(node, 'required') ?? [];
   if (!Array.isArray(requiredList) || !requiredList.every((name) => typeof name === 'string')) {
      throw new SchemaRefusal('required must be an array of property names');
   }
   // The names a value must set, for constant-time lookups.
   const requiredNames: Set<string> = new Set(requiredList as string[]);
   for (const name of requiredNames) {
      if (!declared.has(name)) {
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
      if (!requiredNames.has(name)) {
         type = type.optional();
      }
      // The description sits on the outermost type so the SDK lists it.
      const description: unknown = ownValue(properties[name] as object, 'description');
      shape[name] = typeof description === 'string' ? type.describe(description) : type;
   }
   return shape;
}

/**
 * The zod schema that judges the arguments of a registry tool: its shape as an object, strict when the root declared
 * `additionalProperties: false`.
 * @param {{ shape: ZodRawShape, strict: boolean }} converted - The converted shape and whether the root is strict.
 * @returns {z.ZodObject} The argument schema.
 */
export function argumentSchema(converted: { shape: ZodRawShape; strict: boolean }): z.ZodObject {
   const object: z.ZodObject = z.object(converted.shape);
   return converted.strict ? object.strict() : object;
}

/**
 * Convert the JSON Schema of a tool's arguments to a zod shape. Only a small, documented subset is supported: a root
 * `object` whose properties are `string` (with `enum`, `minLength`, `maxLength`), `number`, `integer` (with `minimum`,
 * `maximum`), `boolean`, `array` (with `items`, `minItems`, `maxItems`) or nested `object`, each with an optional
 * `description`; `required`; and `additionalProperties: false`. Every other keyword (references, combinators,
 * patterns, formats, defaults, constants) refuses the schema for every source: a pattern is attacker-supplied
 * regular-expression work and a combinator or reference cannot be bounded. Server protection, for every source: nesting
 * deeper than `SCHEMA_PLUGIN_DEPTH_MAX` levels is refused, so the recursive conversion cannot overflow the stack, and a
 * schema whose walk expands past `SCHEMA_EXPANDED_NODES_MAX` nodes (a reused object counted every time it appears) is
 * refused, so a schema that reuses one object at several levels costs bounded work. Name lookups use sets, so the
 * conversion is linear in the schema.
 * Plugin switch: the complexity guidelines of `shared/schemaValidate.js` (`SCHEMA_GUIDELINES`) refuse a `shipped`
 * schema and only warn for a `plugin` one, with the same rules and texts as `compileSchema` there; a plugin array
 * without `maxItems` has no `.max()`.
 * @param {unknown} schema - The untrusted JSON Schema.
 * @param {boolean} [strictNested] - Whether every object below the root refuses an undeclared key.
 * @param {SchemaSource} [source] - Who wrote the schema; `shipped` by default.
 * @returns {ShapeOutcome} The shape and the guideline warnings, or the short reason the schema is refused.
 */
export function jsonSchemaToZodShape(
   schema: unknown,
   strictNested: boolean = false,
   source: SchemaSource = 'shipped',
): ShapeOutcome {
   try {
      if (!isRecord(schema) || ownValue(schema, 'type') !== 'object') {
         throw new SchemaRefusal('the schema root must be an object schema');
      }
      // Run the whole-node checks once on the root, then take its property shape.
      const state: ConvertState = {
         nodes: 0,
         strictNested,
         source,
         measured: new Map(),
      };
      const root: ZodType = convertNode(schema, 1, state);
      return {
         ok: true,
         shape: (root as z.ZodObject).shape,
         strict: ownValue(schema, 'additionalProperties') === false,
         warnings: SCHEMA_GUIDELINES.filter((guideline) => state.measured.has(guideline)).map((guideline) => {
            return guidelineWarning(guideline, state.measured.get(guideline) as number);
         }),
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
 * Validate one registry entry with the shared script validator, then convert its argument schema. An entry with an own
 * `moduleId` that is not undefined takes the plugin route: the per-tool guidelines (description, result budget, schema
 * complexity, listed size) warn instead of refusing, and the tool is gated by its module before its declared gate.
 * Every other entry takes the shipped route, where each guideline refuses. Reads own properties only; nothing of the
 * received object is kept.
 * @param {unknown} entry - The untrusted entry.
 * @param {Set<string>} seen - The names accepted so far in this payload.
 * @returns {ToolOutcome} The tool and its warnings (the validator's, then the schema's, then the listed size's), or the
 *          reason the entry is refused.
 */
function sanitizeTool(entry: unknown, seen: Set<string>): ToolOutcome {
   // The route the entry registers through, chosen by the module id it carries.
   const source: SchemaSource =
      isRecord(entry) && ownValue(entry, 'moduleId') !== undefined ? 'plugin' : 'shipped';
   // The shared validator's verdict on the definition.
   const validated: ReturnType<typeof validateScriptDefinition> = validateScriptDefinition(entry, source);
   if (!validated.ok) {
      return validated;
   }
   // The normalized definition.
   const {
      name,
      version,
      description,
      inputSchema,
      result,
      requires,
      mutates,
      moduleId,
      gate,
      handleArgs,
      strictNested,
      requiresUserInteraction,
   } = validated.definition;
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
   const converted: ShapeOutcome = jsonSchemaToZodShape(inputSchema, strictNested === true, source);
   if (!converted.ok) {
      return converted;
   }
   // The schema as the SDK lists it, which is what the client's context pays for.
   const listedSchema: unknown = toJsonSchemaCompat(argumentSchema(converted), {
      strictUnions: true,
      pipeStrategy: 'input',
   });
   const listed: number = definitionBytes(name, description, listedSchema);
   const maxDefinition: number = getBudget('DEFINITION_MAX_BYTES').value;
   // The findings of an accepted entry, in the order they are logged.
   const warnings: string[] = [
      ...validated.warnings,
      ...converted.warnings,
   ];
   if (listed > maxDefinition) {
      if (source !== 'plugin') {
         return {
            ok: false,
            reason: `listed definition is ${listed} bytes, at most ${maxDefinition} bytes`,
         };
      }
      warnings.push(`listed definition is ${listed} bytes, over the ${maxDefinition}-byte guideline`);
   }
   // The gates a call must pass: a plugin tool's module first, then the gate the script declared.
   const gates: RequiredGate[] = [
      ...(source === 'plugin'
         ? [
              {
                 gate: 'allowedPluginModules',
                 moduleId: moduleId as string,
              },
           ]
         : []),
      ...(gate === undefined ? [] : [{ gate }]),
   ];
   // Whether the human is prompted before every call; forced by name so no client can list such a tool without it.
   const prompted: boolean = requiresUserInteraction === true || USER_INTERACTION_TOOLS.includes(name);
   seen.add(name);
   return {
      ok: true,
      warnings,
      tool: {
         name,
         version,
         description,
         shape: converted.shape,
         strict: converted.strict,
         budgetBytes: result.budgetBytes,
         requires,
         mutates,
         gates,
         handleArgs: handleArgs ?? [],
         requiresUserInteraction: prompted,
         signature: JSON.stringify([
            name,
            version,
            description,
            listedSchema,
            result.budgetBytes,
            requires,
            mutates,
            gates,
            handleArgs ?? [],
            strictNested === true,
            prompted,
         ]),
         schemaSignature: JSON.stringify([
            listedSchema,
            handleArgs ?? [],
            strictNested === true,
         ]),
      },
   };
}

/**
 * Reduce an untrusted `bridge:registry` payload to the scripts that pass their checks. The payload must be
 * `{ apiVersion, scripts }`; every entry is judged, one by one: a refused entry is logged with its reason and dropped, an
 * accepted entry's warnings are logged, and the accepted entries are kept. There is no bound on the number of tools or
 * on their total size: the payload is bounded by the Socket.IO `maxHttpBufferSize` (1,000,000 bytes), and the caller's
 * throttled logger bounds the log output.
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
   // The accepted tools.
   const tools: RegistryTool[] = [];
   // The names accepted so far, so a repeated name is refused.
   const seen: Set<string> = new Set();
   // The entries refused.
   let refused: number = 0;
   for (let index: number = 0; index < entries.length; index += 1) {
      // The entry's label in log lines: its name when it is a string, else its position.
      let label: string = `#${index}`;
      try {
         const entry: unknown = entries[index];
         if (isRecord(entry) && typeof ownValue(entry, 'name') === 'string') {
            label = cleanForLog(ownValue(entry, 'name') as string, LOG_LABEL_BYTES);
         }
         const outcome: ToolOutcome = sanitizeTool(entry, seen);
         if (outcome.ok) {
            tools.push(outcome.tool);
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
   return {
      ok: true,
      tools,
      refused,
   };
}
