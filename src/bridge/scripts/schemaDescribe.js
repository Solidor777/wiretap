/**
 * The document-level part of `describe_schema`: the blank example of a document class and subtype, the one-level
 * outline of its schema, and the subtree and constraints at a path. The blank example goes through the canonical
 * export, so the exclusions apply (a User example has no password field). The result is held to
 * `DESCRIBE_SCHEMA_MAX_BYTES` by construction: the example is cut first, then the outlines, and a path result narrows
 * its depth.
 */

import { getBudget } from '$shared/budgets.js';
import { cleanForLog } from '$shared/logText.js';
import { truncateUtf8, utf8Bytes } from '$shared/utf8.js';
import { USER_EXCLUDED_FIELDS, exportDocument } from '~/bridge/scripts/canonical.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { createWalkState, describeField, outlineFields, stepInto } from '~/bridge/scripts/schemaWalk.js';

/**
 * Longest caller text echoed in an error, in UTF-8 bytes.
 * @type {number}
 */
const ECHO_MAX_BYTES = 48;

/**
 * Longest construction error text kept in a log line, in UTF-8 bytes.
 * @type {number}
 */
const LOG_CAUSE_MAX_BYTES = 120;

/**
 * Longest error message, in UTF-8 bytes.
 * @type {number}
 */
const MESSAGE_MAX_BYTES = 256;

/**
 * Most example keys listed when the example is cut.
 * @type {number}
 */
const EXAMPLE_KEYS_MAX = 40;

/**
 * Most outline entries kept when an outline is shortened to fit.
 * @type {number}
 */
const OUTLINE_SHORT_MAX = 40;

/**
 * The data a blank example of some classes needs to construct at all: construction fails without it.
 * @type {Readonly<Record<string, Record<string, unknown>>>}
 */
const MINIMAL_DATA = Object.freeze({
   Setting: { key: 'core.example' },
   Wall: {
      c: [
         0,
         0,
         100,
         0,
      ],
   },
   Tile: {
      width: 100,
      height: 100,
   },
   Drawing: {
      shape: {
         type: 'r',
         width: 100,
         height: 100,
      },
   },
});

/**
 * @typedef {object} DescribeParams
 * @property {string} documentName - The document class.
 * @property {string} [subtype] - The subtype; the base type (or the first type) when omitted.
 * @property {string} [path] - A dotted path into the schema.
 */

/**
 * List the valid subtypes in an error message that fits `MESSAGE_MAX_BYTES`.
 * @param {string} documentName - The class.
 * @param {string} subtype - The refused subtype.
 * @param {string[]} types - The valid subtypes.
 * @returns {string} The error text, at most 256 bytes.
 */
function unknownSubtypeMessage(documentName, subtype, types) {
   /** @type {string} The text before the list. */
   const prefix = `Unknown subtype '${cleanForLog(subtype, ECHO_MAX_BYTES)}' of ${documentName}. Valid: `;
   /** @type {string[]} The types listed whole. */
   const listed = [];
   for (const type of types) {
      if (utf8Bytes(`${prefix}${[
         ...listed,
         type,
      ].join(', ')} (+99 more)`) > MESSAGE_MAX_BYTES) {
         break;
      }
      listed.push(type);
   }
   /** @type {number} The types left out of the list. */
   const more = types.length - listed.length;
   return `${prefix}${listed.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

/**
 * Build the blank example export of a class and subtype in memory, never persisted. A class whose construction fails
 * is reported without throwing.
 * @param {string} documentName - The class.
 * @param {string | undefined} subtype - The subtype the blank is built for, when the class has subtypes.
 * @param {{ fields: Record<string, object> }} schema - The class's schema.
 * @param {(line: string) => void} log - Receives one sanitized, bounded line when the construction fails.
 * @returns {{ example: Record<string, unknown> | null, note?: string }} The example, or null with the reason.
 */
function blankExample(documentName, subtype, schema, log) {
   /** @type {Record<string, unknown>} The construction data. */
   const data = { ...(MINIMAL_DATA[documentName] ?? {}) };
   if (Object.hasOwn(schema.fields, 'name')) {
      data.name = 'Example';
   }
   if (subtype !== undefined && Object.hasOwn(schema.fields, 'type')) {
      data.type = subtype;
   }
   try {
      /** @type {object} The blank document. */
      const blank = new globalThis.CONFIG[documentName].documentClass(data);
      /** @type {ReturnType<typeof exportDocument>} Its canonical export. */
      const outcome = exportDocument(blank, {});
      if (!outcome.ok) {
         return {
            example: null,
            note: outcome.message,
         };
      }
      return { example: outcome.data };
   } catch (cause) {
      log(
         `Wiretap | describe_schema blank ${cleanForLog(documentName, ECHO_MAX_BYTES)} failed: ` +
            cleanForLog(cause?.message, LOG_CAUSE_MAX_BYTES),
      );
      return {
         example: null,
         note: 'A blank document of this class cannot be built without a parent or more data.',
      };
   }
}

/**
 * Build a coded error.
 * @param {string} code - The error code.
 * @param {string} message - The message, cut to the error limit.
 * @returns {ScriptError} The error.
 */
function fail(code, message) {
   return new ScriptError(code, truncateUtf8(message, MESSAGE_MAX_BYTES));
}

/**
 * Measure a result as the JSON text a tool returns.
 * @param {unknown} value - The result.
 * @returns {number} Its UTF-8 bytes.
 */
function jsonBytes(value) {
   return utf8Bytes(JSON.stringify(value));
}

/**
 * Resolve the document class, its schema and the subtype of a request.
 * @param {DescribeParams} params - The class name, the optional subtype and the optional path.
 * @returns {{ documentName: string, subtype: string | undefined, schema: { fields: Record<string, object> } }} The
 * resolved request.
 * @throws {ScriptError} `ARGS_INVALID` for an unknown class or subtype.
 */
function resolveRequest(params) {
   /** @type {DescribeParams} The request fields read below. */
   const { documentName } = params;
   if (
      !CONST.ALL_DOCUMENT_TYPES.includes(documentName) ||
      globalThis.CONFIG?.[documentName]?.documentClass === undefined
   ) {
      throw fail('ARGS_INVALID', `Unknown documentName '${cleanForLog(documentName, ECHO_MAX_BYTES)}'.`);
   }
   /** @type {string[]} The subtypes the world declares for the class. */
   const types = game.documentTypes?.[documentName] ?? [];
   /** @type {string | undefined} The subtype used. */
   let subtype = params.subtype;
   if (subtype === undefined) {
      subtype = types.includes(CONST.BASE_DOCUMENT_TYPE) ? CONST.BASE_DOCUMENT_TYPE : types[0];
   } else if (!types.includes(subtype)) {
      throw fail('ARGS_INVALID', unknownSubtypeMessage(documentName, subtype, types));
   }
   return {
      documentName,
      subtype,
      schema: CONFIG[documentName].documentClass.schema,
   };
}

/**
 * Describe a document class without a path: the blank example and the one-level outlines.
 * @param {ReturnType<typeof resolveRequest>} request - The resolved request.
 * @param {(line: string) => void} log - The log sink for a failed blank.
 * @returns {Record<string, unknown>} The description, within the budget.
 */
function describeWhole(request, log) {
   /** @type {ReturnType<typeof resolveRequest>} The resolved class, subtype and schema. */
   const { documentName, subtype, schema } = request;
   const state = createWalkState({
      documentName,
      subtype,
      topLevel: true,
   });
   /** @type {ReturnType<typeof blankExample>} The blank example. */
   const blank = blankExample(documentName, subtype, schema, log);
   /** @type {Record<string, unknown>} The description. */
   const result = {
      documentName,
      ...(subtype === undefined ? {} : { subtype }),
      example: blank.example,
      ...(blank.note === undefined ? {} : { exampleNote: blank.note }),
      outline: outlineFields(schema, state),
   };
   /** @type {{ fields: Record<string, object> } | undefined} The schema of the subtype's `system`. */
   const system = CONFIG[documentName]?.dataModels?.[subtype]?.schema;
   if (Object.hasOwn(schema.fields, 'system') && system?.fields !== undefined) {
      result.systemOutline = outlineFields(system, createWalkState({
         documentName,
         subtype,
      }));
   }
   /** @type {number} The largest result. */
   const limit = getBudget('DESCRIBE_SCHEMA_MAX_BYTES').value;
   if (jsonBytes(result) > limit && blank.example !== null) {
      result.exampleKeys = Object.keys(blank.example).slice(0, EXAMPLE_KEYS_MAX);
      result.example = undefined;
      result.exampleCut = true;
   }
   for (const key of [
      'outline',
      'systemOutline',
   ]) {
      if (jsonBytes(result) > limit && Array.isArray(result[key])) {
         result[key] = result[key].slice(0, OUTLINE_SHORT_MAX);
         result.outlineCut = true;
      }
   }
   while (jsonBytes(result) > limit && (result.outline.length > 0 || result.systemOutline?.length > 0)) {
      result.outline.pop();
      result.systemOutline?.pop();
      result.outlineCut = true;
   }
   return JSON.parse(JSON.stringify(result));
}

/**
 * Read the blank example at a path, by own properties only.
 * @param {unknown} example - The blank export.
 * @param {string[]} segments - The path segments.
 * @returns {unknown} The subtree, or undefined when the example has none.
 */
function exampleAt(example, segments) {
   /** @type {unknown} The node reached so far. */
   let node = example;
   for (const segment of segments) {
      if (node === null || typeof node !== 'object' || !Object.hasOwn(node, segment)) {
         return undefined;
      }
      node = node[segment];
   }
   return node;
}

/**
 * Describe the subtree and constraints at a path.
 * @param {ReturnType<typeof resolveRequest>} request - The resolved request.
 * @param {string} path - The dotted path.
 * @param {(line: string) => void} log - The log sink for a failed blank.
 * @returns {Record<string, unknown>} The description, within the budget.
 * @throws {ScriptError} A `PATH_*` error for a path that cannot be described.
 */
function describePath(request, path, log) {
   /** @type {ReturnType<typeof resolveRequest>} The resolved class, subtype and schema. */
   const { documentName, subtype, schema } = request;
   /** @type {string[]} The path segments. */
   const segments = path.split('.');
   if (utf8Bytes(path) > getBudget('PATH_BYTES_MAX').value || segments.length > getBudget('PATH_SEGMENTS_MAX').value) {
      throw fail('PATH_LIMIT', 'The path is too long.');
   }
   if (segments.some((segment) => segment === '')) {
      throw fail('PATH_INVALID', 'A path has no empty segments.');
   }
   if (documentName === 'User' && USER_EXCLUDED_FIELDS.includes(segments[0])) {
      throw fail('PATH_EXCLUDED', 'This field is not described.');
   }
   const walkState = createWalkState({
      documentName,
      subtype,
      topLevel: true,
   });
   /** @type {object} The field reached by the path. */
   let field = schema;
   for (const segment of segments) {
      /** @type {ReturnType<typeof stepInto>} The outcome of moving one segment down the schema. */
      const step = stepInto(field, segment, walkState);
      if (!step.ok) {
         throw fail(step.code, step.message);
      }
      field = step.field;
   }
   /** @type {ReturnType<typeof blankExample>} The blank example. */
   const blank = blankExample(documentName, subtype, schema, log);
   /** @type {unknown} The blank subtree. */
   const subtree = blank.example === null ? undefined : exampleAt(blank.example, segments);
   /** @type {number} The largest result. */
   const limit = getBudget('DESCRIBE_SCHEMA_MAX_BYTES').value;
   /** @type {Record<string, unknown>} The result under construction. */
   let result = {};
   for (let depthMax = 3; depthMax >= 0; depthMax -= 1) {
      const state = createWalkState({
         documentName,
         subtype,
         depthMax,
      });
      result = {
         documentName,
         ...(subtype === undefined ? {} : { subtype }),
         path,
         ...(subtree === undefined ? {} : { example: subtree }),
         schema: describeField(field, state, 0),
         ...(state.cut || depthMax < 3 ? { cut: true } : {}),
      };
      if (jsonBytes(result) <= limit) {
         return JSON.parse(JSON.stringify(result));
      }
      if (subtree !== undefined) {
         // The example is cut before the schema loses depth: the schema is what constrains a write.
         delete result.example;
         result.exampleCut = true;
         if (jsonBytes(result) <= limit) {
            return JSON.parse(JSON.stringify(result));
         }
      }
   }
   delete result.example;
   result.exampleCut = true;
   return JSON.parse(JSON.stringify(result));
}

/**
 * Describe a document class and subtype, or a path inside its schema.
 * @param {DescribeParams} params - The request.
 * @param {(line: string) => void} log - The log sink for a blank example that cannot be built.
 * @returns {Record<string, unknown>} The description, within `DESCRIBE_SCHEMA_MAX_BYTES`.
 * @throws {ScriptError} `ARGS_INVALID` or a `PATH_*` code.
 */
export function describeSchema(params, log) {
   /** @type {ReturnType<typeof resolveRequest>} The resolved request. */
   const request = resolveRequest(params);
   return params.path === undefined ? describeWhole(request, log) : describePath(request, params.path, log);
}
