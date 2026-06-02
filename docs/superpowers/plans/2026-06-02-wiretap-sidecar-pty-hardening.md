# Wiretap — Sidecar PTY Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Project rule:** route `.js`/`.ts`/`.svelte` work to the `foundry-module-dev` contract — dispatch `general-purpose` and have it first invoke skills `svelte-5`, `foundry-vtt`, `foundry-svelte`, then follow `.claude/CLAUDE.md` style (120-char wrap; multi-line objects/arrays >1 entry; typed variables with single-line comments; multi-line JSDoc on functions).
> **Task ownership:** Tasks 1, 2, 4 are standard TDD (subagent-implementable). Tasks 3 (measurement) and 5 (reliability verification) are **controller/human-run** — they execute the e2e under the portable Node 22 and make/confirm the backend decision; do not delegate them to an implementer subagent.

**Goal:** Make the terminal e2e reliable by selecting (via measurement) a stable node-pty Windows backend, and stop the sidecar orphaning its PTY on shutdown.

**Architecture:** A pure `resolvePtyOptions(platform, env)` module picks the Windows PTY backend (overridable via `WIRETAP_PTY_BACKEND`); `terminal.ts` spreads it into `pty.spawn`. A measurement phase runs the e2e under each backend and picks the most-stable default. The terminal manager gains `dispose()`, and `createWiretapServer` kills the PTY + closes the server on SIGINT/SIGTERM.

**Tech Stack:** Node + TypeScript sidecar (tsx, socket.io, node-pty 1.1.0 — N-API, bundles winpty + ConPTY), Vitest, Playwright. Measurements run under portable Node 22 at `%TEMP%\node22\node-v22.12.0-win-x64`.

**Spec:** `docs/superpowers/specs/2026-06-02-wiretap-sidecar-pty-hardening-design.md` (approved).

---

## File structure

| File | Change | Task |
|---|---|---|
| `server/ptyOptions.ts` | NEW — pure `resolvePtyOptions` + `PtyBackend` + `DEFAULT_BACKEND` | 1 |
| `tests/unit/sidecarPty.test.js` | NEW — `resolvePtyOptions` tests (T1); `dispose()` test (T4) | 1, 4 |
| `server/terminal.ts` | use `resolvePtyOptions` in `pty.spawn` (T2); injectable `spawn` + `dispose()` (T4) | 2, 4 |
| `server/__measure-pty.ts` | TEMP throwaway longevity probe (run via tsx; deleted after; NOT committed) | 3 |
| `server/ptyOptions.ts` | set `DEFAULT_BACKEND` to the measured winner | 3 |
| `server/server.ts` | `createWiretapServer` → `{ io, dispose }`; SIGINT/SIGTERM handlers | 4 |
| `TODO.md` | tick the PTY-shutdown + e2e-reliability items; record the chosen backend | 5 |

`server/index.ts` needs **no change** — it ignores `createWiretapServer`'s return value, so the new return shape is compatible.

---

### Task 1: `resolvePtyOptions` pure module (TDD)

**Files:** create `server/ptyOptions.ts`, `tests/unit/sidecarPty.test.js`.

- [ ] **Step 1: Write the failing test** — create `tests/unit/sidecarPty.test.js`:

```js
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolvePtyOptions, DEFAULT_BACKEND } from '../../server/ptyOptions.ts';

describe('resolvePtyOptions', () => {
   it('returns no backend options off Windows', () => {
      expect(resolvePtyOptions('linux', {})).toEqual({});
      expect(resolvePtyOptions('darwin', { WIRETAP_PTY_BACKEND: 'winpty' })).toEqual({});
   });

   it('maps each WIRETAP_PTY_BACKEND value to the right options on Windows', () => {
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'conpty' })).toEqual({});
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'conpty-dll' })).toEqual({ useConptyDll: true });
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'winpty' })).toEqual({ useConpty: false });
   });

   it('falls back to the default backend on an unset or unknown value', () => {
      const expected = resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: DEFAULT_BACKEND });
      expect(resolvePtyOptions('win32', {})).toEqual(expected);
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'bogus' })).toEqual(expected);
   });
});
```

- [ ] **Step 2: Run it to verify it fails.** `npm test -- tests/unit/sidecarPty.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Create `server/ptyOptions.ts`:**

```ts
/**
 * Selects the node-pty Windows backend. node-pty defaults to ConPTY on Win10+, which on this stack
 * intermittently severs long-lived PTYs (the ConPTY-only `conpty_console_list` agent crashes); winpty and the
 * bundled ConPTY DLL are alternatives. The default is chosen by measurement (see the PTY-hardening spec) and
 * overridable via WIRETAP_PTY_BACKEND for measurement and debugging. Pure (no node-pty import) so it is
 * unit-testable without loading the native addon.
 */

/**
 * The selectable Windows PTY backends.
 * @typedef {'conpty' | 'conpty-dll' | 'winpty'} PtyBackend
 */
export type PtyBackend = 'conpty' | 'conpty-dll' | 'winpty';

/**
 * The default Windows backend, set by measurement. 'conpty' is node-pty's own default (no extra options).
 */
export const DEFAULT_BACKEND: PtyBackend = 'conpty';

/**
 * node-pty spawn options per backend (Windows only).
 */
const BACKEND_OPTIONS: Record<PtyBackend, object> = {
   'conpty': {},
   'conpty-dll': { useConptyDll: true },
   'winpty': { useConpty: false },
};

/**
 * Resolve the node-pty Windows backend spawn options.
 * @param platform - The host platform (e.g. process.platform).
 * @param env - The process environment (read for WIRETAP_PTY_BACKEND).
 * @returns The backend spawn options to spread into pty.spawn; {} off Windows.
 */
export function resolvePtyOptions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): object {
   if (platform !== 'win32') {
      return {};
   }
   const requested = env.WIRETAP_PTY_BACKEND;
   const backend: PtyBackend = requested && requested in BACKEND_OPTIONS
      ? (requested as PtyBackend)
      : DEFAULT_BACKEND;
   return BACKEND_OPTIONS[backend];
}
```

- [ ] **Step 4: Run it to verify it passes.** `npm test -- tests/unit/sidecarPty.test.js`. Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck.** `npm run typecheck`. Expected: clean (`tsc -p server/tsconfig.json`).

- [ ] **Step 6: Commit:**
```bash
git add server/ptyOptions.ts tests/unit/sidecarPty.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat(sidecar): add resolvePtyOptions backend selector (pure, env-overridable)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: wire the backend into `pty.spawn`

**Files:** modify `server/terminal.ts`.

- [ ] **Step 1: Import the resolver.** Add below the existing `node-pty`/`socket.io` imports (top of `server/terminal.ts`):
```ts
import { resolvePtyOptions } from './ptyOptions.ts';
```

- [ ] **Step 2: Spread the backend options into the spawn.** In `launch()`, change the existing `pty.spawn` call:
```ts
      const child = pty.spawn(file, args, {
         name: 'xterm-color',
         cols: size.cols,
         rows: size.rows,
         cwd: process.cwd(),
         env: process.env as { [key: string]: string },
      });
```
to:
```ts
      const child = pty.spawn(file, args, {
         name: 'xterm-color',
         cols: size.cols,
         rows: size.rows,
         cwd: process.cwd(),
         env: process.env as { [key: string]: string },
         ...resolvePtyOptions(process.platform, process.env),
      });
```
(With `DEFAULT_BACKEND = 'conpty'` and no env override, `resolvePtyOptions` returns `{}`, so this is a no-op change in behavior — it just enables the knob.)

- [ ] **Step 3: Typecheck.** `npm run typecheck`. Expected: clean.

- [ ] **Step 4: Unit tests still pass.** `npm test`. Expected: all pass (no behavior change).

- [ ] **Step 5: Commit:**
```bash
git add server/terminal.ts
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat(sidecar): select PTY backend via resolvePtyOptions in spawn\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: MEASURE backends, decide, apply the winner — **CONTROLLER-RUN**

**Files:** create+delete `server/__measure-pty.ts` (throwaway, not committed); modify `server/ptyOptions.ts` (set `DEFAULT_BACKEND`).

This task is run by the controller under the portable Node 22 (`$env:PATH = "C:\Users\emper\AppData\Local\Temp\node22\node-v22.12.0-win-x64;$env:PATH"`). It is investigation + a one-line decision, not a delegated TDD task.

- [ ] **Step 1: Create the throwaway longevity probe** `server/__measure-pty.ts`:
```ts
import * as pty from 'node-pty';
import { resolvePtyOptions } from './ptyOptions.ts';

const cmd = 'node -e "process.stdout.write(\'M\'); setInterval(() => process.stdout.write(\'.\'), 300)"';
const spawn = process.platform === 'win32'
   ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/c', cmd] }
   : { file: '/bin/sh', args: ['-c', cmd] };
const child = pty.spawn(spawn.file, spawn.args, {
   name: 'xterm-color',
   cols: 80,
   rows: 24,
   cwd: process.cwd(),
   env: process.env as { [key: string]: string },
   ...resolvePtyOptions(process.platform, process.env),
});
let exited = false;
child.onExit(({ exitCode }) => {
   exited = true;
   console.log(`SPURIOUS-EXIT code=${exitCode}`);
});
setTimeout(() => {
   console.log(exited ? 'RESULT: exited early (BAD)' : 'RESULT: survived 90s (GOOD)');
   try { child.kill(); } catch { /* already gone */ }
   process.exit(0);
}, 90_000);
```

- [ ] **Step 2: Longevity probe per backend.** For each `B` in `conpty`, `conpty-dll`, `winpty`:
  `$env:WIRETAP_PTY_BACKEND="B"; npx tsx server/__measure-pty.ts` (run 2× each). Record GOOD/BAD.

- [ ] **Step 3: e2e flake rate per backend.** Ensure no sidecar is running. For each `B`:
  `$env:WIRETAP_PTY_BACKEND="B"; npx playwright test toolbar.spec.js --repeat-each=5 --reporter=line` — run it
  **3×**. Record pass/fail counts (out of 25 per run). (`global-setup` spawns the sidecar; it inherits
  `WIRETAP_PTY_BACKEND` from the env.)

- [ ] **Step 4: Decide the winner.** Lowest e2e flake + GOOD longevity. On a tie, prefer fidelity order
  `conpty` > `conpty-dll` > `winpty`. **If the winner is `winpty`, PAUSE and ask the user to run `claude` in
  the tab for ~1 minute** (colors, full-screen redraw, resize) — adopt winpty only if the TUI is acceptable;
  otherwise take the next-best backend. Record the numbers for the commit message.

- [ ] **Step 5: Apply the winner.** If the winner is not `conpty`, edit `server/ptyOptions.ts`:
  change `export const DEFAULT_BACKEND: PtyBackend = 'conpty';` to the chosen backend. (If `conpty` somehow
  wins — unlikely given the flake — leave it and note that the env override remains available.)

- [ ] **Step 6: Delete the throwaway probe.** `rm -f server/__measure-pty.ts`. Confirm `git status` shows only
  `server/ptyOptions.ts` (if changed). The unit test from Task 1 still passes because it asserts against
  `DEFAULT_BACKEND` (whatever its value).

- [ ] **Step 7: Sanity + commit.** `npm test` (the `resolvePtyOptions` fallback test tracks `DEFAULT_BACKEND`,
  still green) and `npm run typecheck`. Then:
```bash
git add server/ptyOptions.ts
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat(sidecar): default PTY backend to <WINNER> (measured most stable)\n\n<paste measurement numbers: per-backend e2e pass counts + longevity>\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```
(If `conpty` wins and nothing changes, skip the commit and note it in the Task 5 report.)

---

### Task 4: clean shutdown — `dispose()` + signal handlers (TDD)

**Files:** modify `server/terminal.ts`, `server/server.ts`, `tests/unit/sidecarPty.test.js`.

- [ ] **Step 1: Write the failing test** — append to `tests/unit/sidecarPty.test.js` (the file already has the
  `// @vitest-environment node` directive and the `resolvePtyOptions` suite; add these imports at the top with
  the existing import, and the new `describe` at the end):

  Add to the imports:
```js
import { createTerminalManager } from '../../server/terminal.ts';
import { TERMINAL_LAUNCH } from '$shared/protocol.js';
import { vi } from 'vitest';
```
  Add the suite:
```js
describe('terminal manager dispose', () => {
   it('kills the active PTY and is idempotent', () => {
      const child = {
         onData: vi.fn(),
         onExit: vi.fn(),
         write: vi.fn(),
         resize: vi.fn(),
         kill: vi.fn(),
      };
      const spawn = vi.fn(() => child);
      const io = { emit: vi.fn() };
      const handlers = {};
      const socket = {
         emit: vi.fn(),
         on: (event, fn) => {
            handlers[event] = fn;
         },
      };
      const manager = createTerminalManager(io, spawn);
      manager.handleConnection(socket);
      handlers[TERMINAL_LAUNCH]({ command: 'x', cols: 80, rows: 24 });
      expect(spawn).toHaveBeenCalledTimes(1);

      manager.dispose();
      expect(child.kill).toHaveBeenCalledTimes(1);
      // A second dispose is a safe no-op (the term is already cleared).
      manager.dispose();
      expect(child.kill).toHaveBeenCalledTimes(1);
   });
});
```
  (Note: merge the `vi` import into the existing `import { describe, it, expect } from 'vitest';` line rather
  than duplicating — make it `import { describe, it, expect, vi } from 'vitest';`.)

- [ ] **Step 2: Run it to verify it fails.** `npm test -- tests/unit/sidecarPty.test.js`. Expected: FAIL
  (`createTerminalManager` takes one arg / `manager.dispose is not a function`).

- [ ] **Step 3: Add the injectable spawner + `dispose()` in `server/terminal.ts`.**
  (a) Change the manager signature and return type. The current signature is:
```ts
export function createTerminalManager(io: Server): { handleConnection: (socket: Socket) => void } {
```
  Change it to:
```ts
export function createTerminalManager(
   io: Server,
   spawn: typeof pty.spawn = pty.spawn,
): { handleConnection: (socket: Socket) => void; dispose: () => void } {
```
  (b) In `launch()`, change `const child = pty.spawn(file, args, {` to `const child = spawn(file, args, {`
  (use the injected `spawn`; the spread of `resolvePtyOptions(...)` from Task 2 stays).
  (c) Add a `dispose` method to the returned object (after `handleConnection`):
```ts
      dispose(): void {
         term?.kill();
         term = null;
         scrollback = '';
      },
```

- [ ] **Step 4: Run it to verify it passes.** `npm test -- tests/unit/sidecarPty.test.js`. Expected: PASS
  (4 tests total in the file).

- [ ] **Step 5: Wire shutdown in `server/server.ts`.** Replace the whole file with:
```ts
import { Server } from 'socket.io';
import { createTerminalManager } from './terminal.ts';

/**
 * Create and start a Wiretap sidecar Socket.IO server with the terminal relay attached, and register
 * SIGINT/SIGTERM handlers that kill the PTY and close the server so the PTY child does not orphan.
 * @param port - The TCP port to listen on (0 selects an ephemeral port, used by tests).
 * @returns The started server and a dispose function that kills the PTY and closes the server.
 */
export function createWiretapServer(port: number): { io: Server; dispose: () => void } {
   const io = new Server(port, {
      cors: {
         origin: 'http://localhost:30000',
      },
   });

   const terminal = createTerminalManager(io);

   io.on('connection', (socket) => {
      console.log(`Wiretap sidecar | client connected: ${socket.id}`);
      terminal.handleConnection(socket);
      socket.on('disconnect', (reason) => {
         console.log(`Wiretap sidecar | client disconnected: ${socket.id} (${reason})`);
      });
   });

   /**
    * Tear down the sidecar: kill any running PTY, then close the Socket.IO server.
    * @returns Nothing.
    */
   function dispose(): void {
      terminal.dispose();
      io.close();
   }

   // Kill the PTY and close the server on a graceful termination signal so the PTY child does not orphan.
   // (Windows console-window-close sends CTRL_CLOSE_EVENT, which Node cannot reliably trap; Ctrl-C, `kill`,
   // and the e2e teardown are covered.)
   process.once('SIGINT', () => {
      dispose();
      process.exit(0);
   });
   process.once('SIGTERM', () => {
      dispose();
      process.exit(0);
   });

   return { io, dispose };
}
```
  (`server/index.ts` is unchanged — it ignores the return value.)

- [ ] **Step 6: Full gate.** `npm test && npm run eslint && npm run stylelint && npm run typecheck`. Expected:
  all pass. (The new server test runs in the node env; `eslint`/`stylelint` cover the JS/SCSS as before.)

- [ ] **Step 7: Commit:**
```bash
git add server/terminal.ts server/server.ts tests/unit/sidecarPty.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat(sidecar): dispose() + SIGINT/SIGTERM teardown so the PTY does not orphan\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: verify reliability bar + TODO — **CONTROLLER-RUN**

**Files:** modify `TODO.md`.

- [ ] **Step 1: Reliability bar (under Node 22).** With the winning backend as the default and no env override
  set: run `npx playwright test toolbar.spec.js` as a single run **3× in a row** (expect 5/5 each), then once
  with `--repeat-each=5` (expect 25/25). Record the results. If 0 flakes → bar met. If residual flakes remain,
  record the rate honestly (the backend reduced but did not eliminate it).

- [ ] **Step 2: Restore the production build.** `global-setup` ran `build:e2e`, overwriting root `index.js`.
  `npm run build` and `rm -f registerProbe-*.js registerProbe-*.js.map "TerminalConnection.svelte-"*.js "TerminalConnection.svelte-"*.js.map`,
  then leak check: `node -e "const s=require('fs').readFileSync('index.js','utf8');['node-pty','registerProbe'].forEach(t=>{if(s.includes(t))throw new Error('leak: '+t)});console.log('OK')"` → `OK`.
  Confirm `git status` shows only `TODO.md`.

- [ ] **Step 3: Update `TODO.md`.** Under `## Carried-over cleanups`, tick the PTY-shutdown item and the
  e2e-reliability item, recording the chosen backend and outcome, e.g. change:
```markdown
- [ ] Sidecar: kill a running PTY on server shutdown (expose `dispose()`; today a PTY orphans on SIGTERM)
```
  to:
```markdown
- [x] Sidecar: kill a running PTY on server shutdown — `dispose()` + SIGINT/SIGTERM teardown (CTRL_CLOSE on Windows still uncatchable)
```
  and update the `e2e reliability` line to record the measured winner and the residual flake rate (met / rate).

- [ ] **Step 4: Commit:**
```bash
git add TODO.md
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'docs: record PTY-shutdown fix + measured e2e-stable backend in TODO\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 5: Report** the measurement table (per-backend e2e pass counts + longevity), the chosen default,
  whether the reliability bar was met (or the residual rate), and the shutdown behavior. Do not overstate — if
  the bar was not fully met, say so.

---

## Self-review

**Spec coverage:** pure `resolvePtyOptions` + `PtyBackend`/`DEFAULT_BACKEND` (T1, spec A1); wired into spawn
(T2, A1); measurement protocol — longevity probe + e2e matrix + decision criteria + manual winpty check (T3,
A2/A3); apply winner as default (T3, A4); `dispose()` + SIGINT/SIGTERM + `{io,dispose}` return (T4, Part B);
unit tests `resolvePtyOptions` (T1) and `dispose()` (T4) in a node-env file (spec Testing); reliability bar +
honest reporting (T5, Verification); TODO + chosen-backend record (T5). `server/index.ts` no-change is noted.
The throwaway probe is created+deleted in T3 (not committed).

**Placeholder scan:** none — all code blocks are concrete. `<WINNER>` / `<paste measurement numbers>` in T3's
commit message are intentional fill-ins produced by the measurement, not unspecified logic.

**Type/name consistency:** `resolvePtyOptions(platform, env)`, `DEFAULT_BACKEND`, `PtyBackend`, and
`BACKEND_OPTIONS` are defined in T1 and reused in T2/T3 and the probe identically. `createTerminalManager(io,
spawn = pty.spawn)` (T4) matches the dispose test's `createTerminalManager(io, spawn)` call (T4 Step 1) and
keeps the existing single-arg call in `server.ts` working (default param). `createWiretapServer` returns
`{ io, dispose }` (T4) and `index.ts` ignores it (no change). `WIRETAP_PTY_BACKEND` values (`conpty`,
`conpty-dll`, `winpty`) are consistent across the resolver, tests, probe, and measurement commands. The
node-env test imports `$shared/protocol.js` (existing vitest alias) for `TERMINAL_LAUNCH`.

**Risk note:** the node-env unit test imports `server/terminal.ts`, which loads the native `node-pty` addon;
this works in Node (vitest runs in Node even under happy-dom elsewhere), but if the addon fails to load under
vitest, the implementer should report it — the `dispose()` logic is trivial and could fall back to e2e/manual
coverage. The `spawn` default param keeps production behavior identical; only tests inject a fake.
