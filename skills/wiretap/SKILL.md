---
name: wiretap
description: Use when working with the live Foundry VTT world through the Wiretap MCP server (tools named mcp__wiretap__*), for example reading, creating, updating, replacing or deleting documents, backing up or restoring documents, opening or closing sheets, rolling dice or drawing from a table, running a macro, or reading a large stored result.
---
# Wiretap: Foundry VTT tools
Wiretap acts on the live Foundry world through MCP tools that work via a connected GM's browser. With none connected, a
call fails with `NO_ENDPOINT`, naming what to start. An undeclared argument (a misspelled `dryrun`) is refused.

## Recipes
- **Read a document.** `mcp__wiretap__get_document` with `uuid`, or `documentName` and `id` (add `parentUuid` for an
embedded one, `pack` for a compendium one). The default is a compact view (name, type, key fields, embedded `[id, name,
type]` rows, `modified`). For more: `paths` (up to 20, like `system.attributes` or `items.*.name`, keyed by `_id`;
`derived: true` reads prepared values), `fields`, or `mode: "full"` (large becomes a handle). `ifModifiedSince` returns
`{unchanged: true}`; `maxBytes` raises the inline limit to 16,000. Passwords, credential and `wiretap.*` settings are
unreadable; secret-named keys are dropped from setting values and flags.
- **Find documents.** `mcp__wiretap__list_document_types` lists classes and subtypes. `mcp__wiretap__search_documents`
needs `documentName`; narrow with `type`, `query` (name text), `filters` (up to 5 `path=value`), `pack` or `parentUuid`.
Rows are `[uuid, name, type]`, 20 per page (`limit` up to 100); follow `nextCursor` as `cursor`, also after a `cut`.
`mcp__wiretap__describe_schema` (`documentName`, `subtype`; `path` narrows it) shows the data shape to create.
- **Create documents.** `mcp__wiretap__create_documents` takes `documentName` and `data`: one JSON object text per
document (up to 50), for example `["{\"name\":\"Bob\",\"type\":\"npc\"}"]`. Add `parentUuid` for embedded documents (an
Item under an Actor), `pack` for a compendium, `keepId` to keep each `_id`. The ack is `{uuid, name, type}` per
document; `paths` adds those paths of each. Pass `idempotencyKey` (up to 64 letters, digits, `._:-`) so a retry after a
timeout returns the first ack; the same key with other data is `IDEMPOTENCY_CONFLICT`.
- **Update documents.** `mcp__wiretap__update_documents` takes `updates`, one patch per entry: `uuid`, `path`, `value`
(JSON text, so a string is `"\"x\""`) and `op`: `set` merges (default), `replace` swaps the whole value, `delete`
removes the field (no value). Entries with one uuid form one update; embedded documents use `items.<_id>.system.x` (ids
from `get_document`; no wildcards; `_id` itself is never a path). The ack is `{uuid, changed}`; `changed: []` means
Foundry applied nothing (no change, or a hook cancelled it). `dryRun: true` on a write previews it (and works with every
gate closed); on `mcp__wiretap__delete_documents` (irreversible) it lists what would go.
- **Replace and batch.** `mcp__wiretap__replace_document` takes `uuid` and `data`, the JSON text of a full read,
changed: the import replaces each top-level field, so a field left out resets to its default (omit `items`: they are
deleted; omit `flags`: other modules' flags go). Leave `ownership` out; `_id`, `sort`, `folder` stay. Not for Users: use
`update_documents`. `mcp__wiretap__batch` takes `creates` (`documentName`, `data`, `parentUuid` per document), `updates`
(patches) and `deletes`, run in that order; a key an entry does not list (`parent` for `parentUuid`) is refused. Not
atomic: Foundry checks all first, stops at the first failure and keeps what it did; `WRITE_NOT_APPLIED` says "N of M
operations applied". `actAs` (a user id) on any write only checks that user's permission first (`ACT_AS_DENIED`).
- **Backups.** Before a bulk update (more than about 10 documents), any `replace_document`, any delete, or an
`execute_macro` that changes documents, offer `mcp__wiretap__backup_documents`: `uuids` (up to 200; an embedded one
saves its parent) or one `folderUuid`, `documentName` or `pack`, and a `note`. Tell the user the `file` and where it
went (`folder: "default"` is `.wiretap/backups` in the module folder; `"setting"` is the GM's Backup folder setting).
`mcp__wiretap__list_backups` lists them. `mcp__wiretap__restore_backup` (`file`, `uuids`, `dryRun`) only when the user
asks: not atomic, hooks run; it needs `allowReplace`, `allowOwnershipWrites` to re-create a deleted document and
`allowDelete` when embedded documents were added since. `mcp__wiretap__delete_backup` moves a file to the recycle bin.
Another `folder` needs `allowBackupAnyFolder`. A whole-world backup is made on Foundry's setup screen, world shut down.
- **Read a large result.** A result over 8,000 bytes is returned as `{"handle", "bytes", "summary"}`. Call
`mcp__wiretap__read_handle` with that `handle` and `paths` (up to 20, `*` is one wildcard over a list), or `offset` and
`length` for non-JSON text, or a larger `maxBytes`. A handle expires after 30 minutes unused (`HANDLE_NOT_FOUND`). To
write a stored full read, give `"handle:<handle>"` as a `data` text of `create_documents` or `replace_document`; the
gates still judge it (up to 100,000 bytes a text, 200,000 in all; `HANDLE_NOT_DOCUMENT` if it is not one document).
- **Sheets, dice and macros.** `mcp__wiretap__open_sheet` with `uuid` opens a sheet on the client running the call, or
with `userId` on every tab that connected user has open (who needs OBSERVER; the first answer is reported);
`mcp__wiretap__close_sheet` with the same arguments closes it there. With no human connected no one sees a sheet: read
the data instead. `mcp__wiretap__roll` takes a `formula` (no `@` references), `mcp__wiretap__draw_table` a RollTable
`uuid` (drawn results are marked); `toChat` (default false) posts to chat. `mcp__wiretap__execute_macro` runs a Macro
`uuid` for `actorUuid` / `tokenUuid` (on the viewed scene), needs `allowMacroExecution` and returns its value within
`timeoutMs` (1 s to 5 min; default 8 s). A null chat `value`: no message of its own, or its command failed; a `/macro`
or a module may have. `tooLarge: true` (with `bytes`): it ran, its value dropped: that alone does not show it worked.
## Errors you may meet
- `ARGS_INVALID` (names the argument), `DOC_NOT_FOUND`, `DOC_EXCLUDED`, `PATH_*`, `CURSOR_INVALID`, `SCRIPT_BUSY`
  (retry), `VALIDATION_FAILED` (up to 10 failures and the count; nothing written), `TABLE_EMPTY` (nothing left to draw),
  `MACRO_FAILED` (did not compile, so nothing ran; or threw, so it may have partly run), `USER_OFFLINE`, `SHEET_DENIED`
  (no OBSERVER), `SHEET_UNAVAILABLE`, `SHEET_QUERY_FAILED`, `DELETE_REFUSED` (the signed-in user or last GM),
  `BACKUP_NOT_FOUND`, `BACKUP_BUSY` (one at a time; retry), `BACKUP_TOO_LARGE` (10,000 documents or 64,000,000 bytes).
- `GATE_DENIED`: a GM setting is closed (`allowDelete`: delete_documents, batch deletes, removing embedded documents;
  `allowReplace`: replace_document; `allowMacroExecution`: execute_macro, writing macro code (a Macro command, a type
  set to script, an Adventure's macros); others), or the write is never allowed (a `wiretap.*` setting, a User password,
  the `flags.wiretap` scope, erasing `flags`). Tell the user which gate; you cannot open it.
- `WRITE_NOT_APPLIED`, `SCRIPT_TIMEOUT`, `ENDPOINT_TIMEOUT`, or your MCP client giving up before `timeoutMs` (a macro
  may run on): it may still have applied; check before retrying. `RESULT_TOO_LARGE`: read with `paths`.
