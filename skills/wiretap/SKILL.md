---
name: wiretap
description: Use when working with the live Foundry VTT world through the Wiretap MCP server (tools named mcp__wiretap__*), for example reading a document, creating an Actor or reading a large stored result.
---

# Wiretap: Foundry VTT tools

Wiretap acts on the live Foundry world through MCP tools that run in a connected GM's browser. With no GM client
connected, a call fails with `NO_ENDPOINT` and the message says what to start.

## Tools that exist now

| Tool | Does |
|---|---|
| `mcp__wiretap__list_document_types` | Lists the world's document classes and the subtypes of each |
| `mcp__wiretap__get_document` | Reads one document: compact view, `fields`, `paths` or `mode: "full"` |
| `mcp__wiretap__search_documents` | Finds documents of one class by name, type or field values, in pages |
| `mcp__wiretap__describe_schema` | Shows a class's blank example and schema outline, or the constraints at a `path` |
| `mcp__wiretap__create_actor` | Creates one Actor. Returns the JSON ack `{uuid, name, type}` |
| `mcp__wiretap__read_handle` | Reads a stored large result by handle |

The tool list changes as GM clients connect. If a tool you expect is missing, check the GM client. If your client
defers tool schemas, load one with `ToolSearch` and `select:mcp__wiretap__get_document`.

## Recipes

**Read a document.** Call `mcp__wiretap__get_document` with `uuid`, or `documentName` and `id` (add `parentUuid` for an
embedded document, `pack` for a compendium one). The default is a compact view (name, type, key fields, embedded
`[id, name, type]` rows, `modified`). For more: `paths` (up to 20, like `system.attributes` or `items.*.name`, keyed by
`_id`; `derived: true` reads prepared values), `fields` (a nested projection), or `mode: "full"` (a large export
becomes a handle). `ifModifiedSince` (a `modified` value) returns `{unchanged: true}` when nothing changed. Raise the
inline limit with `maxBytes` (up to 16,000). Passwords, credential settings and `wiretap.*` settings are unreadable
(`missing` or `DOC_EXCLUDED`); keys named like a secret (password, token, secret, apiKey) are dropped from setting
values and flags. Other settings, including other modules', are readable: read them only for a reason.

**Find documents.** `mcp__wiretap__search_documents` needs `documentName`; narrow with `type`, `query` (name text),
`filters` (up to 5 `path=value` equalities, for example `system.rarity=common`), `pack` or `parentUuid`. Rows are
`[uuid, name, type]` (`fields` adds values), 20 per page (`limit` up to 100); repeat with `nextCursor` as `cursor`. A
search has a work cap: when it reports `cut`, keep following `nextCursor`. `total` counts matches from the cursor on.

**Learn a schema.** `mcp__wiretap__describe_schema` with `documentName` and `subtype` gives a blank example and an
outline; add `path` (like `system.attributes`) for that subtree with choices, min and max. Embedded collections and
free-form fields are named, not expanded.

**Create an Actor.** `mcp__wiretap__create_actor` takes `name`; add `type` only when the user named a subtype. The
result is `{uuid, name, type}`; calling again creates a second Actor, so check before retrying after a timeout.

**Read a large result.** A result over 8,000 bytes is returned as `{"handle", "bytes", "summary"}`. Call
`mcp__wiretap__read_handle` with that `handle` and `paths` (up to 20 dot paths, `*` is one wildcard over a list), or
`offset` and `length` for non-JSON text, or a larger `maxBytes` (up to 16,000). A handle expires after 30 minutes
unused; `HANDLE_NOT_FOUND` means repeat the call.

## Errors you may meet

- `ARGS_INVALID`: the arguments were refused; the message names the argument.
- `GATE_DENIED`: a world setting the GM controls is closed. Tell the user which one; you cannot open it.
- `DOC_NOT_FOUND`, `DOC_EXCLUDED`, `DOC_UNREADABLE` (failed to export), `PATH_*` (a refused path), `CURSOR_INVALID`
  (search again without the cursor), `SEARCH_ABORTED` (timed out; resume with its cursor).
- `SCRIPT_TIMEOUT` (8 s) and `ENDPOINT_TIMEOUT`: the operation may still have applied; check before retrying.
- `SCRIPT_BUSY`: retry shortly. `RESULT_TOO_LARGE`: read with `paths`. `OP_FAILED` naming a tool: list the tools again.
