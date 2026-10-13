---
name: wiretap
description: Use when working with the live Foundry VTT world through the Wiretap MCP server (tools named mcp__wiretap__*), for example creating an Actor or reading a large stored result.
---

# Wiretap: Foundry VTT tools

Wiretap lets you act on the live Foundry world through MCP tools. Each tool runs in a connected GM's browser, so a
Foundry GM client must be open and connected to the Wiretap sidecar; with none, a call fails with `NO_ENDPOINT` and
the message says what to start.

## Tools that exist now

| Tool | Does |
|---|---|
| `mcp__wiretap__create_actor` | Creates one Actor. Returns the JSON ack `{uuid, name, type}` |
| `mcp__wiretap__read_handle` | Reads a stored large result by handle |

The tool list can change during a session: scripts a GM client registers appear and vanish as the client connects and
disconnects. If a tool you expect is not listed, check that the GM client is connected before assuming it is gone. If
your client defers tool schemas, load one with `ToolSearch` and `select:mcp__wiretap__create_actor`.

## Recipes

**Create an Actor.** Call `mcp__wiretap__create_actor` with `name` (1 to 128 characters). Add `type` only when the user
named a subtype (1 to 64 characters); without it the world's first concrete Actor subtype is used. No other argument is
accepted. The result is the JSON ack `{uuid, name, type}`; a name over about 80 bytes is shortened in it. An unknown `type` fails with the list of valid types: retry with one of them. Calling again creates a
second Actor, so check before retrying after a timeout (`ENDPOINT_TIMEOUT` says the operation may still have applied).

**Read a large result.** A tool result over 8,000 bytes is not returned inline. You receive
`{"handle", "bytes", "summary"}` instead. Call `mcp__wiretap__read_handle` with that `handle`:

- `paths`: up to 20 dot paths into the stored JSON, for example `system.attributes.hp` or `items.*.name`
  (`*` is one wildcard over a list; an embedded document is addressed by its `_id`). Prefer `paths` to paging.
- `offset` and `length`: page through the raw text when it is not JSON. Counts are UTF-16 units.
- `maxBytes`: raise the window up to 16,000 bytes when one read must be larger.

A handle belongs to your MCP session and expires after 30 minutes without use. `HANDLE_NOT_FOUND` means it expired, was
evicted, or belongs to another session: repeat the original call.

## Errors you may meet

- Invalid arguments are refused before anything runs; the message names the argument. A client can also refuse them
  with `ARGS_INVALID` (for example an argument tree over 10,000 values).
- `GATE_DENIED`: a world setting the GM controls (a risk gate) is closed. Tell the user which gate the message names;
  you cannot open it.
- `OP_FAILED` saying a tool is not registered on this client: the client no longer offers it (reported as `TOOL_GONE`
  by the sidecar itself). List the tools again.
- `SCRIPT_TIMEOUT`: the script ran 8 s without finishing, before `ENDPOINT_TIMEOUT` (10 s); the operation may still have
  applied, so check before retrying.
- `SCRIPT_BUSY`: the client already runs 8 scripts; retry shortly.
- `RESULT_TOO_LARGE` or `RESULT_INVALID`: the script's result was over about 900,000 bytes or not plain data; do not
  retry unchanged.
