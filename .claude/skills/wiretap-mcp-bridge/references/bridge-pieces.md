# Bridge pieces

Part of the wiretap-mcp-bridge skill; read it before changing server/mcp.ts, server/endpoints.ts, server/foundryBridge.ts or src/bridge/foundryBridge.js.

## Pieces

- `server/mcp.ts`
  - The sidecar has no handler for a script tool such as `create_documents`: the endpoint registers it like any script (`requires: 'api'`,
    `mutates: true`, `result.budgetBytes` 256). A registered script's ack result is shown as text (a string as is,
    anything else as JSON, an ack with no result as `null`); the enforcer bounds it with the picked endpoint's budget.
    The bridge interface `mcp.ts` needs is `invokeTool`, `tools` and `subscribe`.
  - Sessions, `startMcpServer` (HTTP routing, body and connection limits, cap, `?endpoint=`), `buildServer`, `WIRETAP_INSTRUCTIONS`, the session manager, the `list_changed` debouncer, the registry sanitizer and registry tool calls are in `wiretap-mcp-sessions`. The only built-in tool registered per session is `read_handle`; the scripts of the routed endpoint are listed beside it with `annotations.readOnlyHint = !mutates` (`destructiveHint` is not set).
- `server/endpoints.ts` — protocol v5 core, no sockets: `createEndpointRegistry(now?)` (`register` returns false when a
  new socket would exceed `MAX_ENDPOINTS` (64) / `remove` / `list` / `firstOfKind(kind, { dom? })` (`dom: true` skips endpoints that did not identify with `dom: true`); an endpoint is `{ socketId, userId, userName, kind, dom, gateState, tools, registeredAt }` (`tools` is the sanitized `RegistryTool[]` the endpoint registered, empty until it registers; `setTools(socketId, tools)` replaces it and ignores an unregistered socket; `subscribe(listener)` is called synchronously after every endpoint-set, health or tools change and returns its unsubscribe; `gateState` is the sanitized risk-gate snapshot, see `wiretap-sidecar`; `setGateState(socketId, state)` replaces it and ignores an unregistered socket; a repeated `register` replaces it with the new identify's), insertion order is
  the tiebreak, a repeated identify keeps position and `registeredAt`); every endpoint also has
  `health: 'healthy' | 'unresponsive'` (`register` starts a new socket healthy and keeps the health of an already-registered socket, so a re-identify never restores routing; only a ping ack does; `get(socketId)`,
  `setHealth(socketId, health)`; `firstOfKind` and so every route, `endpoint` override included, skips unresponsive
  endpoints while `list()` still returns them); `validateIdentify(payload)`
  (`PROTOCOL_MISMATCH` for a non-object, a `protocolVersion` other than `PROTOCOL_VERSION` (5), any malformed field, a
  `userId` over 64 bytes or a `userName` over 128 bytes; `NOT_GM` for `isGM:false`; the optional `gateState` is passed through `sanitizeGateState`, never refused, and an absent or invalid one gives the all-closed snapshot); `ROUTE_ORDER = ['agent', 'human']` (the one place the default order is defined);
  `createRouter(registry, { send, ping, timers?, log, logHealth?, newRequestId? })` whose `invoke(op, params, { endpoint?, requireGate?: { gate, moduleId? } })` is the gate enforcement point: it picks ONE endpoint (single `pick()`, no await before the check), judges `gateDenial(endpoint.gateState, gate, moduleId)` on that endpoint's own snapshot, throws `BridgeError` `GATE_DENIED` (message from `gateDenial`, at most 256 bytes) before sending when denied, and otherwise sends to that same endpoint (no endpoint = `NO_ENDPOINT` / `ENDPOINT_UNAVAILABLE`, never `GATE_DENIED`); its `invokeTool(name, args, { endpoint?, listed })` runs the `callTool` op for a registry tool: one `pick()`, the tool resolved by name on that endpoint (`TOOL_GONE` when absent or when it declares another argument schema, `GATE_DENIED` when its declared gate differs from `listed.gate`, otherwise its own gate judged on its snapshot) and returns `{ result, tool }` with the picked endpoint's declaration; its `tools({ endpoint? })` returns a copy of the tools of the endpoint a call would reach now (empty when none is eligible); its `gateState({ endpoint? })` is a display and diagnostic accessor only (fresh copy of the snapshot of the endpoint a call would reach now, all-closed when none is eligible; not a gate check), and `invoke` picks
  the first healthy endpoint of the first kind in `ROUTE_ORDER` (an `endpoint` option restricts to that kind, no
  fallback; when no healthy endpoint is eligible but a connected one of an eligible kind is unresponsive the call fails
  at once with `ENDPOINT_UNAVAILABLE`, at most 256 bytes, and `NO_ENDPOINT` stays for no connected endpoint of the kind), generates a
  UUID `requestId`, logs it, and resolves the ack `result` or throws a `BridgeError`;
  `BridgeError { code, message, failures?, failureCount? }`; `EndpointGoneError` (thrown by a transport); `normalizeAckError`
  (code kept only if `/^[A-Z][A-Z0-9_]{0,63}$/` and not reserved (`NO_ENDPOINT`, `ENDPOINT_TIMEOUT`, `ENDPOINT_GONE`,
  `ENDPOINT_UNAVAILABLE`, `ENDPOINT_LIMIT`, `PROTOCOL_MISMATCH`, `NOT_GM`, `TOOL_GONE`; `GATE_DENIED` is not reserved, so a client may send it), else `OP_FAILED`; message and each failure path/message bounded to 512 bytes by
  `truncateUtf8`; 10 failures max; `failureCount` is the larger of the sent count and the client's reported count);
  `formatBridgeError` (whole text at most 512 bytes: `<code>: <message>`, then `path: message` failure lines, one per line,
  as many as fit, then ` (+N more)` for the failures not shown). `truncateUtf8` returns `''` when the limit is below the
  3-byte ellipsis. `NO_ENDPOINT` is at most 256 bytes and names the fix. A transport rejection with an
  `EndpointTimeoutError` (no ack within the call's reply wait) first runs the endpoint health check, then becomes
  `ENDPOINT_TIMEOUT` with the message `Foundry did not respond in <wait / 1000> s; the operation may still have applied.
  Check before retrying.` (`timeoutMessage(waitMs)`). The reply wait is passed to `send` per call: `invoke` (a plain op)
  uses `DEFAULT_REPLY_WAIT_MS` (10 s, exported); `invokeTool` uses `toolReplyWaitMs(listed, args)`, which is
  `args.timeoutMs` + `REPLY_WAIT_MARGIN_MS` (2 s) when the listed tool's `shape` declares `timeoutMs` (`TIMEOUT_ARG`)
  and the call's value is a number (its bounds are the listed schema's, validated by the SDK before the call), else
  the default. The check pings the endpoint (`ping`, 1 s window in `foundryBridge.ts`; the router awaits it before
  throwing, so a timed-out call reports after up to its reply wait plus at most 1 s): an acked ping leaves it healthy;
  a failed ping
  marks it unresponsive and starts one `timers.setInterval` probe (every `PROBE_INTERVAL_MS` = 5 s; defaults to the
  global interval timers, looked up at call time) that pings it with at most one ping in flight and, on an ack,
  restores it and clears the interval. Health log lines (failed ping, unresponsive, recovery) go to `logHealth` (default `log`); the bridge passes a `createLogThrottle` of 10 per minute (noun `endpoint health lines`), so a never-acking endpoint cannot flood the log. Concurrent timeouts on one endpoint share one check; a tick for a removed or
  healthy endpoint clears the probe. `router.forget(socketId)` and `router.dispose()` clear probes, and nothing starts
  after dispose. A call is sent exactly once; nothing retries it. The router has no clock (the registry takes `now`).
  Other transport rejections never ping; every other transport rejection (an
  `EndpointGoneError` or any error from the send) becomes `ENDPOINT_GONE` (the cause is logged, not returned). `requestId` is in the payload and sidecar log lines, not in error text or tool results.
- `server/foundryBridge.ts` — `createFoundryBridge({ log? })` returns `{ handleConnection(socket), invoke, invokeTool, gateState, tools, subscribe, dispose }` (`invoke`, `invokeTool`, `gateState` and `tools` are the router's, `subscribe` the registry's). It keeps
  a socket map, the registry and the router (the invoke and ping transports share one `emitWithAck` helper (`socket.timeout(ms).emit(event, [payload,] ack)`; the ack-callback error becomes an `EndpointTimeoutError`; invoke uses the window the router passes to `send(socketId, payload, timeoutMs)` and tracks the call so a disconnect rejects it); a missing socket, a synchronous emit failure or a
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
  `handleConnection` also handles `BRIDGE_REGISTRY` through `pushRegistry`: a registered endpoint may push at most `REGISTRY_PUSHES_PER_SECOND_MAX` (2) registries per one-second window; later pushes are coalesced (the replaced push is acked `{ ok: true, coalesced: true }`) and the latest is applied when the window ends by a per-socket timer, cleared on disconnect, a dropped endpoint and `dispose`.
  `handleConnection` also handles `BRIDGE_GATE_STATE` `(payload, ack?)`: only a socket with a live registry entry may set a snapshot (`registry.setGateState(socket.id, sanitizeGateState(payload))`, ack `{ ok: true }`; a non-object payload therefore closes every gate); any other socket (never identified, refused, disconnected) changes nothing, is logged as `Wiretap sidecar | refused gate state from <id>: NOT_GM` through its own `createLogThrottle` (10 per minute, noun `gate state refusals`, separate from the identify throttle) and acked `{ ok: false, error: { code: NOT_GM, message } }`. `handleConnection` also handles `BRIDGE_REGISTRY` `(payload, ack?)`: only a socket with a live registry entry may push a tool list (any other socket is logged as `refused registry from <id>: NOT_GM` through a throttle and acked `{ ok: false, error: { code: NOT_GM, message } }`); the payload goes through `sanitizeRegistry`, replaces the endpoint's whole list (an empty array clears it) and is acked `{ ok: true, accepted, refused }`; a non-array payload or a throw clears the endpoint's tools and acks `{ ok: false, error: { code: OP_FAILED, message } }`. A gated tool calls `bridge.invoke(op, params, { requireGate })` (the router's `invoke`, see above); `bridge.gateState({ endpoint? })` is for display and diagnostics only (a later `invoke` may pick another endpoint). The whole `BRIDGE_GATE_STATE` handler runs in try/catch: on any throw the endpoint's snapshot becomes all-closed, the failure is logged without the snapshot and the sender is acked `{ ok: false, error: { code: OP_FAILED, message } }`. The sidecar snapshot is a pre-check only: the identify is self-declared (same-machine processes are trusted), so the executing browser re-enforces every gate from its own world settings. Snapshots are never in a tool result, error text or log line. `createWiretapServer` returns the bridge as `bridge` so tests can pass the `endpoint` option
  (an MCP session picks its endpoint kind with `?endpoint=` on the initialize URL). **`requires` routing (D25):** for a registry tool call whose listed script has `requires: 'dom'`, `pick` considers `DOM_ROUTE_ORDER` (`['agent']`; the session's `endpoint` kind replaces it) and only `dom: true` endpoints; with none it throws `NO_ENDPOINT` (no new code) whose message names the DOM requirement and the kind (for example `No DOM-capable 'agent' GM endpoint is connected: ...`, at most 256 bytes), or `ENDPOINT_UNAVAILABLE` when a DOM-capable endpoint of that kind is connected but unresponsive. `api` scripts follow `ROUTE_ORDER`. `invokeTool` also throws `TOOL_GONE` when the picked endpoint declares another `requires` or `mutates` for the name than the listed script.
- `src/bridge/foundryBridge.js` — `initFoundryBridge(connection)` (called from `OnceReady`) attaches to the shared
  socket via `TerminalConnection.onSocket`; its op table holds `callTool` only (the world mutations run in script handlers on a GM client).
  On each (re)connect it emits the identify (protocol v5; `gateState: readGateState()` read at emit time from `src/bridge/gates.js`; `kind` from the `wiretap.endpointKind` client setting, `dom: true`)
  with an ack callback and sets `bridgeState.identified` (exposed as `api.bridge.identified`) true only on an ok ack
  while the socket is connected; a disconnect or refused ack sets it false and a refusal is logged with the sidecar's
  message. Op failures ack `{ ok: false, error: { code: OP_FAILED, message } }`. It also listens for `BRIDGE_PING` and
  acks `{ ok: true }` regardless of identify state (no ack, or a non-function ack, is ignored); the sidecar's health
  check relies on this.
