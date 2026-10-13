# Wiretap Terminal Relay — Playwright E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).
> **Project rule:** route `.js`/`.svelte` work to the `foundry-module-dev` contract (load svelte-5/foundry-vtt/foundry-svelte first); follow `.claude/CLAUDE.md` style.

**Goal:** Automated Playwright e2e for the terminal relay — covering the core round-trip plus regression coverage for the two bugs fixed during manual verification (pop-out fan-out; relaunch reaching the docked tab) — and replace the now-stale scaffold smoke spec.

**Design (approved in brainstorming):**
- **Sidecar in the harness:** `tests/e2e/global-setup.js` (already builds the e2e bundle) also spawns the sidecar (`npm run server:start`), TCP-polls `:31416` for readiness, reuses one if already up, and returns a teardown that kills the process tree (`taskkill /T /F` on Windows). Chosen over a Playwright `webServer` entry because socket.io's HTTP readiness probe is unreliable.
- **No `claude` in tests:** specs override the `terminalCommand` client setting (`game.settings.set('wiretap','terminalCommand', …)`) to deterministic `node -e` one-liners.
- **Assert the real render:** xterm v5 uses the DOM renderer (no canvas/webgl addon), so output lands in `.xterm-rows` — assert via `toContainText`. Docked vs pop-out distinguished by `#sidebar section.wiretap` vs `.sidebar-popout section.wiretap`.
- **E2E probe controls:** extend the e2e-gated `registerProbe.js` to expose `_probe.terminal.{running, close}` (imports the `connection` singleton) for robust setup/teardown without UI clicking.

**Standing prerequisite (unchanged):** a live Foundry world with `wiretap` enabled and a GM user `E2E GM 1` (or `FOUNDRY_USER`). Playwright launches Foundry (reuse-if-running) and the sidecar; the world must exist.

**Tech:** Playwright, the existing `login` fixture, the e2e probe, `node-pty` sidecar.

---

## File structure

| File | Change | Task |
|---|---|---|
| `tests/e2e/global-setup.js` | spawn + poll + teardown the sidecar (keep the e2e build) | 1 |
| `src/test-probe/registerProbe.js` | add `_probe.terminal.{running, close}` | 1 |
| `tests/e2e/smoke.spec.js` | rewrite for the terminal UI (was asserting the removed counter) | 2 |
| `tests/e2e/terminal.spec.js` | NEW — round-trip + fan-out + relaunch regressions | 2 |

---

### Task 1: Harness — sidecar lifecycle + probe terminal controls

**Files:** modify `tests/e2e/global-setup.js`, `src/test-probe/registerProbe.js`

- [ ] **Step 1: Replace `tests/e2e/global-setup.js`:**
```js
import { execSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, derived from this file's location (tests/e2e/global-setup.js).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The sidecar port (must match the default `serverUrl` setting).
const SIDECAR_PORT = 31416;

/**
 * Poll a TCP port until it accepts a connection or the timeout elapses.
 * @param {number} port - The port to probe.
 * @param {number} timeoutMs - How long to keep retrying.
 * @returns {Promise<boolean>} Resolves true once connectable; rejects on timeout.
 */
function probePort(port, timeoutMs) {
   return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
         const socket = net.connect(port, '127.0.0.1');
         socket.on('connect', () => {
            socket.end();
            resolve(true);
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
 * Playwright global setup: build the e2e bundle (probe-enabled) and ensure the sidecar is running.
 * Returns a teardown that stops a sidecar we started.
 * @returns {Promise<() => Promise<void>>} The global-teardown function.
 */
export default async function globalSetup() {
   execSync('npm run build:e2e', { cwd: repoRoot, stdio: 'inherit' });

   // Reuse an already-running sidecar; otherwise spawn one for the suite.
   const alreadyUp = await probePort(SIDECAR_PORT, 500).then(() => true).catch(() => false);
   let child = null;
   if (!alreadyUp) {
      child = spawn('npm', ['run', 'server:start'], {
         cwd: repoRoot,
         stdio: 'ignore',
         shell: true,
         detached: process.platform !== 'win32',
      });
      await probePort(SIDECAR_PORT, 30_000);
   }

   return async () => {
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
   };
}
```

- [ ] **Step 2: Extend `src/test-probe/registerProbe.js`** — import the connection and add a `terminal` control block. Add the import at top:
```js
import { connection } from '~/bridge/TerminalConnection.svelte.js';
```
and inside the `api._probe = { ... }` object (after the existing `popout()` method), add:
```js

      /**
       * Terminal controls for e2e setup/teardown without UI interaction.
       */
      terminal: {
         /**
          * Whether a PTY session is currently running.
          * @returns {boolean} True when a session is active.
          */
         running() {
            return connection.running;
         },

         /**
          * Close any running PTY session.
          * @returns {void}
          */
         close() {
            connection.close();
         },
      },
```
(Keep the existing `tabRegistered`/`open`/`popout`.)

- [ ] **Step 3: Verify the bundle still builds with the probe.** Run `npm run build:e2e` then:
`node -e "const s=require('fs').readFileSync('index.js','utf8');console.log(s.includes('_probe')?'probe present in e2e build':'MISSING')"`
Expected: `probe present in e2e build`. Then `npm run build` (restore prod) and `rm -f registerProbe-*.js registerProbe-*.js.map`.

- [ ] **Step 4: Lint + typecheck + unit gate** (no e2e yet). `npm test && npm run eslint && npm run typecheck`. Expected: all pass (these changes don't affect unit tests).

- [ ] **Step 5: Commit:**
```bash
git add tests/e2e/global-setup.js src/test-probe/registerProbe.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'test: spawn sidecar in e2e global-setup; add probe terminal controls\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: E2E specs — smoke rewrite + terminal regressions

**Files:** rewrite `tests/e2e/smoke.spec.js`, create `tests/e2e/terminal.spec.js`

- [ ] **Step 1: Replace `tests/e2e/smoke.spec.js`:**
```js
import { test, expect } from '@playwright/test';
import { login } from './fixtures.js';

test.describe('wiretap terminal tab smoke', () => {
   test.beforeEach(async ({ page }) => {
      await login(page);
   });

   test('module is active and tab is registered', async ({ page }) => {
      const state = await page.evaluate(() => ({
         active: game.modules.get('wiretap')?.active === true,
         registered: game.modules.get('wiretap')?.api?._probe?.tabRegistered() === true,
      }));
      expect(state.active, 'wiretap module must be enabled in the test world').toBe(true);
      expect(state.registered, 'wiretap sidebar tab must be registered').toBe(true);
   });

   test('sidebar tab shows the terminal panel and a Launch control', async ({ page }) => {
      const button = page.locator('#sidebar nav.tabs [data-tab="wiretap"]');
      await expect(button).toHaveCount(1);
      await button.click();
      await expect(page.locator('#sidebar section.wiretap .wiretap__terminal')).toBeVisible();
      await expect(page.locator('#sidebar section.wiretap button.wiretap__toggle')).toBeVisible();
   });
});
```

- [ ] **Step 2: Create `tests/e2e/terminal.spec.js`:**
```js
import { test, expect } from '@playwright/test';
import { login } from './fixtures.js';

// A deterministic, long-lived command: prints a marker then ticks, so output persists for assertions.
const MARKER_CMD = 'node -e "process.stdout.write(\'READY-MARK\'); setInterval(() => process.stdout.write(\'.\'), 300)"';

/**
 * Log in, set the terminal command, open the Wiretap tab, and wait for the socket to connect.
 * @param {import('@playwright/test').Page} page - The Playwright page.
 * @param {string} command - The deterministic command to launch.
 * @returns {Promise<void>} Resolves with the tab open and the toggle enabled.
 */
async function openTab(page, command) {
   await login(page);
   await page.evaluate((cmd) => game.settings.set('wiretap', 'terminalCommand', cmd), command);
   await page.locator('#sidebar nav.tabs [data-tab="wiretap"]').click();
   await expect(page.locator('#sidebar section.wiretap button.wiretap__toggle')).toBeEnabled();
}

test.describe('wiretap terminal relay', () => {
   // Ensure no PTY leaks between serial tests.
   test.afterEach(async ({ page }) => {
      await page.evaluate(() => game.modules.get('wiretap')?.api?._probe?.terminal?.close());
   });

   test('launches a command, renders output in xterm, and clears on close', async ({ page }) => {
      await openTab(page, MARKER_CMD);
      const toggle = page.locator('#sidebar section.wiretap button.wiretap__toggle');
      await toggle.click();
      const rows = page.locator('#sidebar section.wiretap .xterm-rows');
      await expect(rows).toContainText('READY-MARK', { timeout: 15_000 });
      // Now running → label is Close.
      await expect(toggle).toHaveText(/Close/);
      await toggle.click();
      // Closed → terminal cleared and label back to Launch.
      await expect(rows).not.toContainText('READY-MARK', { timeout: 10_000 });
      await expect(toggle).toHaveText(/Launch/);
   });

   test('mirrors the live session to both the docked tab and the pop-out (fan-out regression)', async ({ page }) => {
      await openTab(page, MARKER_CMD);
      await page.locator('#sidebar section.wiretap button.wiretap__toggle').click();
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 15_000 });

      // Pop the tab out via the probe.
      await page.evaluate(() => game.modules.get('wiretap').api._probe.popout());
      const popout = page.locator('.sidebar-popout section.wiretap .xterm-rows');
      await expect(popout).toContainText('READY-MARK', { timeout: 10_000 });

      // Both views keep receiving the live tick stream (the Set fan-out fix).
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toContainText('READY-MARK');
      await expect(popout).toContainText('READY-MARK');
   });

   test('relaunch reaches the docked tab after a pop-out + close (relaunch regression)', async ({ page }) => {
      await openTab(page, MARKER_CMD);
      const toggle = page.locator('#sidebar section.wiretap button.wiretap__toggle');
      await toggle.click();
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 15_000 });

      // Pop out (this is what previously stole the only sink), then close and relaunch.
      await page.evaluate(() => game.modules.get('wiretap').api._probe.popout());
      await expect(page.locator('.sidebar-popout section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 10_000 });

      await toggle.click(); // Close
      await expect(toggle).toHaveText(/Launch/);
      await toggle.click(); // Relaunch

      // The docked terminal must render the new session again (not just the pop-out).
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 15_000 });
   });
});
```

- [ ] **Step 3: Run the e2e suite.** Run `npm run test:e2e`.
   - global-setup builds the e2e bundle and ensures the sidecar is up; Playwright reuses/launches Foundry.
   - Expected: all specs pass (the 2 smoke + 3 terminal tests).
   - **Prerequisite reminder:** a live Foundry world with `wiretap` enabled and GM `E2E GM 1` must exist. If `login` fails on user selection, the controller/user supplies the correct `FOUNDRY_USER`. If a test is flaky on timing, increase the specific `timeout` rather than weakening assertions; if a selector is wrong, capture the actual DOM and fix the selector (report what changed).

- [ ] **Step 4: Commit (only if the suite passes):**
```bash
git add tests/e2e/smoke.spec.js tests/e2e/terminal.spec.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'test: add terminal-relay e2e (round-trip, fan-out, relaunch); refresh smoke\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```
If the suite cannot run to completion due to the environmental world/GM prerequisite, do NOT fake a pass — commit the specs with a note and hand the run to the user.

---

## Self-review

**Coverage vs. approved scope (core + 2 regressions):** core round-trip (Task 2 test 1: launch → render → close → clear); fan-out regression (test 2: docked + pop-out both render); relaunch regression (test 3: pop-out + close + relaunch → docked renders). Stale smoke replaced (Task 2 smoke). ✓

**Placeholder scan:** none; all spec code complete. The `MARKER_CMD` quoting targets the sidecar's shell wrapping (`cmd /c` on Windows / `sh -c` on POSIX) — single quotes inside the JS string become the inner quotes node sees.

**Consistency:** `_probe.terminal.{running,close}` defined in Task 1 (registerProbe), used in Task 2 `afterEach`. `_probe.popout()`/`tabRegistered()` are the existing probe methods. Selectors: docked `#sidebar section.wiretap`, pop-out `.sidebar-popout section.wiretap`, rows `.xterm-rows` — consistent across specs. `terminalCommand` setting key matches the component/setting registration. Sidecar port 31416 matches `serverUrl` default.

**Risk notes (flagged, not blocking):** (1) socket.io HTTP-readiness avoided by TCP-poll in global-setup. (2) xterm DOM-renderer assumption — if a canvas/webgl addon is ever added, `.xterm-rows` assertions break (none is added today). (3) the e2e world/GM prerequisite is environmental — the suite run may need the user's world; specs are still committed.
