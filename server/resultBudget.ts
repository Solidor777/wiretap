import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getBudget } from '../shared/budgets.js';
import { BridgeError, formatBridgeError } from './endpoints.ts';
import type { HandleStore, PutResult } from './handles.ts';
import { describeCause } from './logText.ts';
import { truncateUtf8 } from './utf8.ts';

// Most top-level keys a summary lists, and how many of them get a count.
const SUMMARY_KEYS_MAX: number = 8;

// Longest key, `name` and `type` text in a summary, in UTF-8 bytes.
const SUMMARY_TEXT_BYTES: number = 32;

// PNG file signature followed by the length (13) and the `IHDR` tag of the first chunk.
const PNG_PREFIX: Buffer = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// Bytes of a PNG that hold the prefix, the width and the height.
const PNG_HEADER_BYTES: number = 24;

// The only MIME type an image may carry.
const PNG_MIME_TYPE: string = 'image/png';

// Standard base64: the alphabet, then at most two padding characters at the end; no whitespace, no URL-safe variant.
const BASE64_PATTERN: RegExp = /^[A-Za-z0-9+/]*={0,2}$/;

// The fixed error text for a result the enforcer cannot read or process.
const INVALID_RESULT_MESSAGE: string = 'Tool returned an invalid result.';

// The fixed error text for a handler that threw something other than a BridgeError.
const TOOL_FAILED_MESSAGE: string = 'Tool failed.';

// Longest cause text written to the server log, in UTF-8 bytes.
const LOG_CAUSE_BYTES: number = 512;

/** A tool callback: the validated arguments in, an MCP tool result out. */
export type ToolHandler<Args> = (args: Args, extra?: unknown) => Promise<CallToolResult>;

/** What the enforcer needs besides the handler. */
export interface ResultBudgetOptions {
   /** The store that receives results over the limit. */
   store: HandleStore;
   /** The owner key that may read those handles back. */
   ownerKey: string;
   /**
    * Whether the owner still exists. When it returns false an over-limit result is answered with a `SESSION_ENDED`
    * error instead of being stored, since no one could read the handle. Absent means the owner always exists.
    */
   ownerLive?: () => boolean;
   /** The tool's own result budget in bytes; the effective limit is the smaller of this and the hard cap. */
   budgetBytes?: number;
}

/** A deterministic description of a stored result. */
export interface ResultSummary {
   kind: 'object' | 'array' | 'text';
   /** Top-level key count, array length or character count. */
   n: number;
   /** The first top-level keys of an object in JavaScript property order (integer-like keys first). */
   keys?: string[];
   /** Entry counts of the listed keys whose values are arrays or objects. */
   counts?: Record<string, number>;
   /** How many of the first keys were left out of `keys` because they collide with an earlier key once shortened. */
   omitted?: number;
   /** The top-level `name` when it is a string. */
   name?: string;
   /** The top-level `type` when it is a string. */
   type?: string;
}

/**
 * Build an error tool result.
 * @param {string} text - The error text, already within its budget.
 * @returns {CallToolResult} The result.
 */
function errorResult(text: string): CallToolResult {
   return {
      content: [
         {
            type: 'text',
            text,
         },
      ],
      isError: true,
   };
}

/**
 * Write one line to the server log: what failed and a bounded cause. The line never reaches the tool caller. The cause
 * comes from handler output, so `describeCause` replaces control characters and line breaks: it cannot forge lines.
 * @param {string} what - What failed.
 * @param {unknown} cause - The thrown value.
 * @returns {void}
 */
function logFailure(what: string, cause: unknown): void {
   console.warn(`Wiretap sidecar | ${what}: ${describeCause(cause, LOG_CAUSE_BYTES)}`);
}

/**
 * Turn a value a handler threw into an error result. A BridgeError carries a bounded code and message meant for the
 * caller and passes as `<code>: <message>`; anything else becomes a fixed generic text and its real message goes to
 * the server log.
 * @param {unknown} err - The thrown value.
 * @returns {CallToolResult} The error result, within the error budget.
 */
export function failureResult(err: unknown): CallToolResult {
   if (err instanceof BridgeError) {
      return errorResult(truncateUtf8(formatBridgeError(err), getBudget('ERROR_MAX_BYTES').value));
   }
   logFailure('tool failed', err);
   return errorResult(TOOL_FAILED_MESSAGE);
}

/**
 * Check the shape the enforcer relies on: an object whose `content` is an array of objects with a string `type`, and
 * string `text` on every text item.
 * @param {unknown} result - What the handler returned.
 * @returns {void}
 * @throws {Error} When the shape is wrong.
 */
function assertResultShape(result: unknown): asserts result is CallToolResult {
   if (typeof result !== 'object' || result === null) {
      throw new Error('result is not an object');
   }
   // The candidate's content.
   const content: unknown = (result as { content?: unknown }).content;
   if (!Array.isArray(content)) {
      throw new Error('result content is not an array');
   }
   for (const item of content as unknown[]) {
      if (typeof item !== 'object' || item === null || typeof (item as { type?: unknown }).type !== 'string') {
         throw new Error('a content item is not an object with a string type');
      }
      if ((item as { type: string }).type === 'text' && typeof (item as { text?: unknown }).text !== 'string') {
         throw new Error('a text item has no string text');
      }
   }
}

/**
 * Read the width and height from the first chunk of a base64 PNG without decoding the image.
 * @param {string} data - The base64 text, already checked against the base64 alphabet.
 * @returns {{ width: number; height: number } | null} The size, or null when it is not a readable PNG header.
 */
function readPngSize(data: string): { width: number; height: number } | null {
   // The first 24 decoded bytes come from the first 32 base64 characters.
   const head: Buffer = Buffer.from(data.slice(0, 32), 'base64');
   if (head.length < PNG_HEADER_BYTES || !head.subarray(0, PNG_PREFIX.length).equals(PNG_PREFIX)) {
      return null;
   }
   return {
      width: head.readUInt32BE(16),
      height: head.readUInt32BE(20),
   };
}

/**
 * Check the images of a result: at most one, each `image/png` with plain base64 data within the data budget and a
 * longest side within the side budget.
 * @param {CallToolResult['content']} content - The content items.
 * @returns {string | null} The refusal text, or null when the images are acceptable.
 */
function checkImages(content: CallToolResult['content']): string | null {
   // The image items.
   const images: CallToolResult['content'] = content.filter((item) => item.type === 'image');
   // Most images one result may carry.
   const maxImages: number = getBudget('IMAGE_MAX_PER_RESULT').value;
   // Longest side an image may have.
   const maxSide: number = getBudget('IMAGE_MAX_SIDE_PIXELS').value;
   // Most base64 characters one image may carry.
   const maxData: number = getBudget('IMAGE_DATA_MAX_BYTES').value;
   if (images.length > maxImages) {
      return `IMAGE_LIMIT: at most ${maxImages} image per result.`;
   }
   for (const item of images) {
      // The fields the checks read, whatever the item carries.
      const fields: { data?: unknown; mimeType?: unknown } = item as { data?: unknown; mimeType?: unknown };
      if (fields.mimeType !== PNG_MIME_TYPE) {
         return `IMAGE_LIMIT: only ${PNG_MIME_TYPE} images are accepted.`;
      }
      if (typeof fields.data !== 'string') {
         return 'IMAGE_LIMIT: the image data must be a base64 string.';
      }
      if (fields.data.length > maxData) {
         return `IMAGE_LIMIT: image data is ${fields.data.length} characters; at most ${maxData}.`;
      }
      if (!BASE64_PATTERN.test(fields.data)) {
         return 'IMAGE_LIMIT: image data is not plain base64.';
      }
      // The decoded size of this image.
      const size: { width: number; height: number } | null = readPngSize(fields.data);
      if (size === null) {
         return 'IMAGE_LIMIT: the image size could not be read; only PNG is accepted.';
      }
      if (Math.max(size.width, size.height) > maxSide) {
         return `IMAGE_LIMIT: image is ${size.width}x${size.height}; the longest side is at most ${maxSide} px.`;
      }
   }
   return null;
}

/**
 * Copy a content item keeping only the fields the enforcer measured: an image item as exactly `type`, `data` and
 * `mimeType` (after `checkImages`), a text item as exactly `type` and `text`. An item of any other type is measured as
 * its whole JSON, so it is returned as it is.
 * @param {CallToolResult['content'][number]} item - A shape-checked content item.
 * @returns {CallToolResult['content'][number]} The rebuilt item.
 */
function rebuildItem(item: CallToolResult['content'][number]): CallToolResult['content'][number] {
   if (item.type === 'image') {
      return {
         type: 'image',
         data: item.data,
         mimeType: item.mimeType,
      };
   }
   if (item.type === 'text') {
      return {
         type: 'text',
         text: item.text,
      };
   }
   return item;
}

/**
 * Describe a result's content as text: text items as they are, any other non-image item as its JSON.
 * @param {CallToolResult} result - The result, already shape-checked.
 * @returns {string[]} One string per non-image content item, then the structured content when present.
 */
function textParts(result: CallToolResult): string[] {
   // The non-image content items as text.
   const parts: string[] = result.content
      .filter((item) => item.type !== 'image')
      .map((item) => (item.type === 'text' ? item.text : JSON.stringify(item)));
   if (result.structuredContent !== undefined) {
      parts.push(JSON.stringify(result.structuredContent));
   }
   return parts;
}

/**
 * Work out the byte limit for one call: the hard cap (a valid per-call `maxBytes` lowers it, never above the maximum
 * cap), then the tool's own budget when that is smaller. Only arguments the tool's input schema declares reach here.
 * @param {unknown} args - The tool arguments.
 * @param {number | undefined} budgetBytes - The tool's own budget.
 * @returns {number} The limit in bytes.
 */
function resolveLimit(args: unknown, budgetBytes: number | undefined): number {
   // The default hard cap.
   let limit: number = getBudget('RESULT_HARD_CAP_DEFAULT_BYTES').value;
   // The per-call request, when the arguments carry one.
   const requested: unknown =
      typeof args === 'object' && args !== null ? (args as { maxBytes?: unknown }).maxBytes : undefined;
   if (typeof requested === 'number' && Number.isInteger(requested) && requested >= 1) {
      limit = Math.min(requested, getBudget('RESULT_HARD_CAP_MAX_BYTES').value);
   }
   return budgetBytes === undefined ? limit : Math.min(limit, budgetBytes);
}

/**
 * Summarize a stored result deterministically from its text: an object by its first top-level keys, the sizes of the
 * array and object values among them and its string `name` and `type`; an array by its length; anything else by its
 * character count. A key that is the same as an earlier listed key once shortened is skipped and counted in `omitted`,
 * so each listed key and its count belong to one real key.
 * @param {string} text - The stored text.
 * @returns {ResultSummary} The summary.
 */
export function summarizeResult(text: string): ResultSummary {
   let parsed: unknown;
   try {
      parsed = JSON.parse(text);
   } catch {
      parsed = undefined;
   }
   if (Array.isArray(parsed)) {
      return {
         kind: 'array',
         n: parsed.length,
      };
   }
   if (typeof parsed !== 'object' || parsed === null) {
      return {
         kind: 'text',
         n: text.length,
      };
   }
   // The parsed document viewed as a field map.
   const fields: Record<string, unknown> = parsed as Record<string, unknown>;
   // Every top-level key in JavaScript property order.
   const allKeys: string[] = Object.keys(fields);
   // The listed keys, cut to the summary key length.
   const keys: string[] = [];
   // The shortened keys already listed.
   const listed: Set<string> = new Set();
   // The count entries for the listed keys whose values are arrays or objects.
   const counts: [string, number][] = [];
   // Keys skipped because their shortened form was already listed.
   let omitted: number = 0;
   for (const key of allKeys.slice(0, SUMMARY_KEYS_MAX)) {
      // The key as shown.
      const shown: string = truncateUtf8(key, SUMMARY_TEXT_BYTES);
      if (listed.has(shown)) {
         omitted += 1;
         continue;
      }
      listed.add(shown);
      keys.push(shown);
      // The value under this key.
      const value: unknown = fields[key];
      if (Array.isArray(value)) {
         counts.push([shown, value.length]);
      } else if (typeof value === 'object' && value !== null) {
         counts.push([shown, Object.keys(value).length]);
      }
   }
   // The summary being built.
   const summary: ResultSummary = {
      kind: 'object',
      n: allKeys.length,
      keys,
      counts: Object.fromEntries(counts),
   };
   if (omitted > 0) {
      summary.omitted = omitted;
   }
   if (typeof fields.name === 'string') {
      summary.name = truncateUtf8(fields.name, SUMMARY_TEXT_BYTES);
   }
   if (typeof fields.type === 'string') {
      summary.type = truncateUtf8(fields.type, SUMMARY_TEXT_BYTES);
   }
   return summary;
}

/**
 * Serialize `{handle, bytes, summary}` and shrink the summary until the text fits the acknowledgement budget:
 * count entries go first, then listed keys from the end, then `name`, then `type`. Only `kind`, `n` and `omitted`
 * always remain.
 * @param {string} handle - The handle id.
 * @param {number} bytes - The UTF-8 size of the stored text.
 * @param {ResultSummary} summary - The full summary.
 * @param {number} maxBytes - The acknowledgement budget in UTF-8 bytes.
 * @returns {string} The response text, at most `maxBytes` in UTF-8 bytes.
 */
function formatHandleResponse(handle: string, bytes: number, summary: ResultSummary, maxBytes: number): string {
   // The summary, shrunk in place.
   const shrunk: ResultSummary = {
      ...summary,
      keys: summary.keys ? [...summary.keys] : undefined,
      counts: summary.counts ? { ...summary.counts } : undefined,
   };
   for (;;) {
      // The candidate response text.
      const text: string = JSON.stringify({
         handle,
         bytes,
         summary: shrunk,
      });
      if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
         return text;
      }
      // The count keys still listed.
      const countKeys: string[] = shrunk.counts ? Object.keys(shrunk.counts) : [];
      if (shrunk.counts && countKeys.length > 0) {
         delete shrunk.counts[countKeys[countKeys.length - 1]];
      } else if (shrunk.keys && shrunk.keys.length > 0) {
         shrunk.keys.pop();
      } else if (shrunk.name !== undefined) {
         delete shrunk.name;
      } else if (shrunk.type !== undefined) {
         delete shrunk.type;
      } else {
         return text;
      }
   }
}

/**
 * Enforce the result budget on one handler result: error text is capped, images are checked, and text over the limit
 * is stored and replaced by `{handle, bytes, summary}`.
 * @param {unknown} raw - What the handler returned.
 * @param {unknown} args - The tool arguments, read for `maxBytes`.
 * @param {ResultBudgetOptions} options - The store, owner key and the tool's own budget.
 * @returns {CallToolResult} The enforced result.
 * @throws {Error} When the result has an unexpected shape or cannot be serialized; the caller turns it into a fixed
 *         error result.
 */
function enforce(raw: unknown, args: unknown, options: ResultBudgetOptions): CallToolResult {
   assertResultShape(raw);
   // The shape-checked result.
   const result: CallToolResult = raw;
   if (result.isError) {
      return errorResult(truncateUtf8(textParts(result).join('\n'), getBudget('ERROR_MAX_BYTES').value));
   }
   // The refusal for the result's images, when it has one.
   const imageRefusal: string | null = checkImages(result.content);
   if (imageRefusal !== null) {
      return errorResult(imageRefusal);
   }
   // The text the client would read.
   const parts: string[] = textParts(result);
   // Its size in UTF-8 bytes.
   const bytes: number = parts.reduce((sum, part) => sum + Buffer.byteLength(part, 'utf8'), 0);
   // The content with image and text items rebuilt to their measured fields; any other field (`_meta`, `annotations`)
   // could carry unmeasured bytes. Items of other types are measured whole, as their JSON.
   const content: CallToolResult['content'] = result.content.map(rebuildItem);
   // The rebuilt image items.
   const images: CallToolResult['content'] = content.filter((item) => item.type === 'image');
   if (bytes <= resolveLimit(args, options.budgetBytes)) {
      // Only the fields that were measured leave the enforcer; top-level `_meta` and unknown fields are dropped.
      return result.structuredContent === undefined
         ? { content }
         : {
              content,
              structuredContent: result.structuredContent,
           };
   }
   // The acknowledgement budget in bytes.
   const ackMaxBytes: number = getBudget('ACK_MAX_BYTES').value;
   if (options.ownerLive && !options.ownerLive()) {
      return errorResult('SESSION_ENDED: The MCP session ended, so the large result was not stored.');
   }
   // The text kept for later slices: the parts joined by newlines.
   const stored: string = parts.join('\n');
   // The outcome of storing it.
   const put: PutResult = options.store.put(options.ownerKey, stored);
   if (!put.ok) {
      return errorResult(truncateUtf8(`${put.error.code}: ${put.error.message}`, ackMaxBytes));
   }
   // Only a lone text item is one document; joined parts or structured content are described as plain text.
   const summary: ResultSummary =
      parts.length === 1 && result.structuredContent === undefined
         ? summarizeResult(stored)
         : {
              kind: 'text',
              n: stored.length,
           };
   return {
      content: [
         {
            type: 'text',
            text: formatHandleResponse(put.handle, put.bytes, summary, ackMaxBytes),
         },
         ...images,
      ],
   };
}

/**
 * Wrap a tool handler with the result budget. The wrapped handler returns the handler's result unchanged when its
 * text fits the limit; otherwise it stores the text in the handle store and returns `{handle, bytes, summary}` (images
 * stay). An error result is capped to the error budget and never becomes a handle. The wrapper never passes a result
 * it could not check: a malformed or unserializable result becomes a fixed error, a thrown BridgeError passes its
 * bounded message, and any other thrown value becomes a fixed error while its message goes to the server log. A result
 * with more than one image, a non-PNG image, an oversized or non-base64 image, or a longest side over the limit is
 * refused.
 * @param {ToolHandler<Args>} handler - The tool handler to wrap.
 * @param {ResultBudgetOptions} options - The store, owner key and the tool's own budget.
 * @returns {ToolHandler<Args>} The enforcing handler.
 */
export function withResultBudget<Args>(handler: ToolHandler<Args>, options: ResultBudgetOptions): ToolHandler<Args> {
   return async (args: Args, extra?: unknown): Promise<CallToolResult> => {
      // What the handler returned.
      let raw: unknown;
      try {
         raw = await handler(args, extra);
      } catch (err) {
         return failureResult(err);
      }
      try {
         return enforce(raw, args, options);
      } catch (err) {
         logFailure('tool result rejected', err);
         return errorResult(INVALID_RESULT_MESSAGE);
      }
   };
}
