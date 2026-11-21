/**
 * The document backup file format and its limits, shared by the Foundry client (which exports and restores the
 * documents) and the Node sidecar (which writes, lists, reads and recycles the files). Plain JS so both sides import
 * it.
 *
 * A backup file is JSON Lines: line 1 is a header padded with spaces to exactly `HEADER_LINE_BYTES` bytes, so the
 * sidecar can write a blank line first and fill it in place once the document count and byte total are known; every
 * later line is one `BackupLine`.
 */

import { utf8Bytes } from './utf8.js';

// --- Format ---

// The format version written to and required in every header's `wiretapBackup` field.
export const BACKUP_FORMAT_VERSION = 1;

// The file name ending of every backup file.
export const BACKUP_FILE_SUFFIX = '.wtbackup.jsonl';

// A backup file name: the UTC creation time to the millisecond, a hyphen, eight random characters, the suffix. Any
// other name (a path separator included) is not a backup file.
export const BACKUP_FILE_PATTERN = /^\d{8}T\d{9}Z-[A-Za-z0-9_-]{8}\.wtbackup\.jsonl$/;

// The exact byte length of the header line, its newline included.
export const HEADER_LINE_BYTES = 2048;

// --- Limits ---

// Largest piece of a backup or restore stream, in bytes.
export const BACKUP_PIECE_MAX_BYTES = 512_000;

// Most documents one backup holds.
export const BACKUP_MAX_DOCUMENTS = 10_000;

// Largest backup file, in bytes, header included.
export const BACKUP_MAX_BYTES = 64_000_000;

// Longest backup note, in UTF-8 bytes.
export const BACKUP_NOTE_MAX_BYTES = 200;

// Longest world field of a header (world id, Foundry version, system id, system version), in UTF-8 bytes.
export const BACKUP_WORLD_FIELD_MAX_BYTES = 128;

// Most uuids one backup call names.
export const BACKUP_UUIDS_MAX = 200;

// Shortest `timeoutMs` a backup or restore call may set.
export const BACKUP_TIMEOUT_MIN_MS = 1_000;

// The `timeoutMs` of a backup or restore call that sets none.
export const BACKUP_TIMEOUT_DEFAULT_MS = 120_000;

// Longest `timeoutMs` a backup or restore call may set.
export const BACKUP_TIMEOUT_MAX_MS = 300_000;

// Backups one `list_backups` call returns when it sets no limit.
export const LIST_LIMIT_DEFAULT = 10;

// Most backups one `list_backups` call returns.
export const LIST_LIMIT_MAX = 50;

// Most header lines one `list_backups` call reads.
export const LIST_HEADER_READS_MAX = 1000;

// Longest note shown in a `list_backups` row, in UTF-8 bytes.
export const LIST_NOTE_MAX_BYTES = 40;

// Most per-document rows a `restore_backup` result carries.
export const RESTORE_ROWS_MAX = 20;

// Longest reason text of one `restore_backup` row, in UTF-8 bytes.
export const RESTORE_REASON_MAX_BYTES = 160;

// --- Error codes ---

// No backup file of that name exists in the folder.
export const BACKUP_NOT_FOUND = 'BACKUP_NOT_FOUND';

// The file is not a valid backup (bad header, bad line, or counts that do not match the header).
export const BACKUP_INVALID = 'BACKUP_INVALID';

// Another backup or restore is running.
export const BACKUP_BUSY = 'BACKUP_BUSY';

// The backup would exceed `BACKUP_MAX_DOCUMENTS` or `BACKUP_MAX_BYTES`.
export const BACKUP_TOO_LARGE = 'BACKUP_TOO_LARGE';

// The requested documents resolved to nothing to back up.
export const BACKUP_EMPTY = 'BACKUP_EMPTY';

// The folder is not an absolute path, cannot be used, or is outside the allowed folders while its gate is closed.
export const BACKUP_FOLDER_INVALID = 'BACKUP_FOLDER_INVALID';

// The sidecar could not write the backup file.
export const BACKUP_WRITE_FAILED = 'BACKUP_WRITE_FAILED';

// The stream ended before every piece arrived.
export const BACKUP_INCOMPLETE = 'BACKUP_INCOMPLETE';

// The recycle bin refused the file.
export const TRASH_FAILED = 'TRASH_FAILED';

/**
 * The codes only the sidecar may produce; a client ack carrying one of them is not trusted as such.
 * @type {readonly string[]}
 */
export const BACKUP_SIDECAR_CODES = Object.freeze([
   BACKUP_NOT_FOUND,
   BACKUP_INVALID,
   BACKUP_BUSY,
   BACKUP_FOLDER_INVALID,
   BACKUP_WRITE_FAILED,
   TRASH_FAILED,
]);

/**
 * @typedef {object} BackupHeader
 * @property {1} wiretapBackup - The format version, `BACKUP_FORMAT_VERSION`.
 * @property {string} created - The creation time as an ISO 8601 UTC string with milliseconds.
 * @property {string} worldId - The id of the world the documents came from.
 * @property {string} foundryVersion - The Foundry version that exported them.
 * @property {string} systemId - The id of the world's game system.
 * @property {string} systemVersion - The version of that system.
 * @property {string} note - The caller's note, at most `BACKUP_NOTE_MAX_BYTES` bytes.
 * @property {number} documents - The number of document lines after the header.
 * @property {number} bytes - The file size in bytes, header included.
 */

/**
 * @typedef {object} WorldDescription
 * @property {string} worldId - The identifier of the running world (`game.world.id`).
 * @property {string} foundryVersion - The release of Foundry the world runs on (`game.version`).
 * @property {string} systemId - The identifier of the world's game system.
 * @property {string} systemVersion - The game system version.
 */

/**
 * @typedef {object} BackupLine
 * @property {string} uuid - The uuid of the backed-up document.
 * @property {string} documentName - Its document class name, for example `Actor`.
 * @property {string} [pack] - The compendium pack id, when the document is inside a pack.
 * @property {Record<string, unknown>} data - The document's source data.
 * @property {Array<Array<string | number>>} [secretPaths] - Paths inside `data` whose secret values were left out.
 */

/**
 * The header keys in the order they are written; a header has exactly these.
 * @type {readonly string[]}
 */
const HEADER_KEYS = Object.freeze([
   'wiretapBackup',
   'created',
   'worldId',
   'foundryVersion',
   'systemId',
   'systemVersion',
   'note',
   'documents',
   'bytes',
]);

// The `created` field: an ISO 8601 UTC time with milliseconds, as `Date.prototype.toISOString` writes it.
const CREATED_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// A control character; none is allowed in a world field or a note.
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * Pad a number with leading zeros.
 * @param {number} value - The non-negative integer.
 * @param {number} width - The digit count.
 * @returns {string} The padded digits.
 */
function pad(value, width) {
   return String(value).padStart(width, '0');
}

/**
 * Build a backup file name from a creation time and a random suffix.
 * @param {Date} date - The creation time; its UTC fields are used.
 * @param {string} suffix - Eight characters of `[A-Za-z0-9_-]`.
 * @returns {string} `YYYYMMDDTHHMMSSmmmZ-<suffix>.wtbackup.jsonl`.
 */
export function backupFileName(date, suffix) {
   /** @type {string} The UTC date part. */
   const day = `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`;
   /** @type {string} The UTC time part to the millisecond. */
   const time = `${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}`
      + pad(date.getUTCMilliseconds(), 3);
   return `${day}T${time}Z-${suffix}${BACKUP_FILE_SUFFIX}`;
}

/**
 * Build the blank header line written before the documents: spaces then a newline, `HEADER_LINE_BYTES` bytes.
 * @returns {string} 2,047 spaces and a newline.
 */
export function blankHeaderLine() {
   return `${' '.repeat(HEADER_LINE_BYTES - 1)}\n`;
}

/**
 * Format a header as its line: the JSON padded with spaces to `HEADER_LINE_BYTES - 1` bytes, then a newline.
 * @param {BackupHeader} header - The header; its keys are written in the order given.
 * @returns {string} The line of exactly `HEADER_LINE_BYTES` bytes.
 * @throws {RangeError} When the JSON is longer than `HEADER_LINE_BYTES - 1` bytes.
 */
export function formatHeaderLine(header) {
   /** @type {string} The header JSON. */
   const json = JSON.stringify(header);
   /** @type {number} Its UTF-8 size. */
   const size = utf8Bytes(json);
   if (size > HEADER_LINE_BYTES - 1) {
      throw new RangeError(`Backup header is ${size} bytes; the header line holds ${HEADER_LINE_BYTES - 1}.`);
   }
   return `${json}${' '.repeat(HEADER_LINE_BYTES - 1 - size)}\n`;
}

/**
 * Check a world field of a header: a string of at most `BACKUP_WORLD_FIELD_MAX_BYTES` UTF-8 bytes with no control
 * character.
 * @param {unknown} value - The value to check.
 * @returns {boolean} True when the value is a valid world field.
 */
export function isWorldField(value) {
   return typeof value === 'string'
      && utf8Bytes(value) <= BACKUP_WORLD_FIELD_MAX_BYTES
      && !CONTROL_CHARACTER.test(value);
}

/**
 * Check a backup note: a string of at most `BACKUP_NOTE_MAX_BYTES` UTF-8 bytes with no control character.
 * @param {unknown} value - The value to check.
 * @returns {boolean} True when the value is a valid note.
 */
export function isBackupNote(value) {
   return typeof value === 'string'
      && utf8Bytes(value) <= BACKUP_NOTE_MAX_BYTES
      && !CONTROL_CHARACTER.test(value);
}

/**
 * Check that a value is an integer within an inclusive range.
 * @param {unknown} value - The value to check.
 * @param {number} min - The smallest allowed value.
 * @param {number} max - The largest allowed value.
 * @returns {boolean} True when the value is an integer from `min` to `max`.
 */
function isIntegerIn(value, min, max) {
   return Number.isInteger(value) && /** @type {number} */ (value) >= min && /** @type {number} */ (value) <= max;
}

/**
 * Parse a header line read from a backup file.
 * @param {string} text - The line (trailing padding and newline are allowed).
 * @returns {BackupHeader | null} The header, or null when the text is not a valid header.
 */
export function parseHeaderLine(text) {
   /** @type {unknown} The parsed JSON. */
   let value;
   try {
      value = JSON.parse(text);
   } catch {
      return null;
   }
   if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
   }
   /** @type {Record<string, unknown>} The parsed object. */
   const header = /** @type {Record<string, unknown>} */ (value);
   /** @type {number} How many own enumerable keys the object has. */
   const keyCount = Object.keys(header).length;
   if (keyCount !== HEADER_KEYS.length || !HEADER_KEYS.every((key) => Object.hasOwn(header, key))) {
      return null;
   }
   if (header.wiretapBackup !== BACKUP_FORMAT_VERSION
      || typeof header.created !== 'string'
      || !CREATED_PATTERN.test(header.created)
      || !isWorldField(header.worldId)
      || !isWorldField(header.foundryVersion)
      || !isWorldField(header.systemId)
      || !isWorldField(header.systemVersion)
      || !isBackupNote(header.note)
      || !isIntegerIn(header.documents, 0, BACKUP_MAX_DOCUMENTS)
      || !isIntegerIn(header.bytes, HEADER_LINE_BYTES, BACKUP_MAX_BYTES)) {
      return null;
   }
   return /** @type {BackupHeader} */ (/** @type {unknown} */ (header));
}
