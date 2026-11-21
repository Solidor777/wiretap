# Wiretap document backups — design (M21)

Status: approved 2026-11-21 (the owner delegated the remaining design calls). Replaces the dropped undo history
(M17, D29 DROPPED).

## Intent

Agents make bulk and risky changes to a live world. Undo was dropped as too costly for what it buys. Foundry's own
backup cannot be started while a world is running: the setup route accepts `createBackup` only when no world is
active (READ `dist/server/views/setup.mjs`, `handlePost`: `!game.world && admin`). So a world backup stays a human step
on the setup screen.

Wiretap fills the gap with a lean set of tools to save documents to backup files and put them back. The agent offers a
backup before bulk changes and risky operations. The document text never passes through the agent's context.

## Goals

- Save the full stored form of chosen documents to one new backup file, during a live session.
- List backups, restore all or some documents from one, and remove a backup to the recycle bin.
- A default backup folder that works with no setup, and any other folder the user names.
- The user-facing skill tells the agent when to offer a backup.

## Non-goals

- Undo, turn tracking or change history.
- Whole-world backups (the owner accepted lists and groups only; a whole-world backup is a later option).
- Backing up files Foundry stores outside documents (images, audio, module files).
- Automatic or scheduled backups.
- Triggering Foundry's own setup-screen backup.

## Anti-goals (a failure even if it works)

- Document text entering the agent's context during backup or restore.
- A backup or delete call that overwrites, reads or trashes a file that is not a Wiretap backup.
- A restore that skips a gate, the write guard or Foundry validation that the same write through the write tools would
  meet.
- Any permanent file deletion.

## Owner decisions (2026-11-21)

1. Backups are files the sidecar writes, not compendium packs or world copies.
2. Default folder `<module root>/.wiretap/backups/` (already gitignored), changeable by a GM-only world setting. A call
   may name any other folder.
3. Writing outside the default folder needs a new GM gate, default OFF (owner did not object to the proposal).
4. A restore tool is built.
5. One backup covers a list of documents or a whole group: a folder, a document type, or a compendium pack.
6. The project rule changes from "no file deletion in Wiretap code" to "remove files only by moving them to the
   recycle bin; never delete permanently" (D34 below).
7. Add the `trash` npm package (runtime dependency of the sidecar) for the recycle bin.
8. This is the next milestone, ahead of M18.

## Approaches

| Approach | Trade-off | Verdict |
|---|---|---|
| A. The GM client exports the documents and streams them to the sidecar in pieces; the sidecar writes the file. Restore streams the file back to a GM client, which applies it through the existing write code | One new bridge message pair for pieces; every existing gate, guard and validation applies to restore | **Chosen** |
| B. The agent exports each document to a handle (`export_to_handle`, M15a), then asks the sidecar to save the handles | Many calls; depends on M15a; the agent orchestrates every document | Rejected: loses the context saving that is the point |
| C. The sidecar reads Foundry's database files directly | Works with no client; reads files the running server holds open and skips system DataModel validation | Rejected by D1 and D27 |

## Design

### Tools

All are registry scripts or sidecar built-ins as noted; names are public API (owner consent given with this doc).

| Tool | Runs on | Arguments | Result |
|---|---|---|---|
| `backup_documents` | GM client exports; sidecar writes | `uuids[]?` (1 to 200), or exactly one of `folderUuid`, `documentName` (a world document type), `pack`; `folder?` (target directory); `note?` (≤ 200 B); `dryRun?` | `{ file, documents, bytes }`, ≤ 256 B; a dry run gives the count and estimated bytes |
| `list_backups` | sidecar | `folder?`, `limit?` | Newest first: `[file, created, documents, note]` rows, ≤ 2 KB |
| `restore_backup` | sidecar reads; GM client applies | `file`, `folder?`, `uuids[]?` (a subset), `dryRun?` | Counts `replaced`, `created`, `skipped`, `failed` plus at most 20 rows `[uuid, state, reason?]`, ≤ 4 KB; a dry run lists the planned state per document |
| `delete_backup` | sidecar | `file`, `folder?` | `{ file, trashed: true }`, ≤ 128 B |

`file` is a file name inside the folder, not a path; the folder is `folder` or the default.

### What a backup contains

- Primary documents only, in the canonical full form of §4.4 (`toCompendium(null, { clearSource: false, keepId: true,
  clearSort: false, clearOwnership: false })`), with their embedded documents inside. An embedded uuid in `uuids`
  backs up its primary parent; the result says so.
- A folder group includes its subfolders and the Folder documents, so a restore can re-create a deleted folder before
  its contents.
- `User` and `Setting` documents are refused (`ARGS_INVALID`): the export removes user password fields and redacts
  setting values (§4.4), so a restore would damage them.
- The §4.4 exclusions and redaction apply, as for every read. Documents a read cannot see are not backed up, and the
  result counts them. Redaction stays on because a backup file sits on disk where the agent can read it with its own
  file tools, and it may be in any folder.
- Restore keeps redacted keys: a `flags` key that the export redaction drops (the §4.4 secret-name pattern) is not in
  the backup, so before the replace the client copies the live value of every such key into the restored data. A key
  of that kind that was deleted after the backup cannot come back; the result counts documents where this applies.
  (Owner delegated the design on 2026-11-21; designer's call, chosen over writing unredacted backups.)
- A document whose export hits the redaction walk bounds (50,000 nodes, 24 levels, or JSON text nested 4 deep in
  strings) is not backed up: it is counted as unreadable (`DOC_UNREADABLE`), never written cut, since a cut export no
  longer holds the document whole.
  (Designer's call.)

### File format and naming

- JSON Lines: line 1 is a header `{ wiretapBackup: 1, created, worldId, foundryVersion, systemId, systemVersion,
  note, documents, bytes }`; each further line is one `{ uuid, documentName, pack?, data }`. `list_backups` reads only
  the first line of each file.
- The sidecar names the file `<UTC timestamp>-<8 random base64url chars>.wtbackup.jsonl`; the agent never chooses a
  name. Created with the exclusive-create flag (`wx`): an existing file is never overwritten.
- Bounds: 10,000 documents and 64 MB per backup (`HANDLE_STORE_MAX_BYTES` scale); over either, the call fails before
  writing, naming the count or size.

### Folders, gate and setting

- Default folder: `<module root>/.wiretap/backups/`, created on first use with the same modes and symbolic-link checks
  as `.wiretap/` (`server/mcpConfigFile.ts`).
- World setting `backupFolder` (GM-only, `restricted`, string, empty means the default). No settings carrier exists
  today (the snapshot is a `GateState`), so M21 adds a `settings` object beside the gate snapshot in
  `bridge:identify` and its update message, with `backupFolder` its only member; M19 later adds `persistHandles` to
  it. The sidecar uses the picked endpoint's value, as it does for gates; all GM clients read one world setting, so
  they disagree only for the moment an update is in flight. (Designer's call.)
- New gate `allowBackupAnyFolder` (default OFF): needed when `folder` names a directory other than the default or the
  `backupFolder` setting. Added to `shared/gates.js`, the settings and the lang file.
- Every folder: an absolute path after resolution; the folder and the file are `lstat`-checked and refused when they are
  symbolic links; the folder must already exist unless it is the default.
- A read, restore or delete opens only a file whose name matches the naming pattern and whose first line is a valid
  Wiretap header; anything else is `BACKUP_NOT_FOUND` or `BACKUP_INVALID`, and no file content is ever echoed in a
  message.

### Transport

- The Socket.IO server sets no `maxHttpBufferSize` (READ `server/`, grep). Unverified: Socket.IO's default is 1 MB per
  message. Backup and restore data move in pieces of at most 512 KB over a new pair of bridge events (one per
  direction), tied to the invocation's `requestId`, with an end marker carrying the piece count and total bytes.
- Backup: the sidecar opens the file only after the gate and folder checks, appends pieces as they arrive, and on a
  failure or disconnect moves the partial file to the recycle bin and fails the call.
- This changes the bridge protocol: `PROTOCOL_VERSION` goes to 5 (no backwards compatibility).
- Each piece is acked before the next is sent, so neither side holds more than one piece in flight and a lost piece
  fails the call at once. (Designer's call.)
- The client exports and applies document by document (packs read in batches), so its memory holds about one piece,
  not the whole backup. (Designer's call.)
- `backup_documents` and `restore_backup` declare `timeoutMs` (the existing shared argument, up to 300,000 ms), with a
  default of 120,000 ms. One backup or restore runs at a time per sidecar; a second is refused with a busy error.
  If the GM client disconnects mid-restore, the call fails `ENDPOINT_GONE` and says the restore may be partly applied;
  a dry run or `list_backups` does not show restore progress. (Designer's calls.)

### Gate checks

- `restore_backup` declares no gate, like the write tools: the client checks each document's gates as a write tool
  would, and a denied document is `failed` with the gate's name, not the whole call.
- `backup_documents` declares no gate; `allowBackupAnyFolder` depends on the `folder` argument, so the sidecar checks
  it on the picked endpoint's gate snapshot before anything is sent.
- `list_backups` and `delete_backup` run in the sidecar but still pick a GM endpoint (the router's existing pick) only
  to read its gate snapshot and `backupFolder`; with no GM endpoint connected they work on the default folder only.
  (Designer's calls.)

### Restore

- Refused when the header's `worldId` is not the current world (`ARGS_INVALID`).
- For each document, in folder-first order: if its uuid exists, it is replaced through the `replace_document` path
  (`allowReplace` needed; `allowOwnershipWrites` when `ownership` differs, as today); if not, it is created with its
  id kept through the `create_documents` path. Compendium targets need `allowCompendiumWrites` and an unlocked pack.
  Each document passes `guardWrite`, validation and the gates of its category, exactly as a write tool would.
- Not atomic: documents apply one by one and the result reports each state. Hooks and game-system side effects of the
  restore run and are not reverted; the tool description says so.
- `dryRun` plans every document and reports what would happen, writing nothing.
- A replace restores the document as it was at backup time, embedded documents included: embedded documents added
  since are removed, which also needs `allowDelete` (as for `replace_document` today). A document whose pack or type
  no longer exists is `failed` with that reason.
- A different `foundryVersion`, `systemId` or `systemVersion` does not refuse the restore; the dry run and the result
  name the difference, and Foundry validation judges each document. (Builder-check answer; designer's call.)
- `create_documents` already supports `keepId` (`wiretap-writes` skill); the restore create path reuses
  `prepareCreate` with it.

### Recycle-bin removal (D34)

- Wiretap code may remove a file only through the `trash` package; no permanent-delete API (`fs.rm*`, `fs.unlink*`,
  `fs.rmdir*`, recursive removal helpers) appears in product code or tests. The source check changes to ban those and
  allow `trash`.
- Known limit (per the `trash` README): when the sidecar runs as the Windows SYSTEM account, files go to that account's
  recycle bin, not the user's.
- If `trash` fails (no recycle bin on the host, for example), the file stays where it is and the call fails with
  `TRASH_FAILED`, naming the file and the reason; a partial backup file left this way is named in the backup's error.
  (Designer's call.)
- Unit and integration tests mock `trash`; only e2e runs it for real, on files under `test/tmp/`.
- Text to update: PLAN.md §6 rules (the "No file deletion" bullet), M18 and M19 acceptance and test lines, the
  `wiretap-codebase-core`, `wiretap-build-test` and `wiretap-sidecar` skills.

### Agent guidance

`skills/wiretap/SKILL.md` gains a short section: offer `backup_documents` before a bulk update (more than about 10
documents), any `replace_document`, any delete, and any `execute_macro` that changes documents; say where the file
went; restore only when asked. It also says a full world backup is made from Foundry's setup screen with the world
shut down.

### Plan changes on approval

- PLAN.md: D33 (backups, this design) and D34 (recycle-bin rule) as DECIDED; a new M21 section; the order becomes
  M5 → M6 → M21 → M18 → …; §4.6 gate row for `allowBackupAnyFolder`; the §6 rule change.
- PROGRESS.md: revision 8 entry.

## Left to the builder

- Event names and piece shape; the exact header field types.
- Which sidecar module owns the file store (a new `server/backups.ts` is expected) and how list and delete register as
  built-ins next to `read_handle`.
- Error code names beyond `BACKUP_NOT_FOUND` and `BACKUP_INVALID`.
- Measuring the real bytes of the 64 MB, 10,000-document bounds against a large synthetic world, and adjusting with
  owner consent if they do not fit.
