# Wiretap — Painless Sidecar Start + Clear Offline State

**Status:** Approved (design)
**Date:** 2026-06-02

## Goal

Keep the single manual step of starting the Wiretap sidecar, but make it **trivial** (a double-clickable
launcher) and make the tab **clearly tell the GM when the sidecar is not running** instead of showing a bare
`disconnected` status and a frozen/empty terminal.

## Background

The sidecar (`server/index.ts`, run today via `npm run server`) is a Node process: a Socket.IO server on
port 31416 that uses `node-pty` to spawn the real terminal (e.g. `claude`) and relays it to the xterm in the
Foundry tab. `node-pty` requires Node, and the Foundry tab runs in a browser sandbox that **cannot spawn a
local OS process** — which is why the sidecar exists as a separate process and why the Launch button cannot
itself start the sidecar. The realistic, chosen outcome is therefore "make the manual start painless," not
"auto-launch from the button" or "retire the sidecar."

**Already satisfied (no work needed):** the tab is GM-only (`OnceReady.js` only calls `connection.connect()`
when `game.user.isGM`), and all settings (`serverUrl`, `terminalCommand`, `terminalTheme`) are `client`-scoped
and localhost-default. The client already connects with `reconnection: true`, so once the sidecar appears the
tab connects automatically — **no manual "retry" control is required.**

## Scope

In scope:
1. A double-clickable launcher script (`start-wiretap.cmd` + `start-wiretap.sh`) that starts the non-watch
   server.
2. A clear offline-state panel in the Wiretap tab (`SidecarOffline.svelte`) shown when the socket is not
   connected.
3. Test + docs updates.

Out of scope (explicitly): auto-starting the sidecar with Foundry; compiling a standalone binary; any change
to tab visibility/GM gating; an in-tab start/stop control; a manual reconnect button.

## Design

### 1. Launcher scripts (repo root)

`start-wiretap.cmd` (Windows, primary):

```bat
@echo off
REM Wiretap sidecar — double-click to start the local terminal bridge. Close this window to stop it.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required but was not found on PATH. & pause & exit /b 1)
if not exist "node_modules" ( echo Installing dependencies... & call npm install )
echo Starting Wiretap sidecar...  (close this window to stop)
call npm run server:start
pause
```

`start-wiretap.sh` (POSIX sibling, for non-Windows / future distribution):

```sh
#!/usr/bin/env sh
# Wiretap sidecar — run to start the local terminal bridge. Ctrl-C to stop it.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is required but was not found on PATH."; exit 1; }
[ -d node_modules ] || { echo "Installing dependencies..."; npm install; }
echo "Starting Wiretap sidecar...  (Ctrl-C to stop)"
exec npm run server:start
```

Behavior / rationale:
- Both invoke the existing **non-watch** `server:start` script (`tsx server/index.ts`), not the dev `server`
  (`tsx watch`).
- `%~dp0` / `dirname "$0"` make the script run from the module folder regardless of the working directory.
- The console window stays open while the server runs; **closing the window (or Ctrl-C) stops the sidecar** —
  this is the stop mechanism. `pause` on Windows keeps the window visible if the server exits/crashes.
- `where node` / `command -v node` give a friendly message instead of a silent failure when Node is absent.
- A missing `node_modules` triggers `npm install` so first-run is one double-click.
- `start-wiretap.sh` must be committed with the executable bit set.

### 2. Clear offline state in the tab

**`Wiretap.svelte` body** — replace the current two-branch body with a three-branch body:

```svelte
{#if !showTerminal}
   <p class="wiretap__popped-out">{game.i18n.localize('WIRETAP.PoppedOut')}</p>
{:else if connection.status === 'connected'}
   <TerminalView />
{:else}
   <SidecarOffline />
{/if}
```

- `showTerminal` (pop-out-takeover) keeps its current precedence: a docked tab whose pop-out is open still
  shows the "popped out" placeholder regardless of connection status.
- When this view is authoritative but the socket is not `connected`, render `SidecarOffline` instead of the
  terminal. The terminal is only mounted while connected (no value in an xterm with no PTY behind it).

**`SidecarOffline.svelte`** (new, single-purpose). Reads the shared `connection` and the `serverUrl` setting;
branches on `connection.status`:
- `connecting` → calm "Connecting to sidecar…" text (this is the normal startup state).
- `disconnected` → "Sidecar not running" heading + instruction: "Double-click `start-wiretap.cmd` in the
  Wiretap module folder. This tab will connect automatically once it's running." + a dim line showing the
  `serverUrl` being attempted.

Plain text only — no copy button (the browser cannot resolve the module's absolute filesystem path) and no
retry button (auto-reconnect handles it). Styling follows the existing centered-placeholder pattern used by
`.wiretap__popped-out`; SCSS class selectors are **nested under `.wiretap`** (e.g. `.wiretap { &__offline {…} }`)
to satisfy the repo's stylelint `selector-class-pattern` kebab rule, matching the convention used by
`TerminalView.svelte`.

**`lang/en.json`** — add under `WIRETAP`:
- `Sidecar.Connecting` — "Connecting to sidecar…"
- `Sidecar.OfflineTitle` — "Sidecar not running"
- `Sidecar.OfflineHint` — "Double-click start-wiretap.cmd in the Wiretap module folder. This tab will connect
  automatically once it's running."
- `Sidecar.Trying` — "Trying {url}" (use `game.i18n.format` with the `serverUrl`).

### 3. Behavior on mid-session sidecar loss

If the sidecar dies while a terminal is open, `connection.status` flips away from `connected`; the body swaps
`TerminalView` → `SidecarOffline` (the on-screen scrollback disappears). When the sidecar is restarted,
socket.io reconnects, status returns to `connected`, `TerminalView` remounts, re-attaches, and replays the
buffered scrollback. This simple swap is preferred over keeping a frozen terminal under an overlay (less code
for a rare case, and clearer messaging).

## Testing

- **`tests/unit/Wiretap.test.js`** (extend the existing suite; keep the xterm mocks and the popped-out test):
  - When `connection.status !== 'connected'` and the view is authoritative, the offline guidance is shown and
    `.wiretap__terminal` is absent. Drive this by setting `connection.status = 'disconnected'`.
  - When `connection.status === 'connected'`, `.wiretap__terminal` is present and the offline guidance is
    absent.
  - The existing "popped-out placeholder while a pop-out is open" test still passes (placeholder takes
    precedence over the offline panel).
  - **Required adjustment to an existing test:** the Task 2 test "still shows the terminal in the pop-out
    itself even when a pop-out is open" asserts `.wiretap__terminal` is present. Because the shared
    `connection` singleton defaults to `status === 'disconnected'`, the new three-branch body would render the
    offline panel instead and that test would fail. The test must set `connection.status = 'connected'` before
    rendering so the terminal branch is taken.
  - `connection` is a shared singleton with `status` as a `$state`; tests set it directly and **reset it in
    `afterEach`** (e.g. back to `'disconnected'`, alongside the existing `popoutState.open = false` reset) to
    avoid cross-test bleed.
  - `SidecarOffline` reads `game.settings.get('wiretap', 'serverUrl')` and uses `game.i18n.format`; confirm the
    unit-test global `game` mock provides both (the suite already stubs `game.i18n.localize` and
    `game.settings.get`). Add a `format` stub if missing.
- **Launcher scripts:** not unit-tested. Manual verification: double-click `start-wiretap.cmd` → window opens,
  server logs "listening on …", the tab transitions from the offline panel to the live terminal on its own.
- Full gate must pass: `npm test && npm run eslint && npm run stylelint && npm run typecheck`, plus
  `npm run build` with the existing leak check.

## Docs

- **README**: add a short "Starting the sidecar" note pointing at `start-wiretap.cmd` (double-click; close the
  window to stop).
- **TODO.md**: tick/extend the relevant terminal-UX item to record the launcher + offline-state work.

## File summary

| File | Change |
|---|---|
| `start-wiretap.cmd` | NEW — Windows double-click launcher (non-watch server) |
| `start-wiretap.sh` | NEW — POSIX sibling launcher (executable bit set) |
| `src/components/SidecarOffline.svelte` | NEW — offline/connecting guidance panel |
| `src/components/Wiretap.svelte` | Three-branch body: popped-out / terminal (connected) / offline |
| `lang/en.json` | NEW `WIRETAP.Sidecar.*` keys |
| `tests/unit/Wiretap.test.js` | Add connected/offline rendering tests |
| `README.md` | "Starting the sidecar" note |
| `TODO.md` | Record launcher + offline-state work |
