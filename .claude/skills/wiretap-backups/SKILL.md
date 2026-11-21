---
name: wiretap-backups
description: Wiretap document backups - the sidecar file store (server/backups.ts, the only trash importer), the four backup tools backup_documents, list_backups, restore_backup and delete_backup (server/backupTools.ts), the backup file format (shared/backup.js), the Backup folder setting and its settings carrier (shared/bridgeSettings.js), the piece transport between sidecar and GM client, and the client export and restore (src/bridge/backup/). Use when reading or editing any of them or their tests.
paths:
  - "server/backups.ts"
  - "server/backupTools.ts"
  - "shared/backup.js"
  - "shared/bridgeSettings.js"
  - "src/bridge/backup/**"
  - "src/bridge/pieces.js"
  - "src/bridge/bridgeSettings.js"
  - "src/settings/bridgeSettings.js"
  - "tests/unit/backups.test.js"
  - "tests/unit/backupTools.test.js"
  - "tests/unit/backupFormat.test.js"
  - "tests/unit/backupSelection.test.js"
  - "tests/unit/backupTestHelpers.js"
  - "tests/unit/bridgeSettings.test.js"
  - "tests/unit/bridgeSettings.client.test.js"
  - "tests/unit/exportBackup.test.js"
  - "tests/unit/restoreBackup.test.js"
  - "tests/unit/lineReader.test.js"
  - "tests/unit/pieceWriter.test.js"
  - "tests/unit/secretCarry.test.js"
  - "tests/unit/pieces.test.js"
  - "tests/unit/mockBackupWorld.js"
  - "tests/unit/foundryBridge.pieces.test.js"
  - "tests/unit/foundryBridge.backupOps.test.js"
  - "tests/unit/noPermanentDelete.test.js"
  - "tests/integration/backupTools.test.js"
  - "tests/integration/backupPieces.test.js"
  - "tests/e2e/backupTools.spec.js"
---

# Wiretap document backups

Current-state reference; verify against code before relying on a detail. Core context: `wiretap-codebase-core`.
The format constants, the settings sanitizer, the backup wire identifiers and the tool-by-tool behaviour of
`server/backupTools.ts` are in `wiretap-sidecar` references/backup-format.md (read it before changing any of them);
the router options and the bridge's piece events are in `wiretap-mcp-bridge` references/bridge-pieces.md; restore
mode of the replace path is in `wiretap-writes`; `exportForBackup` is in `wiretap-scripts`. This skill holds how the
parts fit, the file store and the client halves.

## Parts

| File | Role |
|---|---|
| `shared/backup.js` | Format (JSON Lines, a 2,048-byte padded header line, one `BackupLine` per document), name pattern, limits, codes, `BACKUP_SIDECAR_CODES` (reserved in `server/endpoints.ts`) |
| `shared/bridgeSettings.js` | `BridgeSettings` `{ backupFolder }`, `sanitizeBridgeSettings`, `defaultBridgeSettings` |
| `server/backups.ts` | `createBackupStore(options)`: the only module that creates, reads, lists and recycles backup files, and the only importer of `trash` |
| `server/backupTools.ts` | `createBackupTools({ bridge, store, log?, now? })`: the four tool registrations per session, one busy lock, `createBackupSink`, the restore pump, the checks of what the client sends |
| `src/settings/bridgeSettings.js` | `registerBridgeSettings()`: the world `restricted` String setting `wiretap.backupFolder` (default `''`), called from `OnceInit` |
| `src/bridge/bridgeSettings.js` | `readBridgeSettings()`, `isBridgeSettingKey(key)`; the identify and the `bridge:gateState` push carry `settings` |
| `src/bridge/pieces.js` | `createPieceChannel(socket)`: the client side of both piece streams, one per socket |
| `src/bridge/backup/selection.js` | `planSelection(params)`, `loadEntries(entries)`, `PACK_BATCH_SIZE` (100) |
| `src/bridge/backup/exportBackup.js` | `exportBackup(params, invocation)`: the `backupExport` op |
| `src/bridge/backup/pieceWriter.js` | `createPieceWriter(send, maxBytes?)`: cuts UTF-8 text into pieces of 512,000 bytes |
| `src/bridge/backup/restoreBackup.js` | `restoreBackup(params, invocation)`: the `backupRestore` op |
| `src/bridge/backup/lineReader.js` | `createLineReader()`: `push(bytes)` returns the complete lines (split on byte 0x0A), `pending()` the bytes kept |
| `src/bridge/backup/secretCarry.js` | `carrySecrets(data, live, paths)`: copies live secret values into restored data |

## Flow

- **Backup.** `backup_documents` (sidecar) checks one selector and the note, takes the busy lock, and calls
  `bridge.invoke('backupExport', {}, { replyWaitMs: timeoutMs + 2000, prepare })`. `prepare` runs on the picked
  endpoint before the send: it resolves the folder against that endpoint's `settings.backupFolder`, judges
  `allowBackupAnyFolder` on its `gateState` for a named folder, checks (and for the default folder creates) the folder,
  registers a `createBackupSink` with `bridge.expectPieces(socketId, requestId, sink)` (not on a dry run) and returns
  the params. The client `exportBackup` plans and measures, then streams `bridge:backupPiece` pieces; the sink creates
  the file on the first data piece and appends each in order. After the reply the sidecar checks the client's
  `{ documents, bytes, unreadable, parents, world }` against what the sink received (end marker seen, `documents`
  equal to the newline count, `bytes` equal to the file size), writes the header in place and returns
  `{ file, folder, documents, bytes }`. Any failure after the file exists recycles the partial file
  (`discardPartial`). If the recycle bin refuses it, the backup keeps its own error code, not `TRASH_FAILED`: a
  `BridgeError` gains ` The partial file <name> could not be moved to the recycle bin.` (`namePartialFile`, fitted to
  512 B), any other error is thrown unchanged, and the sidecar log names the file either way.
- **Restore.** `restore_backup` takes the lock; `prepare` resolves and gate-checks the folder, checks it, opens the
  file (`openFile` checks name, header and size) and sends `{ header, uuids?, dryRun?, timeoutMs }`; `onSent` starts
  the pump, which reads 512,000-byte pieces and sends each with `bridge.sendPiece` (`bridge:restorePiece`), then the
  end marker, each ack awaited until the reply deadline. The client applies lines as they arrive and acks each piece
  after its lines; the sidecar accepts only the exact `RestoreResult` shape and returns it with `file` first, fitted
  to 4000 B.
- **List and delete** run in the sidecar only. They read the folder and gate from `bridge.snapshot({ endpoint? })`;
  with no GM endpoint every gate is closed and the settings are the defaults, so they work on the default folder.
  `delete_backup` is refused while a backup or restore runs; `list_backups` never is.

## File store (`server/backups.ts`)

`createBackupStore({ root?, trash?, now?, randomSuffix?, platform? })`; defaults: the module root
(`defaultConfigRoot()`), the `trash` package, `new Date()`, six random bytes in base64url, `process.platform`.
`defaultFolder` is `<root>/.wiretap/backups`.

- `resolveFolder(folder, settingFolder)`: a non-absolute folder or setting is `BACKUP_FOLDER_INVALID`. No folder: the
  setting (kind `setting`) or the default (kind `default`). A given folder resolves to kind `default` or `setting`
  when it names one of them (case-insensitive on Windows), else `named`.
- `checkFolder(folder, create)`: refuses a symbolic link (on Windows a directory junction counts) on the folder and,
  for the default folder, on `.wiretap`. Only the default folder may be missing (returns false) and only it is created
  (`ensureWiretapDir`, then `mkdirSync` mode 0o700). A missing setting or named folder, or a non-directory, is
  `BACKUP_FOLDER_INVALID`.
- `createFile(folder)`: names the file `backupFileName(now, suffix)`, refuses a link at the path, opens it with `wx`
  (exclusive; an existing file is never overwritten) at 0o600 and writes the blank header line. The writer's `append`
  writes at the end, `finish(fields)` writes the header (with `created` and `bytes` from `fstat`) over the blank line
  and closes, `close()` closes if open. Every file-system failure is logged and becomes `BACKUP_WRITE_FAILED` with a
  fixed message.
- `openFile(folder, file)`: an off-pattern or missing name is `BACKUP_NOT_FOUND`; a link, a non-file, a header
  `parseHeaderLine` refuses or a size other than the header's `bytes` is `BACKUP_INVALID`. The reader's
  `readPiece(maxBytes)` returns the next bytes after the header line, null at the end.
- `list(folder, limit)`: an empty listing for a missing default folder; otherwise the pattern-matching names, newest
  first (the name starts with the UTC time), each opened and checked, at most `limit` rows and at most 1,000 header
  reads; `total` counts every matching name, `invalid` the ones that failed with `BACKUP_INVALID`.
- `trashPath(path)`: `trash([path], { glob: false })`, then confirms nothing is left at the path; a throw or a file
  still there is `TRASH_FAILED` naming the file and the reason (at most 120 bytes). `trashFile(folder, file)` runs
  `openFile` first, so only a checked backup file is ever recycled. Only `delete_backup` (through `trashFile`)
  surfaces `TRASH_FAILED`; the backup tool catches it from `trashPath` and keeps the backup's own code.
- Residual risk (documented in the file): each link check and the following open are separate calls, so a link
  swapped in between is not caught; no `O_NOFOLLOW` open is used.

## Piece transport

- Both directions carry `{ requestId, seq, data }` data pieces of at most 512,000 bytes and one end marker
  `{ requestId, seq, end: true, pieces, bytes }`; each piece is acked before the next is sent, so one piece is in
  flight per stream. A refusal (`PIECE_REFUSED` or the receiver's own code) stops the stream.
- Sidecar side: `expectPieces` and `sendPiece` of `server/foundryBridge.ts` (`wiretap-mcp-bridge`). The backup sink
  (`createBackupSink`) refuses a piece out of order, a total over 64,000,000 bytes with the header
  (`BACKUP_TOO_LARGE`) and an end marker whose counts differ from what arrived; it keeps its first failure and refuses
  every later piece; `gone()` records `ENDPOINT_GONE` and never throws.
- Client side (`createPieceChannel(socket)`, made once per socket by `initFoundryBridge` and passed to every op
  handler as `invocation.pieces`): `send(requestId, seq, data, waitMs)` and `end(requestId, seq, pieces, bytes,
  waitMs)` emit `bridge:backupPiece` with `socket.timeout(waitMs).emitWithAck` and resolve on `{ ok: true }`; a
  refusal throws `PIECE_REFUSED` naming the sidecar's code (cut by `cleanForLog` to 64 bytes), a timeout or
  disconnect `SCRIPT_TIMEOUT`. `receive(requestId)` opens a receiver; the one `bridge:restorePiece` listener checks
  each piece's shape (`data` an `ArrayBuffer`, as Socket.IO delivers binary in the browser, or a `Uint8Array`) and
  refuses at once a malformed piece, a piece with no open receiver and a piece that arrives while one is unacked.
  `next(waitMs)` resolves with the held or next piece, or rejects `SCRIPT_TIMEOUT`; the piece's `ack(refusal?)`
  answers it (only the first call counts); `close()` removes the receiver and refuses a held piece.

## Client export (`selection.js`, `exportBackup.js`)

- Selection, one selector: `uuids` (each resolved with `fromUuid`; nothing there is `DOC_NOT_FOUND`; an embedded
  document becomes its primary parent and counts in `parents`; a uuid named twice keeps its first place; Folders move
  to the front), `folderUuid` (a Folder, then its subfolders a level at a time, then the world documents of its type
  or the pack index entries inside them; not a Folder or a Folder of packs is `ARGS_INVALID`), `documentName` (a
  world document type: its world Folders, then every world document of it; `Folder` means every world Folder) or
  `pack` (its Folders, then every index entry; unknown is `ARGS_INVALID`). Folders are ordered parent before child
  (by depth in their own world or pack). `User` and `Setting` are refused (`ARGS_INVALID`): the export drops
  passwords and redacts setting values, so a restore would damage them.
- `loadEntries` yields each entry with its document, or null when it is gone: world documents and pack Folders one by
  one, other pack documents in runs of up to 100 of one pack with one `getDocuments({ _id__in })`.
- `exportBackup`: more than 10,000 entries is `BACKUP_TOO_LARGE`. A measuring pass exports every document with
  `exportForBackup` and sums the line bytes; a document that is gone or refused counts in `unreadable`. No readable
  document is `BACKUP_EMPTY`; header plus lines over 64,000,000 bytes is `BACKUP_TOO_LARGE`. A dry run returns
  `{ documents, bytes, unreadable, parents }` here. Otherwise a second pass exports again and writes each line
  (`{ uuid, documentName, pack?, data, secretPaths? }` and a newline) through `createPieceWriter`, then sends the end
  marker, and returns the counts with `world` (`game.world.id`, `game.version`, `game.system.id`,
  `game.system.version`). Each document is checked against the deadline (`timeoutMs`); past it is `SCRIPT_TIMEOUT`
  ("nothing was saved"). Each ack wait is the time left. Documents never pass through the agent's context.

## Client restore (`restoreBackup.js`)

- Opens its receiver before any await, so a piece sent right after the invoke has one. A header of another world is
  `ARGS_INVALID`; a different `foundryVersion`, `systemId` or `systemVersion` is listed in `differences`
  (`<field>: <backup> -> <current>`), not refused.
- Lines are split by `createLineReader` and applied in file order, one at a time, each piece acked after its lines.
  A line that is not valid UTF-8 JSON of the `BackupLine` shape is a `failed` row `line <n>`. With `uuids`, a line is
  applied when an asked uuid is its uuid or starts with it plus `.` (an embedded uuid names its document); asked uuids
  no line matched are `skipped` rows.
- Per line: the pack must exist (`PACK_GONE`) and be unlocked (`PACK_LOCKED`), the class and the subtype must exist
  (`TYPE_GONE`). A `folder` that names no Folder of its world or pack, nor one this dry run plans to create, is
  cleared (`FOLDER_GONE` reason). `flags.wiretap` is stripped. A live document (`fromUuid`) gets its secrets carried
  back (`carrySecrets`) and is replaced through `prepareReplace({ uuid, data, dryRun: false, restore: true })` and
  `runReplace`; a missing one is created again through `prepareCreate({ documentName, data: [data], pack, keepId:
  true })` and `runCreate`. Each document so meets every gate, the write guard and Foundry validation the same write
  through `replace_document` or `create_documents` meets (re-creating needs `allowOwnershipWrites` for the backed-up
  ownership). A dry run prepares with the gates of a real run and writes nothing. One failing document becomes a
  `failed` row with `<code>: <message>` and does not stop the others.
- `secretLost` counts documents whose left-out secret values have no live value to carry back (a re-created
  document with any `secretPaths` counts). `carrySecrets` walks each path beside the live `toObject()`, following an
  array member by its `_id` (embedded documents may have moved) and, for a member with no `_id`, by index only.
- End marker: its counts must equal the pieces and bytes received with no partial line left, else
  `BACKUP_INCOMPLETE`. The deadline passing while waiting or between lines is `SCRIPT_TIMEOUT` naming how many
  documents were written ("it is partly applied"). Result: `{ replaced, created, skipped, failed, rows, secretLost,
  differences?, dryRun? }`, rows failed first, then skipped, created and replaced, at most 20, reasons cut to 160 B.
- Not atomic: documents apply one by one, hooks and system side effects run and are not reverted.

## Rules

- Files are removed only through the recycle bin (D34): only `server/backups.ts` imports `trash`, called as
  `trash([path], { glob: false })`; `tests/unit/noPermanentDelete.test.js` enforces the import rule and the ban on
  permanent-delete calls. A sidecar running as the Windows SYSTEM account sends files to that account's recycle bin
  (the `trash` README).
- What a GM client sends is untrusted (any local process can connect and identify): the bridge bounds piece shapes,
  the sink checks order and size, and the tools check the export and restore results against the received pieces
  before a file is finished or a result returned (`BACKUP_INCOMPLETE` on a mismatch).
- No message echoes file content or unbounded caller text. Document text never reaches an MCP message
  (`tests/integration/backupTools.test.js` and the e2e spec assert it with a marker string).
- Budgets (`shared/budgets.js`): results `backup_documents` 256 B, `list_backups` 2000 B, `restore_backup` 4000 B,
  `delete_backup` 128 B; each definition at most 800 B (`backup_documents` is exactly 800 B). To fit, an argument
  has a `describe` only where its name and type do not say what it is: `uuids`, `folderUuid`, `documentName`, `pack`
  and `timeoutMs` of `backup_documents`, `limit` of `list_backups` and `timeoutMs` of `restore_backup` have none.
- One backup or restore at a time per MCP server (`BACKUP_BUSY`); the lock clears when the invoke settles.

## Tests

Unit: `backupFormat`, `bridgeSettings`, `bridgeSettings.client`, `backups` (the store over a scratch root with
`fakeTrash`; the 1,001-file header-read cap test has a 30 s limit), `backupTools` (a fake `BackupBridge`, the real
store), `backupSelection` and `exportBackup` (over `mockBackupWorld.js`), `pieceWriter`, `lineReader`, `pieces`,
`restoreBackup`, `secretCarry`, `foundryBridge.pieces` (the sidecar bridge's piece events and `sendPiece`),
`foundryBridge.backupOps` (the client op table), `noPermanentDelete`; restore mode in `writeReplaceRestore`,
`exportForBackup` in `canonicalBackup`. `backupTestHelpers.js` holds `scratchRoot(prefix)` and `fakeTrash(binDir)`;
no unit or integration test runs the real `trash`. Integration: `backupTools.test.js` (real sidecar, Socket.IO, SDK
client, fake GM of `contextBudgetHarness.js`), `backupPieces.test.js` (raw sockets). e2e: `backupTools.spec.js` on the
live world (the Backup folder setting set to a `test/tmp/` scratch root after `recordGateSettings`, so a killed run is
restored; the real `trash`; a dry run of the largest compendium pack).
