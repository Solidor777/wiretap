---
name: wiretap-client
description: Wiretap Foundry-client code — sidebar tab, Svelte 5 terminal UI, TerminalConnection socket client, terminal themes/font size, init/ready hooks, localization. Use when reading or editing anything under src/ or lang/.
paths:
  - "src/**"
  - "lang/**"
---

# Wiretap client (`src/`)

Current-state reference; verify against code before relying on a detail. Core context: `wiretap-codebase-core`.
For Svelte/Foundry syntax defer to the `svelte-5`, `foundry-vtt`, `foundry-svelte` skills.

## Entry and lifecycle

- `src/index.js` imports `~/styles/Global.scss`, `hooks/OnceInit.js`, `hooks/OnceReady.js` (`~` aliases `src/`).
- `OnceInit.js` sets `CONFIG.ui.wiretap = WiretapSidebarTab` (guarded on `foundry.applications.sidebar`
  availability) and registers the world-agnostic settings `serverUrl`, `terminalCommand`, `terminalTheme`,
  `terminalFontSize` under module id `wiretap`. The e2e probe (`test-probe/registerProbe.js`) is loaded from there
  by a guarded dynamic import that is only valid in the e2e build.
- `OnceReady.js` connects the shared `connection` (TerminalConnection) and calls `initFoundryBridge(connection)`
  (see `wiretap-mcp-bridge`).

## Pieces

| File | Role |
|---|---|
| `apps/WiretapSidebarTab.js` | `extends foundry.applications.sidebar.AbstractSidebarTab`; mounts/unmounts `components/Wiretap.svelte` with Svelte `mount`/`unmount` |
| `components/Wiretap.svelte` | docked/pop-out panel; composes `TerminalView`, `TerminalToolbar`, `SidecarOffline` |
| `components/terminalController.js` | `terminalController` singleton wrapping the xterm instance (clear/copy/etc.) |
| `components/terminalThemes.svelte.js` | `TERMINAL_THEMES`, `TERMINAL_THEME_CHOICES`, `terminalTheme` rune state (default `tokyo-night`) |
| `components/terminalFontSize.svelte.js` | `terminalFontSize` rune state; `FONT_SIZE_MIN 8`, `MAX 32`, `STEP 2`, `DEFAULT 16`; `clampFontSize` |
| `bridge/TerminalConnection.svelte.js` | `TerminalConnection` class + `connection` singleton: Socket.IO client to the sidecar, terminal events, `onSocket` hook for sharing the socket |
| `bridge/popoutState.svelte.js` | `popoutState` rune state `{ open }` |
| `test-probe/registerProbe.js` | e2e-only probe (must never ship in the production build) |

## Rules specific to this subsystem

- Pure Svelte 5 runes mounted directly into ApplicationV2; never TyphonJS.
- Terminal wire constants come from `$shared/protocol.js` (`TERMINAL_*`), never string literals.
- Settings, localization strings (`lang/en.json`) and keys must stay in sync when adding UI.
- Unit tests live in `tests/unit/` (`Wiretap`, `TerminalToolbar`, `TerminalConnection*`, `terminalController`,
  `terminalFontSize`, `terminalThemes`); e2e in `tests/e2e/` (see `wiretap-build-test`).
