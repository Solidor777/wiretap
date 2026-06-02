# Wiretap — Per-Spec-File Sidecar Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Project rule:** `.js` test-harness work — the implementer should follow `.claude/CLAUDE.md` style (120-char wrap; multi-line objects/arrays >1 entry; typed variables with single-line comments; multi-line JSDoc on functions).
> **Task ownership:** Task 1 is a standard implementation task (subagent — write harness JS + eslint; no live e2e run). Task 2 is **controller/human-run** — it runs the full e2e suite under the portable Node 22 to verify reliability.

**Goal:** Give each e2e spec file its own fresh sidecar so the full `npm run test:e2e` is reliable (bounds the ConPTY kill/respawn churn to one file).

**Architecture:** Lift the sidecar process management out of `global-setup.js` into a reusable `tests/e2e/sidecar.js` (`startSidecar`/`stopSidecar` + port helpers). `global-setup.js` only builds the e2e bundle. Each spec file adds a file-scoped `beforeAll`(start)/`afterAll`(stop) so the sidecar is fresh per file. Playwright runs serially (`workers: 1`), so one sidecar at a time.

**Tech Stack:** Playwright, Node child_process, the existing `npm run server:start` sidecar (tsx + socket.io + node-pty). Verification runs under portable Node 22 at `%TEMP%\node22\node-v22.12.0-win-x64`.

**Spec:** `docs/superpowers/specs/2026-06-02-wiretap-e2e-per-spec-sidecar-design.md` (approved).

---

## File structure

| File | Change | Task |
|---|---|---|
| `tests/e2e/sidecar.js` | NEW — `startSidecar`/`stopSidecar` + `probePort`/`waitForPortFree` | 1 |
| `tests/e2e/global-setup.js` | build the e2e bundle only; remove the sidecar spawn/teardown | 1 |
| `tests/e2e/smoke.spec.js` | add the per-file sidecar lifecycle | 1 |
| `tests/e2e/spawn.spec.js` | add the per-file sidecar lifecycle | 1 |
| `tests/e2e/terminal.spec.js` | add the per-file sidecar lifecycle | 1 |
| `tests/e2e/toolbar.spec.js` | add the per-file sidecar lifecycle | 1 |
| `TODO.md` | tick the per-spec-isolation item; record the full-suite result | 2 |

---

### Task 1: per-spec sidecar lifecycle (harness)

This is one atomic change — the helper, the global-setup refactor, and all four spec wirings must land together (between them the suite would be broken: global-setup stops spawning the sidecar, so the specs must start their own). No unit tests (process orchestration is validated by the e2e run in Task 2). The implementer writes the code and runs `eslint` only — **do NOT run the Playwright e2e suite** (the controller runs it in Task 2).

**Files:** create `tests/e2e/sidecar.js`; modify `tests/e2e/global-setup.js`, `tests/e2e/smoke.spec.js`, `tests/e2e/spawn.spec.js`, `tests/e2e/terminal.spec.js`, `tests/e2e/toolbar.spec.js`.

- [ ] **Step 1: Create `tests/e2e/sidecar.js`:**
```js
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, derived from this file's location (tests/e2e/sidecar.js).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The sidecar port (must match the default `serverUrl` setting).
const SIDECAR_PORT = 31416;

/**
 * Poll a TCP port until it accepts a connection or the timeout elapses.
 * @param {number} port - The port to probe.
 * @param {number} timeoutMs - How long to keep retrying.
 * @returns {Promise<void>} Resolves once connectable; rejects on timeout.
 */
function probePort(port, timeoutMs) {
   return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
         const socket = net.connect(port, '127.0.0.1');
         socket.on('connect', () => {
            socket.end();
            resolve();
         });
         socket.on('error', () => {
            socket.destroy();
            if (Date.now() > deadline) {
               reject(new Error(`port ${port} not reachable within ${timeoutMs}ms`));
            } else {
               setTimeout(attempt, 300);
            }
         });
      };
      attempt();
   });
}

/**
 * Poll a TCP port until it is free (refuses connections) or the timeout elapses.
 * @param {number} port - The port to probe.
 * @param {number} timeoutMs - How long to keep retrying.
 * @returns {Promise<void>} Resolves once the port is free; rejects on timeout.
 */
function waitForPortFree(port, timeoutMs) {
   return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
         const socket = net.connect(port, '127.0.0.1');
         socket.on('connect', () => {
            socket.end();
            if (Date.now() > deadline) {
               reject(new Error(`port ${port} still occupied after ${timeoutMs}ms — stop any stray sidecar`));
            } else {
               setTimeout(attempt, 300);
            }
         });
         socket.on('error', () => {
            socket.destroy();
            resolve();
         });
      };
      attempt();
   });
}

/**
 * Start a fresh Wiretap sidecar for one spec file and wait until it is listening. Waits for the port to be
 * free first so a crashed prior run cannot block the spawn.
 * @returns {Promise<import('node:child_process').ChildProcess>} The spawned sidecar process.
 */
export async function startSidecar() {
   await waitForPortFree(SIDECAR_PORT, 10_000);
   const child = spawn('npm', ['run', 'server:start'], {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: true,
      detached: process.platform !== 'win32',
   });
   await probePort(SIDECAR_PORT, 30_000);
   return child;
}

/**
 * Stop a sidecar started by startSidecar and wait until its port is released so the next file can bind.
 * @param {import('node:child_process').ChildProcess | null} child - The sidecar process, or null.
 * @returns {Promise<void>} Resolves once the sidecar is gone and the port is free.
 */
export async function stopSidecar(child) {
   if (!child) {
      return;
   }
   if (process.platform === 'win32') {
      try {
         execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {
         // Already gone.
      }
   } else {
      try {
         process.kill(-child.pid);
      } catch {
         // Already gone.
      }
   }
   await waitForPortFree(SIDECAR_PORT, 10_000);
}
```

- [ ] **Step 2: Refactor `tests/e2e/global-setup.js`** — replace the WHOLE file with build-only (the sidecar
  is now per-file):
```js
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, derived from this file's location (tests/e2e/global-setup.js).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Playwright global setup: build the e2e bundle (probe-enabled) once before the suite. Each spec file manages
 * its own fresh sidecar (see tests/e2e/sidecar.js), so the sidecar is no longer started here.
 * @returns {Promise<void>} Resolves once the e2e bundle is built.
 */
export default async function globalSetup() {
   execSync('npm run build:e2e', { cwd: repoRoot, stdio: 'inherit' });
}
```

- [ ] **Step 3: Wire the lifecycle into `tests/e2e/smoke.spec.js`.** It currently starts:
```js
import { test, expect } from '@playwright/test';
import { login } from './fixtures.js';
```
  Add the sidecar import directly below those, then a lifecycle block before the `test.describe(...)`:
```js
import { startSidecar, stopSidecar } from './sidecar.js';

// Each spec file runs against its own fresh sidecar so cumulative PTY kill/respawn churn stays bounded.
let sidecar;
test.beforeAll(async () => {
   sidecar = await startSidecar();
});
test.afterAll(async () => {
   await stopSidecar(sidecar);
});
```

- [ ] **Step 4: Wire the same lifecycle into `tests/e2e/spawn.spec.js`.** Its imports start:
```js
import { test, expect } from '@playwright/test';
import { openTab } from './fixtures.js';
```
  Add the identical block (import below the existing imports, then the `let sidecar` + `beforeAll`/`afterAll`)
  before its `test.describe(...)`:
```js
import { startSidecar, stopSidecar } from './sidecar.js';

// Each spec file runs against its own fresh sidecar so cumulative PTY kill/respawn churn stays bounded.
let sidecar;
test.beforeAll(async () => {
   sidecar = await startSidecar();
});
test.afterAll(async () => {
   await stopSidecar(sidecar);
});
```

- [ ] **Step 5: Wire the same lifecycle into `tests/e2e/terminal.spec.js`.** Its imports start:
```js
import { test, expect } from '@playwright/test';
import { openTab, MARKER_CMD } from './fixtures.js';
```
  Add the identical block (import + `let sidecar` + `beforeAll`/`afterAll`) before its `test.describe(...)`:
```js
import { startSidecar, stopSidecar } from './sidecar.js';

// Each spec file runs against its own fresh sidecar so cumulative PTY kill/respawn churn stays bounded.
let sidecar;
test.beforeAll(async () => {
   sidecar = await startSidecar();
});
test.afterAll(async () => {
   await stopSidecar(sidecar);
});
```

- [ ] **Step 6: Wire the same lifecycle into `tests/e2e/toolbar.spec.js`.** It begins with imports, then a
  long `// NOTE:` comment and a `function tool(...)` helper. Add the sidecar import alongside the existing
  imports (which start):
```js
import { test, expect } from '@playwright/test';
import { openTab, MARKER_CMD } from './fixtures.js';
```
  i.e. add `import { startSidecar, stopSidecar } from './sidecar.js';` below them. Then add the lifecycle block
  immediately after the `function tool(page, label) { ... }` helper and before `test.describe(...)`:
```js

// Each spec file runs against its own fresh sidecar so cumulative PTY kill/respawn churn stays bounded.
let sidecar;
test.beforeAll(async () => {
   sidecar = await startSidecar();
});
test.afterAll(async () => {
   await stopSidecar(sidecar);
});
```

- [ ] **Step 7: Lint.** `npm run eslint -- tests/e2e/sidecar.js tests/e2e/global-setup.js tests/e2e/smoke.spec.js tests/e2e/spawn.spec.js tests/e2e/terminal.spec.js tests/e2e/toolbar.spec.js`. Expected: clean. (Also run `npm test` to confirm the unit suite is unaffected — expect 42 pass. Do NOT run the e2e suite.)

- [ ] **Step 8: Commit:**
```bash
git add tests/e2e/sidecar.js tests/e2e/global-setup.js tests/e2e/smoke.spec.js tests/e2e/spawn.spec.js tests/e2e/terminal.spec.js tests/e2e/toolbar.spec.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'test(e2e): per-spec-file sidecar isolation (bounds ConPTY churn)\n\nLift sidecar start/stop into tests/e2e/sidecar.js; global-setup only builds\nthe bundle; each spec gets a fresh sidecar via beforeAll/afterAll.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: verify full-suite reliability + TODO — **CONTROLLER-RUN**

**Files:** modify `TODO.md`.

- [ ] **Step 1: Full-suite reliability (under Node 22).** With `$env:PATH` prefixed by the portable Node 22 dir
  and `WIRETAP_PTY_BACKEND` unset (default `conpty`), run `npx playwright test --reporter=line` **3× in a row**.
  Expected: all specs pass each run (smoke + spawn + terminal + toolbar). Record the pass counts. Also confirm a
  single spec still self-manages: `npx playwright test toolbar.spec.js` passes on its own (its `beforeAll`
  now starts the sidecar). If residual flakes remain, record them honestly rather than claiming success.

- [ ] **Step 2: Restore the production build.** `global-setup` ran `build:e2e`, overwriting root `index.js`.
  Run `npm run build`, then
  `rm -f registerProbe-*.js registerProbe-*.js.map "TerminalConnection.svelte-"*.js "TerminalConnection.svelte-"*.js.map`,
  then the leak check:
  `node -e "const s=require('fs').readFileSync('index.js','utf8');['node-pty','registerProbe'].forEach(t=>{if(s.includes(t))throw new Error('leak: '+t)});console.log('OK')"` → `OK`.
  Confirm `git status` shows only `TODO.md`.

- [ ] **Step 3: Update `TODO.md`** — tick the per-spec-isolation item and record the full-suite outcome. Change:
```markdown
- [ ] e2e harness: per-spec sidecar isolation so the FULL suite is reliable (see the residual above).
```
  to (with the measured result):
```markdown
- [x] e2e harness: per-spec sidecar isolation — each spec file gets a fresh sidecar (tests/e2e/sidecar.js + beforeAll/afterAll). Full `npm run test:e2e` now green (3/3 runs under Node 22).
```
  And update the preceding `e2e reliability` line's "RESIDUAL" sentence to note it is resolved by per-spec
  isolation (or record the residual rate if the bar was not fully met).

- [ ] **Step 4: Commit:**
```bash
git add TODO.md
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'docs: record full-suite e2e green via per-spec sidecar isolation\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 5: Report** the 3-run full-suite result (pass counts), the single-spec self-management check, and
  the prod-build restore. Do not overstate — if any run flaked, say so with the numbers.

---

## Self-review

**Spec coverage:** `sidecar.js` with `startSidecar`/`stopSidecar` + `probePort`/`waitForPortFree` (Task 1
Step 1, spec "Component: sidecar.js"); `global-setup.js` build-only (Step 2, spec "Component: global-setup");
all four specs wired with `beforeAll`/`afterAll` (Steps 3–6, spec "Component: the 4 spec files"); verification
= full suite 3× green + single-spec self-management + prod restore (Task 2, spec "Testing/verification"); TODO
update (Task 2 Step 3). Error handling (port-free/accept timeouts, tolerant kill) is in the `sidecar.js` code
(spec "Error handling").

**Placeholder scan:** none — every code block is concrete; the lifecycle block is repeated verbatim per spec
(not "same as Task N") so each step is self-contained.

**Type/name consistency:** `startSidecar()`/`stopSidecar(child)` and `SIDECAR_PORT`/`probePort`/
`waitForPortFree` are defined in Step 1 and imported identically (`from './sidecar.js'`) in Steps 3–6.
`global-setup.js` no longer spawns a sidecar, so the per-file `startSidecar` owns `:31416` (its
`waitForPortFree` precheck confirms the port is free first). The lifecycle block uses a module-level
`let sidecar;` and the same `beforeAll`/`afterAll` shape in all four specs. `npm run server:start` and the
`taskkill /PID … /T /F` teardown match the logic lifted from the original `global-setup.js`.

**Risk note:** `beforeAll` runs under Playwright's hook timeout (the config's 60s) — `startSidecar`
(≤10s port-free + spawn + ≤30s accept) fits comfortably; a real boot takes a few seconds. Between a file's
`afterAll` and the next file's `beforeAll` there is a no-sidecar window, but the next file's tests only run
after its `beforeAll` resolves (sidecar listening), and each test uses a fresh Foundry page that connects then,
so there is no race. Single-spec invocation still works (the spec's own `beforeAll` starts the sidecar).
