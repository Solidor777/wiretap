# Wiretap

A Foundry VTT v14 module that adds a tab and a bridge for AI agents inside Foundry. Built with
Svelte 5 (runes), SCSS, and Vite.

## Development

- `npm run dev` — Vite dev server (proxies to Foundry on :30000)
- `npm run build` — production build (emits `dist/index.js` + `dist/style.css`, the files `module.json` loads)
- `npm run check:build` — fails when a file named by `module.json` `esmodules` or `styles` does not exist; the e2e build
  (`vite build --mode e2e`, run by `npm run test:e2e`) writes to the same `dist/` with hash-free file names, so nothing
  accumulates and nothing is deleted
- `npm run check:release` — packaging check: fails while `dist/` holds any file other than `index.js`, `index.js.map` and
  `style.css`. Package with `npm run build` and then `npm run check:release`; the e2e leftovers (`registerProbe.js`,
  `TerminalConnection.svelte.js` and their `.map` files) must be recycled with `trash` before packaging
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

A spec that creates a world document records it in the running list `test/state/registry.json` (gitignored,
overwritten, never deleted) as soon as its id is known, and removes it with a Foundry document call (`document.delete()`)
after the test. Before it deletes anything the teardown checks every recorded entry: an allowed world document type, a
uuid of the form `<Type>.<16-character id>` (never a compendium or embedded uuid), a resolved document of the recorded
type that is not in a pack, not embedded and named with the `Wiretap E2E ` prefix; if any entry fails, nothing is
deleted and the run fails. After the teardown a sweep deletes (through the same checks) every world document named with
the prefix that no running list recorded, and the run fails when it finds one. A census then counts prefixed documents,
every combat and every token whose actor no longer resolves; each test and the global teardown fail on a non-empty
census, and the global setup removes what a crashed run left. The suite refuses to run these steps in any world but
`FOUNDRY_WORLD` (default `test-titan`).

## Running the sidecar

Wiretap's terminal needs a small local Node sidecar (it runs the real PTY; a browser can't). Start it with
a single action:

- **Windows:** double-click `scripts/start-wiretap.cmd` in the module folder.
- **macOS/Linux:** run `./scripts/start-wiretap.sh` from the module folder.

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

## MCP sessions and registered tools

The MCP endpoint is stateful Streamable HTTP. A client's `initialize` POST opens a session and returns an
`Mcp-Session-Id`; later requests carry it. `GET /mcp` opens the session's event stream, `POST /mcp` carries requests
and `DELETE /mcp` ends the session (in memory only; nothing is deleted on disk). A request without a session id other
than `initialize` gets `400`, an unknown, expired or ended id gets `404` (a client re-initializes after that; measured
with `claude` 2.1.296 in `docs/experiments/2026-10-m3-results.md`), a path other than `/mcp` gets `404` and any other
method `405`.

- **Endpoint choice.** `?endpoint=human` or `?endpoint=agent` on the initialize URL fixes which kind of Foundry GM
  client the session routes to (any other value gets `400`). Without it a call goes to the first healthy `agent`
  endpoint, then the first healthy `human` one.
- **Instructions.** Every session receives a short server `instructions` text that names the tools and explains
  handles and tool-list changes; it does not point to the Wiretap skill (see below). An earlier, longer text (531
  characters) cost about 221 tokens of context (measured, same results file); the current text is shorter and was not
  re-measured.
- **Registered scripts.** Every tool except the built-in `read_handle` is a script a GM client registers. A registered
  GM client pushes its complete script list with the Socket.IO event `bridge:registry`, whose payload is
  `{ apiVersion: 1, scripts: [...] }` (a plain array is refused); each event replaces the endpoint's previous list. A
  script definition is `{ name, version, description, inputSchema, result: { budgetBytes }, requires, mutates, gate? }`,
  documented field by field in `shared/scripts.js`: `version` is a semver-like string of at most 32 characters,
  `requires` is `'api'` (any client endpoint) or `'dom'` (a DOM-capable endpoint), and `mutates` is required and never
  defaulted. The sidecar refuses any entry over the budgets (name at most 32 characters, description at most 240,
  bounded definition, a documented JSON Schema subset), logs the reason, and tells each session routed to that endpoint
  with one debounced `notifications/tools/list_changed` (200 ms quiet, 1,000 ms at most). A call to such a tool runs the
  `callTool` operation on the session's endpoint; each tool is listed with `readOnlyHint` set to the inverse of
  `mutates`. `create_actor` is one of these scripts: the Foundry client registers it from `src/bridge/scripts/` and the
  sidecar has no handler of its own for it. The client sends its registry after every acknowledged identify and
  whenever a script registers, so a reconnect restores the tool list. The client runs a call only after it has found the
  script by name, judged the script's declared risk gate from its own world settings, and validated the arguments
  against the script's own schema (`shared/schemaValidate.js`, the same JSON Schema subset the sidecar converts; every
  array schema must declare a `maxItems` of at most 1,000); a script that runs longer than 8 s fails with
  `SCRIPT_TIMEOUT`, which says the operation may still have applied. A client runs at most 8 scripts at once; a call
  beyond that fails at once with `SCRIPT_BUSY`. The client sends one registry push per task however many scripts register in it; the sidecar applies at most 2
  `bridge:registry` pushes per second from one socket: later pushes in the same second are coalesced, and the latest is applied when the second ends (an earlier
  coalesced push is acked `{ ok: true, coalesced: true }`). The listed definitions of all tools, with the room kept
  for the sidecar's own `read_handle`, fit 16,000 bytes; a tool that would overflow it is refused with a logged reason.
  `create_actor` takes `name` (1 to 128 characters) and an optional `type` (1 to 64 characters), accepts no other
  argument, is listed with `readOnlyHint` false, and returns the JSON ack `{uuid, name, type}` (a name over about 80
  bytes is shortened in it). A tool
  added during a `claude` session was deferred (found through `ToolSearch`) and callable in the same session.
- **Expiry and cap.** A session expires after 30 minutes without a request that carries its id (an open event stream
  alone does not count). At most 32 sessions are held; an `initialize` beyond that is refused with `503` and a
  `Retry-After` header and no held session is ended, so one client cannot push another's session out. The idle sweep (one
  per minute) frees slots. Ending a session releases the result handles it owns. One client may open several sessions
  over its life (measured).
- **Request limits.** A request body over 1,048,576 bytes gets `413`; a request whose headers or body take longer than
  10 s and 15 s gets `408`; a connection that sends no request for 30 s is closed (one with a request in flight, such
  as an open event stream, is not); at most 128 connections are served at once. An unknown session id is answered
  `404` before any body is read. A refused request is answered with `Connection: close` once the rest of its body
  (up to 8 MiB) has been read and discarded, so the client sees the status instead of a reset connection.

## Wiretap skill for Claude Code

`skills/wiretap/SKILL.md` is a short user-facing skill that tells an agent which Wiretap tools exist
(`mcp__wiretap__create_actor`, `mcp__wiretap__read_handle`) and how to use them. It is not installed automatically:
copy the `skills/wiretap` directory into the `.claude/skills/` directory of the project that runs `claude` (a skill for
one project), or into `~/.claude/skills/` (a skill for every project), so that the file is
`.claude/skills/wiretap/SKILL.md`, then start a new `claude` session. A symbolic link to the directory works the same
way where your system allows one (`ln -s <module>/skills/wiretap <target>/wiretap`; on Windows `mklink /D` needs a
console with symbolic-link rights). The skill names only tools that exist; a test (`tests/unit/shippedSkill.test.js`
and the context-budget test) fails when it names one that does not.

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
(the least recently used is evicted beyond that). Handles are owned by the MCP session that stored them and are released when it ends; eviction is still global, so one
session's large results can evict another's. Inside the 64 MB total each entry is accounted as the larger of its
UTF-8 size and twice its character count, plus 256 bytes of overhead; least recently used entries are evicted first, and
a handle not read for 30 minutes (measured on a monotonic clock) expires.

**Errors and images.** Error text is capped at 512 bytes. A thrown `BridgeError` passes as `<code>: <message>`; any
other failure, and any result the enforcer cannot read (no `content`, non-string text, unserializable content), becomes a fixed short
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

## Bridge routing and identify (protocol v4)

Foundry GM clients register with the sidecar as **endpoints** over Socket.IO. Each endpoint has a `kind`: `human` (a
person's tab) or `agent` (an agent-runner browser).

**Routing.** The default order is the single constant `ROUTE_ORDER` in `server/endpoints.ts` (`['agent', 'human']`): an
invocation goes to the earliest-registered endpoint of the first kind that has one, so a connected agent endpoint is
preferred and a human tab is the fallback. A call may pass `endpoint: 'agent' | 'human'` to the router's
`invoke(op, params, { endpoint })` to restrict the choice to that kind with no fallback. With no eligible endpoint the
call fails with `NO_ENDPOINT`.

**Scripts that need the DOM.** A script registered with `requires: 'dom'` (opening sheets, measuring layout) is routed
to the `agent` kind only, and only to an endpoint that identified with `dom: true`; it never falls back to a human tab.
A session opened with `?endpoint=human` is routed to human tabs instead (a DOM-capable one). With no such endpoint the
call fails with `NO_ENDPOINT` (at most 256 bytes) naming the missing kind, for example `No DOM-capable 'agent' GM
endpoint is connected: enable an agent, or restrict this session to a human tab with ?endpoint=human.` A script with
`requires: 'api'` follows the default order above. The endpoint that runs a call must declare the same `requires`
and `mutates` for the script as the listing did, or the call fails with `TOOL_GONE` without being sent.

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
   protocolVersion: 4,
   userId,
   userName,
   isGM: true,
   kind: 'human', // or 'agent'
   dom: true,
   gateState, // optional risk-gate snapshot, see below
}, (ack) => { /* { ok: true } or { ok: false, error: { code, message } } */ });
```

The sidecar registers the endpoint and then acks `{ ok: true }`; calls routed after that ack succeed. A refused
identify acks `{ ok: false, error: { code, message } }` and registers nothing: `PROTOCOL_MISMATCH` (any other
`protocolVersion`, including a v1 payload without one, or a malformed field; reload Foundry) or `NOT_GM`. A refused
identify also removes any earlier registration of the same socket. A repeated identify on the same socket updates its
entry; a disconnect removes it. Limits: `userId` is at most 64 bytes and `userName` at most 128 bytes (longer is
`PROTOCOL_MISMATCH`), and at most 64 endpoints are registered (an identify from a new socket beyond that acks
`ENDPOINT_LIMIT`). Refused-identify log lines are throttled to 10 per minute in total; the ack is never throttled.

**Risk gates.** A gate is a world-scope GM setting that unlocks a class of dangerous operation. The registry is
`shared/gates.js` (`GATES`): the boolean gates `allowMacroExecution`, `allowUserWrites`, `allowSettingWrites`,
`allowFileUpload`, `allowOwnershipWrites`, `allowCompendiumWrites`, `allowModuleConfigWrites` and `allowAgentScripts`
(all default `false`) and `allowedPluginModules` (an array of module ids, default empty). There is no delete gate and no
undo gate. The client reports its gate values as a snapshot object with exactly those keys: in the identify's optional
`gateState`, and again by emitting `bridge:gateState` with the snapshot as the payload (ack callback optional) whenever
a gate changes. The sidecar sanitizes every snapshot: only the registry names are read, each only as an own property and
only with its registry type (booleans; `allowedPluginModules` is at most 64 entries, each a Foundry module id of 1 to 64
characters from `[a-z0-9_-]` starting with a letter or digit, duplicates removed, and a longer list is treated as
empty); every other key and every wrong-typed value is dropped and the gate stays closed. An absent or non-object
snapshot closes every gate. The snapshot belongs to the sending endpoint: a repeated identify replaces it, a
`bridge:gateState` from a registered GM endpoint replaces only that endpoint's snapshot and acks `{ ok: true }`, and one
from a socket that is not a registered endpoint (never identified, refused, disconnected) changes nothing and acks
`{ ok: false, error: { code: 'NOT_GM', message } }`; those refusals are logged at most 10 per minute. If handling a
snapshot throws, that endpoint's gates are all closed and the sender gets `{ ok: false, error: { code: 'OP_FAILED',
message } }`. Snapshots never appear in a tool result or a log line.

The sidecar snapshot is a **pre-check only**. The executing browser re-enforces every gate from its own world settings
and never from a parameter, because the identify payload is self-declared and same-machine processes are trusted until
tokens exist: a forged GM endpoint can claim open gates, which is why the client re-checks. The sidecar enforces a gate
by passing `requireGate: { gate, moduleId? }` to `invoke`: the router picks one endpoint, judges that endpoint's own
snapshot, throws `GATE_DENIED` before sending when it is closed, and otherwise sends to that same endpoint, so no
endpoint change can split the check from the send. `bridge.gateState()` is a display accessor only. A gate denial is a
`GATE_DENIED` error of at most 256 bytes that names the gate and says only a GM can enable it in the Wiretap module
settings; `GATE_DENIED` is not a reserved code (the executing client may send it), so a received one is never proof that
a sidecar check ran. No write path may write a `Setting` whose key is in the `wiretap` namespace:
`denyWiretapSettingWrite` refuses it, and callers write the string `resolveSettingKey` returns (resolve a by-id update
to its key first; pass a namespaced setting as `{ namespace, key }`). The module's own client sends no snapshot, so every
gate reads closed.

**Wiretap client.** The module's Foundry client sends this identify (protocol 4, `dom: true`) on every (re)connect, with
`kind` taken from the client-scope setting `wiretap.endpointKind` (`human` by default; an agent runner sets `agent`). The
client counts as identified only after an `{ ok: true }` ack: `game.modules.get('wiretap').api.bridge.identified` is
`true` from that ack until a disconnect or a refusal, so a runner waits on it before invoking tools. A refused ack is
logged to the browser console with the sidecar's message; for `PROTOCOL_MISMATCH` reload Foundry. The client has no
fallback to an older protocol.

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
A registered script's ack result is shown as text (a string as is, anything else as JSON) behind the result enforcer with
the script's own `result.budgetBytes`; an ack with no result is shown as `null`.

## Settings and risk gates

Wiretap registers its settings in Foundry's module settings. The client-scope settings (sidecar URL, terminal command,
theme, font size) belong to each browser. The risk gates are world-scope, GM-only (`restricted`) settings, all off by
default; each unlocks a class of dangerous operation for agents:

| Setting | Unlocks |
|---|---|
| `allowMacroExecution` | Running macros (arbitrary code) |
| `allowUserWrites` | Creating, updating and deleting User documents |
| `allowSettingWrites` | Writing Setting documents and world or user settings |
| `allowFileUpload` | Base64 data in file-path fields and the file upload tool |
| `allowOwnershipWrites` | Changing the ownership of documents |
| `allowCompendiumWrites` | Writing compendium packs and their documents |
| `allowModuleConfigWrites` | Writing the module configuration (enables and disables modules) |
| `allowAgentScripts` | Saving, disabling and running agent-saved scripts (arbitrary code) |
| `allowedPluginModules` | Plugin skills and scripts of the module ids listed (comma-separated; empty by default) |

The gate definitions live in `shared/gates.js`; the settings are registered from that table. A GM client sends its
gate snapshot to the sidecar when it identifies and again whenever a gate setting changes. The sidecar uses the snapshot
as a pre-check, and the executing browser re-reads its own settings before it acts, so a gate is always judged by the
world setting of the client that would run the operation. No bridge operation can write a `wiretap.*` setting.

The push ignores a change whose author is not a GM. Trust assumption: `restricted` only hides the setting in the
settings window; Foundry lets any user holding the `SETTINGS_MODIFY` permission write a world setting, and that
permission can be granted to a non-GM role. The executing browser reads the stored value whoever wrote it, so a user
holding `SETTINGS_MODIFY` is trusted at GM level for the gates.

Known limit: any arbitrary-code capability (`allowMacroExecution`, `allowAgentScripts`, a listed plugin module) can
call `game.settings.set` directly. While one is enabled, the guarantee is only that no core skill can change a gate.

## Documentation

See [`docs/README.md`](docs/README.md) for the index. Key files: [`docs/PLAN.md`](docs/PLAN.md) (plan and design),
[`docs/PROGRESS.md`](docs/PROGRESS.md) (milestone history), [`docs/TODO.md`](docs/TODO.md) (deferred work),
[`docs/OPEN_BUGS.md`](docs/OPEN_BUGS.md) and [`docs/CLOSED_BUGS.md`](docs/CLOSED_BUGS.md) (bugs).
