# Backup format, bridge settings and backup wire identifiers

Current-state reference for `shared/backup.js`, `shared/bridgeSettings.js`, the backup parts of
`shared/protocol.js`, and the sidecar backup tools of `server/backupTools.ts` (last section). The shared files are plain
JS imported by both sides.

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
  `BridgeStatePush` `{ gateState, settings }`, the `BRIDGE_GATE_STATE` payload the client sends and the sidecar reads
  (a payload without `gateState` closes every gate). The identify carries the same `settings` beside `gateState`.

## Backup tools (`server/backupTools.ts`)

`createBackupTools({ bridge, store, log?, now? })` returns `(endpoint) => ToolRegistration[]`: the four registrations
for a session (every invoke and snapshot passes `{ endpoint }` when the session restricts its kind, else `{}`). One busy
flag is shared by every session: a backup or restore (dry runs included) or a delete while one runs is `BACKUP_BUSY`;
`list_backups` is never refused. The flag clears when the invoke settles. `BackupBridge` is the slice of the Foundry
bridge used (`invoke`, `snapshot`, `expectPieces`, `sendPiece`); the `FoundryBridge` interface of `server/mcp.ts`
extends it. `startMcpServer` builds one store (`createBackupStore(options.backups)`) and one `createBackupTools({ bridge,
store, log })`, so the busy flag is one per MCP server; every session registers `read_handle`, then the four tools for
its endpoint kind, then the caller's `tools`. Their names are in `RESERVED_SCRIPT_NAMES`, so no script can take them.
`createWiretapServer(port, mcpPort, mode, { backups? })` passes `backups` through; production passes none (module root,
real `trash`). Measured listed sizes (`npx tsx tests/measure/measureContext.mjs`): `backup_documents` 800 B,
`list_backups` 378 B, `restore_backup` 730 B, `delete_backup` 369 B. `tests/unit/contextBudget.test.js` holds each
result to its budget through the `FIXTURES` of `contextBudgetHarness.js` (fake GM pieces and acks; measured 132, 1971,
3921 and 69 B).

- Definitions: each listed definition (`z.toJSONSchema(z.object(inputSchema), { target: 'draft-7', io: 'input' })`, the
  SDK's conversion) is at most `DEFINITION_MAX_BYTES` (800 B), measured by `tests/unit/backupTools.test.js`;
  `backup_documents` is exactly 800 B. An argument has a `.describe` only where its name and type do not say what it
  is: `folder` (absolute, default the backup folder), `note`, `dryRun`, and `file` and `uuids` of `restore_backup`.

- Folder and gate: `store.resolveFolder(args.folder, settings.backupFolder)`; kind `named` with
  `allowBackupAnyFolder` closed is `GATE_DENIED`. Backup and restore judge it inside the invoke's `prepare` on the
  picked endpoint; list and delete on `bridge.snapshot(...)`, or the closed gates and default settings with no endpoint.
- `backup_documents` (budget 256): exactly one of `uuids`, `folderUuid`, `documentName`, `pack`, and a note passing
  `isBackupNote`, else `ARGS_INVALID`. `prepare` checks the folder (`checkFolder(folder, !dryRun)`), registers a
  `createBackupSink` (not on a dry run) and sends `{ selector, dryRun?, timeoutMs }` (default 120,000; reply wait
  `timeoutMs + 2000`). After the invoke the sink is removed; the error is the sink's first failure, else the invoke's,
  else `BACKUP_INCOMPLETE` unless the end marker arrived, `documents` is at least 1 and equals the newline count,
  `bytes` equals the file size, `unreadable`/`parents` are non-negative integers and the four `world` fields pass
  `isWorldField`; more than `BACKUP_MAX_DOCUMENTS` (10,000) documents is `BACKUP_TOO_LARGE` (`parseHeaderLine` refuses
  such a header, so the file could not be opened, restored or recycled). Then `writer.finish` writes the header. Any failure after the file exists closes it and sends it to
  `store.trashPath`; if that fails the message gains `The partial file <name> could not be moved to the recycle bin.`
  (fitted to 512 B). Result `{ file, folder, documents, bytes }` (+ `unreadable`, `parents` when above 0); a dry run
  `{ dryRun: true, folder, documents, bytes }` (+ the same).
- `createBackupSink(openWriter)`: data pieces must come with `seq` 0, 1, 2, …; the file is created on the first;
  header plus received bytes over `BACKUP_MAX_BYTES` is `BACKUP_TOO_LARGE`; the end marker's `seq`/`pieces` must equal
  the data piece count and `bytes` the data bytes; `gone()` records `ENDPOINT_GONE` (nothing saved) and never throws;
  the first failure is kept and refuses every later piece. `counts()` gives pieces, bytes, newline count and `ended`.
- `restore_backup` (budget 4000): `prepare` runs `checkFolder(folder, false)` (a linked folder or `.wiretap` is
  `BACKUP_FOLDER_INVALID`), opens `store.openFile(folder, file)` and sends `{ header, uuids?, dryRun?,
  timeoutMs }`; `onSent` starts the pump (not awaited): `readPiece(512000)` pieces with `seq` 0, 1, … then the end
  marker, each `sendPiece` waiting until the reply deadline; a pump failure is logged and stops it. The reader closes once the
  pump and the invoke both ended. `ENDPOINT_GONE` becomes "the restore may be partly applied". The client result must
  have the shape `RestoreResult` of `src/bridge/backup/restoreBackup.js`: `replaced`, `created`, `skipped`, `failed`
  and `secretLost` non-negative integers; `rows` at most 20 rows of `[string, string, string?]`; `differences`, when
  present, 1 to 3 strings (one per differing world field); `dryRun`, when present, `true`; no other key; every string
  at most 256 B; else `BACKUP_INCOMPLETE`; it is returned with `file` first,
  fitted by `fitRestoreResult`, and `BACKUP_INCOMPLETE` if it still exceeds 4000 B.
- `list_backups` (budget 2000): `checkFolder(folder, false)`, `store.list(folder, limit ?? 10)`, notes cut to 40 B,
  `{ folder, rows, total }` (+ `invalid` when above 0), fitted by `fitListResult`.
- `delete_backup` (budget 128): `checkFolder(folder, false)`, `store.trashFile(folder, file)`,
  `{ file, trashed: true }`.
- `fitListResult` / `fitRestoreResult(result, maxBytes)`: drop `rows` from the end until the JSON fits; `cut: true`
  when any was dropped.

Tests: `tests/unit/backupTools.test.js` (fake `BackupBridge`, the real store over a scratch root, `fakeTrash`).
