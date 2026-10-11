# Wiretap

A Foundry VTT v14 module that adds a tab and a bridge for AI agents inside Foundry. Built with
Svelte 5 (runes), SCSS, and Vite.

## Development

- `npm run dev` — Vite dev server (proxies to Foundry on :30000)
- `npm run build` — production build (emits `index.js` + `style.css`)
- `npm test` — unit tests (Vitest)
- `npm run test:e2e` — end-to-end tests (Playwright)
- `npm run foundry:start` — starts Foundry on the configured world if nothing answers on the port, and stops it when the
  process that ran the command ends

## Running e2e / starting Foundry

`npm run test:e2e` starts Foundry itself through `scripts/e2e-foundry-server.mjs` when nothing answers on
`:30000`, reuses a running server otherwise, and stops a server it started when the run ends. The launched world
(default `test-titan`) must have Wiretap enabled. Defaults derive from the module location (userdata three levels
up, Foundry app in `<userdata>/../foundry`); override with `FOUNDRY_DATA_PATH`, `FOUNDRY_APP_DIR`, `FOUNDRY_PORT`,
`FOUNDRY_WORLD`, `FOUNDRY_SERVER_LOG` (default `debug/dumps/e2e-server.log`).

## Running the sidecar

Wiretap's terminal needs a small local Node sidecar (it runs the real PTY; a browser can't). Start it with
a single action:

- **Windows:** double-click `start-wiretap.cmd` in the module folder.
- **macOS/Linux:** run `./start-wiretap.sh` from the module folder.

A console window opens and stays up while the sidecar runs — its log shows `listening on http://127.0.0.1:31416`.
**Close that window (or press Ctrl-C) to stop the sidecar.** The Wiretap tab (GM-only) connects automatically
once the sidecar is up; until then it shows a "Sidecar not running" panel.

## MCP modes

The sidecar hosts a Streamable-HTTP MCP endpoint (default `http://127.0.0.1:31417/mcp`, loopback only; override the
port with `WIRETAP_MCP_PORT`) whose tools run against the live world through a GM-identified Foundry client.

- **In-session (default, `full` mode):** when the Wiretap terminal launches `claude` followed only by plain
  arguments (the default command is bare `claude`), the sidecar writes `.wiretap/mcp-<mcpPort>.json` in the module
  directory (the parent of `server/`, resolved from the server's own location; the directory is mode 0o700, the file
  0o600, gitignored) and appends `--mcp-config "<path>"`, so that `claude` sees the Wiretap tools with no setup. Wiring follows an allowlist: every argument must consist solely of
  `A-Z a-z 0-9 . _ : = / @ + , -`. Any other command line is launched unchanged and the skip is logged: a command
  that is not exactly `claude`, one that already passes `--mcp-config`, one with a standalone `--`, and one with any
  other character, which includes **every quoted argument** (for example `claude --append-system-prompt "..."` is
  not wired). The same applies if the config file cannot be written. The config file is rewritten on every wired
  launch (a symbolic link at the file path is refused) and is never deleted by the sidecar; a failed write is logged and
  the command is launched unchanged.
- **Standalone (`mcp-only` mode):** run the sidecar without the terminal relay and attach any MCP client:

  ```
  npm run server:mcp
  claude mcp add --transport http wiretap http://127.0.0.1:31417/mcp
  ```

  `--mcp-only` on the command line or `WIRETAP_MODE=mcp-only` selects this mode (the argument wins; `full` is the
  default and any other `WIRETAP_MODE` value exits with an error). The Socket.IO server and the Foundry bridge stay
  up (the Socket.IO server, like the MCP endpoint, binds `127.0.0.1` only and is not reachable from other machines) so
  the Foundry client can still identify as a GM.

## Origin validation

Both listeners refuse a request from a browser page of another origin. The allowed origins are the single constant
`ALLOWED_ORIGINS` in `server/origins.ts` (`http://localhost:30000` and `http://127.0.0.1:30000`, the Foundry page
origins, plus `http://localhost:30001` and `http://127.0.0.1:30001`, the Vite dev-server page origins of `npm run dev`):

- **Socket.IO:** the handshake (`allowRequest`) is refused when it carries an `Origin` header that is not listed
  (cross-site WebSocket hijack). A handshake with no `Origin` header, which is what a local non-browser process sends,
  is accepted: the trust model is that same-machine processes are trusted, and there is still no authentication on
  socket events. Each refused handshake is logged as `Wiretap sidecar | refused origin "<origin>"` (the origin cut to
  64 bytes), at most 10 lines per minute, followed by one `N further origin refusals suppressed` line when the window
  ends (written by the next refusal after the window).
- **MCP (`/mcp`):** a request with a listed-or-absent `Origin` and a `Host` of `127.0.0.1:<mcpPort>` or
  `localhost:<mcpPort>` is served; anything else gets `403` (DNS-rebinding defence). MCP clients send no `Origin`. The `Host` is compared with the port the server actually bound,
  so a server started on an ephemeral port (0) accepts its own Host.

The list is not configurable yet; a Foundry served from another port or host needs the constant edited.

## Bridge routing and identify (protocol v2)

Foundry GM clients register with the sidecar as **endpoints** over Socket.IO. Each endpoint has a `kind`: `human` (a
person's tab) or `agent` (an agent-runner browser).

**Routing.** The default order is the single constant `ROUTE_ORDER` in `server/endpoints.ts` (`['agent', 'human']`): an
invocation goes to the earliest-registered endpoint of the first kind that has one, so a connected agent endpoint is
preferred and a human tab is the fallback. A call may pass `endpoint: 'agent' | 'human'` to the router's
`invoke(op, params, { endpoint })` to restrict the choice to that kind with no fallback. With no eligible endpoint the
call fails with `NO_ENDPOINT`.

**Identify contract (for runner authors).** Emit `bridge:identify` on every (re)connect, with an ack callback:

```js
socket.emit('bridge:identify', {
   protocolVersion: 2,
   userId,
   userName,
   isGM: true,
   kind: 'human', // or 'agent'
   dom: true,
}, (ack) => { /* { ok: true } or { ok: false, error: { code, message } } */ });
```

The sidecar registers the endpoint and then acks `{ ok: true }`; calls routed after that ack succeed. A refused
identify acks `{ ok: false, error: { code, message } }` and registers nothing: `PROTOCOL_MISMATCH` (any other
`protocolVersion`, including a v1 payload without one, or a malformed field; reload Foundry) or `NOT_GM`. A refused
identify also removes any earlier registration of the same socket. A repeated identify on the same socket updates its
entry; a disconnect removes it. Limits: `userId` is at most 64 bytes and `userName` at most 128 bytes (longer is
`PROTOCOL_MISMATCH`), and at most 64 endpoints are registered (an identify from a new socket beyond that acks
`ENDPOINT_LIMIT`). Refused-identify log lines are throttled to 10 per minute in total; the ack is never throttled.

**Wiretap client.** The module's Foundry client sends this identify (protocol 2, `dom: true`) on every (re)connect, with
`kind` taken from the client-scope setting `wiretap.endpointKind` (`human` by default; an agent runner sets `agent`). The
client counts as identified only after an `{ ok: true }` ack: `game.modules.get('wiretap').api.bridge.identified` is
`true` from that ack until a disconnect or a refusal, so a runner waits on it before invoking tools. A refused ack is
logged to the browser console with the sidecar's message; for `PROTOCOL_MISMATCH` reload Foundry. The client has no
protocol 1 fallback.

**Invocation and errors.** The sidecar emits `bridge:invoke` `{ op, params, requestId }` (`requestId` is a UUID per
call and appears in sidecar log lines). The client acks `{ ok: true, result }` or
`{ ok: false, error: { code?, message, failures? } }`. Failures reach the caller as
`{ code, message, failures?, failureCount? }` with codes `NO_ENDPOINT`, `ENDPOINT_TIMEOUT` (10 s with no ack),
`ENDPOINT_GONE` (the endpoint disconnected, or could not be written to, before it acked; reported at once, not after
10 s), `OP_FAILED` (the default when the client gives no code), `PROTOCOL_MISMATCH`, `NOT_GM`, `ENDPOINT_LIMIT`. The
last six are reserved: a code of that name in a client's failure ack is reported as `OP_FAILED`. Messages are at most
512 bytes (256 for `NO_ENDPOINT`), truncated with `…`; `failures` is capped at 10 entries with `failureCount` holding
the true total. MCP error results are at most 512 bytes in total: `<code>: <message>`, then as many `path: message`
failure lines as fit, then ` (+N more)` for the failures not shown. The `create_actor` result must be an object with
string `uuid`, `name` and `type` (each bounded to 256 bytes in the tool text); any other ack result is reported as
`OP_FAILED`.
