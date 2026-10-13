# M3 live check results (stateful MCP sessions)

Run 2026-10-12 on a Windows host with `claude` 2.1.296 (`claude --version` printed `2.1.296 (Claude Code)`), model
`haiku` (the M0 method of `docs/PLAN.md` §2.1). Labels: **MEASURED** (command and output named), **INFERRED** (not
verified). No credentials appear here. The throwaway scripts live in the gitignored `test/tmp/m3live/` and are not
committed.

## Setup (MEASURED)

- Sidecar: `createWiretapServer(41516, 41517, 'mcp-only')` in a throwaway Node process (`npx tsx
  test/tmp/m3live/sidecar.mjs`), loopback only, non-default ports; the developer's `.wiretap/mcp-31417.json` was not
  touched. A fake GM (`socket.io-client`) identifies as `human`, acks `createActor` with a bounded result and `callTool`
  with `echo: <text>`. Mode `a`: on its first `createActor` invoke it emits `bridge:registry` with one tool `late_echo`
  (acked `{"ok":true,"accepted":1,"refused":0}`), then waits 2.5 s before acking, so the registration happens after
  the claude session has initialized and listed tools.
- Client: `claude -p "<prompt>" --model haiku --output-format stream-json --verbose --strict-mcp-config --mcp-config
  cfg.json --allowedTools ... < /dev/null` under `timeout 120` (headless; no browser). `cfg.json` is
  `{"mcpServers":{"wiretap":{"type":"http","url":"http://127.0.0.1:41517/mcp"}}}`.
- Context per assistant message = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, as in
  `docs/PLAN.md` §2.1.
- After every run the listeners were checked with `netstat -ano | grep ":415"` (no listener), and the sidecar was
  stopped with `taskkill /T /F` on its own pid.

## 1. A tool added by `list_changed` is deferred and callable in the same session (MEASURED)

Prompt: call `mcp__wiretap__create_actor` with name Zed, then call `mcp__wiretap__late_echo` with text hi.

- The `system`/`init` message listed `ToolSearch`, `mcp__wiretap__create_actor`, `mcp__wiretap__read_handle`: the
  session-start tool list does not contain `late_echo` (not registered yet).
- Turn sequence: `ToolSearch select:mcp__wiretap__create_actor,mcp__wiretap__late_echo` returned only
  `create_actor` (the late tool was not yet registered then); `create_actor` ran (fake GM registered `late_echo` during
  that call); the model then ran `ToolSearch late_echo`, which returned `tool_reference mcp__wiretap__late_echo`, and
  `mcp__wiretap__late_echo {"text":"hi"}` returned `echo: hi`. Result `success`, 5 turns, `duration_ms` 12363 (12.4 s).
- So the late tool arrived by `tools/list_changed`, was deferred (found only through `ToolSearch`, like the tools at
  session start), and was callable in the same session.

## 2. Context cost (MEASURED, two runs each)

Prompt: call `mcp__wiretap__create_actor` with name Zed (ToolSearch first if needed), then reply `done`. Variants:
`d` = real server, no late tool; `a` = real server, `late_echo` registered during the create call; `b` = server
started with `instructions: ''`.

| Quantity | Runs | Context tokens |
|---|---|---|
| First-turn context, real `instructions` (`d`, `a`) | d1, d2, a1, a2 | 55,049 (all four) |
| First-turn context, no `instructions` (`b`) | b1, b2 | 54,828 (both) |
| Cost of the `WIRETAP_INSTRUCTIONS` text measured (531 chars / 531 bytes) | d minus b | 221 tokens (about 0.42 tokens per character) |
| Context growth from the create result to the final turn, no late tool (`d`) | d1, d2 | 109, 109 |
| Same growth with `late_echo` registered during the call (`a`) | a1, a2 | 207, 207 |
| Cost of one late deferred tool name (a minus d) | | 98 tokens |

- The 98 tokens are the announcement of the new deferred tool as the client reports it; the stream does not contain
  its text, so how much is the name and how much is surrounding wording is INFERRED (not separable here). The M0 figure
  for a tool present at session start was about 12 to 14 tokens each (`docs/PLAN.md` §2.1, R2 and R3), so one late tool
  costs more than that, once.
- Every run shows the same figures for the first turn, so the variation is the model's own output, not the server.
- The instructions text changed after this measurement: the sentence about Wiretap skills was removed because no skill
  ships yet. The 221-token figure refers to the earlier 531-character text; the current text is shorter and was not
  re-measured.

## 3. Session 404 and re-initialize (MEASURED, `c` runs)

Sidecar with `sessions: { idleMs: 3000, sweepMs: 500 }`; the prompt had a `sleep 8` step between two `create_actor`
calls, and a plain one-call run with the call delayed by the client's own startup. Request log (method, status, session
id prefix) from a monkey-patched `http.Server.emit` in the throwaway process.

- Startup: claude first POSTs a 458-byte `server/discover` probe without a session id; the server answers `400`
  (`Mcp-Session-Id header is required`); claude then POSTs `initialize` (`200`, a session is created),
  `notifications/initialized` (`202`) and `tools/list` (`200`).
- The session expired after 3 s idle (`MCP session 341ba93d-... expired after 3000 ms idle`). Claude's GET stream on
  that id returned `404 Session not found`, retried twice, then the next `tools/call` POST on that id returned `404`.
- Right after the 404 claude sent `server/discover` (400), then two `initialize` POSTs (200, two new sessions), the
  `notifications/initialized` POSTs, and re-sent the same `tools/call` on one new session: it returned 200 and the fake
  GM saw `createActor {"name":"Amy"}` (and `Zed` in the single-call run). The tool call result reached the model; the
  run ended `success`.
- The client therefore recovers from an expired session by re-initializing and retrying the call. The unused second
  session from the double initialize stays until idle expiry and counts against the session cap meanwhile.
- One claude run opens several sessions over its life (four session expiries in the log of the `c1` run); the cap of 32
  is counted per session, not per client (MEASURED from the session lines of `c1.log`). At the cap the server now
  refuses a new initialize with `503` and `Retry-After` instead of ending another session; how claude reacts to that
  refusal was not measured.
- A `200` GET appears in the request log right after the expiry log line (`t+5011 ms` in the `c3` run), before the GETs
  that return `404`. INFERRED: it is the GET stream that was already open finishing as the expired session closed,
  because the request log line is written when a response finishes, not when the request arrives. Evidence: the log
  has no GET line for that id before the expiry, which is what an open stream looks like (its line is written only when
  it ends), and every later GET on that id returned `404`. The alternative (a new GET accepted on an expired id) is not excluded by a direct
  measurement.

## Not measured

- Behaviour with the `?endpoint=` query, the pending-call outcome of a session that expires while a tool call
  is in flight, and the behaviour of other MCP clients.
- The two-sessions-per-reconnect pattern is observed, its cause (INFERRED: a parallel connection of the client) is not
  verified.
