# Wiretap — Per-Spec-File Sidecar Isolation (e2e)

**Status:** Approved (design)
**Date:** 2026-06-02

## Goal

Make the **full** `npm run test:e2e` suite reliable by giving each e2e spec **file** a **fresh sidecar**, so
the ConPTY kill/respawn churn is bounded to one file's worth of PTY cycles (reliable — `toolbar.spec` is 25/25
in isolation) instead of accumulating across the whole suite on one shared sidecar.

## Background

`tests/e2e/global-setup.js` currently builds the e2e bundle AND spawns ONE sidecar for the entire Playwright
run (reusing an already-listening one if present), with a global teardown that kills the spawned sidecar. All
specs share that single sidecar. The root-cause e2e flake (inline marker mangled by node-pty Windows
arg-escaping) is already fixed, and per-spec the suite is reliable. The **residual** flake is that running ALL
specs against the one shared sidecar degrades it under cumulative rapid PTY kill/respawn churn (backend-
agnostic; the ConPTY `conpty_console_list` agent crashes on each kill). Resetting the sidecar per spec file
bounds that churn.

The harness runs serially (`workers: 1`, `fullyParallel: false`), so at most one sidecar is needed at a time.

## Design

### Component: `tests/e2e/sidecar.js` (NEW)

Lifts the sidecar process management out of `global-setup.js` into a reusable helper:

- `SIDECAR_PORT = 31416` (must match the default `serverUrl` setting).
- `probePort(port, timeoutMs)` — resolves once the TCP port ACCEPTS a connection (moved from global-setup).
- `waitForPortFree(port, timeoutMs)` — resolves once the port is NOT accepting (so a fresh sidecar can bind).
- `startSidecar()` — `await waitForPortFree(SIDECAR_PORT, 10_000)` (recovers from a crashed prior run), then
  `spawn('npm', ['run', 'server:start'], { cwd: repoRoot, stdio: 'ignore', shell: true, detached: process.platform !== 'win32' })`,
  then `await probePort(SIDECAR_PORT, 30_000)`, and return the child. On Windows the port-free wait does NOT
  kill an occupant (we never kill a process we did not spawn); if the port is still occupied after the
  timeout, throw a clear error ("port 31416 occupied — stop any stray sidecar before running e2e").
- `stopSidecar(child)` — if `child` is null, return. Kill the process tree: Windows `taskkill /PID <pid> /T /F`
  (swallow "already gone"); POSIX `process.kill(-child.pid)` (swallow ESRCH). Then `await waitForPortFree(
  SIDECAR_PORT, 10_000)` so the next file's `startSidecar` can bind. (The new sidecar SIGINT/SIGTERM `dispose()`
  helps on POSIX; on Windows `taskkill /T /F` is ungraceful but reaps the tree.)

`repoRoot` is derived from the file location (`path.resolve(dirname(fileURLToPath(import.meta.url)), '../..')`),
as in the current global-setup.

### Component: `tests/e2e/global-setup.js` (MODIFY)

- KEEP: `execSync('npm run build:e2e', { cwd: repoRoot, stdio: 'inherit' })` (the probe-enabled bundle is
  still built once per run).
- REMOVE: the sidecar `spawn` + `probePort` reuse logic and the returned teardown that kills the sidecar.
- The function returns nothing (no teardown needed) once the sidecar is no longer global. `probePort` moves to
  `sidecar.js`.

### Component: the 4 spec files (MODIFY)

Each of `tests/e2e/smoke.spec.js`, `spawn.spec.js`, `terminal.spec.js`, `toolbar.spec.js` adds a file-scoped
sidecar lifecycle (Playwright `beforeAll`/`afterAll` are per-file):

```js
import { startSidecar, stopSidecar } from './sidecar.js';

let sidecar;
test.beforeAll(async () => {
   sidecar = await startSidecar();
});
test.afterAll(async () => {
   await stopSidecar(sidecar);
});
```

All four specs need a connected sidecar: `smoke`'s "terminal panel" assertion expects the connected branch (a
disconnected tab now shows the offline panel), and `spawn`/`terminal`/`toolbar` launch PTYs. A fresh Foundry
page per test (existing behavior) reconnects to the current sidecar; `openTab` already waits for the toggle to
be enabled ("connected"), so the per-file sidecar is up before any test body runs.

### Data flow / lifecycle

Per run: `global-setup` builds the bundle once. Then per spec file, in order: `beforeAll` → fresh sidecar up →
file's tests run (each with a fresh page) → `afterAll` → sidecar killed + port freed → next file's `beforeAll`.
Foundry itself is launched/reused by Playwright's `webServer` config (unchanged) and is independent of the
sidecar lifecycle.

## Error handling

- `startSidecar`: throws if the port never frees (stray occupant) or never accepts (sidecar failed to boot),
  with actionable messages; Playwright surfaces a `beforeAll` failure as the file's failure.
- `stopSidecar`: tolerant of an already-dead child and a never-bound port (swallow errors); always waits for
  release so the next file is not blocked.
- A Windows `taskkill` on an already-exited PID is caught and ignored (as today).

## Testing / verification

- **Success criterion:** the FULL `npm run test:e2e` passes reliably — run it **3× green** under the portable
  Node 22. Also confirm each spec still passes in isolation (`--repeat-each=3` on `toolbar.spec` stays green).
- No new unit tests (this is harness/process orchestration; it is validated by the e2e run itself).
- `eslint` must stay clean on the changed e2e files.

## File summary

| File | Change |
|---|---|
| `tests/e2e/sidecar.js` | NEW — `startSidecar`/`stopSidecar` + `probePort`/`waitForPortFree` |
| `tests/e2e/global-setup.js` | build the e2e bundle only; remove sidecar spawn/teardown |
| `tests/e2e/smoke.spec.js` | add `beforeAll`/`afterAll` sidecar lifecycle |
| `tests/e2e/spawn.spec.js` | add `beforeAll`/`afterAll` sidecar lifecycle |
| `tests/e2e/terminal.spec.js` | add `beforeAll`/`afterAll` sidecar lifecycle |
| `tests/e2e/toolbar.spec.js` | add `beforeAll`/`afterAll` sidecar lifecycle |
| `TODO.md` | tick the "per-spec sidecar isolation" item; note the full-suite result |

## Out of scope

Parallel workers / multi-port sidecars; reusing a developer's own running sidecar (the e2e owns `:31416`);
changing Foundry's `webServer` lifecycle; the optional Node-LTS pin (separate concern, already noted).
