# Backup format, bridge settings and backup wire identifiers

Current-state reference for `shared/backup.js`, `shared/bridgeSettings.js` and the backup parts of
`shared/protocol.js`. Plain JS shared by both sides; no product code imports `shared/backup.js` or
`shared/bridgeSettings.js` yet beyond their tests, and no sidecar or client code handles the backup events and ops yet.

## `shared/backup.js` (imports only `./utf8.js`)

The backup file format: JSON Lines, line 1 a header padded with spaces to `HEADER_LINE_BYTES` (2048) bytes, then one
`BackupLine` (`{ uuid, documentName, pack?, data, secretPaths? }`) per document. `WorldDescription` is
`{ worldId, foundryVersion, systemId, systemVersion }` (strings).

- Constants: `BACKUP_FORMAT_VERSION` 1, `BACKUP_FILE_SUFFIX` `.wtbackup.jsonl`, `BACKUP_FILE_PATTERN`
  (`YYYYMMDDTHHMMSSmmmZ-<8 of [A-Za-z0-9_-]>.wtbackup.jsonl`, nothing else, so no path separator), and the limits
  `BACKUP_PIECE_MAX_BYTES` 512,000, `BACKUP_MAX_DOCUMENTS` 10,000, `BACKUP_MAX_BYTES` 64,000,000,
  `BACKUP_NOTE_MAX_BYTES` 200, `BACKUP_WORLD_FIELD_MAX_BYTES` 128, `BACKUP_UUIDS_MAX` 200, `BACKUP_TIMEOUT_MIN_MS`
  1,000, `BACKUP_TIMEOUT_DEFAULT_MS` 120,000, `BACKUP_TIMEOUT_MAX_MS` 300,000, `LIST_LIMIT_DEFAULT` 10,
  `LIST_LIMIT_MAX` 50, `LIST_HEADER_READS_MAX` 1000, `LIST_NOTE_MAX_BYTES` 40, `RESTORE_ROWS_MAX` 20,
  `RESTORE_REASON_MAX_BYTES` 160.
- Codes (strings equal to their names): `BACKUP_NOT_FOUND`, `BACKUP_INVALID`, `BACKUP_BUSY`, `BACKUP_TOO_LARGE`,
  `BACKUP_EMPTY`, `BACKUP_FOLDER_INVALID`, `BACKUP_WRITE_FAILED`, `BACKUP_INCOMPLETE`, `TRASH_FAILED`;
  `BACKUP_SIDECAR_CODES` (frozen) holds the six only the sidecar may produce: not found, invalid, busy, folder invalid,
  write failed, trash failed.
- `backupFileName(date, suffix)` builds the name from the UTC fields of `date`.
- `blankHeaderLine()` is 2,047 spaces and `\n`.
- `formatHeaderLine(header)` writes `JSON.stringify(header)` (key order as given) padded with spaces to 2,047 UTF-8
  bytes, then `\n`; it throws `RangeError` when the JSON is longer. The largest valid header (four 128-byte world
  fields of backslashes and a 200-byte note of quotes, each doubled by JSON escaping) fits.
- `parseHeaderLine(text)` returns null unless the text parses to a non-array object with exactly the nine
  `BackupHeader` keys (`wiretapBackup`, `created`, `worldId`, `foundryVersion`, `systemId`, `systemVersion`, `note`,
  `documents`, `bytes`), `wiretapBackup === 1`, `created` an ISO UTC time with milliseconds, the four world fields
  passing `isWorldField`, `note` passing `isBackupNote`, `documents` an integer 0 to 10,000 and `bytes` an integer 2,048
  to 64,000,000. A blank header line is null.
- `isWorldField(value)`: a string of at most 128 UTF-8 bytes with no `\p{Cc}`. `isBackupNote(value)`: the same at 200.

Tests: `tests/unit/backupFormat.test.js`.

## `shared/bridgeSettings.js`

`BACKUP_FOLDER_MAX_BYTES` 1024, `BRIDGE_SETTING_KEYS` (`['backupFolder']`, frozen), `BridgeSettings`
`{ backupFolder: string }` (empty means the sidecar's default folder), `defaultBridgeSettings()` (a fresh
`{ backupFolder: '' }`) and `sanitizeBridgeSettings(input)`: keeps `backupFolder` only as an own string property of at
most 1,024 UTF-8 bytes with no `\p{Cc}`, else `''`; unknown keys are dropped; it never throws (a throwing getter or
proxy gives the defaults). Tests: `tests/unit/bridgeSettings.test.js`.

## Backup identifiers in `shared/protocol.js`

- Events: `BRIDGE_BACKUP_PIECE` (`bridge:backupPiece`, client → server) and `BRIDGE_RESTORE_PIECE`
  (`bridge:restorePiece`, server → client), each piece acked with a `PieceAck` before the next is sent.
- Ops over `BRIDGE_INVOKE`: `OP_BACKUP_EXPORT` (`backupExport`) and `OP_BACKUP_RESTORE` (`backupRestore`).
- Code: `PIECE_REFUSED` (the receiver refused a piece; the stream stops).
- Typedefs: `BackupPiece` = `BackupDataPiece` `{ requestId, seq, data: Uint8Array }` | `BackupEndPiece`
  `{ requestId, seq, end: true, pieces, bytes }`; `PieceAck` `{ ok: true }` | `{ ok: false, error: { code, message } }`;
  `BridgeStatePush` `{ gateState, settings }`. The comment of `BRIDGE_GATE_STATE` names `BridgeStatePush` as its
  payload, while the sidecar and client code still send and read a bare `GateState`.
