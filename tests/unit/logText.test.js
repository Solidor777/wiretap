// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { CONTROL_PATTERN, LOG_CAUSE_BYTES, cleanForLog, describeCause } from '../../server/logText.ts';

/** @type {string} The Unicode line and paragraph separators. */
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);

describe('cleanForLog', () => {
   it('replaces C0 and C1 controls, newlines and the Unicode line separators with spaces', () => {
      const text = `a\nb\rc\td${String.fromCharCode(0x7f, 0x85)}e${LINE_SEPARATORS}f`;
      const cleaned = cleanForLog(text, 100);
      expect(cleaned).toBe('a b c d  e  f');
      expect(CONTROL_PATTERN.test(cleaned)).toBe(false);
   });

   it('cuts the text to the byte bound without splitting a character', () => {
      const cleaned = cleanForLog('é'.repeat(100), 21);
      expect(Buffer.byteLength(cleaned, 'utf8')).toBeLessThanOrEqual(21);
      expect(cleaned).not.toContain('�');
   });

   it('leaves plain text alone', () => {
      expect(cleanForLog('plain text', 100)).toBe('plain text');
   });
});

describe('describeCause', () => {
   it('uses the message of an Error and the string form of anything else', () => {
      expect(describeCause(new Error('boom'))).toBe('boom');
      expect(describeCause('text')).toBe('text');
      expect(describeCause(42)).toBe('42');
   });

   it('cleans and bounds the text', () => {
      const described = describeCause(new Error(`line one\nline two ${'y'.repeat(1000)}`));
      expect(described).not.toContain('\n');
      expect(Buffer.byteLength(described, 'utf8')).toBeLessThanOrEqual(LOG_CAUSE_BYTES);
   });

   it('honors a different bound', () => {
      expect(Buffer.byteLength(describeCause('y'.repeat(100), 10), 'utf8')).toBeLessThanOrEqual(10);
   });

   it('never throws for a value that cannot be printed', () => {
      const unprintable = {
         toString() {
            throw new Error('no string form');
         },
      };
      expect(describeCause(unprintable)).toBe('unprintable value');
   });
});
