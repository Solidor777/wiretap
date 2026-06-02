# Wiretap — Terminal Toolbar + Persisted Font Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Project rule:** route `.js`/`.svelte`/`.svelte.js` work to the `foundry-module-dev` contract — dispatch `general-purpose` and have it first invoke skills `svelte-5`, `foundry-vtt`, `foundry-svelte`, then follow `.claude/CLAUDE.md` style (120-char wrap; multi-line `{}` for conditionals; multi-line objects/arrays >1 entry; Svelte elements/components with >1 attribute multi-line with `>`/`/>` on their own line; typed variables with single-line comments; multi-line JSDoc on functions; NO `:global`).

**Goal:** Add a slim terminal toolbar (Clear, Copy, Font −/+, Restart) shown with the live terminal, and make font size a persisted, live-applied client setting.

**Architecture:** A `terminalFontSize` reactive store + client setting drives a live `$effect` in `TerminalView` (mirroring the existing `terminalTheme` pattern). A `terminalController` singleton holds the active xterm `term` so header-level controls can Clear/Copy it. `connection.restart()` orchestrates a client-side close-then-relaunch. A new `TerminalToolbar.svelte` renders the icon buttons and is placed above `TerminalView` in `Wiretap.svelte`'s connected branch.

**Tech Stack:** Svelte 5 (runes), Foundry VTT v14 ApplicationV2, xterm.js, Vitest + @testing-library/svelte, SCSS.

**Spec:** `docs/superpowers/specs/2026-06-02-wiretap-terminal-toolbar-design.md` (approved).

---

## File structure

| File | Change | Task |
|---|---|---|
| `src/components/terminalFontSize.svelte.js` | NEW — bounds, reactive `terminalFontSize` store, `clampFontSize` | 1 |
| `tests/unit/terminalFontSize.test.js` | NEW — default + clamp tests | 1 |
| `src/hooks/OnceInit.js` | register `terminalFontSize` Number/range setting; seed the store | 1 |
| `src/components/TerminalView.svelte` | initial `fontSize` from store + live font `$effect`; (Task 2) register/deregister term | 1, 2 |
| `lang/en.json` | `Settings.FontSize.*` (T1); `Copied`/`CopyFailed` (T2); `Toolbar.*` (T4) | 1, 2, 4 |
| `src/components/terminalController.js` | NEW — active-term ref + `clear()`/`copy()` | 2 |
| `tests/unit/terminalController.test.js` | NEW | 2 |
| `tests/setup.js` | add `game.settings.set` + `ui.notifications` stubs | 2 |
| `src/bridge/TerminalConnection.svelte.js` | `#pendingRelaunch` + `restart()`; relaunch on `TERMINAL_EXIT` | 3 |
| `tests/unit/TerminalConnection.test.js` | add `restart` cases | 3 |
| `src/components/TerminalToolbar.svelte` | NEW — icon-button toolbar | 4 |
| `tests/unit/TerminalToolbar.test.js` | NEW | 4 |
| `src/components/Wiretap.svelte` | render `<TerminalToolbar />` above `<TerminalView />` in connected branch | 4 |
| `tests/unit/Wiretap.test.js` | toolbar present/absent per branch | 4 |
| `TODO.md` | record toolbar + persisted font size; close font-size item | 5 |

---

### Task 1: persisted, live font size

**Files:** create `src/components/terminalFontSize.svelte.js`, `tests/unit/terminalFontSize.test.js`; modify `src/hooks/OnceInit.js`, `src/components/TerminalView.svelte`, `lang/en.json`.

- [ ] **Step 1: Write the failing test** — create `tests/unit/terminalFontSize.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
   clampFontSize,
   terminalFontSize,
   FONT_SIZE_MIN,
   FONT_SIZE_MAX,
   FONT_SIZE_DEFAULT,
} from '~/components/terminalFontSize.svelte.js';

describe('terminalFontSize', () => {
   it('defaults to FONT_SIZE_DEFAULT', () => {
      expect(terminalFontSize.size).toBe(FONT_SIZE_DEFAULT);
   });

   it('clamps a too-small size up to FONT_SIZE_MIN', () => {
      expect(clampFontSize(FONT_SIZE_MIN - 4)).toBe(FONT_SIZE_MIN);
   });

   it('clamps a too-large size down to FONT_SIZE_MAX', () => {
      expect(clampFontSize(FONT_SIZE_MAX + 4)).toBe(FONT_SIZE_MAX);
   });

   it('leaves an in-range size unchanged', () => {
      expect(clampFontSize(18)).toBe(18);
   });
});
```

- [ ] **Step 2: Run it to verify it fails.** `npm test -- tests/unit/terminalFontSize.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Create `src/components/terminalFontSize.svelte.js`:**

```js
/**
 * Terminal font size for the embedded xterm terminal, controlled by the `terminalFontSize` setting and the
 * toolbar +/- buttons. One module owns the bounds, the reactive size store, and the clamp helper.
 */

/**
 * Smallest allowed terminal font size, in pixels.
 * @type {number}
 */
export const FONT_SIZE_MIN = 8;

/**
 * Largest allowed terminal font size, in pixels.
 * @type {number}
 */
export const FONT_SIZE_MAX = 32;

/**
 * Step between adjacent font sizes, in pixels.
 * @type {number}
 */
export const FONT_SIZE_STEP = 2;

/**
 * Default terminal font size, in pixels.
 * @type {number}
 */
export const FONT_SIZE_DEFAULT = 16;

/**
 * Reactive holder for the active terminal font size (px). The setting onChange and the toolbar both mutate
 * `terminalFontSize.size`, which the terminal component observes to re-apply live.
 * @type {{ size: number }}
 */
export const terminalFontSize = $state({ size: FONT_SIZE_DEFAULT });

/**
 * Clamp a candidate font size to the allowed range.
 * @param {number} size - The desired size in pixels.
 * @returns {number} The size constrained to [FONT_SIZE_MIN, FONT_SIZE_MAX].
 */
export function clampFontSize(size) {
   return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size));
}
```

- [ ] **Step 4: Run it to verify it passes.** `npm test -- tests/unit/terminalFontSize.test.js`. Expected: PASS (4 tests).

- [ ] **Step 5: Register the setting in `src/hooks/OnceInit.js`.** Add this import below the existing `terminalThemes` import (currently line 2):

```js
import {
   terminalFontSize,
   FONT_SIZE_MIN,
   FONT_SIZE_MAX,
   FONT_SIZE_STEP,
   FONT_SIZE_DEFAULT,
} from '~/components/terminalFontSize.svelte.js';
```

Then, immediately after the existing line `terminalTheme.id = game.settings.get('wiretap', 'terminalTheme');`, insert:

```js
   // Terminal font size (px); Foundry renders a slider from the `range`. Applied live via the reactive
   // `terminalFontSize` store that the terminal component observes.
   game.settings.register('wiretap', 'terminalFontSize', {
      name: 'WIRETAP.Settings.FontSize.Name',
      hint: 'WIRETAP.Settings.FontSize.Hint',
      scope: 'client',
      config: true,
      type: Number,
      range: {
         min: FONT_SIZE_MIN,
         max: FONT_SIZE_MAX,
         step: FONT_SIZE_STEP,
      },
      default: FONT_SIZE_DEFAULT,
      onChange: (size) => {
         terminalFontSize.size = size;
      },
   });

   // Seed the reactive store from the stored value (covers a non-default saved size on load).
   terminalFontSize.size = game.settings.get('wiretap', 'terminalFontSize');
```

- [ ] **Step 6: Apply the font size live in `src/components/TerminalView.svelte`.**
  (a) Add this import below the existing `terminalThemes` import (currently line 7):
```js
   import { terminalFontSize } from '~/components/terminalFontSize.svelte.js';
```
  (b) Change the Terminal construction line `fontSize: 16,` to:
```js
         fontSize: terminalFontSize.size,
```
  (c) Add this `$effect` immediately after the existing live-theme `$effect` (the one that sets `term.options.theme`):
```js
   // Re-apply the font size live when the setting changes, reflowing rows/cols to fit.
   $effect(() => {
      if (term) {
         term.options.fontSize = terminalFontSize.size;
         fit?.fit();
      }
   });
```

- [ ] **Step 7: Add the `Settings.FontSize` lang keys to `lang/en.json`.** Inside `WIRETAP.Settings`, after the `"TerminalTheme"` block (add a comma after its closing `}`), insert:
```json
         "FontSize": {
            "Name": "Terminal Font Size",
            "Hint": "Font size (px) of the embedded terminal."
         }
```

- [ ] **Step 8: Full gate.** `npm test && npm run eslint && npm run stylelint && npm run typecheck`. Expected: all pass (the existing Wiretap/TerminalView tests still pass — the xterm mock ignores `fontSize` and provides `options`).

- [ ] **Step 9: Commit:**
```bash
git add src/components/terminalFontSize.svelte.js tests/unit/terminalFontSize.test.js src/hooks/OnceInit.js src/components/TerminalView.svelte lang/en.json
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: persisted, live-applied terminal font size setting\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: active-terminal controller (Clear / Copy)

**Files:** create `src/components/terminalController.js`, `tests/unit/terminalController.test.js`; modify `tests/setup.js`, `src/components/TerminalView.svelte`, `lang/en.json`.

- [ ] **Step 1: Extend the test mocks in `tests/setup.js`.** The `game.settings` object currently has only `get`; add `set`, and add a global `ui.notifications` stub. Replace the existing `globalThis.game = { ... }` block:
```js
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
with:
```js
globalThis.game = {
   i18n: {
      localize: (key) => key,
      format: (key) => key,
   },
   settings: {
      get: () => 'http://localhost:31416',
      set: () => {},
   },
};

// Minimal notifications mock so components that surface info/warn toasts can run in tests.
globalThis.ui = {
   notifications: {
      info: () => {},
      warn: () => {},
   },
};
```

- [ ] **Step 2: Write the failing test** — create `tests/unit/terminalController.test.js`:
```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { terminalController } from '~/components/terminalController.js';

/**
 * Build a fake xterm terminal whose getSelection returns the current selection, or the whole buffer after
 * selectAll() has been called.
 * @param {string} selection - The text returned by getSelection before selectAll.
 * @returns {object} A fake terminal with sp-able clear/selection methods.
 */
function makeFakeTerm(selection = '') {
   return {
      _selection: selection,
      _all: 'full buffer',
      selectedAll: false,
      cleared: false,
      clear() {
         this.cleared = true;
      },
      getSelection() {
         return this.selectedAll ? this._all : this._selection;
      },
      selectAll() {
         this.selectedAll = true;
      },
      clearSelection() {
         this.selectedAll = false;
      },
   };
}

describe('terminalController', () => {
   beforeEach(() => {
      terminalController.term = null;
      vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
   });

   afterEach(() => {
      vi.unstubAllGlobals();
   });

   it('clear() clears the active terminal', () => {
      const term = makeFakeTerm();
      terminalController.term = term;
      terminalController.clear();
      expect(term.cleared).toBe(true);
   });

   it('clear() is a no-op when no terminal is registered', () => {
      terminalController.term = null;
      expect(() => terminalController.clear()).not.toThrow();
   });

   it('copy() writes the current selection to the clipboard', async () => {
      terminalController.term = makeFakeTerm('selected text');
      await terminalController.copy();
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text');
   });

   it('copy() falls back to the whole buffer when nothing is selected', async () => {
      terminalController.term = makeFakeTerm('');
      await terminalController.copy();
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('full buffer');
   });
});
```

- [ ] **Step 3: Run it to verify it fails.** `npm test -- tests/unit/terminalController.test.js`. Expected: FAIL (module not found).

- [ ] **Step 4: Create `src/components/terminalController.js`** (plain `.js` — no runes, so not `.svelte.js`):
```js
/**
 * Holds the active xterm terminal instance so toolbar controls (Clear, Copy) can act on whichever terminal
 * view is currently mounted. Pop-out-takeover guarantees only one terminal view is mounted at a time, so at
 * most one terminal is registered. Exported as a shared singleton.
 */
class TerminalController {

   /**
    * The active xterm Terminal, or null when no terminal view is mounted.
    * @type {object | null}
    */
   term = null;

   /**
    * Clear the on-screen terminal display. The server scrollback is untouched.
    * @returns {void}
    */
   clear() {
      this.term?.clear();
   }

   /**
    * Copy the current selection to the clipboard, or the whole buffer when nothing is selected.
    * @returns {Promise<void>} Resolves once the copy attempt completes.
    */
   async copy() {
      const term = this.term;
      if (!term) {
         return;
      }
      let text = term.getSelection();
      if (!text) {
         term.selectAll();
         text = term.getSelection();
         term.clearSelection();
      }
      if (!text) {
         return;
      }
      try {
         await navigator.clipboard.writeText(text);
         ui.notifications?.info(game.i18n.localize('WIRETAP.Copied'));
      } catch {
         ui.notifications?.warn(game.i18n.localize('WIRETAP.CopyFailed'));
      }
   }
}

/**
 * Shared singleton: the terminal view registers its term here; the toolbar acts on it.
 * @type {TerminalController}
 */
export const terminalController = new TerminalController();
```

- [ ] **Step 5: Run it to verify it passes.** `npm test -- tests/unit/terminalController.test.js`. Expected: PASS (4 tests).

- [ ] **Step 6: Register the term in `src/components/TerminalView.svelte`.**
  (a) Add this import below the `terminalFontSize` import added in Task 1:
```js
   import { terminalController } from '~/components/terminalController.js';
```
  (b) In `onMount`, immediately after `term.open(viewport);`, add:
```js
      terminalController.term = term;
```
  (c) In the `onMount` cleanup function, add `terminalController.term = null;` immediately before `term?.dispose();` so the cleanup becomes:
```js
      return () => {
         detach();
         observer.disconnect();
         terminalController.term = null;
         term?.dispose();
         term = null;
         fit = null;
      };
```

- [ ] **Step 7: Add the `Copied`/`CopyFailed` lang keys to `lang/en.json`.** Add them under `WIRETAP`, immediately after the `"PoppedOut": "Terminal is popped out.",` line:
```json
      "Copied": "Copied to clipboard.",
      "CopyFailed": "Could not copy to clipboard.",
```

- [ ] **Step 8: Full gate.** `npm test && npm run eslint && npm run stylelint && npm run typecheck`. Expected: all pass.

- [ ] **Step 9: Commit:**
```bash
git add src/components/terminalController.js tests/unit/terminalController.test.js tests/setup.js src/components/TerminalView.svelte lang/en.json
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: terminalController singleton for Clear/Copy of the active terminal\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: one-click Restart

**Files:** modify `src/bridge/TerminalConnection.svelte.js`, `tests/unit/TerminalConnection.test.js`.

- [ ] **Step 1: Write the failing tests** — add these two `it` blocks inside the `describe('TerminalConnection', ...)` in `tests/unit/TerminalConnection.test.js` (the file already imports `TERMINAL_LAUNCH` and `TERMINAL_CLOSE`):
```js
   it('restart while running closes, then relaunches on exit', () => {
      const { socket, fire, sent } = makeFakeSocket();
      const conn = new TerminalConnection();
      conn.connect('http://localhost:31416', () => socket);
      fire('connect');
      fire('terminal:state', { running: true, cols: 80, rows: 24 });
      conn.restart('claude');
      let events = sent.map((s) => s.event);
      expect(events).toContain(TERMINAL_CLOSE);
      expect(events).not.toContain(TERMINAL_LAUNCH);
      fire('terminal:exit', { code: 0 });
      events = sent.map((s) => s.event);
      expect(events).toContain(TERMINAL_LAUNCH);
   });

   it('restart while idle launches immediately', () => {
      const { socket, fire, sent } = makeFakeSocket();
      const conn = new TerminalConnection();
      conn.connect('http://localhost:31416', () => socket);
      fire('connect');
      conn.restart('claude');
      const events = sent.map((s) => s.event);
      expect(events).toContain(TERMINAL_LAUNCH);
   });
```

- [ ] **Step 2: Run them to verify they fail.** `npm test -- tests/unit/TerminalConnection.test.js`. Expected: FAIL (`conn.restart is not a function`).

- [ ] **Step 3: Implement `restart` in `src/bridge/TerminalConnection.svelte.js`.**
  (a) Add this private field immediately after the `#rows = 24;` field:
```js
   /**
    * A command to launch once the current PTY exits, set by restart() while a PTY is still running.
    * @type {string | null}
    */
   #pendingRelaunch = null;
```
  (b) In the `TERMINAL_EXIT` handler inside `connect`, which is currently:
```js
      socket.on(TERMINAL_EXIT, () => {
         this.running = false;
      });
```
  change it to:
```js
      socket.on(TERMINAL_EXIT, () => {
         this.running = false;
         if (this.#pendingRelaunch !== null) {
            const command = this.#pendingRelaunch;
            this.#pendingRelaunch = null;
            this.launch(command);
         }
      });
```
  (c) Add this `restart` method immediately after the `launch(command)` method:
```js
   /**
    * Restart the terminal: relaunch the command, closing any running PTY first. While a PTY is running the
    * relaunch is deferred until the PTY's exit is observed, so only one PTY exists at a time.
    * @param {string} command - The command line to run.
    * @returns {void}
    */
   restart(command) {
      if (this.running) {
         this.#pendingRelaunch = command;
         this.close();
      } else {
         this.launch(command);
      }
   }
```

- [ ] **Step 4: Run them to verify they pass.** `npm test -- tests/unit/TerminalConnection.test.js`. Expected: PASS (6 tests).

- [ ] **Step 5: Full gate.** `npm test && npm run eslint && npm run stylelint && npm run typecheck`. Expected: all pass.

- [ ] **Step 6: Commit:**
```bash
git add src/bridge/TerminalConnection.svelte.js tests/unit/TerminalConnection.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: connection.restart (close-then-relaunch) for one-click terminal restart\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: TerminalToolbar component + Wiretap integration

**Files:** create `src/components/TerminalToolbar.svelte`, `tests/unit/TerminalToolbar.test.js`; modify `src/components/Wiretap.svelte`, `tests/unit/Wiretap.test.js`, `lang/en.json`.

- [ ] **Step 1: Add the `Toolbar` lang keys to `lang/en.json`.** Add a `"Toolbar"` object under `WIRETAP`, immediately after the `"CopyFailed"` line added in Task 2:
```json
      "Toolbar": {
         "Clear": "Clear terminal",
         "Copy": "Copy",
         "Restart": "Restart",
         "FontDecrease": "Decrease font size",
         "FontIncrease": "Increase font size"
      },
```

- [ ] **Step 2: Write the failing tests** — create `tests/unit/TerminalToolbar.test.js`:
```js
import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, afterEach } from 'vitest';
import TerminalToolbar from '~/components/TerminalToolbar.svelte';
import { connection } from '~/bridge/TerminalConnection.svelte.js';
import { terminalController } from '~/components/terminalController.js';
import { terminalFontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT } from '~/components/terminalFontSize.svelte.js';

describe('TerminalToolbar.svelte', () => {
   afterEach(() => {
      connection.running = false;
      terminalFontSize.size = FONT_SIZE_DEFAULT;
      vi.restoreAllMocks();
   });

   it('renders the five toolbar controls', () => {
      render(TerminalToolbar);
      const labels = [
         'WIRETAP.Toolbar.Clear',
         'WIRETAP.Toolbar.Copy',
         'WIRETAP.Toolbar.FontDecrease',
         'WIRETAP.Toolbar.FontIncrease',
         'WIRETAP.Toolbar.Restart',
      ];
      labels.forEach((label) => {
         expect(screen.getByRole('button', { name: label })).toBeTruthy();
      });
   });

   it('disables Clear, Copy, and Restart when the terminal is not running', () => {
      connection.running = false;
      render(TerminalToolbar);
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Clear' }).disabled).toBe(true);
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Copy' }).disabled).toBe(true);
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Restart' }).disabled).toBe(true);
   });

   it('enables Clear when the terminal is running', () => {
      connection.running = true;
      render(TerminalToolbar);
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Clear' }).disabled).toBe(false);
   });

   it('disables Font − at the minimum size', () => {
      terminalFontSize.size = FONT_SIZE_MIN;
      render(TerminalToolbar);
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.FontDecrease' }).disabled).toBe(true);
   });

   it('disables Font + at the maximum size', () => {
      terminalFontSize.size = FONT_SIZE_MAX;
      render(TerminalToolbar);
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.FontIncrease' }).disabled).toBe(true);
   });

   it('clicking Clear calls the controller', async () => {
      connection.running = true;
      const spy = vi.spyOn(terminalController, 'clear').mockImplementation(() => {});
      render(TerminalToolbar);
      await fireEvent.click(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Clear' }));
      expect(spy).toHaveBeenCalled();
   });

   it('clicking Restart calls connection.restart', async () => {
      connection.running = true;
      const spy = vi.spyOn(connection, 'restart').mockImplementation(() => {});
      render(TerminalToolbar);
      await fireEvent.click(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Restart' }));
      expect(spy).toHaveBeenCalled();
   });

   it('clicking Font + persists an increased size', async () => {
      const spy = vi.spyOn(game.settings, 'set').mockImplementation(() => {});
      terminalFontSize.size = 16;
      render(TerminalToolbar);
      await fireEvent.click(screen.getByRole('button', { name: 'WIRETAP.Toolbar.FontIncrease' }));
      expect(spy).toHaveBeenCalledWith('wiretap', 'terminalFontSize', 18);
   });
});
```

- [ ] **Step 3: Run them to verify they fail.** `npm test -- tests/unit/TerminalToolbar.test.js`. Expected: FAIL (component not found).

- [ ] **Step 4: Create `src/components/TerminalToolbar.svelte`:**
```svelte
<script>
   import { connection } from '~/bridge/TerminalConnection.svelte.js';
   import { terminalController } from '~/components/terminalController.js';
   import {
      terminalFontSize,
      clampFontSize,
      FONT_SIZE_MIN,
      FONT_SIZE_MAX,
      FONT_SIZE_STEP,
   } from '~/components/terminalFontSize.svelte.js';

   /**
    * Persist a new terminal font size; the setting's onChange updates the reactive store live.
    * @param {number} size - The desired size in pixels (clamped to the allowed range).
    * @returns {void}
    */
   function setFontSize(size) {
      game.settings.set('wiretap', 'terminalFontSize', clampFontSize(size));
   }

   /**
    * Restart the terminal with the configured command.
    * @returns {void}
    */
   function restart() {
      connection.restart(game.settings.get('wiretap', 'terminalCommand'));
   }
</script>

<div class="wiretap__toolbar">
   <button
      type="button"
      class="wiretap__tool"
      title={game.i18n.localize('WIRETAP.Toolbar.Clear')}
      aria-label={game.i18n.localize('WIRETAP.Toolbar.Clear')}
      disabled={!connection.running}
      onclick={() => terminalController.clear()}
   >
      <i class="fa-solid fa-eraser"></i>
   </button>
   <button
      type="button"
      class="wiretap__tool"
      title={game.i18n.localize('WIRETAP.Toolbar.Copy')}
      aria-label={game.i18n.localize('WIRETAP.Toolbar.Copy')}
      disabled={!connection.running}
      onclick={() => terminalController.copy()}
   >
      <i class="fa-solid fa-copy"></i>
   </button>
   <button
      type="button"
      class="wiretap__tool"
      title={game.i18n.localize('WIRETAP.Toolbar.FontDecrease')}
      aria-label={game.i18n.localize('WIRETAP.Toolbar.FontDecrease')}
      disabled={terminalFontSize.size <= FONT_SIZE_MIN}
      onclick={() => setFontSize(terminalFontSize.size - FONT_SIZE_STEP)}
   >
      <i class="fa-solid fa-magnifying-glass-minus"></i>
   </button>
   <button
      type="button"
      class="wiretap__tool"
      title={game.i18n.localize('WIRETAP.Toolbar.FontIncrease')}
      aria-label={game.i18n.localize('WIRETAP.Toolbar.FontIncrease')}
      disabled={terminalFontSize.size >= FONT_SIZE_MAX}
      onclick={() => setFontSize(terminalFontSize.size + FONT_SIZE_STEP)}
   >
      <i class="fa-solid fa-magnifying-glass-plus"></i>
   </button>
   <button
      type="button"
      class="wiretap__tool"
      title={game.i18n.localize('WIRETAP.Toolbar.Restart')}
      aria-label={game.i18n.localize('WIRETAP.Toolbar.Restart')}
      disabled={!connection.running}
      onclick={restart}
   >
      <i class="fa-solid fa-rotate-right"></i>
   </button>
</div>

<style lang="scss">
   .wiretap {
      &__toolbar {
         display: flex;
         align-items: center;
         gap: 4px;
         padding: 4px $wiretap-padding;
      }

      &__tool {
         flex: 0 0 auto;
         width: 24px;
         height: 24px;
         display: inline-flex;
         align-items: center;
         justify-content: center;
         border: 1px solid $wiretap-accent;

         &:disabled {
            opacity: 0.4;
         }
      }
   }
</style>
```

- [ ] **Step 5: Run them to verify they pass.** `npm test -- tests/unit/TerminalToolbar.test.js`. Expected: PASS (8 tests).

- [ ] **Step 6: Render the toolbar in `src/components/Wiretap.svelte`.**
  (a) Add this import directly below the existing `SidecarOffline` import:
```js
   import TerminalToolbar from '~/components/TerminalToolbar.svelte';
```
  (b) In the body, change the connected branch from:
```svelte
   {:else if connection.status === 'connected'}
      <TerminalView />
```
  to:
```svelte
   {:else if connection.status === 'connected'}
      <TerminalToolbar />
      <TerminalView />
```

- [ ] **Step 7: Add toolbar present/absent tests to `tests/unit/Wiretap.test.js`** — add these two `it` blocks inside the existing `describe('Wiretap.svelte', ...)`:
```js
   it('shows the terminal toolbar in the connected branch', () => {
      connection.status = 'connected';
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Clear' })).toBeTruthy();
   });

   it('hides the terminal toolbar when the sidecar is disconnected', () => {
      connection.status = 'disconnected';
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.queryByRole('button', { name: 'WIRETAP.Toolbar.Clear' })).toBeNull();
   });
```

- [ ] **Step 8: Full gate.** `npm test && npm run eslint && npm run stylelint && npm run typecheck`. Expected: all pass.

- [ ] **Step 9: Commit:**
```bash
git add src/components/TerminalToolbar.svelte tests/unit/TerminalToolbar.test.js src/components/Wiretap.svelte tests/unit/Wiretap.test.js lang/en.json
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: terminal toolbar (clear, copy, font +/-, restart)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: build gate, TODO, manual verification

**Files:** modify `TODO.md`.

- [ ] **Step 1: Build + sanity.** `npm run build` (expect success). Leak check:
`node -e "const s=require('fs').readFileSync('index.js','utf8');['node-pty','registerProbe'].forEach(t=>{if(s.includes(t))throw new Error('leak: '+t)});console.log('OK')"` → must print `OK`. Then clean stray hashed chunks:
`rm -f registerProbe-*.js registerProbe-*.js.map "TerminalToolbar.svelte-"*.js "TerminalToolbar.svelte-"*.js.map "Wiretap.svelte-"*.js "Wiretap.svelte-"*.js.map "TerminalView.svelte-"*.js "TerminalView.svelte-"*.js.map` (globs may match nothing — `rm -f` won't error).

- [ ] **Step 2: Update `TODO.md`.** Read it first. Change the `#3 terminal UX polish` line to record the toolbar + persisted font size, and remove "font-size setting" from the remaining list (it is now done):
```markdown
- [ ] #3 terminal UX polish (theme dropdown ✓, popout-takeover + 4:3 default ✓, sidecar launcher + offline panel ✓, toolbar [clear/copy/font/restart] + persisted font size ✓; remaining: scrollback tuning)
```

- [ ] **Step 3: Commit:**
```bash
git add TODO.md
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'docs: note terminal toolbar + persisted font size in TODO\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 4: Manual verification (report; not automated). PAUSE here — needs the human driving live Foundry.** With the sidecar running, Foundry open as GM, terminal launched:
  1. The toolbar row shows above the terminal with five icon buttons; Clear/Copy/Restart are enabled while running.
  2. **Clear** wipes the on-screen scrollback.
  3. Select text in the terminal → **Copy** → a "Copied to clipboard." toast; paste elsewhere matches. With no selection, Copy copies the whole buffer.
  4. **Font −/+** change the terminal font live and reflow; the size persists across a reload, and the **Configure Settings → Wiretap → Terminal Font Size** slider reflects/sets the same value.
  5. **Restart** kills the current command and relaunches it fresh (one click), preserving the terminal size.
  6. When the terminal is idle (connected, not running) Clear/Copy/Restart are disabled; the toolbar is absent on the offline and popped-out states.

---

## Self-review

**Spec coverage:** font store + bounds + clamp (T1 Steps 1–4); setting registration with range slider + seed (T1 Step 5); live `$effect` + initial size (T1 Step 6); `Settings.FontSize` keys (T1 Step 7). `terminalController` clear/copy with selection-or-buffer + toasts (T2 Steps 2–4); term register/deregister in `TerminalView` (T2 Step 6); `Copied`/`CopyFailed` keys (T2 Step 7); test mocks `settings.set` + `ui.notifications` (T2 Step 1). `connection.restart` close-then-relaunch + idle launch + exit relaunch (T3). `TerminalToolbar` five buttons with correct disabled gating + click wiring (T4 Steps 2–4); placement in connected branch only (T4 Step 6); `Toolbar.*` keys (T4 Step 1); toolbar present/absent tests (T4 Step 7). Build/leak/TODO/manual (T5). Closes the font-size TODO (T5 Step 2). Clear-is-view-only and Copy-fallback behaviors are encoded in T2's controller and exercised in T2 tests + T5 manual steps 2–3.

**Placeholder scan:** none — every code/test/lang block is concrete; each lang edit names its exact anchor line.

**Type/name consistency:** `terminalFontSize.size`, `clampFontSize`, and `FONT_SIZE_{MIN,MAX,STEP,DEFAULT}` are defined in T1 and reused identically in T1's `OnceInit`/`TerminalView`, and in T4's `TerminalToolbar`. `terminalController` (from `~/components/terminalController.js`, plain `.js` — no runes) exposes `term`/`clear()`/`copy()` used by `TerminalView` (T2) and `TerminalToolbar` (T4) and spied in tests. `connection.restart(command)` (T3) matches the toolbar's call and the spy in T4. The toolbar persists via `game.settings.set('wiretap', 'terminalFontSize', …)`, whose `onChange` (T1) feeds the store — single source of truth. Lang keys `WIRETAP.Toolbar.{Clear,Copy,Restart,FontDecrease,FontIncrease}`, `WIRETAP.{Copied,CopyFailed}`, `WIRETAP.Settings.FontSize.{Name,Hint}` match every `localize`/`name`/`hint` reference. The connected-branch toolbar placement matches the three-branch body added by the prior sidecar feature.

**Note (spec naming deviation):** the spec listed `terminalController.svelte.js`; the plan uses plain `terminalController.js` because the controller holds an imperative term ref and uses no runes (`$state`), so the `.svelte.js` extension is unwarranted. All imports in the plan reference the `.js` path consistently.

**Risk note:** `game.settings.set` is async; the live store update arrives via the setting's `onChange`, so the visible font change lags the click by the (local, instant) settings round-trip — acceptable and consistent with the existing theme dropdown. The toolbar unmounts with the connected branch on disconnect; no listeners are left dangling (it holds none).
