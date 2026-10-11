# Wiretap M1 — endpoint registry, routing, protocol v2 — design

Source: `plan.md` §5 M1, §4.5, decisions D5, D16, D25 (all DECIDED). No backwards compatibility
(`.claude/claude.md`): v1 identify is refused, not translated.

Out of scope: tokens (M10), risk-gate state in identify (M2), skills registry (M7), credentials (M8), runner (M9),
new tools. The raw-socket `fingerprint` field is dropped with M11 (D27).

## R1 — Protocol v2 (`shared/protocol.js`)

- R1.1 `PROTOCOL_VERSION = 2` exported, with typedefs for the v2 identify payload, the invoke payload, the ack and the
  error contract.
- R1.2 `bridge:identify` payload: `{ protocolVersion, userId, userName, isGM, kind: 'human' | 'agent', dom: boolean }`.
- R1.3 `bridge:invoke` payload: `{ op, params, requestId }`. The sidecar generates `requestId` (a UUID) per invocation.
- R1.4 Error codes as exported constants: `NO_ENDPOINT`, `ENDPOINT_TIMEOUT`, `OP_FAILED`, `PROTOCOL_MISMATCH`, `NOT_GM`.

## R2 — Endpoint registry and router (`server/endpoints.ts`)

- R2.1 The registry replaces `gmSockets`. An endpoint is `{ socketId, userId, userName, kind, dom, registeredAt }`
  (insertion order is the tiebreak). Only GM identifies register. A repeated identify on the same socket updates its
  entry. Disconnect removes it.
- R2.2 Identify acknowledgement: the sidecar acks the `bridge:identify` Socket.IO callback AFTER registration with
  `{ ok: true }`, or `{ ok: false, error: { code, message } }` for `PROTOCOL_MISMATCH` (including a v1 payload with no
  `protocolVersion`) and `NOT_GM`. A refused identify is logged (`Wiretap sidecar | refused identify ...`) and does not
  register.
- R2.3 The router chooses the endpoint for an invocation. The default order is ONE exported constant
  (`ROUTE_ORDER = ['agent', 'human']`, D5): the first registered endpoint of the first kind that has one. An optional
  per-call `endpoint: 'agent' | 'human'` restricts the choice to that kind with NO fallback. D25 (DOM scripts to the
  agent by default) is applied by later milestones through this same option.
- R2.4 No eligible endpoint → error `NO_ENDPOINT`, message at most 256 bytes, naming the fix (open a GM tab or enable an
  agent).

## R3 — Invocation and error contract

- R3.1 `invokeOnGM` is replaced by `invoke(op, params, { endpoint? })` on the router, returning the op result or
  throwing a `BridgeError` `{ code, message, failures? }`. Timeout keeps the 10 s default, code `ENDPOINT_TIMEOUT`.
- R3.2 Messages are at most 512 bytes (truncated with an ellipsis marker). `failures` is `[{ path, message }]`, capped
  at 10, with `failureCount` carrying the true total.
- R3.3 The client op ack is `{ ok: true, result } | { ok: false, error: { code?, message, failures? } }`; the sidecar
  normalizes it into a `BridgeError` (`OP_FAILED` when the client gives no code) and enforces R3.2.
- R3.4 `requestId` appears in the invoke payload, in sidecar log lines for the call, and in the error text only when a
  log correlation is useful (not added to normal tool results).
- R3.5 `create_actor` (MCP) runs on the router unchanged apart from error formatting: an error result's text is
  `<code>: <message>` plus ` (+N more)` when failures were truncated. No new MCP arguments in M1.

## R4 — Client (`src/bridge/foundryBridge.js`, `src/hooks/OnceInit.js`)

- R4.1 The client sends identify v2 on each (re)connect and waits for the ack.
- R4.2 `kind` comes from a new client-scope setting `wiretap.endpointKind` (`'human'` default, `'agent'`; `config:
  false`); the M9 runner sets it. `dom` is `true` (every endpoint is a browser client).
- R4.3 The client exposes the identified state at `game.modules.get('wiretap').api.bridge.identified` (boolean; true
  after an ok ack, false on disconnect or a refused ack). An ack refusal is logged with the sidecar's message; a
  `PROTOCOL_MISMATCH` message tells the user to reload Foundry.
- R4.4 A call made after identify-ack succeeds works (the race measured in M0 E3 is closed by the ack, not by sleeping).

## R5 — Tests

- R5.1 Unit: registry (add, update, remove on disconnect, insertion tiebreak), router (order, fallback, override with
  no fallback, no-endpoint message size), error contract (truncation at 512 B, 50 failures → 10 + `failureCount`),
  identify validation (v1 payload refused, non-GM refused, ack shapes).
- R5.2 Integration with two fake GM Socket.IO clients (one `agent`, one `human`) against `createWiretapServer`: route
  choice, fallback when the agent disconnects, `endpoint` override without fallback, MCP `create_actor` returns the
  structured error text when nothing is connected.
- R5.3 Client unit tests: identify v2 payload, ack handling, `api.bridge.identified` transitions, refused-ack logging.
- R5.4 Existing `create_actor` tests stay green (updated to v2 where they build identify payloads).
- R5.5 No test or product code uses a deletion API; fixtures are synthetic.

## R6 — Documentation (required final step)

- R6.1 README: the routing order constant and the override; the identify-ack contract for runner authors.
- R6.2 Skills `wiretap-mcp-bridge`, `wiretap-sidecar`, `wiretap-client` and `wiretap-codebase-core` updated to the new
  current state. `graphify update .` run.
- R6.3 `plan.md` M1 text matches this spec (gateState moves to M2; fingerprint dropped).

## Addendum A (code-review findings, 2026-10-11)

- R7.1 Origin validation on the Socket.IO server via `allowRequest`: a request carrying an `Origin` header that is
  not in the allowed origin list is refused (cross-site WebSocket hijack). The allowed list is the Foundry page origins
  (`http://localhost:30000` and `http://127.0.0.1:30000`) and the Vite dev-server page origins
  (`http://localhost:30001` and `http://127.0.0.1:30001`; `server.port` in `vite.config.mjs`) in ONE exported constant (M10 makes it configurable); a request
  with NO `Origin` (a local non-browser process) is allowed, because the accepted trust model is "same-machine
  processes are trusted". Test first with a client sending a hostile `Origin`: it is accepted before the fix (record this
  as the red measurement) and refused after; absent and allowed origins connect.
- R7.2 The MCP HTTP endpoint (`/mcp`) rejects (403) a request whose `Origin` header is present and not allowed, and a
  request whose `Host` header is not `127.0.0.1:<mcpPort>` or `localhost:<mcpPort>` (DNS-rebinding defence, as the MCP
  transport guidance requires). Requests without `Origin` (MCP clients) are allowed. Tests for each.
- R3.6 `create_actor` validates the client's `result` (an object with string `uuid`, `name`, `type`) and bounds each
  string to 256 bytes; any other shape becomes `OP_FAILED` with a short message. A hostile `ok:true` ack never throws a
  TypeError and never floods the tool text.
- R3.7 Error text budget: the whole text returned for an error is at most 512 bytes: `<code>: <message>`, then as many
  `path: message` failure lines as fit, then ` (+N more)` for the rest.
- R3.8 Client-supplied error codes cannot use the reserved protocol codes (`NO_ENDPOINT`, `ENDPOINT_TIMEOUT`,
  `ENDPOINT_GONE`, `PROTOCOL_MISMATCH`, `NOT_GM`); they become `OP_FAILED`.
- R1.5 New code `ENDPOINT_GONE`.
- R2.5 When an endpoint disconnects while an invocation to it is pending, that invocation rejects immediately with
  `ENDPOINT_GONE` (not after 10 s). A synchronous send failure or a missing socket is also `ENDPOINT_GONE`, not
  `ENDPOINT_TIMEOUT`; the cause is kept in the log line.
- R2.6 Identify limits: `userId` at most 64 bytes, `userName` at most 128 bytes (longer is `PROTOCOL_MISMATCH`), at most
  64 registered endpoints (an identify beyond that is refused with the new reserved code `ENDPOINT_LIMIT`), and
  refused-identify log lines are throttled to at most 10 per minute in total.
- R1.6 New code `ENDPOINT_LIMIT` (reserved per R3.8).
- R3.9 `truncateUtf8` is safe for any `maxBytes` (returns an empty string below the ellipsis size) and is tested on
  2-, 3- and 4-byte characters.
- R5.6 Added tests: hostile ack shapes (null ack, `ok:true` without result, array/string `error`, numeric `message`,
  non-array `failures`), identify during an in-flight invoke, a timeout test with fake timers (not an immediate reject),
  requestId reaching the client, disconnect during the ack wait.
- R4.5 (client) Changing `endpointKind` re-identifies (setting `onChange`); the late-ack guard uses a per-attempt token
  so an ack from an earlier connection cannot mark a later one identified; op lookup uses `Object.hasOwn` so inherited
  names (`constructor`) are unknown ops.
- R8 Cleanups: lines over 120 columns in touched files; typed + commented declarations flagged by the review; the double
  blank line in `src/bridge/foundryBridge.js`; the `plan.md` §4 component-table registry row matches M1; the
  `mcpConfigFile.test.js` scratch root includes a timestamp (open bug in `docs/OPEN_BUGS.md` moves to CLOSED when fixed).
- R7.3 Refused Socket.IO origin handshakes are logged (`Wiretap sidecar | refused origin "<origin>"`, the origin cut to
  64 bytes) through the same throttle as refused identifies: at most 10 lines per minute, then ONE
  `N further origin refusals suppressed` line from the first call after the window. R2.6's identify throttle writes
  `N further identify refusals suppressed` the same way. One helper (`createLogThrottle`) serves both.
- R7.4 The `/mcp` Host check compares with the port the server actually bound (`startMcpServer` returns `port()`), so a
  server started on port 0 does not refuse its own Host. Test: `startMcpServer(bridge, 0)`.
- R2.7 Only the transport's ack timeout (`EndpointTimeoutError`) maps to `ENDPOINT_TIMEOUT`; any other error thrown by
  the send maps to `ENDPOINT_GONE` (R2.5), with the cause in the log line. Test: a plain `Error` from the transport.
- R5.7 The "does nothing before the bridge is wired" client test imports a fresh module instance (`vi.resetModules`) and
  asserts `reidentifyBridge` reads no setting; the origin test asserts the refusal body `Origin not allowed` (HTTP 403 on
  a polling handshake; the client library reports only `websocket error` / `xhr poll error`).
- Deferred (needs a decision, logged in `TODO.md`): endpoint health and fallback after a timeout (a hung preferred
  endpoint blocks later calls; automatic retry of a mutation on another endpoint risks a double apply).
