// The marker that ends a text cut by `truncateUtf8`; it counts toward the byte limit.
const ELLIPSIS: string = '…';

/**
 * Truncate text to a UTF-8 byte limit, appending an ellipsis marker that counts toward the limit. Never splits a
 * multi-byte character.
 * @param {string} text - The text to bound.
 * @param {number} maxBytes - The maximum UTF-8 byte length of the result.
 * @returns {string} The text unchanged when it fits; an empty string when it does not fit and the limit cannot hold the
 *          marker; otherwise a truncated copy ending in the marker.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
   const bytes: Buffer = Buffer.from(text, 'utf8');
   if (bytes.length <= maxBytes) {
      return text;
   }
   const markerBytes: number = Buffer.byteLength(ELLIPSIS, 'utf8');
   if (maxBytes < markerBytes) {
      return '';
   }
   let end: number = maxBytes - markerBytes;
   // A continuation byte (10xxxxxx) at the cut means the cut is inside a character; back up to its start.
   while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
      end--;
   }
   return bytes.subarray(0, end).toString('utf8') + ELLIPSIS;
}
