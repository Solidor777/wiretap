---
name: wiretap-mcp-sessions
description: Wiretap stateful MCP sessions and the endpoint tool registry — session lifecycle, idle expiry and cap, tools/list_changed debounce, HTTP body and connection limits, bridge:registry sanitizing and registry tool calls, server instructions. Use when reading or editing server/mcpSessions.ts, server/toolRegistry.ts, the session or HTTP parts of server/mcp.ts, or their tests.
paths:
  - "server/mcpSessions.ts"
  - "server/toolRegistry.ts"
  - "tests/unit/mcpSessions.test.js"
  - "tests/unit/toolRegistry.test.js"
  - "tests/unit/toolRegistry.logs.test.js"
  - "tests/unit/foundryBridge.registry.test.js"
  - "tests/integration/mcpSessions.test.js"
  - "tests/integration/mcpHardening.test.js"
  - "tests/integration/mcpHttp.js"
---

# Wiretap MCP sessions and the tool registry

Current-state reference; verify against code before relying on a detail. Core context: `wiretap-codebase-core`; the
tools, the router and the result enforcer are in `wiretap-mcp-bridge`; composition is in `wiretap-sidecar`.

## HTTP layer (`startMcpServer` in `server/mcp.ts`)

`startMcpServer(bridge, port, options?)` is stateful Streamable HTTP on `127.0.0.1`. `options`: `tools`, `instructions`
(default `WIRETAP_INSTRUCTIONS`), `handleStore`, `sessions` (`maxSessions`, `idleMs`, `sweepMs`, `listChangedQuietMs`,
`listChangedMaxWaitMs`, `now`, `timers`, `log`), `limits` (`requestTimeoutMs`, `headersTimeoutMs`, `timeoutCheckMs`,
`socketIdleMs`, `maxConnections`, `bodyMaxBytes`). Returns `{ close, ready, port, sessions }`: `port()` is the bound port, `sessions()` the
open count, `ready` resolves once bound and rejects on a bind failure, and `close()` cancels the debouncer, unsubscribes,
ends every session and closes the server and its connections.

Request handling, in order:

1. `Origin` present and not in `ALLOWED_ORIGINS`, or `Host` not `127.0.0.1:<boundPort>` / `localhost:<boundPort>` → 403
   (before anything else; `server/origins.ts`).
2. Unparsable URL → 400; a path other than `/mcp` → 404; a method other than GET, POST, DELETE → 405 with `Allow`.
3. A request that names an `Mcp-Session-Id`: unknown, expired or ended id → 404 `-32001` **before any body is read**;
   known id → `manager.touch(id)`, then (POST only) the body is read, then the session's
   `StreamableHTTPServerTransport` handles it (GET opens the SSE stream, POST carries requests, DELETE ends the session in
   memory; no file is deleted).
4. No session id: a non-POST → 400 `Mcp-Session-Id header is required`; a POST is read (bounded) and must be an
   `initialize`, else the same 400. The optional `?endpoint=human|agent` fixes the endpoint kind the session routes to
   (another value → 400, checked before the body is read; absent means the router's default order `agent`, `human`).
5. Session cap: when the held sessions plus the initializes still opening reach the cap, the initialize gets
   `503` with `Retry-After` (the sweep period in seconds, rounded up) and **no held session is ended**; the idle sweep
   frees slots. A refused initialize is logged. An initialize reserves a slot (`opening`) from the cap check until the
   manager holds its session (`release` in `openSession`), so a held session is never counted twice. A session is held
   by the manager only after its initialize succeeded; if holding it fails, or the tool sync right after holding it
   throws, the callback throws, the session is ended and the SDK answers the initialize with an error status and no
   session id (the client never keeps a 200 with a dead id).
6. An unexpected dispatch failure → 500 `-32603`.

Body and connection limits: a request body over `MCP_BODY_MAX_BYTES` (budget, 1,048,576) → 413. A declared `Content-Length`
over the limit is refused without reading; a chunked body is counted and reading stops at the first chunk past the limit
(`readJsonBody`). Every refusal (403, 400, 404, 405, 413, 503, 500) goes through `rejectRequest`: the status is sent at
once with `Connection: close`, the rest of the request body is read and discarded (`drainThen`, at most
`MCP_DRAIN_MAX_BYTES` = 8 MiB, then the request is destroyed), and only then the response ends, because closing a
connection with unread data resets it and the client would see ECONNRESET instead of the status (measured with Node's
http client and a 5 MB body). The HTTP server has `requestTimeout` 15 s, `headersTimeout` 10 s and a 1 s timeout check
(`connectionsCheckingInterval`; Node's default is 30 s), so a stalled body or header gets 408 and a closed socket; both
apply only until the request is received, so an open event stream or a slow tool call is not cut (tested with 200 ms
limits). `maxConnections` 128 closes a connection beyond it at once. A connection that sends no request within
`MCP_SOCKET_IDLE_MS` (30 s) is closed: Node's timeouts start with the first request byte, so the socket idle timeout
covers silent sockets; a server `timeout` listener decides (Node destroys a timed-out socket unless the server has such
a listener), and it ignores a socket with a request in flight (`inFlight` counts per socket until the response closes).
The constants are `MCP_REQUEST_TIMEOUT_MS`, `MCP_HEADERS_TIMEOUT_MS`, `MCP_TIMEOUT_CHECK_MS`, `MCP_SOCKET_IDLE_MS`,
`MCP_CONNECTIONS_MAX`, `MCP_DRAIN_MAX_BYTES` in `server/mcp.ts`.

## Per-session server

`buildServer(bridge, store, extraTools, instructions, ownerKey, ownerLive)` builds a `SessionMcpServer`: an `McpServer`
named `wiretap` whose own `sendToolListChanged` is a no-op (the sidecar debounces), with `notifyToolListChanged()` sending
one `tools/list_changed` when connected. It registers `create_actor`, `read_handle` and the extra tools, each behind the
result enforcer with the session id as owner and `ownerLive` = "the manager still holds the session". `fixedNames`
(names a registry tool may not reuse) come from `RESERVED_TOOL_NAMES` plus the extra tools. An over-limit result for an
ended session is answered `SESSION_ENDED: ...` and stores nothing.

`WIRETAP_INSTRUCTIONS` is the `instructions` every session receives: a short orientation naming
`mcp__wiretap__create_actor` and `mcp__wiretap__read_handle`, how handles are paged and that tools can appear or vanish
(`tools/list_changed`). It names no skill (none ships yet); `INSTRUCTIONS_MAX_CHARS` is 600. `tests/unit/contextBudget.test.js`
holds length, listed tool names and the absence of the word "skill".

## Session manager and debouncer (`server/mcpSessions.ts`)

`createSessionManager({ maxSessions, idleMs, sweepMs, now, timers, onEnd, log })` holds sessions in least-recently-active
order. `add` returns false, holding and closing nothing, when the cap (`MCP_SESSIONS_MAX` 32) is reached (a disposed
manager closes the session and returns false); `isFull(reserved?)` counts held plus pending sessions; `touch` restarts a
session's idle clock; `end(id)` removes it, runs `onEnd(id)` once synchronously (`startMcpServer` calls
`store.releaseOwner(id)` there) and closes it (a close failure is logged); `dispose` ends all. A repeat `end` is a no-op, so
the close that re-enters through the transport's `onclose` ends nothing twice.

Idle rule: only requests that carry the session id (POST, the GET that opens the stream, DELETE, so a client `ping`)
restart the idle clock; an open SSE stream and server writes do not. Defaults: idle 30 min (`MCP_SESSION_IDLE_MS`), sweep
every 60 s (`MCP_SESSION_SWEEP_MS`); one sweep interval runs only while a session exists; the clock is
`performance.now()`; expiry logs `MCP session <id> expired after <ms> ms idle`.

`createDebouncer({ quietMs, maxWaitMs, run, now, timers })`: trailing debounce with a maximum wait
(`LIST_CHANGED_QUIET_MS` 200, `LIST_CHANGED_MAX_WAIT_MS` 1000), at most one timer. `startMcpServer` triggers it on every
`bridge.subscribe` change while a session exists. Its `run` calls `syncOrEnd(session, true)` for each held session: it
recomputes the session's registry tools from `bridge.tools(...)` for its endpoint kind and sends `list_changed` only when
that session's own list changed (a changed signature, an added or a removed tool). An identify, an identical repeated
registry or a gate-state change alone sends nothing.

Guarded callbacks: `syncOrEnd`, the debouncer `run`, and the sync in `createSession` never let an exception escape. A
throw in a held session's sync is logged (`MCP session <id> tool sync failed, ending it: <text>`, control characters
replaced and cut to 200 bytes with `cleanForLog`) and ends only that session; a throw while building a new session fails
that initialize with 500 and holds nothing. After `manager.add` in `onsessioninitialized` the session's tools are synced
again (without a notification, since the client lists after initialize), so a registry change between creating and
holding the session is not lost.

## Tool registry (`server/toolRegistry.ts`)

`sanitizeRegistry(payload, log)` reduces an untrusted `bridge:registry` payload (an array) to `RegistryTool`s. Entries are
judged one by one: a refused entry is logged with its reason (`cleanForLog`, 200 bytes) and dropped. At most
`ALWAYS_LISTED_TOOLS_MAX` (30) less the 2 built-in names are accepted and at most twice that many examined (the rest refused
with one summary line); a non-array payload is refused as a whole. Per entry: `name` 1 to `CORE_TOOL_NAME_MAX_CHARS` (32) of
`[a-z][a-z0-9_-]*`, not in `RESERVED_TOOL_NAMES` (`create_actor`, `read_handle`), not an `Object.prototype` member, unique;
`description` 1 to `DESCRIPTION_MAX_CHARS` (240) characters on one line; `inputSchema` an object within
`DEFINITION_MAX_BYTES` both as received and as the SDK lists it; optional integer `budgetBytes` 1 to 16000; optional
`gate` (a name in `GATES`) with `moduleId` required exactly for `allowedPluginModules`.

`jsonSchemaToZodShape(schema)` converts a documented subset: a root object whose properties are string (`enum`,
`minLength`, `maxLength`), number, integer (`minimum`, `maximum`), boolean, array (`items`, `minItems`, `maxItems`) or
object, depth 4, 64 nodes, 32 properties, string enums of at most 32 values. `$ref`, combinators, `pattern`, `format`,
`default`, `const`, unknown keywords and `Object.prototype`-named properties refuse the schema. A `description` is validated
on every node but listed only on object properties. `RegistryTool.signature` identifies a definition for change detection.
Log text goes through `server/logText.ts`: `cleanForLog(text, maxBytes)` replaces control characters and cuts to a byte bound,
`describeCause(cause, maxBytes?)` does the same for a thrown value and never throws; `mcp.ts`, `mcpSessions.ts`, `foundryBridge.ts`,
`resultBudget.ts` and `toolRegistry.ts` all use them.

## Registry tool calls

A registry tool's handler (`makeRegistryToolHandler`) calls `bridge.invokeTool(name, args, { endpoint?, listed })`. The
router picks one endpoint, resolves the tool **by name on that endpoint** and uses that endpoint's own declaration: a
missing name, or a different argument schema (`schemaSignature`, the schema as listed), → `TOOL_GONE` without sending; a
declared gate that differs from the listed tool's → `GATE_DENIED` without sending; the gate is judged on the picked
endpoint's snapshot; the result budget is the picked endpoint's `budgetBytes` (a different description or budget does not
fail the call). The sidecar validates the arguments against the listed shape, which equals the picked endpoint's schema
once the signatures match. The client has no `callTool` handler yet, so it re-validates nothing (`docs/TODO.md`). The result is shown
as text (a string as is, anything else as JSON) behind the result enforcer. The production client sends no registry and
has no `callTool` handler (`docs/TODO.md`).

## Tests

- `tests/unit/mcpSessions.test.js`: manager (cap refusal, `isFull`, idle expiry on a fake clock, timers, repeat `end`) and
  debouncer.
- `tests/unit/toolRegistry.test.js`, `toolRegistry.logs.test.js`: sanitizer, schema subset, bounded safe log lines.
- `tests/unit/foundryBridge.registry.test.js`: the `bridge:registry` socket handler. `tests/unit/logText.test.js`: the log helpers.
- `tests/integration/mcpSessions.test.js`: real HTTP with the SDK client (lifecycle, methods, late tools and
  `list_changed`, endpoint choice, gates, expiry, cap, 503).
- `tests/integration/mcpHardening.test.js` (with `mcpHarness.js`): body, header, idle-socket and connection limits, no body
  read for an unknown session or a hostile Origin, refusals that reach a client still sending 3 MB, an open stream and a
  slow tool call surviving 200 ms timeouts, the session cap (503, Retry-After, exact slot count), guarded callbacks (a
  throwing `registerTool`), the initialize race and a failing post-add sync, exactly one `releaseOwner` per DELETE, no
  handle for an ended session, endpoint binding (rogue gate, other schema, picked budget, `TOOL_GONE`, pinned session
  whose endpoint dropped).
  A test that fakes timers must fake them after connecting the Socket.IO client.
- `tests/integration/mcpHttp.js`: `INITIALIZE`, `freePort`, `raw` and a one-session-per-port raw helper.
