---
name: wiretap-mcp-bridge
description: Wiretap MCP server and Foundry bridge — MCP tool registration (create_actor), sidecar-to-GM-client op dispatch, client-side op handlers, wire ops. Use when reading or editing the MCP endpoint, adding MCP tools or bridge ops, or touching the bridge handshake.
paths:
  - "server/mcp.ts"
  - "server/foundryBridge.ts"
  - "server/resultBudget.ts"
  - "server/handles.ts"
  - "server/utf8.ts"
  - "src/bridge/foundryBridge.js"
  - "src/bridge/gates.js"
  - "src/settings/gates.js"
  - "shared/gates.js"
  - "shared/protocol.js"
  - "tests/unit/mcp.test.js"
  - "tests/unit/handles.test.js"
  - "tests/unit/resultBudget.test.js"
  - "tests/integration/resultHandles.test.js"
  - "tests/unit/foundryBridge.*.test.js"
---

# Wiretap MCP + Foundry bridge

Current-state reference; verify against code before relying on a detail. Core context: `wiretap-codebase-core`;
sidecar composition: `wiretap-sidecar`.

## Request flow (`create_actor`)

MCP client → `POST http://127.0.0.1:<WIRETAP_MCP_PORT>/mcp` → `server/mcp.ts` tool handler →
`bridge.invoke(OP_CREATE_ACTOR, params)` (`server/foundryBridge.ts`, the router of `server/endpoints.ts`) → Socket.IO
`BRIDGE_INVOKE` `{ op, params, requestId }` to the chosen endpoint → `OP_HANDLERS` in `src/bridge/foundryBridge.js` → `createActor({ name, type })` → result returns the same
way as the tool result.

## Reaching the endpoint

- In-session: the terminal manager appends `--mcp-config "<module root>/.wiretap/mcp-<port>.json"` to a plain
  `claude <args>` launch whose arguments are allowlisted (`[A-Za-z0-9._:=/@+,-]` only: quoted arguments are not wired;
  no standalone `--`). The file is rewritten on every wired launch and never deleted (config:
  `{"mcpServers":{"wiretap":{"type":"http","url":"http://127.0.0.1:<port>/mcp"}}}`; see `wiretap-sidecar`).
- Standalone: `npm run server:mcp` (`mcp-only` mode: Socket.IO, bridge and MCP up, no terminal relay) plus
  `claude mcp add --transport http wiretap http://127.0.0.1:31417/mcp`.
- Only Streamable HTTP exists; stdio is not built (`TODO.md`).

## Pieces

- `server/mcp.ts`
  - `makeCreateActorHandler(bridge)`: pure handler; errors become `{ isError: true }` tool results whose text is
    `formatBridgeError` (`<code>: <message>` plus ` (+N more)` when failures were truncated) for a `BridgeError`, the
    message otherwise. The bridge interface it needs is `invoke(op, params, { endpoint? })`. The ack result is
    validated by `parseCreateActorResult`: an object with string `uuid`, `name`, `type` (each bounded to 256 bytes with
    `truncateUtf8` from `server/utf8.ts`); any other shape becomes `OP_FAILED: Foundry returned an invalid actor result.`
  - `buildServer(bridge, store, extraTools)`: a fresh `McpServer` (`name: 'wiretap'`) per request; registers
    `create_actor` (`name: string`, optional `type: string`; omitted `type` defaults to the world's first concrete
    actor subtype), `read_handle` and the extra tools, each behind the result enforcer (see below).
  - `startMcpServer(bridge, port, options?)`: Streamable HTTP, stateless (`sessionIdGenerator: undefined`), `POST /mcp` only
    (other methods → 405), a request whose `Origin` is present and not in `ALLOWED_ORIGINS`, or whose `Host` is not
    `127.0.0.1:<boundPort>` / `localhost:<boundPort>` (the port actually bound, so port 0 works), → 403 (checked before method and path; `server/origins.ts`), body-read failure → 400, dispatch failure → JSON-RPC `-32603`; listens on `127.0.0.1`. Returns `{ close, ready, port }` (`port()` is the bound port); `ready` resolves once bound and rejects on a bind failure
    (for example `EADDRINUSE`), so `createWiretapServer` folds it into its own `ready`.
- `server/endpoints.ts` — protocol v3 core, no sockets: `createEndpointRegistry(now?)` (`register` returns false when a
  new socket would exceed `MAX_ENDPOINTS` (64) / `remove` / `list` / `firstOfKind`; an endpoint is `{ socketId, userId, userName, kind, dom, gateState, registeredAt }` (`gateState` is the sanitized risk-gate snapshot, see `wiretap-sidecar`; `setGateState(socketId, state)` replaces it and ignores an unregistered socket; a repeated `register` replaces it with the new identify's), insertion order is
  the tiebreak, a repeated identify keeps position and `registeredAt`); every endpoint also has
  `health: 'healthy' | 'unresponsive'` (`register` starts a new socket healthy and keeps the health of an already-registered socket, so a re-identify never restores routing; only a ping ack does; `get(socketId)`,
  `setHealth(socketId, health)`; `firstOfKind` and so every route, `endpoint` override included, skips unresponsive
  endpoints while `list()` still returns them); `validateIdentify(payload)`
  (`PROTOCOL_MISMATCH` for a non-object, a `protocolVersion` other than `PROTOCOL_VERSION` (3), any malformed field, a
  `userId` over 64 bytes or a `userName` over 128 bytes; `NOT_GM` for `isGM:false`; the optional `gateState` is passed through `sanitizeGateState`, never refused, and an absent or invalid one gives the all-closed snapshot); `ROUTE_ORDER = ['agent', 'human']` (the one place the default order is defined);
  `createRouter(registry, { send, ping, timers?, log, logHealth?, newRequestId? })` whose `invoke(op, params, { endpoint?, requireGate?: { gate, moduleId? } })` is the gate enforcement point: it picks ONE endpoint (single `pick()`, no await before the check), judges `gateDenial(endpoint.gateState, gate, moduleId)` on that endpoint's own snapshot, throws `BridgeError` `GATE_DENIED` (message from `gateDenial`, at most 256 bytes) before sending when denied, and otherwise sends to that same endpoint (no endpoint = `NO_ENDPOINT` / `ENDPOINT_UNAVAILABLE`, never `GATE_DENIED`); its `gateState({ endpoint? })` is a display and diagnostic accessor only (fresh copy of the snapshot of the endpoint a call would reach now, all-closed when none is eligible; not a gate check), and `invoke` picks
  the first healthy endpoint of the first kind in `ROUTE_ORDER` (an `endpoint` option restricts to that kind, no
  fallback; when no healthy endpoint is eligible but a connected one of an eligible kind is unresponsive the call fails
  at once with `ENDPOINT_UNAVAILABLE`, at most 256 bytes, and `NO_ENDPOINT` stays for no connected endpoint of the kind), generates a
  UUID `requestId`, logs it, and resolves the ack `result` or throws a `BridgeError`;
  `BridgeError { code, message, failures?, failureCount? }`; `EndpointGoneError` (thrown by a transport); `normalizeAckError`
  (code kept only if `/^[A-Z][A-Z0-9_]{0,63}$/` and not reserved (`NO_ENDPOINT`, `ENDPOINT_TIMEOUT`, `ENDPOINT_GONE`,
  `ENDPOINT_UNAVAILABLE`, `ENDPOINT_LIMIT`, `PROTOCOL_MISMATCH`, `NOT_GM`; `GATE_DENIED` is not reserved, so a client may send it), else `OP_FAILED`; message and each failure path/message bounded to 512 bytes by
  `truncateUtf8`; 10 failures max; `failureCount` is the larger of the sent count and the client's reported count);
  `formatBridgeError` (whole text at most 512 bytes: `<code>: <message>`, then `path: message` failure lines, one per line,
  as many as fit, then ` (+N more)` for the failures not shown). `truncateUtf8` returns `''` when the limit is below the
  3-byte ellipsis. `NO_ENDPOINT` is at most 256 bytes and names the fix. A transport rejection with an
  `EndpointTimeoutError` (no ack within 10 s) first runs the endpoint health check, then becomes `ENDPOINT_TIMEOUT` with
  the message `Foundry did not respond in 10 s; the operation may still have applied. Check before retrying.`. The
  check pings the endpoint (`ping`, 1 s window in `foundryBridge.ts`; the router awaits it before throwing, so a timed-out call reports after up to 11 s: the 10 s ack window plus at most 1 s): an acked ping leaves it healthy; a failed ping
  marks it unresponsive and starts one `timers.setInterval` probe (every `PROBE_INTERVAL_MS` = 5 s; defaults to the
  global interval timers, looked up at call time) that pings it with at most one ping in flight and, on an ack,
  restores it and clears the interval. Health log lines (failed ping, unresponsive, recovery) go to `logHealth` (default `log`); the bridge passes a `createLogThrottle` of 10 per minute (noun `endpoint health lines`), so a never-acking endpoint cannot flood the log. Concurrent timeouts on one endpoint share one check; a tick for a removed or
  healthy endpoint clears the probe. `router.forget(socketId)` and `router.dispose()` clear probes, and nothing starts
  after dispose. A call is sent exactly once; nothing retries it. The router has no clock (the registry takes `now`).
  Other transport rejections never ping; every other transport rejection (an
  `EndpointGoneError` or any error from the send) becomes `ENDPOINT_GONE` (the cause is logged, not returned). `requestId` is in the payload and sidecar log lines, not in error text or tool results.
- `server/foundryBridge.ts` — `createFoundryBridge({ log? })` returns `{ handleConnection(socket), invoke, gateState, dispose }` (`invoke` and `gateState` are the router's). It keeps
  a socket map, the registry and the router (the invoke and ping transports share one `emitWithAck` helper (`socket.timeout(ms).emit(event, [payload,] ack)`; the ack-callback error becomes an `EndpointTimeoutError`; invoke uses a 10 s window and tracks the call so a disconnect rejects it); a missing socket, a synchronous emit failure or a
  disconnect while an invocation awaits its ack rejects with `EndpointGoneError`, the disconnect immediately; the
  router's `ping` is the same helper with a 1 s window and no payload, untracked). The returned bridge also has `dispose()` (stops every
  health probe; `createWiretapServer.dispose()` calls it).
  `handleConnection` handles `BRIDGE_IDENTIFY` `(payload, ack?)`: validate, register (a new socket beyond 64 endpoints is
  refused with `ENDPOINT_LIMIT`) or, when refused, drop any earlier entry of the socket (`dropEndpoint`: registry remove plus `router.forget`, so no probe survives) and log
  `Wiretap sidecar | refused identify from <id>: <code>` (at most 10 such lines per minute in total via `createLogThrottle`, followed by one
  `N further identify refusals suppressed` line after the window; clock injectable as `options.now`; the ack is never
  throttled), then call `ack` with
  `{ ok: true }` or `{ ok: false, error: { code, message } }` (an absent ack callback is tolerated); `disconnect`
  calls `dropEndpoint(socket.id)` (removes the endpoint and stops its probe).
  `handleConnection` also handles `BRIDGE_GATE_STATE` `(payload, ack?)`: only a socket with a live registry entry may set a snapshot (`registry.setGateState(socket.id, sanitizeGateState(payload))`, ack `{ ok: true }`; a non-object payload therefore closes every gate); any other socket (never identified, refused, disconnected) changes nothing, is logged as `Wiretap sidecar | refused gate state from <id>: NOT_GM` through its own `createLogThrottle` (10 per minute, noun `gate state refusals`, separate from the identify throttle) and acked `{ ok: false, error: { code: NOT_GM, message } }`. A gated tool calls `bridge.invoke(op, params, { requireGate })` (the router's `invoke`, see above); `bridge.gateState({ endpoint? })` is for display and diagnostics only (a later `invoke` may pick another endpoint). The whole `BRIDGE_GATE_STATE` handler runs in try/catch: on any throw the endpoint's snapshot becomes all-closed, the failure is logged without the snapshot and the sender is acked `{ ok: false, error: { code: OP_FAILED, message } }`. The sidecar snapshot is a pre-check only: the identify is self-declared (same-machine processes are trusted), so the executing browser re-enforces every gate from its own world settings. Snapshots are never in a tool result, error text or log line. `createWiretapServer` returns the bridge as `bridge` so tests can pass the `endpoint` option
  (no MCP tool takes it yet).
- `src/bridge/foundryBridge.js` — `initFoundryBridge(connection)` (called from `OnceReady`) attaches to the shared
  socket via `TerminalConnection.onSocket`; `createActor` executes the world mutation on a GM client.
  On each (re)connect it emits the identify (protocol v3; `gateState: readGateState()` read at emit time from `src/bridge/gates.js`; `kind` from the `wiretap.endpointKind` client setting, `dom: true`)
  with an ack callback and sets `bridgeState.identified` (exposed as `api.bridge.identified`) true only on an ok ack
  while the socket is connected; a disconnect or refused ack sets it false and a refusal is logged with the sidecar's
  message. Op failures ack `{ ok: false, error: { code: OP_FAILED, message } }`. It also listens for `BRIDGE_PING` and
  acks `{ ok: true }` regardless of identify state (no ack, or a non-function ack, is ignored); the sidecar's health
  check relies on this.

## Client gate enforcement (`src/bridge/gates.js`, `src/settings/gates.js`)

- The gates are world-scope `restricted` settings registered from `GATES` (see `wiretap-client`). `readGateState()`
  builds the sanitized snapshot from `game.settings`; `requireGate(name, moduleId?)` is the executing client's own check
  (`gateDenial` over a snapshot read at call time). A gated op handler calls `requireGate` first and acks the denial as
  `GATE_DENIED`; no gated op exists yet.
- Push: `initFoundryBridge` registers one listener on `createSetting`, `updateSetting` and `deleteSetting` (a first
  change creates the Setting document, a later one updates it, a reset to default deletes it; each document hook
  runs on every client; the world collection is updated before the hook, so `game.settings.get` already returns the new value, or the default after a delete; the author is the last hook argument). For a `wiretap.<gate>` key written by a GM user (`game.users.get(userId)?.isGM`), and only on a connected GM client, it emits `BRIDGE_GATE_STATE` with a fresh
  `readGateState()` and an ack callback; a non-ok ack is logged with `console.error`
  (`Wiretap | bridge gate state refused (<code>): <message>`). A second `initFoundryBridge` call replaces the listener
  (`Hooks.off` first), so a change is never pushed twice. A non-GM author is ignored; a user holding `SETTINGS_MODIFY` can still write a gate and is trusted at GM level (README). A change while disconnected needs no push: the next identify
  carries the snapshot.
- No op can set a setting: `OP_HANDLERS` holds only `createActor`, which passes `name` and `type` to `Actor.create`.
  `foundryBridge.noSettingWrites.test.js` documents it. Each future write path wires `denyWiretapSettingWrite` (`TODO.md`).

## Adding a tool or op

1. Add the `OP_*` constant in `shared/protocol.js` (the wire contract — `PROTOCOL_VERSION`, error codes, identify /
   invoke / ack typedefs — lives there too).
2. Add the handler to `OP_HANDLERS` in `src/bridge/foundryBridge.js`.
3. Add a pure `make<Tool>Handler(bridge)` (calling `bridge.invoke`) and add it to the tool list in `buildServer` in
   `server/mcp.ts`; registration wraps it in the result enforcer, so a result over 8,000 bytes becomes a handle; a tool that wants the per-call
   `maxBytes` limit declares an optional integer `maxBytes` in its `inputSchema`.
4. Add a representative-result fixture for the tool to `FIXTURES` in `tests/unit/contextBudgetHarness.js`; `tests/unit/contextBudget.test.js` fails for a listed tool without one and for a definition or fixture result over its budget.
5. Unit-test both sides (`tests/unit/mcp.test.js`, `foundryBridge.client.test.js`, `foundryBridge.server.test.js`,
   `endpoints.test.js`); routing over real sockets is in `tests/integration/endpointRouting.test.js` (fake v3 clients); gate snapshots: `tests/unit/gates.test.js`, `foundryBridge.gateState.test.js` (fake sockets: registered-only rule, throttle, per-endpoint) and `tests/integration/gateState.test.js` (real sockets: identify and event paths, hostile snapshots, two endpoints, no gate state in tool results).
6. Update this skill and the deferred-work file (`TODO.md` at the repo root).

## Result enforcer, handles and `read_handle`

Every registered tool runs through `withResultBudget(handler, { store, ownerKey, budgetBytes? })`
(`server/resultBudget.ts`); `buildServer` applies it to `create_actor`, `read_handle` and any `tools` entry. Budgets
count raw UTF-8 text bytes, not JSON-escaped wire bytes.

- **Limit.** The hard cap is 8,000 bytes; a valid integer `maxBytes` in the call arguments (>= 1) replaces it, clamped to
  16,000 (an invalid `maxBytes` is ignored); the tool's own `budgetBytes` lowers it further (the smaller of the two).
  The SDK strips arguments a tool's `inputSchema` does not declare (measured), so `maxBytes` reaches the enforcer and
  handler only for a tool that declares an optional integer `maxBytes` (that adds to its definition size); `read_handle`
  declares it (128..16000). The measured size is the UTF-8 bytes of the text content items (other non-image items as their
  JSON, then `structuredContent` as JSON); at or below the limit the result is returned unchanged, one byte over becomes
  a handle. `create_actor` registers `budgetBytes` = `ACK_MAX_BYTES` (256), so a worst-case ack (every field at its 256-byte bound, about 790 bytes) becomes a handle.
- **Over the limit.** The parts are joined with `\n` and stored (`HandleStore.put`); the result is a single text item
  `{"handle","bytes","summary"}` (any image items are kept; `structuredContent` is dropped), at most 256 bytes
  (`ACK_MAX_BYTES`). `bytes` is the stored size (`put().bytes`, parts plus the joining newlines). `summarizeResult(text)`
  is deterministic: a JSON object gives `{kind:'object', n, keys (first 8 in JS property order, integer-like keys first,
  each <= 32 B), counts (array length or key count of those keys), omitted?, name?, type?}` (strings <= 32 B; a key
  that equals an earlier listed key once shortened is skipped and counted in `omitted`), a JSON array
  `{kind:'array', n}`, anything else `{kind:'text', n}` (characters). Only a single-part result without
  `structuredContent` is summarized from its JSON; multi-part or structured results are described as `{kind:'text', n}`.
  `formatHandleResponse` drops count entries, then keys, then `name`, then `type` until the text fits. A result over the
  entry cap or the whole store becomes an error (`HANDLE_TOO_LARGE: ...`); `summarizeResult` runs only after a
  successful `put`.
- **Never fails open.** A handler throw is caught: a `BridgeError` passes as `formatBridgeError` (`<code>: <message>`, capped to
  512 bytes), anything else becomes `Tool failed.` and the real message goes to `console.warn`
  (`Wiretap sidecar | tool failed: ...`; control characters, line breaks and U+2028/2029 replaced by spaces, cause cut to
  512 bytes). `makeCreateActorHandler` returns only `BridgeError`s as results and rethrows anything else. Everything after the handler (shape check, image checks, serialization, `byteLength`, `put`) runs in
  one `try`; a result that is null, has no `content` array, has a content item without a string `type`, a text item
  without string text, or cannot be serialized becomes `Tool returned an invalid result.` (logged the same way).
- **Errors and images.** An `isError` result is rewritten as one text item capped to 512 bytes (`ERROR_MAX_BYTES`) and is
  never a handle. `IMAGE_LIMIT: ...` (an error result) is returned for: more than one image; a `mimeType` other than
  exactly `image/png`; `data` that is not a string, is longer than 1,000,000 characters (`IMAGE_DATA_MAX_BYTES`) or
  does not match `^[A-Za-z0-9+/]*={0,2}$` (whitespace is refused); a PNG header (IHDR, first 32 base64 characters) that
  cannot be read; a longest side over 1280 px. The result leaves the enforcer rebuilt (`rebuildItem`): image items as exactly
  `{type, data, mimeType}`, text items as exactly `{type, text}`, other item types whole (they are measured as their
  JSON), and the result as `{content, structuredContent?}` only (inline path) or the handle text plus rebuilt images
  (handle-ack path); `_meta`, `annotations` and unknown fields are dropped. `IMAGE_DEFAULT_MAX_PIXELS` (480,000 px) is a capture-time default and is
  not enforced here.
- **Store** (`server/handles.ts`, `createHandleStore({ now?, maxTotalBytes?, idleMs?, maxEntryBytes?, maxCount? })`).
  Memory only: no file-system import, no timers, no deletion API. Ids are 16 random bytes in base64url (22 characters).
  The default clock is `performance.now()`. Each entry is accounted as `max(UTF-8 bytes, 2 * length) + 256`
  (`HANDLE_ENTRY_OVERHEAD_BYTES`) inside the 64,000,000-byte total across all owners; a value over 8,000,000 UTF-8 bytes
  (`HANDLE_ENTRY_MAX_BYTES`) or over the total gets `HANDLE_TOO_LARGE`; at most 1,024 entries (`HANDLE_MAX_COUNT`). LRU
  eviction (global across owners, so one owner's puts can evict another's until per-session ownership exists) frees
  count and bytes; a use (successful `slice`) re-inserts the entry last, so map order is `lastAccess`
  order and `purgeExpired` walks from the front and stops at the first live entry (`idle >= idleMs` expires; 30 minutes
  default; run on every `put` and `slice`). `slice(ownerKey, handle, { paths?, offset?, length?, maxBytes? })` checks
  ownership, then validates `offset`/`length`, and only a fully successful read touches the entry. It returns
  `{ok, text, offset, length, total, truncated?}` counted in UTF-16 code units; `maxBytes` (default 8,000, at most
  16,000) bounds the UTF-8 size of `text`. The window scan is O(maxBytes): it walks code points, never ends inside a
  surrogate pair, moves an `offset` on a low surrogate back one unit (the returned `offset` is the real start), and
  takes the whole pair for `length: 1` at a high surrogate; if not even the next character fits `maxBytes` it returns
  `HANDLE_WINDOW_TOO_SMALL`. With `paths` the entry is parsed again (nothing cached), `resolvePaths` runs, and
  `boundedStringify({values, missing}, maxBytes)` (iterative, stops once the output exceeds the limit) builds the view;
  a longer result is cut to the limit and `truncated: true` is returned, so a `paths` result is one window whose cut
  depends on the call's `maxBytes`; its tail is reachable only by narrowing `paths`. Measured cost of one `paths` read
  (parse plus 20 wildcard paths): ~17 ms for an 8 MB long-string document, ~185 ms for 7.7 MB of 106,000 small objects. Grammar
  errors keep their `PATH_*` codes, non-JSON text gives `HANDLE_NOT_JSON`. Unknown, expired, evicted and other-owner
  handles all give `HANDLE_NOT_FOUND: Handle not found or expired.` A bad `offset`/`length` gives `HANDLE_BAD_RANGE`.
- **Owner key.** `mcp.ts` uses one process-wide `PROCESS_OWNER_KEY` (bound once in `buildServer` as `ownerKey` and passed
  to both `makeReadHandleHandler` and `withResultBudget`) because sessions are stateless, so any MCP caller reads any
  handle (`TODO.md`). `startMcpServer(bridge, port, { tools?, instructions? })` creates the store once per server; the
  per-request `McpServer` shares it. `instructions` goes to the `McpServer` constructor (none in production yet; the
  context-budget test holds it to `INSTRUCTIONS_MAX_CHARS`). `tools` are `ToolRegistration` entries (`name`, `description`, `inputSchema` zod shape,
  `handler`, `budgetBytes?`); tests use it for test-local tools (no production test tool exists).
- **`read_handle`** (`makeReadHandleHandler(store, ownerKey)`): args `handle` (string <= 64), `paths` (<= 20 strings),
  `offset`, `length`, `maxBytes` (128..16000, the whole result's limit, default 8,000; the handler also answers a smaller value with
  `HANDLE_WINDOW_TOO_SMALL`, so the result is always a window plus a footer within the limit). Result content: the window text,
  then a footer item `{"offset","length","total"}` (plus `"truncated":true` for a cut `paths` result); the window is
  limited to `maxBytes - 64` bytes so both items stay within the limit. A store failure is an `isError` result
  `<code>: <message>`. Its definition is inside the budgets (name 11 chars, description <= 160, definition <= 800 B;
  asserted in `tests/integration/resultHandles.test.js` and, with the other budgets, in `tests/unit/contextBudget.test.js`).
- **`server/utf8.ts`** holds `truncateUtf8`, shared by `endpoints.ts`, `resultBudget.ts`, `mcp.ts` and `server.ts`.

## Security boundary

Loopback-only HTTP; browser requests with a foreign `Origin` are refused on both the socket handshake and `/mcp` (and a
foreign `Host` on `/mcp`), while requests without `Origin` are trusted as same-machine processes; GM-only execution (a v3 identify with `isGM: true` is the only way to register an endpoint). A shared-secret handshake on the sidecar socket is a
tracked, unimplemented follow-up.
