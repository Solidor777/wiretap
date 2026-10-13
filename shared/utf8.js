/**
 * UTF-8 byte bounds for text that travels over the bridge. Plain JS with no dependencies because the Foundry client
 * and the sidecar tooling both import it.
 */

/**
 * The marker that ends a text cut by `truncateUtf8`; it counts toward the byte limit.
 * @type {string}
 */
const ELLIPSIS = '…';

/**
 * Encodes text to UTF-8 to count and cut bytes.
 * @type {TextEncoder}
 */
const ENCODER = new TextEncoder();

/**
 * Decodes the kept prefix back to text.
 * @type {TextDecoder}
 */
const DECODER = new TextDecoder();

/**
 * Truncate text to a UTF-8 byte limit, appending an ellipsis marker that counts toward the limit. Never splits a
 * multi-byte character.
 * @param {string} text - The text to bound.
 * @param {number} maxBytes - The maximum UTF-8 byte length of the result.
 * @returns {string} The text unchanged when it fits; an empty string when it does not fit and the limit cannot hold the
 * marker; otherwise a truncated copy ending in the marker.
 */
export function truncateUtf8(text, maxBytes) {
   /** @type {Uint8Array} The encoded text. */
   const bytes = ENCODER.encode(text);
   if (bytes.length <= maxBytes) {
      return text;
   }
   /** @type {number} The size of the marker in bytes. */
   const markerBytes = ENCODER.encode(ELLIPSIS).length;
   if (maxBytes < markerBytes) {
      return '';
   }
   /** @type {number} The cut position. */
   let end = maxBytes - markerBytes;
   // A continuation byte (10xxxxxx) at the cut means the cut is inside a character; back up to its start.
   while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
      end -= 1;
   }
   return DECODER.decode(bytes.subarray(0, end)) + ELLIPSIS;
}

/**
 * Measure text as UTF-8 bytes.
 * @param {string} text - The text to measure.
 * @returns {number} The byte length.
 */
export function utf8Bytes(text) {
   return ENCODER.encode(text).length;
}
