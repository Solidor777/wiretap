// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
   BACKUP_FILE_PATTERN,
   backupFileName,
   blankHeaderLine,
   formatHeaderLine,
   parseHeaderLine,
} from '../../shared/backup.js';

/**
 * A valid backup header with every field set.
 * @type {import('../../shared/backup.js').BackupHeader}
 */
const HEADER = Object.freeze({
   wiretapBackup: 1,
   created: '2026-11-21T03:04:05.006Z',
   worldId: 'w',
   foundryVersion: '14.364',
   systemId: 's',
   systemVersion: '1.0.0',
   note: 'n',
   documents: 3,
   bytes: 5000,
});

describe('backupFileName', () => {
   it('names a file from the UTC time and the suffix', () => {
      expect(backupFileName(new Date(Date.UTC(2026, 10, 21, 3, 4, 5, 6)), 'Ab_-1234'))
         .toBe('20261121T030405006Z-Ab_-1234.wtbackup.jsonl');
      expect(BACKUP_FILE_PATTERN.test('20261121T030405006Z-Ab_-1234.wtbackup.jsonl')).toBe(true);
   });

   it.each([
      'x.wtbackup.jsonl',
      '20261121T030405006Z-Ab_-1234.wtbackup.json',
      '20261121T030405006Z-Ab_-123.wtbackup.jsonl',
      '../20261121T030405006Z-Ab_-1234.wtbackup.jsonl',
   ])('refuses the name %s', (name) => {
      expect(BACKUP_FILE_PATTERN.test(name)).toBe(false);
   });
});

describe('header line', () => {
   it('pads the header line to 2048 bytes and parses it back', () => {
      /** @type {string} The formatted header line. */
      const line = formatHeaderLine({ ...HEADER });
      expect(Buffer.byteLength(line)).toBe(2048);
      expect(line.endsWith('\n')).toBe(true);
      expect(parseHeaderLine(line)).toEqual(HEADER);
   });

   it('fits the largest header: a 200-byte note of quotes and four 128-byte world fields of backslashes', () => {
      /** @type {string} A world field of 128 backslashes, each escaped to two characters in JSON. */
      const field = '\\'.repeat(128);
      /** @type {import('../../shared/backup.js').BackupHeader} The largest valid header. */
      const header = {
         ...HEADER,
         worldId: field,
         foundryVersion: field,
         systemId: field,
         systemVersion: field,
         note: '"'.repeat(200),
         documents: 10_000,
         bytes: 64_000_000,
      };
      /** @type {string} The formatted header line. */
      const line = formatHeaderLine(header);
      expect(Buffer.byteLength(line)).toBe(2048);
      expect(parseHeaderLine(line)).toEqual(header);
   });

   it('throws a RangeError for a header longer than the line', () => {
      expect(() => formatHeaderLine({
         ...HEADER,
         note: 'x'.repeat(2000),
      })).toThrow(RangeError);
   });

   it('parses a blank header line to null', () => {
      expect(parseHeaderLine(blankHeaderLine())).toBeNull();
      expect(Buffer.byteLength(blankHeaderLine())).toBe(2048);
      expect(blankHeaderLine()).toBe(`${' '.repeat(2047)}\n`);
   });

   it.each([
      [
         'an extra key',
         JSON.stringify({
            ...HEADER,
            extra: 1,
         }),
      ],
      [
         'wiretapBackup 2',
         JSON.stringify({
            ...HEADER,
            wiretapBackup: 2,
         }),
      ],
      [
         'created without milliseconds',
         JSON.stringify({
            ...HEADER,
            created: '2026-11-21T03:04:05Z',
         }),
      ],
      [
         'documents 10001',
         JSON.stringify({
            ...HEADER,
            documents: 10_001,
         }),
      ],
      [
         'bytes 2047',
         JSON.stringify({
            ...HEADER,
            bytes: 2047,
         }),
      ],
      [
         'bytes 64000001',
         JSON.stringify({
            ...HEADER,
            bytes: 64_000_001,
         }),
      ],
      [
         'a note of 201 bytes',
         JSON.stringify({
            ...HEADER,
            note: 'x'.repeat(201),
         }),
      ],
      [
         'a worldId with a tab',
         JSON.stringify({
            ...HEADER,
            worldId: 'a\tb',
         }),
      ],
      [
         'documents 1.5',
         JSON.stringify({
            ...HEADER,
            documents: 1.5,
         }),
      ],
      [
         'a JSON array',
         JSON.stringify([HEADER]),
      ],
   ])('parses an invalid header (%s) to null', (_label, text) => {
      expect(parseHeaderLine(text)).toBeNull();
   });
});
