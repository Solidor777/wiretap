# Wiretap — Sidecar PTY Hardening (stability + clean shutdown)

**Status:** Approved (design)
**Date:** 2026-06-02

## Goal

Make the terminal e2e suite reliable by eliminating the intermittent PTY death, and stop the sidecar from
orphaning its PTY child on shutdown. Two independent parts: a measured PTY-backend selection (Part A) and a
clean-shutdown path (Part B).

## Background

The Wiretap sidecar (`server/terminal.ts`) spawns one `node-pty` PTY and relays it over Socket.IO. On Windows,
node-pty defaults to the **ConPTY** backend, which on this machine (Node 25; somewhat better but not fixed on
Node 22) intermittently severs long-lived PTYs — `child.onExit` fires while the child is still alive, so
`connection.running` flips false and the terminal controls disable. The ConPTY-only helper
`conpty_console_list_agent.js` also throws `AttachConsole failed` (the recurring stderr trace). This flakes
every terminal e2e (`toolbar.spec.js`, and the pre-existing `terminal.spec.js` pop-out tests on a clean
checkout) and could, in principle, kill a long real `claude` session.

node-pty 1.1.0 exposes spawn options `useConpty?: boolean` and `useConptyDll?: boolean`, and bundles both
backends' binaries (`winpty-agent.exe`/`winpty.dll` and `conpty.node`/`conpty_console_list.node`), so any
backend choice works with no install or rebuild. The crashing console-list agent is ConPTY-specific; winpty
avoids it entirely.

Separately, the sidecar registers no shutdown handler, so a `SIGINT`/`SIGTERM`/`exit` leaves the spawned PTY
child orphaned (the long-standing TODO: "kill a running PTY on server shutdown; today a PTY orphans on
SIGTERM").

## Part A — PTY backend selection (decided by measurement)

### A1. Backend knob

The backend options are computed by a small **pure** helper in its OWN module `server/ptyOptions.ts` (no
`node-pty` import), so it is unit-testable without loading the native addon. `terminal.ts` imports it and
spreads the result into `pty.spawn`:

```ts
// server/ptyOptions.ts
export type PtyBackend = 'conpty' | 'conpty-dll' | 'winpty';

/**
 * Resolve the node-pty Windows backend options. Reads WIRETAP_PTY_BACKEND when set (used to measure
 * backends); otherwise returns the chosen default. Returns {} off Windows.
 */
export function resolvePtyOptions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): object { ... }
```

- Off Windows → `{}` (no backend options; POSIX uses its single pty).
- On Windows, the backend is selected by `env.WIRETAP_PTY_BACKEND` (`conpty` | `conpty-dll` | `winpty`) when
  set, else the **chosen default** (see A3). Mapping: `conpty` → `{}`; `conpty-dll` → `{ useConptyDll: true }`;
  `winpty` → `{ useConpty: false }`. An unrecognized value falls back to the default.
- `launch()` spreads the result into the existing `pty.spawn(file, args, { name, cols, rows, cwd, env, ... })`.

### A2. Measurement protocol

Run under the portable Node 22 (`%TEMP%\node22\...`, PATH-prefixed). For each backend
(`conpty`, `conpty-dll`, `winpty`), set `WIRETAP_PTY_BACKEND` and:

1. **e2e flake rate:** run `npx playwright test toolbar.spec.js --repeat-each=5` (one shared sidecar = worst
   case) **three times**; record pass/fail counts (15 runs × 3 = 45 datapoints per backend).
2. **Longevity probe:** a throwaway script (`server/__measure-pty.mjs`, deleted after) spawns one PTY running
   the marker command for ~90s and logs whether `onExit` fires spuriously. Run once per backend.

Record the numbers in the implementation notes (and the commit message / TODO update).

### A3. Decision criteria

Pick the backend with the lowest flake rate. When two are comparably stable, prefer the higher-fidelity one
in this order: `conpty` > `conpty-dll` > `winpty` (so we keep ConPTY-class fidelity for the `claude` TUI when
possible). **If the winner is `winpty`, do a manual `claude` TUI sanity check first** (user runs `claude` in
the tab ~1 min: colors, full-screen redraw, resize) — only adopt winpty as the default if the TUI is
acceptable. The chosen backend becomes the `resolvePtyOptions` default.

### A4. Apply

Set the chosen default in `resolvePtyOptions`. Keep `WIRETAP_PTY_BACKEND` as a documented escape hatch (it is
the measurement mechanism and a future-debugging aid).

## Part B — Clean shutdown (the TODO)

- `createTerminalManager(io)` returns `{ handleConnection, dispose }`. `dispose()` kills the active PTY (if
  any) and nulls the manager's `term`/scrollback state, idempotently.
- `createWiretapServer(port)` wires shutdown: it registers `process.once('SIGINT', ...)` and
  `process.once('SIGTERM', ...)` handlers that call `terminal.dispose()`, then `io.close()`, then
  `process.exit(0)`. It returns `{ io, dispose }` so `index.ts` (and tests) can trigger teardown explicitly.
- `index.ts` logs listening as today; no behavior change beyond receiving the new return shape.
- **Windows caveat (documented, not solvable here):** a hard console-window close sends `CTRL_CLOSE_EVENT`,
  which Node cannot reliably trap, so Ctrl-C / `kill` / programmatic dispose are covered but a forced
  window-close may still leave the child for the OS to reap. The e2e teardown already uses `taskkill /T`.

## Verification & testing

- **Reliability bar (definition of "solid"):** after applying the winner, `toolbar.spec.js` passes a single
  run cleanly **3× in a row** AND a `--repeat-each=5` batch with **0 flakes**. If no backend reaches 0, report
  the residual rate honestly and pick the lowest.
- **Unit tests** (`tests/unit/`, vitest). The existing unit env is happy-dom with `conditions: ['browser']`;
  to avoid resolution surprises with the native `node-pty`, the server test file declares the node env via a
  top-of-file `// @vitest-environment node` comment.
  - `resolvePtyOptions` (imports only the pure `server/ptyOptions.ts`, so env is irrelevant): returns `{}` off
    Windows; maps each `WIRETAP_PTY_BACKEND` value (`conpty`→`{}`, `conpty-dll`→`{useConptyDll:true}`,
    `winpty`→`{useConpty:false}`) on `win32`; falls back to the default on an unset/unknown value. Pure
    function — pass `platform`/`env` explicitly; no real spawn.
  - `dispose()`: `createTerminalManager(io, spawn)` takes an injectable `spawn` (defaulting to `pty.spawn`);
    the test injects a fake returning a fake child with a `kill` spy, drives a launch, calls `dispose()`, and
    asserts `kill` was called and that a second `dispose()` is a safe no-op. (This test imports `terminal.ts`,
    hence the node environment.)
- **Server typecheck:** `npm run typecheck` (`tsc -p server/tsconfig.json`) stays clean.
- The backend choice itself is validated by the e2e measurement, not unit tests.

## File summary

| File | Change |
|---|---|
| `server/ptyOptions.ts` | NEW — pure `resolvePtyOptions(platform, env)` + `PtyBackend` type (no node-pty import) |
| `server/terminal.ts` | import + use `resolvePtyOptions` in `pty.spawn`; `dispose()` on the manager; injectable `spawn` param for tests |
| `server/server.ts` | `createWiretapServer` registers SIGINT/SIGTERM → dispose + close; returns `{ io, dispose }` |
| `server/index.ts` | consume the new return shape (no behavior change) |
| `server/__measure-pty.mjs` | TEMP throwaway longevity probe (deleted after measurement; not committed) |
| `tests/unit/sidecarPty.test.js` | NEW — `resolvePtyOptions` + `dispose()` unit tests (`// @vitest-environment node`) |
| `TODO.md` | tick the sidecar PTY-shutdown item + the e2e-reliability item; record the chosen backend |

## Out of scope

Catching `CTRL_CLOSE_EVENT` on Windows; reworking the relay protocol; multi-PTY support; changing the
client. The `claude` TUI fidelity check is manual (no automated TUI-rendering assertions).
