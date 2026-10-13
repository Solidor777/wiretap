---
name: wiretap
description: Use when working with the live Foundry VTT world through the Wiretap MCP server (tools named mcp__wiretap__*), for example reading, creating, updating or deleting documents, or reading a large stored result.
---

# Wiretap: Foundry VTT tools

Wiretap acts on the live Foundry world through MCP tools that run in a connected GM's browser; tools appear as GM
clients connect. With none connected, a call fails with `NO_ENDPOINT` and the message says what to start.

## Tools that exist now

| Tool | Does |
|---|---|
| `mcp__wiretap__list_document_types` | Lists the world's document classes and the subtypes of each |
| `mcp__wiretap__get_document` | Reads one document: compact view, `fields`, `paths` or `mode: "full"` |
| `mcp__wiretap__search_documents` | Finds documents of one class by name, type or field values, in pages |
| `mcp__wiretap__describe_schema` | Shows a class's blank example and schema outline, or the constraints at a `path` |
| `mcp__wiretap__create_documents` | Creates documents of one class, also embedded or in a pack |
| `mcp__wiretap__update_documents` | Writes paths of documents, also embedded paths like `items.<id>.name` |
| `mcp__wiretap__delete_documents` | Deletes documents by uuid. Irreversible |
| `mcp__wiretap__read_handle` | Reads a stored large result by handle |

## Recipes

**Read a document.** `mcp__wiretap__get_document` with `uuid`, or `documentName` and `id` (add `parentUuid` for an
embedded one, `pack` for a compendium one). The default is a compact view (name, type, key fields, embedded
`[id, name, type]` rows, `modified`). For more: `paths` (up to 20, like `system.attributes` or `items.*.name`, keyed by
`_id`; `derived: true` reads prepared values), `fields`, or `mode: "full"` (large becomes a handle). `ifModifiedSince`
returns `{unchanged: true}`; `maxBytes` raises the inline limit to 16,000. Passwords, credential settings and
`wiretap.*` settings are unreadable; secret-named keys are dropped from setting values and flags.

**Find documents.** `mcp__wiretap__search_documents` needs `documentName`; narrow with `type`, `query` (name text),
`filters` (up to 5 `path=value`), `pack` or `parentUuid`. Rows are `[uuid, name, type]`, 20 per page (`limit` up to
100); follow `nextCursor` as `cursor`, also when it reports `cut`. `mcp__wiretap__describe_schema` with `documentName`
and `subtype` shows the data shape to create; add `path` for one subtree with choices, min and max.

**Create documents.** `mcp__wiretap__create_documents` takes `documentName` and `data`: one JSON object text per
document (up to 50), for example `["{\"name\":\"Bob\",\"type\":\"npc\"}"]`. Add `parentUuid` for embedded documents
(an Item under an Actor), `pack` for a compendium, `keepId` to keep each `_id`. The ack is `{uuid, name, type}` per
document; `paths` adds those paths of each created document. Check before retrying after a timeout.

**Update documents.** `mcp__wiretap__update_documents` takes `updates`, one patch per entry: `uuid`, `path`, `value`
(JSON text, so a string is `"\"x\""`) and `op`: `set` merges (default), `replace` swaps the whole value, `delete`
removes the field (no value). Entries with one uuid form one update; embedded documents use `items.<_id>.system.x`
(ids from `get_document`; no wildcards). The ack is `{uuid, changed}`; `changed: []` means Foundry applied nothing.
`dryRun: true` on a write previews it; on `delete_documents` it lists `[uuid, name, type]` of all that goes.

**Read a large result.** A result over 8,000 bytes is returned as `{"handle", "bytes", "summary"}`. Call
`mcp__wiretap__read_handle` with that `handle` and `paths` (up to 20, `*` is one wildcard over a list), or `offset` and
`length` for non-JSON text, or a larger `maxBytes`. A handle expires after 30 minutes unused (`HANDLE_NOT_FOUND`).

## Errors you may meet

- `ARGS_INVALID` (the message names the argument), `DOC_NOT_FOUND`, `DOC_EXCLUDED`, `PATH_*` (a refused path),
  `CURSOR_INVALID`, `VALIDATION_FAILED` (up to 10 failures and the count; nothing written), `SCRIPT_BUSY` (retry).
- `GATE_DENIED`: a world setting the GM controls is closed, or the write is never allowed (a `wiretap.*` setting, a User
  password). Tell the user which gate; you cannot open it. `DELETE_REFUSED`: the signed-in user or last game master.
- `WRITE_NOT_APPLIED` (a hook cancelled part of the call), `SCRIPT_TIMEOUT` (8 s) and `ENDPOINT_TIMEOUT`: the
  operation may still have applied; check before retrying. `RESULT_TOO_LARGE`: read with `paths`.
