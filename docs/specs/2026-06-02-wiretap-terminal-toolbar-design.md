# Wiretap — Terminal Toolbar (Clear · Copy · Font ± · Restart) + Persisted Font Size

**Status:** Approved (design)
**Date:** 2026-06-02

## Goal

Add a slim toolbar of terminal controls to the Wiretap tab — Clear, Copy, Font size −/+, and Restart —
shown alongside the live terminal. Font size becomes a persisted, live-applied client setting (folding in the
separate "font-size setting" TODO item).

## Background

The Wiretap tab's header (`Wiretap.svelte`) currently holds the icon, title, a status badge, and a single
Launch/Close button. The xterm `term` instance lives in the child `TerminalView.svelte`; the socket/PTY lives
in the `connection` singleton (`src/bridge/TerminalConnection.svelte.js`). The reactive `terminalTheme` store
(`src/components/terminalThemes.svelte.js`) shows the established pattern for a setting-backed reactive value
that `TerminalView` observes and live-applies.

Three of the four controls (Clear, Copy, Font ±) need the live `term`, which is not reachable from the header
today — so this design adds a small view-side controller the terminal registers itself with. Restart only
needs `connection`.

## Scope

In scope: `TerminalToolbar.svelte`; a `terminalController` singleton (active-term ref + clear/copy);
a `terminalFontSize` store + persisted client setting + live `TerminalView` application; a `connection.restart`
method; the three-way body already in `Wiretap.svelte` gains the toolbar in its connected branch; lang keys;
tests.

Out of scope: scrollback tuning, other toolbar items (search, scroll-to-bottom), server-side scrollback
changes, clearing the server/shared output buffer on Clear.

Closes the TODO item: "(#3) font-size setting".

## Design

### 1. Persisted, live font size

**`src/components/terminalFontSize.svelte.js`** (new) — mirrors `terminalThemes.svelte.js`:

```js
// Min/max/step bounds for the terminal font size, shared by the setting range and the toolbar +/- clamp.
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const FONT_SIZE_STEP = 2;
export const FONT_SIZE_DEFAULT = 16;

// Reactive holder for the active terminal font size (px). The setting onChange and the toolbar both update
// `terminalFontSize.size`, which the terminal component observes to re-apply live.
export const terminalFontSize = $state({ size: FONT_SIZE_DEFAULT });

// Clamp a candidate size to the allowed range (used by the toolbar +/- handlers).
export function clampFontSize(size) {
   return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size));
}
```

**Setting registration** in `src/hooks/OnceInit.js` (alongside the existing `terminalTheme` registration):
a client-scoped `terminalFontSize` Number setting, `config: true`, `default: FONT_SIZE_DEFAULT`,
`range: { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, step: FONT_SIZE_STEP }` (Foundry renders a slider),
`onChange: (size) => { terminalFontSize.size = size; }`. After registration, seed the store from the stored
value: `terminalFontSize.size = game.settings.get('wiretap', 'terminalFontSize');` (mirrors the theme seed).

**`TerminalView.svelte`** — use `terminalFontSize.size` for the initial `Terminal` `fontSize`, and add an
`$effect` that re-applies and refits when it changes:

```js
$effect(() => {
   if (term) {
      term.options.fontSize = terminalFontSize.size;
      fit?.fit();
   }
});
```

(Place beside the existing live-theme `$effect`. The `fit?.fit()` reflows rows/cols and the existing
`onResize` handler propagates the new size to the PTY.)

### 2. Active-terminal controller (Clear / Copy)

**`src/components/terminalController.svelte.js`** (new) — a singleton holding the active xterm `term`:

```js
class TerminalController {
   /** The active xterm Terminal, or null when no terminal view is mounted. */
   term = null;

   // Clear the on-screen terminal (view only; the server scrollback is untouched).
   clear() { this.term?.clear(); }

   // Copy the current selection to the clipboard; if nothing is selected, copy the whole buffer.
   async copy() {
      const term = this.term;
      if (!term) { return; }
      let text = term.getSelection();
      if (!text) {
         term.selectAll();
         text = term.getSelection();
         term.clearSelection();
      }
      if (!text) { return; }
      try {
         await navigator.clipboard.writeText(text);
         ui.notifications?.info(game.i18n.localize('WIRETAP.Copied'));
      } catch (error) {
         ui.notifications?.warn(game.i18n.localize('WIRETAP.CopyFailed'));
      }
   }
}
export const terminalController = new TerminalController();
```

**`TerminalView.svelte`** registers/deregisters its term: set `terminalController.term = term;` after
`term.open(viewport)` in `onMount`, and `terminalController.term = null;` in the `onMount` cleanup (next to
`term?.dispose()`). Because pop-out-takeover guarantees only one `TerminalView` is mounted at a time, exactly
one term is ever registered.

### 3. One-click Restart

**`src/bridge/TerminalConnection.svelte.js`** — add a pending-relaunch field and a `restart` method, and fire
the pending launch when the PTY exits:

```js
// A command to launch once the current PTY has exited, set by restart() while a PTY is still running.
#pendingRelaunch = null;

restart(command) {
   if (this.running) {
      this.#pendingRelaunch = command;
      this.close();
   } else {
      this.launch(command);
   }
}
```

In the existing `TERMINAL_EXIT` handler (which sets `this.running = false`), after clearing running, if
`#pendingRelaunch` is set, capture and clear it and `this.launch(captured)`. The server sets its `term = null`
in `onExit` before emitting `TERMINAL_EXIT`, so the follow-up launch spawns cleanly; the tracked `#cols/#rows`
preserve the size.

### 4. Toolbar component + placement

**`src/components/TerminalToolbar.svelte`** (new) — a slim row of icon buttons. Reads `connection` for the
disabled state and the command setting; calls `terminalController`, the font store, and `connection.restart`.

- **Clear** — `onclick={() => terminalController.clear()}`, `disabled={!connection.running}`.
- **Copy** — `onclick={() => terminalController.copy()}`, `disabled={!connection.running}`.
- **Font −** — decrease: `setFontSize(clampFontSize(terminalFontSize.size - FONT_SIZE_STEP))`; always enabled;
  `disabled` at `FONT_SIZE_MIN`.
- **Font +** — increase symmetrically; `disabled` at `FONT_SIZE_MAX`.
- **Restart** — `onclick={() => connection.restart(game.settings.get('wiretap', 'terminalCommand'))}`,
  `disabled={!connection.running}`.

`setFontSize(size)` writes through the setting: `game.settings.set('wiretap', 'terminalFontSize', size)` (its
`onChange` updates the store, keeping the settings slider and toolbar in sync). Each button is icon-only
(Font Awesome) with a localized `title` and `aria-label`. SCSS class selectors nested under `.wiretap`
(`&__toolbar`, `&__tool`) to satisfy the repo's stylelint kebab `selector-class-pattern`.

**`Wiretap.svelte`** — render the toolbar above the terminal in the connected branch only:

```svelte
   {#if !showTerminal}
      <p class="wiretap__popped-out">{game.i18n.localize('WIRETAP.PoppedOut')}</p>
   {:else if connection.status === 'connected'}
      <TerminalToolbar />
      <TerminalView />
   {:else}
      <SidecarOffline />
   {/if}
```

The toolbar shows only with the live terminal (not on offline/popped-out states). The header's Launch/Close
button is unchanged.

### 5. i18n

Add under `WIRETAP`:
- `Toolbar.Clear` — "Clear terminal"
- `Toolbar.Copy` — "Copy"
- `Toolbar.Restart` — "Restart"
- `Toolbar.FontDecrease` — "Decrease font size"
- `Toolbar.FontIncrease` — "Increase font size"
- `Copied` — "Copied to clipboard."
- `CopyFailed` — "Could not copy to clipboard."
- `Settings.FontSize.Name` — "Terminal Font Size"
- `Settings.FontSize.Hint` — "Font size (px) of the embedded terminal."

## Behavior notes

- **Clear is view-only.** `term.clear()` wipes the visible scrollback but not the server scrollback or the
  client output buffer, so a reconnect or a dock↔pop-out swap repaints history. This is standard terminal-clear
  behavior and is accepted (no shared-buffer reset).
- **Copy** copies the selection, or the whole buffer when nothing is selected; clipboard access works in
  Foundry's localhost (secure) context, with a warning toast on failure.
- **Restart** is close-then-relaunch orchestrated client-side via `#pendingRelaunch`; size is preserved.
- **Font ±** persist immediately and apply live; the same value drives the settings-menu slider.

## Testing

- **`terminalController`** (`tests/unit/terminalController.test.js`): `clear()` calls `term.clear()`; `copy()`
  with a selection copies it; `copy()` with no selection selects-all then copies the buffer; both write via a
  mocked `navigator.clipboard.writeText`; no-op when `term` is null. (Mock `ui.notifications` /
  `game.i18n.localize`.)
- **`connection.restart`** (extend `tests/unit/TerminalConnection.test.js`): when running, `restart` emits
  `TERMINAL_CLOSE` and does not immediately emit `TERMINAL_LAUNCH`; after a simulated `TERMINAL_EXIT`, it emits
  `TERMINAL_LAUNCH` with the command. When idle, `restart` emits `TERMINAL_LAUNCH` immediately.
- **`terminalFontSize`** (`tests/unit/terminalFontSize.test.js`): `clampFontSize` clamps below `MIN` to `MIN`,
  above `MAX` to `MAX`, leaves in-range values unchanged.
- **`TerminalToolbar.svelte`** (`tests/unit/TerminalToolbar.test.js`): renders 5 buttons; Clear/Copy/Restart
  are disabled when `connection.running` is false and enabled when true; Font −/+ disabled at the respective
  bounds; clicking each calls the right singleton (spies on `terminalController.clear/copy`,
  `connection.restart`, and `game.settings.set`).
- **`Wiretap.svelte`** (extend `tests/unit/Wiretap.test.js`): the toolbar (e.g. the Clear button by aria-label)
  is present in the connected branch and absent in the offline/popped-out branches.
- **Test mocks:** extend `tests/setup.js` with `game.settings.set` (used by the toolbar) and `ui.notifications`
  (`info`/`warn` stubs) so the components render and act in tests.
- Full gate must pass: `npm test && npm run eslint && npm run stylelint && npm run typecheck`, plus
  `npm run build` with the existing leak check. Manual verification (live Foundry) for the actual button
  behaviors and the settings slider.

## Docs

- **TODO.md:** tick the font-size item / extend the `#3` line to record the toolbar + persisted font size.

## File summary

| File | Change |
|---|---|
| `src/components/terminalFontSize.svelte.js` | NEW — bounds, reactive store, `clampFontSize` |
| `src/components/terminalController.svelte.js` | NEW — active-term ref + `clear()`/`copy()` |
| `src/components/TerminalToolbar.svelte` | NEW — icon-button toolbar row |
| `src/components/TerminalView.svelte` | register/deregister term; live font-size `$effect`; initial fontSize from store |
| `src/components/Wiretap.svelte` | render `<TerminalToolbar />` above `<TerminalView />` in the connected branch |
| `src/bridge/TerminalConnection.svelte.js` | `#pendingRelaunch` + `restart()`; relaunch on `TERMINAL_EXIT` |
| `src/hooks/OnceInit.js` | register `terminalFontSize` Number/range setting; seed the store |
| `lang/en.json` | `WIRETAP.Toolbar.*`, `Copied`, `CopyFailed`, `Settings.FontSize.*` |
| `tests/setup.js` | add `game.settings.set` + `ui.notifications` stubs |
| `tests/unit/terminalController.test.js` | NEW |
| `tests/unit/terminalFontSize.test.js` | NEW |
| `tests/unit/TerminalToolbar.test.js` | NEW |
| `tests/unit/TerminalConnection.test.js` | add `restart` cases |
| `tests/unit/Wiretap.test.js` | toolbar present/absent per branch |
| `TODO.md` | record toolbar + persisted font size; close font-size item |
