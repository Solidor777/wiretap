# Wiretap — Terminal Theme Dropdown Design

**Date:** 2026-06-01
**Status:** Approved (design); pending implementation plan
**Scope:** Make the terminal's color theme a user-selectable dropdown setting (part of the #3 terminal UX-polish track), applied live to open terminals.

## 0. Context

Sub-project #2 shipped a `node-pty` + `xterm.js` terminal in the Wiretap tab. A first readability pass
(commit `46f8b96`) hardcoded a Tokyo Night theme + 16px crisp monospace. Brainstorming (with the visual
companion) settled that the user wants to **choose** the palette from a **dropdown**, not have one baked in.
This spec supersedes the hardcoded theme block with a setting-driven theme system.

## 1. Decisions (locked in brainstorming)

- **Five themes** in the dropdown: Tokyo Night, Tokyo Night Deep (hybrid: TN palette, deeper bg, brighter
  fg, Wiretap-blue cursor), Wiretap Contrast (near-black, brightest, Wiretap-blue cursor), One Dark, Dracula.
- **Default:** Tokyo Night.
- **Apply live:** changing the dropdown updates any open terminal immediately (docked tab + pop-out).
- **Font size stays 16px** (with the existing line-height / monospace stack); a size dropdown is explicitly
  deferred (could be added the same way).
- The setting is **client-scoped** (per machine/user), like `serverUrl` / `terminalCommand`.

## 2. Components

### 2.1 `src/components/terminalThemes.svelte.js` (new) — source of truth
- `export const TERMINAL_THEMES` — a map `id → { label: string, theme: object }`, where `theme` is a full
  xterm `ITheme` (background, foreground, cursor, cursorAccent, selectionBackground, and the 16 ANSI colors)
  for each of the five themes.
- `export const TERMINAL_THEME_CHOICES` — derived `id → label` map (`Object.fromEntries(... )`) for the
  Foundry setting's `choices`.
- `export const terminalTheme = $state({ id: 'tokyo-night' })` — a tiny reactive store holding the active
  theme id. Mutating `terminalTheme.id` notifies the component(s).

(One `.svelte.js` module: it exports plain data consts AND the rune-backed reactive store.)

### 2.2 `src/hooks/OnceInit.js` (modify) — the dropdown setting
Register after the existing `terminalCommand` setting:
```js
game.settings.register('wiretap', 'terminalTheme', {
   name: 'WIRETAP.Settings.TerminalTheme.Name',
   hint: 'WIRETAP.Settings.TerminalTheme.Hint',
   scope: 'client',
   config: true,
   type: String,
   choices: TERMINAL_THEME_CHOICES,   // Foundry renders a <select> dropdown for `choices`.
   default: 'tokyo-night',
   onChange: (id) => { terminalTheme.id = id; },
});
// Seed the reactive store from the stored value (handles a non-default saved choice on load).
terminalTheme.id = game.settings.get('wiretap', 'terminalTheme');
```

### 2.3 `src/components/Wiretap.svelte` (modify) — apply + live-update
- Import `TERMINAL_THEMES` and `terminalTheme`.
- Create the `Terminal` with `theme: TERMINAL_THEMES[terminalTheme.id].theme` (keep `fontSize: 16`,
  `lineHeight: 1.3`, the monospace `fontFamily`).
- Add `$effect(() => { if (term) { term.options.theme = TERMINAL_THEMES[terminalTheme.id]?.theme; } });`
  so changing the setting re-themes the live terminal (this runs in every mounted instance → docked + pop-out
  both update).
- Make the panel background reactive: a `$derived` of the active theme's `background`, bound via
  `style:background` on the `.wiretap__terminal` div (replacing the hardcoded `background: #1a1b26` in SCSS),
  so the padding area always matches the selected theme.

### 2.4 `lang/en.json` (modify)
Add `Settings.TerminalTheme.{Name,Hint}` (e.g. Name "Terminal Theme", Hint "Color theme for the embedded
terminal.").

## 3. Live-apply data flow

1. Foundry `init` → register `terminalTheme` (dropdown) → seed `terminalTheme.id` from the stored value.
2. Component mounts → `Terminal({ theme: TERMINAL_THEMES[terminalTheme.id].theme, … })`; panel bg bound to
   the active theme bg.
3. User changes the dropdown in Settings → setting `onChange(id)` → `terminalTheme.id = id` → every mounted
   component's `$effect` sets `term.options.theme` (xterm re-renders) and the bound panel bg updates. No
   reload needed.

## 4. Testing

- **Unit (`tests/unit/Wiretap.test.js`)**: extend the xterm `Terminal` mock with `options = {}` so the
  theme-applying `$effect` (`term.options.theme = …`) runs without error; existing assertions still hold.
- **Unit (`tests/unit/terminalThemes.test.js`, new)**: assert `TERMINAL_THEMES` has all five ids, each with
  a non-empty `label` and a `theme` carrying `background` + `foreground`; assert `TERMINAL_THEME_CHOICES`
  maps each id to its label.
- **Manual**: open the tab, change the Terminal Theme dropdown in module settings → the docked tab (and an
  open pop-out) re-theme immediately; the default is Tokyo Night.

## 5. Out of scope

Font-size dropdown (deferred); adding/removing themes beyond the five; per-world (vs per-client) scope.

## 6. Definition of done

A **Terminal Theme** dropdown appears in Wiretap's module settings with the five themes (default Tokyo
Night); selecting one re-themes any open terminal live (docked + pop-out); the panel background matches the
selected theme; unit tests (mock + themes-module) pass; `npm run build`, eslint, stylelint, typecheck stay
green; the browser bundle is unaffected in size class (no new heavy deps).
