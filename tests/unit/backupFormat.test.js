// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
   BACKUP_FILE_PATTERN,
   BACKUP_NOTE_MAX_JSON_BYTES,
   backupFileName,
   blankHeaderLine,
   formatHeaderLine,
   isBackupNote,
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

   it('fits the largest header: the largest note of quotes, four 128-byte world fields of backslashes, the '
      + 'largest counts', () => {
      /** @type {string} A world field of 128 backslashes, each escaped to two characters in JSON. */
      const field = '\\'.repeat(128);
      /** @type {import('../../shared/backup.js').BackupHeader} The largest valid header. */
      const header = {
         ...HEADER,
         worldId: field,
         foundryVersion: field,
         systemId: field,
         systemVersion: field,
         note: '"'.repeat(Math.floor(BACKUP_NOTE_MAX_JSON_BYTES / 2)),
         documents: Number.MAX_SAFE_INTEGER,
         bytes: Number.MAX_SAFE_INTEGER,
      };
      expect(isBackupNote(header.note)).toBe(true);
      /** @type {string} The formatted header line. */
      const line = formatHeaderLine(header);
      expect(Buffer.byteLength(line)).toBe(2048);
      expect(parseHeaderLine(line)).toEqual(header);
   });

   it('accepts a note whose JSON fills the header room and refuses one byte more or a control character', () => {
      expect(BACKUP_NOTE_MAX_JSON_BYTES).toBeGreaterThan(200);
      expect(isBackupNote('x'.repeat(BACKUP_NOTE_MAX_JSON_BYTES))).toBe(true);
      expect(isBackupNote('x'.repeat(BACKUP_NOTE_MAX_JSON_BYTES + 1))).toBe(false);
      expect(isBackupNote('"'.repeat(Math.floor(BACKUP_NOTE_MAX_JSON_BYTES / 2) + 1))).toBe(false);
      expect(isBackupNote('a\nb')).toBe(false);
   });

   it('parses a header past the guideline values: 10001 documents, 64000001 bytes, a 201-byte note', () => {
      /** @type {import('../../shared/backup.js').BackupHeader} A header over each guideline. */
      const header = {
         ...HEADER,
         note: 'x'.repeat(201),
         documents: 10_001,
         bytes: 64_000_001,
      };
      expect(parseHeaderLine(formatHeaderLine(header))).toEqual(header);
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
         'documents past the safe integers',
         JSON.stringify({
            ...HEADER,
            documents: 2 ** 53,
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
         'bytes past the safe integers',
         JSON.stringify({
            ...HEADER,
            bytes: 2 ** 53,
         }),
      ],
      [
         'a note with a newline',
         JSON.stringify({
            ...HEADER,
            note: 'a\nb',
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
