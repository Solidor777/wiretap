# Wiretap AI Bridge — Sub-project #2: Claude Code Terminal Relay

**Date:** 2026-06-01
**Status:** Approved (design); pending implementation plan
**Scope:** Turn the Wiretap tab into a PTY-backed terminal that mirrors an interactive `claude` session running on the sidecar. No AI calls from Wiretap itself.

## 0. Context: a deliberate pivot

The original bridge plan (sub-projects #2–#6) had the sidecar **embed the Claude Agent SDK** and forward chat
programmatically. Brainstorming surfaced a decisive constraint: on a Claude Pro/Max **subscription**, all
*programmatic* paths (Agent SDK, `claude -p`, message-forwarding products) are funneled into a separate,
capped **$200/mo "Agent SDK credit"** (effective June 15, 2026) under Commercial Terms — they cannot ride the
generous *interactive* subscription pool, by design. The user wants subscription-backed usage, not
pay-per-token and not the capped credit.

**Resolution — Wiretap becomes a terminal relay, not an AI client.** The sidecar spawns an **interactive
`claude` in a pseudo-terminal (PTY)**; the Foundry tab is a **terminal emulator** (`xterm.js`) that streams
the PTY's output and sends keystrokes back. Wiretap **never calls Anthropic** — it pipes bytes between a PTY
and a browser, exactly like a web terminal (ttyd/wetty/VS Code terminal). The `claude` inside is the user's
ordinary **interactive** session (same as running it in any terminal/tmux/SSH), so:

- rides the **interactive subscription pool** (not the $200 credit), fully sanctioned human-in-the-loop use;
- no Agent SDK, no API key, no programmatic/ToS exposure for Wiretap;
- full Claude Code power (whatever MCP/tools the user's `claude` already uses — e.g. to create actors).

**What this supersedes:** the Agent-SDK engine decision and the old #3–#6 (tools/permissions/auth) largely
dissolve — "the agent acts on Foundry" is delegated to the user's own Claude Code. A dedicated Foundry
tool-set, if ever wanted, would be a separate MCP server the user's `claude` connects to, independent of this
relay.

**Parked (not chosen):** a fully *structured* chat UI (Remote-Control-style bubbles/tool-cards) requires a
structured output stream, available only in headless/programmatic mode → reintroduces the $200-credit /
Commercial-Terms position. Reconstructing it by scraping the interactive TUI is fragile/high-maintenance.
Deferred as a future option, not the foundation.

## 1. Goal

A **Launch/Close** toggle in the Wiretap tab spawns/kills an interactive `claude` in a PTY on the sidecar; the
tab is a themed `xterm.js` terminal that streams output and sends input, reattaching across Foundry reloads.

## 2. Decisions (locked in brainstorming)

- **PTY command:** launch `claude` **directly** (configurable via a `terminalCommand` setting; default `claude`).
- **Lifecycle:** a **toggle button**, **default closed** — click launches the PTY, click again kills it.
- **Persistence:** a launched session **persists on the sidecar across tab close / Foundry reload**; reconnect
  **reattaches** and replays scrollback. Explicit Close (or process exit) ends it.
- **Front-end:** a real terminal emulator — **`xterm.js`** (+ fit addon), **bundled into the browser build**
  (xterm is not provided by Foundry, so it adds bundle weight — accepted).
- **Transport:** reuse #1's socket.io channel; the echo handler is replaced by terminal events.
- **Security:** sidecar binds **localhost only**; the module connects/enables only for **GM** users.
- **Engine library:** **`node-pty`** (Windows ConPTY).

## 3. Components

### 3.1 Sidecar — `server/`
- Add dependency **`node-pty`** (native module; prebuilt binaries / build step — install consideration).
- **`server/terminal.ts`** (replaces `echo.ts`): a terminal manager that
  - on `terminal:launch {command?, cols, rows}` → spawns the command (default `claude`, from setting/env) in a
    PTY at the given size; tracks the single active PTY;
  - streams PTY output as `terminal:data {chunk}` **broadcast to all connected sockets** (so the docked tab and
    its pop-out mirror the same session);
  - maintains a **scrollback ring buffer** (~64 KB) of recent output for reattach;
  - on `terminal:input {data}` → writes to PTY stdin; on `terminal:resize {cols, rows}` → resizes the PTY;
    on `terminal:close` → kills the PTY; on PTY exit → emits `terminal:exit {code, signal?}`;
  - on each socket (re)connect → emits `terminal:state {running, cols?, rows?}`, and if running replays the
    scrollback buffer (then live data resumes).
- Single PTY per sidecar (single-GM assumption). Windows: `claude` resolution may route through the shell or
  need an explicit path — handled in the plan; the `terminalCommand` setting allows a full path.
- `server/server.ts` swaps `registerEcho` for the terminal manager wiring; `server/index.ts` unchanged.

### 3.2 Shared wire contract — `shared/protocol.js`
Replace the echo constant/typedefs with terminal event names + typedefs:
- Client→server: `TERMINAL_LAUNCH` (`{command?: string, cols: number, rows: number}`), `TERMINAL_INPUT`
  (`{data: string}`), `TERMINAL_RESIZE` (`{cols: number, rows: number}`), `TERMINAL_CLOSE`.
- Server→client: `TERMINAL_DATA` (`{chunk: string}`), `TERMINAL_STATE` (`{running: boolean, cols?: number,
  rows?: number}`), `TERMINAL_EXIT` (`{code: number|null, signal?: string}`).

### 3.3 Browser module
- Add deps **`@xterm/xterm`** + **`@xterm/addon-fit`** (and import `@xterm/xterm/css/xterm.css`).
- **`src/bridge/TerminalConnection.svelte.js`** (evolves from `WiretapConnection`): reactive `$state` for
  `status` (socket: from #1) and `running` (PTY state); methods `launch(cols, rows)`, `close()`,
  `sendInput(data)`, `resize(cols, rows)`; subscribes to `TERMINAL_DATA`/`TERMINAL_STATE`/`TERMINAL_EXIT` and
  exposes an output callback the component feeds to xterm.
- **`src/components/Wiretap.svelte`**: replace the chat UI with a **toolbar** (Launch/Close toggle bound to
  `running`, connection badge bound to `status`, Clear, Reconnect) + a **mounted `xterm.js` terminal**. Wiring:
  `TERMINAL_DATA` → `term.write(chunk)`; `term.onData` → `sendInput`; fit-addon resize → `resize`; on mount
  with a running session, the replayed scrollback paints the terminal.
- New client setting **`terminalCommand`** (`scope: 'client'`, default `'claude'`); `serverUrl` retained.

## 4. Data flow & lifecycle

1. Tab opens (GM) → socket connects (from #1) → sidecar emits `TERMINAL_STATE {running}`. If already running,
   scrollback is replayed → terminal shows the live session. If not, the toolbar shows **Launch**.
2. **Launch** → `TERMINAL_LAUNCH {command, cols, rows}` → sidecar spawns the PTY → `TERMINAL_STATE
   {running:true}` + streamed `TERMINAL_DATA`.
3. User types → `term.onData` → `TERMINAL_INPUT` → PTY stdin → `claude` reacts → `TERMINAL_DATA` → `term.write`.
4. Panel/window resize → fit addon → `TERMINAL_RESIZE` → `pty.resize` → `claude` TUI reflows.
5. Foundry reload / tab close → socket drops, **PTY keeps running**. Reopen → reconnect → `TERMINAL_STATE
   {running:true}` + scrollback replay → reattached.
6. **Close** (or `claude` exits) → PTY killed / `TERMINAL_EXIT` → `running:false`, toolbar shows **Launch**.

## 5. Security

- Sidecar binds **localhost only** — players' browsers (other machines) cannot reach it; only the GM's own
  machine can. The module gates connect/launch on `game.user.isGM`.
- A PTY relay is effectively remote code execution on the GM's host; localhost + GM gating is the boundary. An
  optional shared-secret handshake is noted as a future hardening, not in #2.

## 6. Error handling

- **Spawn failure** (e.g. `claude` not on PATH) → sidecar catches, emits `TERMINAL_EXIT {code}` (or a state with
  an error flag) so the tab shows the failure instead of a dead terminal; the `terminalCommand` setting lets the
  user point at an explicit path.
- **PTY process exit** (user quits `claude`) → `TERMINAL_EXIT` → toolbar returns to **Launch**.
- **Socket drop** → PTY persists; reconnect reattaches (scrollback replay). Reattach fidelity for a full-screen
  TUI is best-effort (a resize nudge prompts `claude` to repaint); flagged, acceptable.
- **Multiple clients** (docked tab + pop-out) share the one PTY: output broadcast to all, input accepted from any.

## 7. Testing

- **Unit** (vitest, happy-dom): `TerminalConnection` state machine (closed → launching → running → closed, and
  reattach to a running session) using an injected fake socket; assert events map to state and method calls emit
  the right protocol events.
- **Integration** (vitest, node): the sidecar terminal manager spawns a **deterministic throwaway** PTY command
  (e.g. `node -e "process.stdout.write('hello')"` — NOT `claude`); a socket client asserts `TERMINAL_DATA`
  carries the output, `TERMINAL_INPUT` reaches the process, `TERMINAL_STATE` reflects running, and
  `TERMINAL_CLOSE`/exit tears down. Uses real `node-pty`.
- **Manual:** Launch `claude` in the tab; confirm full interactivity (run it as today, including creating an
  actor); reload Foundry → reattach with scrollback; resize → reflow; Close → ends. xterm rendering is verified
  manually.

## 8. Out of scope

Structured chat UI (parked, §0); Foundry tools/MCP (delegated to the user's `claude`); Anthropic auth (the
user's `claude` login handles it); multi-user/multi-session PTYs; shared-secret hardening.

## 9. Definition of done

Click **Launch** → `claude` runs fully interactively in the themed tab terminal (and can do what it does today,
e.g. create actors); **reload Foundry → the terminal reattaches** to the live session with scrollback; resize
reflows the TUI; **Close** ends the session; unit + integration tests pass; `npm run build`, eslint, stylelint,
and typecheck stay green; the browser bundle gains `xterm.js` but **not** `node-pty`/socket.io server code.
