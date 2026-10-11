# Wiretap

A Foundry VTT v14 module that adds a tab and a bridge for AI agents inside Foundry. Built with
Svelte 5 (runes), SCSS, and Vite.

## Development

- `npm run dev` — Vite dev server (proxies to Foundry on :30000)
- `npm run build` — production build (emits `index.js` + `style.css`)
- `npm test` — unit and integration tests (Vitest), including the context-budget test that holds every MCP tool
  definition and representative result to the budgets in `shared/budgets.js`
- `npx tsx tests/measure/measureContext.mjs` — manual report of the real tool list and fixture result sizes against
  those budgets (not part of CI; needs no Foundry)
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

## Large results and handles

Every MCP tool result passes through a result enforcer (`server/resultBudget.ts`). A text result of at most 8,000
bytes is returned as is. A larger one is kept in the sidecar's memory and the caller gets `{handle, bytes, summary}`
(at most 256 bytes). Budgets count the raw UTF-8 bytes of the text, not the JSON-escaped bytes of the MCP wire message
(1 KB is 1000 bytes), so a result at the cap can be larger on the wire. `bytes` is the size of the stored text. Only a
result that is a single text item holding JSON is described by its top-level keys, entry counts and `name`/`type`
(keys that collide once shortened to 32 bytes are skipped and counted in `omitted`; keys are listed in JavaScript
property order, integer-like keys first). A result with several items or structured content is stored as the items
joined by newlines and described as `text`.

**Raising the limit.** A tool call may pass `maxBytes` (1 to 16,000) to change the limit for that call, but the MCP SDK
strips arguments a tool's input schema does not declare. `read_handle` declares `maxBytes` (128 to 16,000); any other tool opts in by
declaring an optional integer `maxBytes` in its schema, which adds to that tool's definition size. Without the
declaration the 8,000-byte limit applies.

**Reading a handle.** `read_handle` takes `handle` and optionally `paths` (document paths over the stored JSON, the
grammar of `shared/docPath.js`), `offset`, `length` and `maxBytes` (128 to 16,000; the 64 bytes above the window are the
footer reserve). Offsets and lengths count UTF-16 units. The first
item is the window text, the second a footer `{offset, length, total}`; the window plus footer stay within `maxBytes`.
A window never ends inside a surrogate pair, an `offset` inside a pair moves back to the pair's first unit (the footer
reports the real offset), and `length: 1` at a pair returns the whole pair. When `maxBytes` is too small for the next
character the call fails with `HANDLE_WINDOW_TOO_SMALL`. A `paths` result is built only as far as one window can reach:
a result longer than the window is cut to it and the footer adds `"truncated": true`. The cut depends on the call's
`maxBytes`, and the cut-off tail is reachable only by narrowing `paths`, not by paging. Each `paths` read parses the
stored text again (nothing is cached); measured on this machine, parse plus 20 wildcard paths took about 17 ms for an
8 MB document of long strings and about 185 ms (parse 26 to 55 ms, resolve 153 to 170 ms) for 7.7 MB of 106,000 small
objects. A read that fails (bad range, bad path, not JSON) does not keep the handle alive.

**Limits.** Handles live only in memory, and nothing is written to disk; a sidecar restart loses them. One stored
result is at most 8,000,000 bytes (a larger one is refused with `HANDLE_TOO_LARGE`) and at most 1,024 handles are held
(the least recently used is evicted beyond that). Eviction is global: until handles are owned per session, one caller's
large results can evict another's. Inside the 64 MB total each entry is accounted as the larger of its
UTF-8 size and twice its character count, plus 256 bytes of overhead; least recently used entries are evicted first, and
a handle not read for 30 minutes (measured on a monotonic clock) expires.

**Errors and images.** Error text is capped at 512 bytes. A thrown `BridgeError` passes as `<code>: <message>`; any
other failure (`create_actor` rethrows them too), and any result the enforcer cannot read (no `content`, non-string text, unserializable content), becomes a fixed short
error (`Tool failed.` or `Tool returned an invalid result.`) and the real cause is written to the sidecar log only, with
control characters and line breaks replaced by spaces and the text cut to 512 bytes. A
result is refused with `IMAGE_LIMIT` when it carries more than one image, an image whose `mimeType` is not `image/png`,
base64 data that is longer than 1,000,000 characters or has any character outside the standard base64 alphabet
(whitespace included), or a PNG whose longest side exceeds 1280 px. The enforcer returns only what it measured: image items as exactly
`type`, `data` and `mimeType`, text items as exactly `type` and `text`, and the result as `content` plus
`structuredContent` when present. `_meta`, `annotations` and any unknown field, on an item or on the result, are dropped. The 480,000 px default image area is applied when a
capture tool takes the picture, not by the enforcer.

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

**Endpoint health.** Every endpoint is `healthy` or `unresponsive`; routing (the default order and the `endpoint`
override alike) skips unresponsive endpoints, keeping the order above among the rest. When an invocation gets no ack in
10 s the sidecar emits `bridge:ping` to that endpoint (the client acks `{ ok: true }` at once). A ping acked within 1 s
leaves the endpoint healthy (the operation was slow). A ping that is not acked in 1 s, or cannot be written, marks it
unresponsive and the sidecar pings it every 5 s, one ping in flight per endpoint, until one is acked; only a ping ack
restores it (a new identify from an already-registered socket keeps its health and probe), and a disconnect or a refused
identify removes it and stops its probe. The sidecar waits for that ping (at most 1 s) before answering, so a timed-out
call reports `ENDPOINT_TIMEOUT` after up to 11 s. Health log lines are throttled to 10 per minute. Concurrent timeouts
on one endpoint start one probe. When endpoints of the eligible kind are connected but all are unresponsive the call
fails at once with `ENDPOINT_UNAVAILABLE` (an `endpoint` override never switches kind: it returns `ENDPOINT_UNAVAILABLE`
when that kind has only unresponsive endpoints and `NO_ENDPOINT` when none of that kind is connected). The sidecar never
retries a call: it is sent once, and `ENDPOINT_TIMEOUT` reports that the operation may still have applied so the caller
checks before retrying.

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

**Invocation and errors.** The sidecar emits `bridge:invoke` `{ op, params, requestId }` (`requestId` is a UUID per call
and appears in sidecar log lines). The client acks `{ ok: true, result }` or `{ ok: false, error: { code?, message,
failures? } }`. Failures reach the caller as `{ code, message, failures?, failureCount? }` with codes `NO_ENDPOINT`,
`ENDPOINT_UNAVAILABLE` (endpoints connected, all unresponsive; refused without sending), `ENDPOINT_TIMEOUT` (10 s with
no ack; the operation may still have applied; it is reported after up to 11 s, the 10 s ack window plus the sidecar's
health ping of at most 1 s), `ENDPOINT_GONE` (the endpoint disconnected, or could not be written to, before it acked;
reported at once, not after 10 s), `OP_FAILED` (the default when the client gives no code), `PROTOCOL_MISMATCH`,
`NOT_GM`, `ENDPOINT_LIMIT`. All of them except `OP_FAILED` are reserved: a code of that name in a client's failure ack
is reported as `OP_FAILED`. Messages are at most 512 bytes (256 for `NO_ENDPOINT`), truncated with `…`; `failures` is
capped at 10 entries with `failureCount` holding the true total. MCP error results are at most 512 bytes in total:
`<code>: <message>`, then as many `path: message` failure lines as fit, then ` (+N more)` for the failures not shown.
The `create_actor` result must be an object with string `uuid`, `name` and `type` (each bounded to 256 bytes in the tool
text); any other ack result is reported as `OP_FAILED`.