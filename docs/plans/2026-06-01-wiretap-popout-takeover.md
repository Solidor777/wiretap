# Wiretap — Pop-out Takes Over (single live terminal) + 4:3 Default

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).
> **Project rule:** route `.js`/`.svelte`/`.svelte.js` work to the `foundry-module-dev` contract (load svelte-5/foundry-vtt/foundry-svelte first); follow `.claude/CLAUDE.md` style.

**Goal:** Fix the shared-PTY resize conflict: while the tab is popped out, the docked sidebar shows a "popped out" placeholder instead of a second live terminal, so only one `xterm` view drives the PTY size. Also default the pop-out window to a 4:3 size (800×600).

**Architecture:** Both views mount the same component and share one `connection`/PTY. We extract the terminal into a `TerminalView` child whose lifecycle follows being rendered; `Wiretap.svelte` renders it only for the authoritative view (`foundryApp.isPopout || !popoutState.open`), where `popoutState` is a tiny reactive store the pop-out sets while open. The shared connection tracks the latest size so `launch()` no longer needs the component's `term`.

**Spec:** Design approved inline (no separate spec doc for this polish fix). Supersedes the resize wiring from the #2 terminal relay.

---

## File structure

| File | Change | Task |
|---|---|---|
| `src/bridge/popoutState.svelte.js` | NEW — reactive `{ open }` store | 1 |
| `src/bridge/TerminalConnection.svelte.js` | track latest size; `launch(command)` uses it | 1 |
| `tests/unit/TerminalConnection.test.js` | update `launch` call (now `launch(command)`) | 1 |
| `src/components/TerminalView.svelte` | NEW — extracted xterm terminal (mount/teardown + effects + bg) | 2 |
| `src/components/Wiretap.svelte` | header/toolbar + popout tracking + conditional body | 2 |
| `src/apps/WiretapSidebarTab.js` | add `position: { width: 800, height: 600 }` (4:3 pop-out default) | 2 |
| `lang/en.json` | add `WIRETAP.PoppedOut` | 2 |
| `tests/unit/Wiretap.test.js` | update for the refactor (+ placeholder-when-popped-out test) | 2 |
| `TODO.md` | tick the popout-fit item | 3 |

---

### Task 1: popout store + connection size tracking

**Files:** create `src/bridge/popoutState.svelte.js`; modify `src/bridge/TerminalConnection.svelte.js`, `tests/unit/TerminalConnection.test.js`

- [ ] **Step 1: Create `src/bridge/popoutState.svelte.js`:**
```js
/**
 * Reactive flag shared between the docked sidebar tab and its pop-out. The pop-out sets `open = true`
 * while mounted; the docked tab observes it to yield the single live terminal to the pop-out.
 * @type {{ open: boolean }}
 */
export const popoutState = $state({ open: false });
```

- [ ] **Step 2: Update `src/bridge/TerminalConnection.svelte.js`** — track the latest size and use it in `launch`.
  (a) Add two private fields (near `#output`):
```js
   /**
    * The most recent terminal size reported by a view, used when launching a new PTY.
    * @type {number}
    */
   #cols = 80;

   /**
    * The most recent terminal row count reported by a view.
    * @type {number}
    */
   #rows = 24;
```
  (b) Change `launch` to take only the command and use the tracked size:
```js
   /**
    * Request the sidecar spawn a PTY at the most recently reported size.
    * @param {string} command - The command line to run.
    * @returns {void}
    */
   launch(command) {
      this.#socket?.emit(TERMINAL_LAUNCH, { command, cols: this.#cols, rows: this.#rows });
   }
```
  (c) Update `resize` to remember the size:
```js
   /**
    * Resize the PTY and remember the size for the next launch.
    * @param {number} cols - New columns.
    * @param {number} rows - New rows.
    * @returns {void}
    */
   resize(cols, rows) {
      this.#cols = cols;
      this.#rows = rows;
      this.#socket?.emit(TERMINAL_RESIZE, { cols, rows });
   }
```

- [ ] **Step 3: Update `tests/unit/TerminalConnection.test.js`** — the "emits launch / input / close" test calls
`conn.launch('claude', 80, 24)`; change it to `conn.launch('claude')`. (The assertions on emitted event names are unchanged.)

- [ ] **Step 4: Run unit tests.** `npm test -- tests/unit/TerminalConnection.test.js`. Expected: PASS (4 tests).

- [ ] **Step 5: Lint.** `npm run eslint -- src/bridge/popoutState.svelte.js src/bridge/TerminalConnection.svelte.js`. Expected: clean.

- [ ] **Step 6: Commit:**
```bash
git add src/bridge/popoutState.svelte.js src/bridge/TerminalConnection.svelte.js tests/unit/TerminalConnection.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'refactor: add popoutState store; connection tracks size for launch\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: extract TerminalView + pop-out-takes-over + 4:3 default

**Files:** create `src/components/TerminalView.svelte`; modify `src/components/Wiretap.svelte`, `src/apps/WiretapSidebarTab.js`, `lang/en.json`, `tests/unit/Wiretap.test.js`

- [ ] **Step 1: Create `src/components/TerminalView.svelte`** (the xterm terminal, moved out of Wiretap.svelte):
```svelte
<script>
   import { onMount } from 'svelte';
   import { Terminal } from '@xterm/xterm';
   import { FitAddon } from '@xterm/addon-fit';
   import '@xterm/xterm/css/xterm.css';
   import { connection } from '~/bridge/TerminalConnection.svelte.js';
   import { TERMINAL_THEMES, terminalTheme } from '~/components/terminalThemes.svelte.js';

   // The DOM node the xterm terminal mounts into.
   let viewport = $state(null);

   // The xterm instance and its fit addon, created on mount.
   /** @type {Terminal | null} */
   let term = null;
   /** @type {FitAddon | null} */
   let fit = null;

   onMount(() => {
      term = new Terminal({
         convertEol: false,
         cursorBlink: true,
         fontSize: 16,
         lineHeight: 1.3,
         fontFamily: "'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', Consolas, 'Courier New', monospace",
         theme: TERMINAL_THEMES[terminalTheme.id].theme,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(viewport);
      fit.fit();

      // Pipe PTY output into the terminal (replays buffered scrollback immediately).
      const detach = connection.attach((chunk) => term?.write(chunk));
      // Forward keystrokes to the PTY.
      term.onData((data) => connection.sendInput(data));
      // Keep the PTY sized to this viewport.
      term.onResize(({ cols, rows }) => connection.resize(cols, rows));

      // Refit on container resize.
      const observer = new ResizeObserver(() => fit?.fit());
      observer.observe(viewport);

      return () => {
         detach();
         observer.disconnect();
         term?.dispose();
         term = null;
         fit = null;
      };
   });

   // Clear the terminal display whenever the session ends, so a stale session is not left on screen.
   $effect(() => {
      if (!connection.running) {
         term?.reset();
      }
   });

   // The active theme's background, used to match the terminal panel padding to the palette.
   const terminalBackground = $derived(TERMINAL_THEMES[terminalTheme.id].theme.background);

   // Re-theme the terminal live when the dropdown setting changes.
   $effect(() => {
      if (term) {
         term.options.theme = TERMINAL_THEMES[terminalTheme.id].theme;
      }
   });
</script>

<div
   class="wiretap__terminal"
   bind:this={viewport}
   style:background={terminalBackground}
></div>

<style lang="scss">
   .wiretap__terminal {
      flex: 1;
      min-height: 0;
      padding: $wiretap-padding;
   }
</style>
```

- [ ] **Step 2: Replace `src/components/Wiretap.svelte`** with the header/toolbar + conditional body:
```svelte
<script>
   import { onMount } from 'svelte';
   import { connection } from '~/bridge/TerminalConnection.svelte.js';
   import { popoutState } from '~/bridge/popoutState.svelte.js';
   import TerminalView from '~/components/TerminalView.svelte';

   /** @type {{ foundryApp: { isPopout?: boolean } }} */
   let { foundryApp } = $props();

   // Announce the pop-out's presence so the docked tab yields the single live terminal to it.
   onMount(() => {
      if (!foundryApp.isPopout) {
         return undefined;
      }
      popoutState.open = true;
      return () => {
         popoutState.open = false;
      };
   });

   // The pop-out always shows the terminal; the docked tab shows it only when no pop-out is open.
   const showTerminal = $derived(foundryApp.isPopout || !popoutState.open);

   /**
    * Toggle the terminal: launch the configured command if idle, otherwise close it.
    * @returns {void}
    */
   function toggle() {
      if (connection.running) {
         connection.close();
      } else {
         connection.launch(game.settings.get('wiretap', 'terminalCommand'));
      }
   }
</script>

<section class="wiretap">
   <header class="wiretap__header">
      <i class="fa-solid fa-user-secret"></i>
      <h2>{game.i18n.localize('WIRETAP.Title')}</h2>
      <span
         class="wiretap__status"
         data-status={connection.status}
      >
         {connection.status}
      </span>
      <button
         type="button"
         class="wiretap__toggle"
         disabled={connection.status !== 'connected'}
         onclick={toggle}
      >
         {connection.running ? game.i18n.localize('WIRETAP.Close') : game.i18n.localize('WIRETAP.Launch')}
      </button>
   </header>

   {#if showTerminal}
      <TerminalView />
   {:else}
      <p class="wiretap__popped-out">{game.i18n.localize('WIRETAP.PoppedOut')}</p>
   {/if}
</section>

<style lang="scss">
   .wiretap {
      display: flex;
      flex-direction: column;
      height: 100%;

      &__header {
         display: flex;
         align-items: center;
         gap: $wiretap-padding;

         i {
            color: $wiretap-accent;
         }
      }

      &__status {
         margin-left: auto;
         font-size: 12px;
      }

      &__toggle {
         border: 1px solid $wiretap-accent;
      }

      &__popped-out {
         flex: 1;
         display: flex;
         align-items: center;
         justify-content: center;
         opacity: 0.7;
      }
   }
</style>
```

- [ ] **Step 3: Update `src/apps/WiretapSidebarTab.js`** — give the pop-out a 4:3 default. Change the existing
`static DEFAULT_OPTIONS` block to include a `position`:
```js
   /**
    * Application options merged across the ApplicationV2 chain. `window.resizable` makes the popped-out
    * window user-resizable; `position` gives it a 4:3 default size (the docked sidebar tab ignores both).
    * @type {object}
    */
   static DEFAULT_OPTIONS = {
      position: {
         width: 800,
         height: 600,
      },
      window: {
         resizable: true,
      },
   };
```

- [ ] **Step 4: Add `lang/en.json` key** — add `"PoppedOut": "Terminal is popped out."` under `WIRETAP`
(alongside `Launch`/`Close`; mind commas).

- [ ] **Step 5: Replace `tests/unit/Wiretap.test.js`** to cover the refactor:
```js
import { render, screen } from '@testing-library/svelte';
import { describe, it, expect, vi, afterEach } from 'vitest';
import Wiretap from '~/components/Wiretap.svelte';
import { popoutState } from '~/bridge/popoutState.svelte.js';

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
      const { container } = render(Wiretap, { props: { foundryApp: { isPopout: true } } });
      expect(container.querySelector('.wiretap__terminal')).toBeTruthy();
      expect(screen.queryByText('WIRETAP.PoppedOut')).toBeNull();
   });
});
```

- [ ] **Step 6: Full gate.** `npm test && npm run eslint && npm run stylelint && npm run typecheck`. Expected: all pass.

- [ ] **Step 7: Commit:**
```bash
git add src/components/TerminalView.svelte src/components/Wiretap.svelte src/apps/WiretapSidebarTab.js lang/en.json tests/unit/Wiretap.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: pop-out takes over the live terminal; 4:3 default pop-out size\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: build gate, TODO, manual verification

**Files:** modify `TODO.md`

- [ ] **Step 1: Build + sanity.** `npm run build` (expect success). `node -e "const s=require('fs').readFileSync('index.js','utf8');['node-pty','registerProbe'].forEach(t=>{if(s.includes(t))throw new Error('leak: '+t)});console.log('OK')"` → `OK`. Then `rm -f registerProbe-*.js registerProbe-*.js.map "TerminalConnection.svelte-"*.js "TerminalConnection.svelte-"*.js.map "TerminalView.svelte-"*.js "TerminalView.svelte-"*.js.map`.

- [ ] **Step 2: Update `TODO.md`** — adjust the `#3 terminal UX polish` line, e.g.:
```markdown
- [ ] #3 terminal UX polish (theme dropdown ✓, popout-takeover + 4:3 default ✓; remaining: font-size setting, toolbar niceties, scrollback tuning)
```

- [ ] **Step 3: Commit:**
```bash
git add TODO.md
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'docs: note popout-takeover + 4:3 default in TODO\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 4: Manual verification (report; not automated).** With the sidecar running + live Foundry:
  1. Docked tab → Launch → terminal works.
  2. Pop out → the pop-out opens at ~4:3 (800×600) and is resizable; the docked sidebar now shows
     "Terminal is popped out."
  3. Resize the pop-out → only the pop-out reflows; the docked sidebar is unaffected (it's the placeholder).
  4. Close the pop-out → the terminal returns to the docked sidebar with its scrollback (re-attached).

---

## Self-review

**Design coverage:** popoutState store (Task 1) + connection size tracking so `launch` is term-independent
(Task 1); TerminalView extraction (Task 2 Step 1); Wiretap conditional render + popout tracking (Step 2);
4:3 pop-out default (Step 3); placeholder string (Step 4); tests incl. placeholder/popout cases (Step 5).

**Placeholder scan:** none; all code concrete.

**Type/name consistency:** `popoutState.open` set by the pop-out (`foundryApp.isPopout`) in Wiretap and read
in `showTerminal`. `connection.launch(command)` matches the new 1-arg signature (Task 1) and the Task 1 unit
test update. `TerminalView` imports the same `connection`/`terminalTheme`/`TERMINAL_THEMES` singletons. The
xterm mock includes `options`, `reset`, `onResize` used by TerminalView. `WIRETAP.PoppedOut` key matches the
component + tests. `WiretapSidebarTab.DEFAULT_OPTIONS` keeps `window.resizable` (from the earlier fix) and
adds `position`.

**Risk note:** the docked terminal unmounts/remounts as the pop-out opens/closes; on remount it re-attaches
and replays the client output buffer (existing `attach` behavior), so the session reappears with scrollback.
