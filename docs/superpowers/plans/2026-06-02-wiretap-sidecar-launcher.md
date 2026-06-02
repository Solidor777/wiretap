# Wiretap — Painless Sidecar Start + Clear Offline State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Project rule:** route `.js`/`.svelte`/`.svelte.js` work to the `foundry-module-dev` contract — dispatch `general-purpose` and have it first invoke skills `svelte-5`, `foundry-vtt`, `foundry-svelte`, then follow `.claude/CLAUDE.md` style (120-char wrap; multi-line `{}` for conditionals; multi-line objects/arrays >1 entry; Svelte elements/components with >1 attribute multi-line with `>`/`/>` on their own line; typed variables with single-line comments; multi-line JSDoc on functions; NO `:global` selectors).

**Goal:** Make starting the Wiretap sidecar a single double-click, and make the tab clearly tell the GM when the sidecar is not running instead of showing a bare `disconnected` status and an empty terminal.

**Architecture:** Add checked-in double-click launcher scripts (`start-wiretap.cmd` / `start-wiretap.sh`) that run the existing non-watch `server:start`. In the tab, split the body into three branches — popped-out placeholder / live terminal (only when the socket is `connected`) / a new `SidecarOffline` guidance panel (when not connected). The client already reconnects automatically, so no retry control is needed.

**Tech Stack:** Svelte 5 (runes), Foundry VTT v14 ApplicationV2, Vitest + @testing-library/svelte, Node sidecar (tsx + socket.io + node-pty), SCSS.

**Spec:** `docs/superpowers/specs/2026-06-02-wiretap-sidecar-launcher-design.md` (approved).

---

## File structure

| File | Change | Task |
|---|---|---|
| `start-wiretap.cmd` | NEW — Windows double-click launcher (non-watch server) | 1 |
| `start-wiretap.sh` | NEW — POSIX sibling launcher (executable bit set) | 1 |
| `README.md` | add "Running the sidecar" note | 1 |
| `tests/setup.js` | extend the `game` mock with `settings.get` + `i18n.format` | 2 |
| `lang/en.json` | add `WIRETAP.Sidecar.*` keys | 2 |
| `src/components/SidecarOffline.svelte` | NEW — offline/connecting guidance panel | 2 |
| `src/components/Wiretap.svelte` | three-branch body: popped-out / terminal (connected) / offline | 2 |
| `tests/unit/Wiretap.test.js` | add connected/offline tests; fix the pop-out terminal test | 2 |
| `TODO.md` | record launcher + offline-state work | 3 |

---

### Task 1: launcher scripts + README note

**Files:**
- Create: `start-wiretap.cmd`
- Create: `start-wiretap.sh`
- Modify: `README.md`

No automated tests (these are shell artifacts verified manually in Task 3). This task is a single commit.

- [ ] **Step 1: Create `start-wiretap.cmd`** (repo root) with exactly this content:

```bat
@echo off
REM Wiretap sidecar - double-click to start the local terminal bridge. Close this window to stop it.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required but was not found on PATH. & pause & exit /b 1)
if not exist "node_modules" ( echo Installing dependencies... & call npm install )
echo Starting Wiretap sidecar...  ^(close this window to stop^)
call npm run server:start
pause
```

Notes: `%~dp0` is the script's own directory (the module root) so it works from any working directory. The `^(` / `^)` escape the parentheses in the echo so `cmd` does not treat them as block syntax. `call npm run server:start` runs the existing non-watch server script (`tsx server/index.ts`).

- [ ] **Step 2: Create `start-wiretap.sh`** (repo root) with exactly this content:

```sh
#!/usr/bin/env sh
# Wiretap sidecar - run to start the local terminal bridge. Ctrl-C to stop it.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is required but was not found on PATH."; exit 1; }
[ -d node_modules ] || { echo "Installing dependencies..."; npm install; }
echo "Starting Wiretap sidecar...  (Ctrl-C to stop)"
exec npm run server:start
```

- [ ] **Step 3: Mark `start-wiretap.sh` executable in git** so the committed file has the executable bit:

Run: `git add start-wiretap.cmd start-wiretap.sh && git update-index --chmod=+x start-wiretap.sh`
Then verify: `git ls-files -s start-wiretap.sh`
Expected: the mode begins with `100755` (executable), not `100644`.

- [ ] **Step 4: Update `README.md`** — append this section to the end of the file:

```markdown

## Running the sidecar

Wiretap's terminal needs a small local Node sidecar (it runs the real PTY; a browser can't). Start it with
a single action:

- **Windows:** double-click `start-wiretap.cmd` in the module folder.
- **macOS/Linux:** run `./start-wiretap.sh` from the module folder.

A console window opens and stays up while the sidecar runs — its log shows `listening on http://localhost:31416`.
**Close that window (or press Ctrl-C) to stop the sidecar.** The Wiretap tab (GM-only) connects automatically
once the sidecar is up; until then it shows a "Sidecar not running" panel.
```

- [ ] **Step 5: Commit:**

```bash
git add start-wiretap.cmd start-wiretap.sh README.md
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: add double-click sidecar launchers + README note\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

(The `git add` re-stages with the executable bit already set on `start-wiretap.sh` from Step 3.)

---

### Task 2: offline-state UX

**Files:**
- Modify: `tests/setup.js`
- Modify: `lang/en.json`
- Create: `src/components/SidecarOffline.svelte`
- Modify: `src/components/Wiretap.svelte`
- Test: `tests/unit/Wiretap.test.js`

**Why `tests/setup.js` first:** the global `game` mock currently provides only `i18n.localize`. `SidecarOffline` calls `game.settings.get('wiretap', 'serverUrl')` and `game.i18n.format(...)` **during render**, so without extending the mock every Wiretap test throws. Extend the mock before writing the component tests.

- [ ] **Step 1: Extend the `game` mock in `tests/setup.js`.** Replace the existing block:

```js
// Minimal game mock: i18n.localize returns the key so components render deterministically in tests.
globalThis.game = {
   i18n: {
      localize: (key) => key,
   },
};
```

with:

```js
// Minimal game mock: i18n.localize/format return the key so components render deterministically in tests;
// settings.get returns the sidecar default so the offline panel can render its target URL.
globalThis.game = {
   i18n: {
      localize: (key) => key,
      format: (key) => key,
   },
   settings: {
      get: () => 'http://localhost:31416',
   },
};
```

- [ ] **Step 2: Add the `WIRETAP.Sidecar.*` keys to `lang/en.json`.** Insert a `"Sidecar"` object after the `"PoppedOut"` line (mind the trailing comma after `"PoppedOut": "Terminal is popped out.",`). The `WIRETAP` object becomes:

```json
{
   "WIRETAP": {
      "Title": "Wiretap",
      "SidebarTab": "Wiretap",
      "Launch": "Launch",
      "Close": "Close",
      "PoppedOut": "Terminal is popped out.",
      "Sidecar": {
         "Connecting": "Connecting to sidecar…",
         "OfflineTitle": "Sidecar not running",
         "OfflineHint": "Double-click start-wiretap.cmd in the Wiretap module folder. This tab will connect automatically once it's running.",
         "Trying": "Trying {url}"
      },
      "Settings": {
         "ServerUrl": {
            "Name": "Sidecar Server URL",
            "Hint": "URL of the Wiretap agent sidecar (default http://localhost:31416)."
         },
         "TerminalCommand": {
            "Name": "Terminal Command",
            "Hint": "Command launched in the terminal (default `claude`)."
         },
         "TerminalTheme": {
            "Name": "Terminal Theme",
            "Hint": "Color theme for the embedded terminal."
         }
      }
   }
}
```

- [ ] **Step 3: Write the failing tests** in `tests/unit/Wiretap.test.js`. Replace the whole file with:

```js
import { render, screen } from '@testing-library/svelte';
import { describe, it, expect, vi, afterEach } from 'vitest';
import Wiretap from '~/components/Wiretap.svelte';
import { popoutState } from '~/bridge/popoutState.svelte.js';
import { connection } from '~/bridge/TerminalConnection.svelte.js';

// xterm touches DOM APIs happy-dom lacks; stub it so TerminalView mounts in the unit test.
vi.mock('@xterm/xterm', () => ({
   Terminal: class {
      cols = 80;
      rows = 24;
      options = {};
      open() {}
      write() {}
      onData() {}
      onResize() {}
      loadAddon() {}
      dispose() {}
      reset() {}
   },
}));
vi.mock('@xterm/addon-fit', () => ({
   FitAddon: class {
      fit() {}
      activate() {}
      dispose() {}
   },
}));

describe('Wiretap.svelte', () => {
   afterEach(() => {
      popoutState.open = false;
      connection.status = 'disconnected';
   });

   it('renders the title header', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('heading', { name: 'WIRETAP.Title' })).toBeTruthy();
   });

   it('shows a Launch control when no terminal is running', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('button', { name: 'WIRETAP.Launch' })).toBeTruthy();
   });

   it('shows the popped-out placeholder in the docked tab while a pop-out is open', () => {
      popoutState.open = true;
      render(Wiretap, { props: { foundryApp: { isPopout: false } } });
      expect(screen.getByText('WIRETAP.PoppedOut')).toBeTruthy();
   });

   it('still shows the terminal in the pop-out itself even when a pop-out is open', () => {
      popoutState.open = true;
      connection.status = 'connected';
      const { container } = render(Wiretap, { props: { foundryApp: { isPopout: true } } });
      expect(container.querySelector('.wiretap__terminal')).toBeTruthy();
      expect(screen.queryByText('WIRETAP.PoppedOut')).toBeNull();
   });

   it('shows the offline panel (not the terminal) when the sidecar is disconnected', () => {
      connection.status = 'disconnected';
      const { container } = render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByText('WIRETAP.Sidecar.OfflineTitle')).toBeTruthy();
      expect(container.querySelector('.wiretap__terminal')).toBeNull();
   });

   it('shows the terminal (not the offline panel) when the sidecar is connected', () => {
      connection.status = 'connected';
      const { container } = render(Wiretap, { props: { foundryApp: {} } });
      expect(container.querySelector('.wiretap__terminal')).toBeTruthy();
      expect(screen.queryByText('WIRETAP.Sidecar.OfflineTitle')).toBeNull();
   });
});
```

- [ ] **Step 4: Run the tests to verify they fail.**

Run: `npm test -- tests/unit/Wiretap.test.js`
Expected: FAIL — the two new tests and the pop-out test fail because `Wiretap.svelte` still renders `TerminalView` regardless of `connection.status` and `SidecarOffline` does not exist yet.

- [ ] **Step 5: Create `src/components/SidecarOffline.svelte`** with exactly this content:

```svelte
<script>
   import { connection } from '~/bridge/TerminalConnection.svelte.js';

   // The sidecar URL this tab is attempting to reach, shown so the GM can confirm the target.
   const serverUrl = game.settings.get('wiretap', 'serverUrl');
</script>

<div class="wiretap__offline">
   {#if connection.status === 'connecting'}
      <p class="wiretap__offline-title">{game.i18n.localize('WIRETAP.Sidecar.Connecting')}</p>
   {:else}
      <p class="wiretap__offline-title">{game.i18n.localize('WIRETAP.Sidecar.OfflineTitle')}</p>
      <p class="wiretap__offline-hint">{game.i18n.localize('WIRETAP.Sidecar.OfflineHint')}</p>
   {/if}
   <p class="wiretap__offline-url">{game.i18n.format('WIRETAP.Sidecar.Trying', { url: serverUrl })}</p>
</div>

<style lang="scss">
   .wiretap {
      &__offline {
         flex: 1;
         display: flex;
         flex-direction: column;
         align-items: center;
         justify-content: center;
         gap: $wiretap-padding;
         padding: $wiretap-padding;
         text-align: center;
         opacity: 0.85;
      }

      &__offline-title {
         font-weight: bold;
      }

      &__offline-hint {
         max-width: 40ch;
         opacity: 0.85;
      }

      &__offline-url {
         font-size: 12px;
         opacity: 0.6;
      }
   }
</style>
```

Notes: the SCSS class selectors are nested under `.wiretap` (the `&__offline` form) to satisfy the repo's stylelint `selector-class-pattern` kebab rule, matching `TerminalView.svelte` and the existing `&__popped-out`. `$wiretap-padding` is in scope via the preprocessor's `prependData`. Each `<p>`/`<div>` has a single attribute, so single-line elements are correct here.

- [ ] **Step 6: Update the body of `src/components/Wiretap.svelte`.** Add the `SidecarOffline` import below the `TerminalView` import:

```js
   import TerminalView from '~/components/TerminalView.svelte';
   import SidecarOffline from '~/components/SidecarOffline.svelte';
```

Then replace the body block:

```svelte
   {#if showTerminal}
      <TerminalView />
   {:else}
      <p class="wiretap__popped-out">{game.i18n.localize('WIRETAP.PoppedOut')}</p>
   {/if}
```

with:

```svelte
   {#if !showTerminal}
      <p class="wiretap__popped-out">{game.i18n.localize('WIRETAP.PoppedOut')}</p>
   {:else if connection.status === 'connected'}
      <TerminalView />
   {:else}
      <SidecarOffline />
   {/if}
```

(Leave the rest of `Wiretap.svelte` — script, header, styles — unchanged. The popped-out placeholder keeps precedence so a docked tab whose pop-out is open still shows it regardless of connection status.)

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `npm test -- tests/unit/Wiretap.test.js`
Expected: PASS (6 tests).

- [ ] **Step 8: Full gate.** `npm test && npm run eslint && npm run stylelint && npm run typecheck`. Expected: all pass.

- [ ] **Step 9: Commit:**

```bash
git add tests/setup.js lang/en.json src/components/SidecarOffline.svelte src/components/Wiretap.svelte tests/unit/Wiretap.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: show a clear offline panel when the sidecar is not connected\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: build gate, TODO, manual verification

**Files:** modify `TODO.md`

- [ ] **Step 1: Build + sanity.** `npm run build` (expect success). Then the leak check:
`node -e "const s=require('fs').readFileSync('index.js','utf8');['node-pty','registerProbe'].forEach(t=>{if(s.includes(t))throw new Error('leak: '+t)});console.log('OK')"` → must print `OK`. Then clean any stray hashed build chunks:
`rm -f registerProbe-*.js registerProbe-*.js.map "SidecarOffline.svelte-"*.js "SidecarOffline.svelte-"*.js.map "Wiretap.svelte-"*.js "Wiretap.svelte-"*.js.map` (globs may match nothing — `rm -f` will not error).

- [ ] **Step 2: Update `TODO.md`** — read it first to find the exact `#3 terminal UX polish` line, then extend it to record this work, e.g.:

```markdown
- [ ] #3 terminal UX polish (theme dropdown ✓, popout-takeover + 4:3 default ✓, sidecar launcher + offline panel ✓; remaining: font-size setting, toolbar niceties, scrollback tuning)
```

Match the surrounding TODO.md formatting; preserve the existing structure and the other items on the line.

- [ ] **Step 3: Commit:**

```bash
git add TODO.md
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'docs: note sidecar launcher + offline panel in TODO\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 4: Manual verification (report; not automated). PAUSE here — this needs the human driving live Foundry.** With the sidecar **not** running and Foundry open as GM:
  1. Open the Wiretap tab → it shows the "Sidecar not running" panel with the start instruction and the `Trying http://localhost:31416` line (no empty terminal, Launch disabled).
  2. Double-click `start-wiretap.cmd` → a console window opens and logs `listening on http://localhost:31416`.
  3. Within a moment the tab transitions on its own from the offline panel to the live terminal (Launch becomes enabled). Click Launch → the terminal runs.
  4. Close the console window → the tab returns to the "Sidecar not running" panel; re-open the launcher → it reconnects automatically and the terminal's scrollback replays.

---

## Self-review

**Spec coverage:** launcher scripts `.cmd` + `.sh` with Node/`node_modules` guards and non-watch `server:start` (Task 1 Steps 1–2); `.sh` executable bit (Task 1 Step 3); README note (Task 1 Step 4); three-branch body popped-out / terminal-when-connected / offline (Task 2 Step 6); `SidecarOffline` with connecting/disconnected text + `serverUrl` line (Task 2 Step 5); `WIRETAP.Sidecar.*` keys (Task 2 Step 2); test-mock extension for `settings.get`/`i18n.format` (Task 2 Step 1); connected/offline tests + fixed pop-out test (Task 2 Step 3); build/leak gate + TODO + manual verify (Task 3). The spec's "already satisfied — GM-only / localhost / client-scope / auto-reconnect" items require no work and have no task, as intended. Mid-session-loss behavior is covered by the three-branch swap (Task 2 Step 6) and exercised in manual Step 4.4.

**Placeholder scan:** none — every code/script/lang block is concrete; the `TODO.md` edit shows its exact target line.

**Type/name consistency:** `connection.status === 'connected'` is the single gate used in both `Wiretap.svelte` (Step 6) and the tests (Step 3); `SidecarOffline` branches on `connection.status === 'connecting'`. Lang keys `WIRETAP.Sidecar.Connecting/OfflineTitle/OfflineHint/Trying` match between `en.json` (Step 2) and `SidecarOffline.svelte` (Step 5). The test mock adds exactly the `game.i18n.format` and `game.settings.get` that `SidecarOffline` calls. SCSS uses the nested `.wiretap { &__offline… }` form proven against stylelint in the prior popout task. `server:start` is the existing non-watch script the launchers invoke.

**Risk note:** updating the shared `tests/setup.js` mock is additive (adds methods), so other suites (`TerminalConnection.test.js`, integration) are unaffected. On a transient mid-session disconnect the terminal view unmounts and remounts on reconnect, replaying the client output buffer — a brief flicker accepted in the spec for a rare, localhost-only event.
