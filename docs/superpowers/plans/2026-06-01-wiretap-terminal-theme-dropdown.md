# Wiretap — Terminal Theme Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).
> **Project rule:** route `.js`/`.svelte`/`.svelte.js` work to the `foundry-module-dev` contract (load svelte-5/foundry-vtt/foundry-svelte first); follow `.claude/CLAUDE.md` style.

**Goal:** Replace the hardcoded terminal theme with a client-scoped **dropdown setting** offering five palettes (default Tokyo Night), applied **live** to any open terminal (docked + pop-out).

**Architecture:** A `terminalThemes.svelte.js` module holds the five xterm palettes, a derived `choices` map for the setting, and a reactive `terminalTheme` store. `OnceInit` registers a `choices` setting (Foundry renders it as a `<select>`) whose `onChange` updates the store. `Wiretap.svelte` builds the terminal from the active theme and a `$effect` re-applies `term.options.theme` whenever the store changes.

**Tech:** Svelte 5 runes (`$state`/`$derived`/`$effect`), Foundry `game.settings.register` with `choices`, xterm `term.options.theme`.

**Spec:** `docs/superpowers/specs/2026-06-01-wiretap-terminal-theme-dropdown-design.md`

---

## File structure

| File | Change | Task |
|---|---|---|
| `src/components/terminalThemes.svelte.js` | NEW — themes map, choices, reactive store | 1 |
| `tests/unit/terminalThemes.test.js` | NEW — themes/choices integrity | 1 |
| `src/hooks/OnceInit.js` | register `terminalTheme` dropdown setting + seed store | 2 |
| `lang/en.json` | add `Settings.TerminalTheme.{Name,Hint}` | 2 |
| `src/components/Wiretap.svelte` | build terminal from active theme; `$effect` live-apply; reactive bg | 2 |
| `tests/unit/Wiretap.test.js` | extend xterm mock with `options = {}` | 2 |
| `TODO.md` | tick the theme-dropdown polish item | 3 |

---

### Task 1: Themes module (TDD)

**Files:** create `src/components/terminalThemes.svelte.js`, `tests/unit/terminalThemes.test.js`

- [ ] **Step 1: Write the failing test — `tests/unit/terminalThemes.test.js`:**
```js
import { describe, it, expect } from 'vitest';
import { TERMINAL_THEMES, TERMINAL_THEME_CHOICES, terminalTheme } from '~/components/terminalThemes.svelte.js';

const IDS = ['tokyo-night', 'tokyo-night-deep', 'wiretap-contrast', 'one-dark', 'dracula'];

describe('terminalThemes', () => {
   it('defines all five themes with a label and a background/foreground', () => {
      expect(Object.keys(TERMINAL_THEMES).sort()).toEqual([...IDS].sort());
      for (const id of IDS) {
         const entry = TERMINAL_THEMES[id];
         expect(entry.label, `${id} label`).toBeTruthy();
         expect(entry.theme.background, `${id} background`).toMatch(/^#/);
         expect(entry.theme.foreground, `${id} foreground`).toMatch(/^#/);
      }
   });

   it('derives a choices map of id -> label', () => {
      expect(Object.keys(TERMINAL_THEME_CHOICES).sort()).toEqual([...IDS].sort());
      for (const id of IDS) {
         expect(TERMINAL_THEME_CHOICES[id]).toBe(TERMINAL_THEMES[id].label);
      }
   });

   it('exposes a reactive store defaulting to tokyo-night', () => {
      expect(terminalTheme.id).toBe('tokyo-night');
   });
});
```

- [ ] **Step 2: Run it to verify it FAILS.** `npm test -- tests/unit/terminalThemes.test.js`. Expected: FAIL (module missing).

- [ ] **Step 3: Create `src/components/terminalThemes.svelte.js`:**
```js
/**
 * Terminal color themes for the embedded xterm terminal, selectable via the `terminalTheme` setting.
 * One module owns the palettes, the derived setting `choices` map, and the reactive active-theme store.
 */

/**
 * @typedef {object} TerminalThemeEntry
 * @property {string} label - Human-readable name shown in the settings dropdown.
 * @property {object} theme - An xterm `ITheme` (background, foreground, cursor, and the 16 ANSI colors).
 */

/**
 * The available terminal themes, keyed by id.
 * @type {Record<string, TerminalThemeEntry>}
 */
export const TERMINAL_THEMES = {
   'tokyo-night': {
      label: 'Tokyo Night',
      theme: {
         background: '#1a1b26', foreground: '#c0caf5', cursor: '#7aa2f7', cursorAccent: '#1a1b26',
         selectionBackground: '#28304d',
         black: '#414868', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
         blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
         brightBlack: '#565f89', brightRed: '#ff7a93', brightGreen: '#b9f27c', brightYellow: '#ff9e64',
         brightBlue: '#7da6ff', brightMagenta: '#bb9af7', brightCyan: '#0db9d7', brightWhite: '#c0caf5',
      },
   },
   'tokyo-night-deep': {
      label: 'Tokyo Night Deep',
      theme: {
         background: '#12131c', foreground: '#d7ddf2', cursor: '#4a9eff', cursorAccent: '#12131c',
         selectionBackground: '#28304d',
         black: '#414868', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
         blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
         brightBlack: '#565f89', brightRed: '#ff7a93', brightGreen: '#b9f27c', brightYellow: '#ff9e64',
         brightBlue: '#7da6ff', brightMagenta: '#bb9af7', brightCyan: '#0db9d7', brightWhite: '#ffffff',
      },
   },
   'wiretap-contrast': {
      label: 'Wiretap Contrast',
      theme: {
         background: '#0e0f14', foreground: '#e8eaf0', cursor: '#4a9eff', cursorAccent: '#0e0f14',
         selectionBackground: '#243049',
         black: '#2a2c33', red: '#ff6b6b', green: '#5af78e', yellow: '#f3f99d',
         blue: '#6cb6ff', magenta: '#c792ea', cyan: '#5ad4e6', white: '#d6dae0',
         brightBlack: '#5c6370', brightRed: '#ff8a8a', brightGreen: '#7ee787', brightYellow: '#ffe98a',
         brightBlue: '#8ac8ff', brightMagenta: '#ffb3e1', brightCyan: '#8ae6f2', brightWhite: '#ffffff',
      },
   },
   'one-dark': {
      label: 'One Dark',
      theme: {
         background: '#282c34', foreground: '#abb2bf', cursor: '#61afef', cursorAccent: '#282c34',
         selectionBackground: '#3e4451',
         black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
         blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
         brightBlack: '#4f5666', brightRed: '#ff7a85', brightGreen: '#a9d77f', brightYellow: '#f0ca8a',
         brightBlue: '#74c0ff', brightMagenta: '#d68ce6', brightCyan: '#63c6d2', brightWhite: '#ffffff',
      },
   },
   dracula: {
      label: 'Dracula',
      theme: {
         background: '#282a36', foreground: '#f8f8f2', cursor: '#bd93f9', cursorAccent: '#282a36',
         selectionBackground: '#44475a',
         black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
         blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
         brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
         brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
      },
   },
};

/**
 * Setting `choices` map (id -> label) derived from TERMINAL_THEMES, for the dropdown.
 * @type {Record<string, string>}
 */
export const TERMINAL_THEME_CHOICES = Object.fromEntries(
   Object.entries(TERMINAL_THEMES).map(([id, entry]) => [id, entry.label]),
);

/**
 * Reactive holder for the active theme id. The setting's onChange mutates `terminalTheme.id`, which the
 * terminal component observes to re-theme live.
 * @type {{ id: string }}
 */
export const terminalTheme = $state({ id: 'tokyo-night' });
```

- [ ] **Step 4: Run the test to verify it PASSES.** `npm test -- tests/unit/terminalThemes.test.js`. Expected: PASS (3 tests).

- [ ] **Step 5: Lint.** `npm run eslint -- src/components/terminalThemes.svelte.js`. Expected: clean.

- [ ] **Step 6: Commit:**
```bash
git add src/components/terminalThemes.svelte.js tests/unit/terminalThemes.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: add terminal theme palettes, choices, and reactive store\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Wire the dropdown setting + live-apply

**Files:** modify `src/hooks/OnceInit.js`, `lang/en.json`, `src/components/Wiretap.svelte`, `tests/unit/Wiretap.test.js`

- [ ] **Step 1: Register the setting in `src/hooks/OnceInit.js`.** Add an import near the top:
```js
import { TERMINAL_THEME_CHOICES, terminalTheme } from '~/components/terminalThemes.svelte.js';
```
Then, immediately AFTER the existing `terminalCommand` `game.settings.register(...)` block, insert:
```js

   // Color theme for the embedded terminal; Foundry renders `choices` as a dropdown. Applied live via the
   // reactive `terminalTheme` store that the tab component observes.
   game.settings.register('wiretap', 'terminalTheme', {
      name: 'WIRETAP.Settings.TerminalTheme.Name',
      hint: 'WIRETAP.Settings.TerminalTheme.Hint',
      scope: 'client',
      config: true,
      type: String,
      choices: TERMINAL_THEME_CHOICES,
      default: 'tokyo-night',
      onChange: (id) => {
         terminalTheme.id = id;
      },
   });

   // Seed the reactive store from the stored value (covers a non-default saved choice on load).
   terminalTheme.id = game.settings.get('wiretap', 'terminalTheme');
```

- [ ] **Step 2: Add localization keys to `lang/en.json`.** Inside the `Settings` object (after the
`TerminalCommand` block), add:
```json
         "TerminalTheme": {
            "Name": "Terminal Theme",
            "Hint": "Color theme for the embedded terminal."
         }
```
(Mind the trailing comma after the preceding `TerminalCommand` block.)

- [ ] **Step 3: Update `src/components/Wiretap.svelte`.** READ it first.
  (a) Add to the imports:
```js
   import { TERMINAL_THEMES, terminalTheme } from '~/components/terminalThemes.svelte.js';
```
  (b) Replace the hardcoded `theme: { ... }` inside the `new Terminal({ ... })` call so the constructor reads:
```js
      term = new Terminal({
         convertEol: false,
         cursorBlink: true,
         fontSize: 16,
         lineHeight: 1.3,
         fontFamily: "'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', Consolas, 'Courier New', monospace",
         theme: TERMINAL_THEMES[terminalTheme.id].theme,
      });
```
  (c) Add, at the top level of the `<script>` (e.g. just after the existing close-clearing `$effect`), a derived
  background and a live-theme effect:
```js

   // The active theme's background, used to match the terminal panel padding to the palette.
   const terminalBackground = $derived(TERMINAL_THEMES[terminalTheme.id].theme.background);

   // Re-theme any open terminal live when the dropdown setting changes (runs in docked + pop-out instances).
   $effect(() => {
      if (term) {
         term.options.theme = TERMINAL_THEMES[terminalTheme.id].theme;
      }
   });
```
  (d) Bind the panel background reactively — change the terminal div to:
```svelte
   <div
      class="wiretap__terminal"
      bind:this={viewport}
      style:background={terminalBackground}
   ></div>
```
  (e) In the `<style>`, remove the hardcoded `background: #1a1b26;` line from the `&__terminal` rule (the
  reactive `style:background` now supplies it). The rule becomes:
```scss
      &__terminal {
         flex: 1;
         min-height: 0;
         padding: $wiretap-padding;
      }
```

- [ ] **Step 4: Update the xterm mock in `tests/unit/Wiretap.test.js`.** Add an `options` field to the mocked
`Terminal` class so the live-theme `$effect` (`term.options.theme = …`) runs without error. The mock class
gains:
```js
      options = {};
```
(alongside the existing `cols`/`rows`/methods).

- [ ] **Step 5: Full gate.** `npm test && npm run eslint && npm run stylelint && npm run typecheck`. Expected:
all pass (unit suite includes the new themes test + the component test with the updated mock).

- [ ] **Step 6: Commit:**
```bash
git add src/hooks/OnceInit.js lang/en.json src/components/Wiretap.svelte tests/unit/Wiretap.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: terminal theme dropdown setting with live re-theming\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Build gate, TODO, manual verification

**Files:** modify `TODO.md`

- [ ] **Step 1: Production build.** `npm run build`. Expected: success; `index.js` + `style.css` emitted (no
significant size change — themes are small data).

- [ ] **Step 2: Sanity-check the bundle.** Run:
`node -e "const s=require('fs').readFileSync('index.js','utf8');['Tokyo Night','Dracula','One Dark'].forEach(t=>{if(!s.includes(t))throw new Error('missing theme label: '+t)});['node-pty','registerProbe'].forEach(t=>{if(s.includes(t))throw new Error('leak: '+t)});console.log('OK')"`
Expected: `OK` (theme labels bundled; no node-pty/probe leak).

- [ ] **Step 3: Clean any stray e2e chunk.** `rm -f registerProbe-*.js registerProbe-*.js.map "TerminalConnection.svelte-"*.js "TerminalConnection.svelte-"*.js.map`.

- [ ] **Step 4: Update `TODO.md`** — change the `#3 terminal UX polish` line to reflect the dropdown landing,
e.g. replace it with:
```markdown
- [ ] #3 terminal UX polish (theme dropdown ✓; remaining: font-size setting, toolbar niceties, scrollback tuning)
```

- [ ] **Step 5: Commit:**
```bash
git add TODO.md
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'docs: note terminal theme dropdown done in TODO\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 6: Manual verification (report; not automated).** With the sidecar running and the live Foundry
world:
  1. Open module **Settings** → a **Terminal Theme** dropdown lists the five themes; default Tokyo Night.
  2. Open the Wiretap tab, Launch a session.
  3. Change the dropdown to **Wiretap Contrast** / **Dracula** / etc. → the open terminal (and an open
     pop-out) re-themes **immediately**, and the panel background matches.

---

## Self-review

**Spec coverage:** §2.1 themes module → Task 1; §2.2 setting → Task 2 Step 1; §2.3 component apply + live
`$effect` + reactive bg → Task 2 Step 3; §2.4 lang → Task 2 Step 2; §4 testing → Task 1 test + Task 2 mock
update; §6 DoD → Tasks 2/3.

**Placeholder scan:** none; all five palettes and all edits are concrete.

**Type/name consistency:** `TERMINAL_THEMES` / `TERMINAL_THEME_CHOICES` / `terminalTheme` defined in Task 1,
imported identically by `OnceInit.js` (choices + store) and `Wiretap.svelte` (themes + store) in Task 2. The
setting key `terminalTheme` matches the store and the `default: 'tokyo-night'` matches the store's initial
`id`. The `$effect` assigns `term.options.theme`, and the Task 2 mock adds `options = {}` so that assignment
is valid in unit tests. Theme ids in the Task 1 test (`IDS`) match the keys in `TERMINAL_THEMES`.

**Note:** this supersedes the hardcoded theme block from commit `46f8b96` (Task 2 Step 3 replaces it); the
fontSize/lineHeight/fontFamily from that pass are retained.
