---
name: wiretap-mcp-bridge
description: Wiretap MCP server and Foundry bridge — MCP tool registration (create_actor), sidecar-to-GM-client op dispatch, client-side op handlers, wire ops. Use when reading or editing the MCP endpoint, adding MCP tools or bridge ops, or touching the bridge handshake.
paths:
  - "server/mcp.ts"
  - "server/foundryBridge.ts"
  - "src/bridge/foundryBridge.js"
  - "shared/protocol.js"
  - "tests/unit/mcp.test.js"
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
    `truncateUtf8`); any other shape becomes `OP_FAILED: Foundry returned an invalid actor result.`
  - `buildServer(bridge)`: a fresh `McpServer` (`name: 'wiretap'`) per request; registers `create_actor`
    (`name: string`, optional `type: string`; omitted `type` defaults to the world's first concrete actor subtype).
  - `startMcpServer(bridge, port)`: Streamable HTTP, stateless (`sessionIdGenerator: undefined`), `POST /mcp` only
    (other methods → 405), a request whose `Origin` is present and not in `ALLOWED_ORIGINS`, or whose `Host` is not
    `127.0.0.1:<boundPort>` / `localhost:<boundPort>` (the port actually bound, so port 0 works), → 403 (checked before method and path; `server/origins.ts`), body-read failure → 400, dispatch failure → JSON-RPC `-32603`; listens on `127.0.0.1`. Returns `{ close, ready, port }` (`port()` is the bound port); `ready` resolves once bound and rejects on a bind failure
    (for example `EADDRINUSE`), so `createWiretapServer` folds it into its own `ready`.
- `server/endpoints.ts` — protocol v2 core, no sockets: `createEndpointRegistry(now?)` (`register` returns false when a
  new socket would exceed `MAX_ENDPOINTS` (64) / `remove` / `list` / `firstOfKind`; an endpoint is `{ socketId, userId, userName, kind, dom, registeredAt }`, insertion order is
  the tiebreak, a repeated identify keeps position and `registeredAt`); every endpoint also has
  `health: 'healthy' | 'unresponsive'` (`register` starts a new socket healthy and keeps the health of an already-registered socket, so a re-identify never restores routing; only a ping ack does; `get(socketId)`,
  `setHealth(socketId, health)`; `firstOfKind` and so every route, `endpoint` override included, skips unresponsive
  endpoints while `list()` still returns them); `validateIdentify(payload)`
  (`PROTOCOL_MISMATCH` for a non-object, a `protocolVersion` other than `PROTOCOL_VERSION` (2), any malformed field, a
  `userId` over 64 bytes or a `userName` over 128 bytes; `NOT_GM` for `isGM:false`); `ROUTE_ORDER = ['agent', 'human']` (the one place the default order is defined);
  `createRouter(registry, { send, ping, timers?, log, logHealth?, newRequestId? })` whose `invoke(op, params, { endpoint? })` picks
  the first healthy endpoint of the first kind in `ROUTE_ORDER` (an `endpoint` option restricts to that kind, no
  fallback; when no healthy endpoint is eligible but a connected one of an eligible kind is unresponsive the call fails
  at once with `ENDPOINT_UNAVAILABLE`, at most 256 bytes, and `NO_ENDPOINT` stays for no connected endpoint of the kind), generates a
  UUID `requestId`, logs it, and resolves the ack `result` or throws a `BridgeError`;
  `BridgeError { code, message, failures?, failureCount? }`; `EndpointGoneError` (thrown by a transport); `normalizeAckError`
  (code kept only if `/^[A-Z][A-Z0-9_]{0,63}$/` and not reserved (`NO_ENDPOINT`, `ENDPOINT_TIMEOUT`, `ENDPOINT_GONE`,
  `ENDPOINT_UNAVAILABLE`, `ENDPOINT_LIMIT`, `PROTOCOL_MISMATCH`, `NOT_GM`), else `OP_FAILED`; message and each failure path/message bounded to 512 bytes by
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
- `server/foundryBridge.ts` — `createFoundryBridge({ log? })` returns `{ handleConnection(socket), invoke }`. It keeps
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
  calls `dropEndpoint(socket.id)` (removes the endpoint and stops its probe). `createWiretapServer` returns the bridge as `bridge` so tests can pass the `endpoint` option
  (no MCP tool takes it yet).
- `src/bridge/foundryBridge.js` — `initFoundryBridge(connection)` (called from `OnceReady`) attaches to the shared
  socket via `TerminalConnection.onSocket`; `createActor` executes the world mutation on a GM client.
  On each (re)connect it emits the v2 identify (`kind` from the `wiretap.endpointKind` client setting, `dom: true`)
  with an ack callback and sets `bridgeState.identified` (exposed as `api.bridge.identified`) true only on an ok ack
  while the socket is connected; a disconnect or refused ack sets it false and a refusal is logged with the sidecar's
  message. Op failures ack `{ ok: false, error: { code: OP_FAILED, message } }`. It also listens for `BRIDGE_PING` and
  acks `{ ok: true }` regardless of identify state (no ack, or a non-function ack, is ignored); the sidecar's health
  check relies on this.

## Adding a tool or op

1. Add the `OP_*` constant in `shared/protocol.js` (the wire contract — `PROTOCOL_VERSION`, error codes, identify /
   invoke / ack typedefs — lives there too).
2. Add the handler to `OP_HANDLERS` in `src/bridge/foundryBridge.js`.
3. Add a pure `make<Tool>Handler(bridge)` (calling `bridge.invoke`) and register it in `buildServer` in `server/mcp.ts`.
4. Unit-test both sides (`tests/unit/mcp.test.js`, `foundryBridge.client.test.js`, `foundryBridge.server.test.js`,
   `endpoints.test.js`); routing over real sockets is in `tests/integration/endpointRouting.test.js` (fake v2 clients).
5. Update this skill and the deferred-work file (`TODO.md` at the repo root).

## Budgets and path grammar (shared, not yet wired)

`shared/budgets.js` (context budgets with `hard`/`warn` severity) and `shared/docPath.js` (document path grammar:
parse, resolve by `_id`/index/wildcard, missing list, embedded write grouping) are pure modules for the MCP tool
layer; no MCP tool or bridge op calls them yet. Their current behaviour is described in `wiretap-sidecar`.

## Security boundary

Loopback-only HTTP; browser requests with a foreign `Origin` are refused on both the socket handshake and `/mcp` (and a
foreign `Host` on `/mcp`), while requests without `Origin` are trusted as same-machine processes; GM-only execution (a v2 identify with `isGM: true` is the only way to register an endpoint). A shared-secret handshake on the sidecar socket is a
tracked, unimplemented follow-up.
