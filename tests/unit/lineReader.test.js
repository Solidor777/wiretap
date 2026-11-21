import { describe, it, expect } from 'vitest';
import { createLineReader } from '~/bridge/backup/lineReader.js';

/** @type {TextEncoder} Encodes test text as UTF-8 bytes. */
const encoder = new TextEncoder();

/** @type {TextDecoder} Decodes the lines back to text. */
const decoder = new TextDecoder();

/**
 * Decode every line a push returned.
 * @param {Uint8Array[]} lines - The complete lines.
 * @returns {string[]} The lines as text.
 */
function texts(lines) {
   return lines.map((line) => decoder.decode(line));
}

describe('createLineReader', () => {
   it('returns complete lines and keeps the tail', () => {
      const reader = createLineReader();
      expect(texts(reader.push(encoder.encode('one\ntwo\nthr')))).toEqual([
         'one',
         'two',
      ]);
      expect(texts(reader.push(encoder.encode('ee\n')))).toEqual(['three']);
      expect(reader.pending()).toBe(0);
   });

   it('rebuilds a line split across three pieces, a multi-byte character cut at a piece edge', () => {
      const reader = createLineReader();
      /** @type {Uint8Array} A line holding a three-byte character, then its newline. */
      const bytes = encoder.encode('a€b\n');
      expect(reader.push(bytes.subarray(0, 2))).toEqual([]);
      expect(reader.push(bytes.subarray(2, 3))).toEqual([]);
      expect(texts(reader.push(bytes.subarray(3)))).toEqual(['a€b']);
   });

   it('reports the pending tail length', () => {
      const reader = createLineReader();
      reader.push(encoder.encode('done\nabc'));
      expect(reader.pending()).toBe(3);
      reader.push(encoder.encode('de'));
      expect(reader.pending()).toBe(5);
   });
});
