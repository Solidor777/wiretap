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
  `terminalFontSize` under module id `wiretap`, plus the hidden client-scope `endpointKind` (`human` default, `agent`;
  `config: false`, no lang keys) that supplies `kind` in the bridge identify. It sets
  `game.modules.get('wiretap').api = { bridge: { get identified() } }`, a getter over `bridgeState.identified` exported
  by `bridge/foundryBridge.js` (true only after an ok identify ack; false on disconnect, refusal or a new identify) so
  a Playwright page can wait on it. The e2e probe (`test-probe/registerProbe.js`) is loaded from there
  by a guarded dynamic import that is only valid in the e2e build.
- `OnceReady.js` connects the shared `connection` (TerminalConnection) and calls `initFoundryBridge(connection)`
  (see `wiretap-mcp-bridge`). `initFoundryBridge` emits the protocol v2 identify
  `{ protocolVersion, userId, userName, isGM, kind, dom: true }` with an ack callback on every (re)connect; a refused
  ack is logged with `console.error` (`Wiretap | bridge identify refused (<code>): <message>`, plus a reload-Foundry
  hint for `PROTOCOL_MISMATCH`). Op failures ack `{ ok: false, error: { code: OP_FAILED, message } }`.
  Each identify gets a per-attempt token (also bumped on disconnect); an ack for any earlier token is ignored, so a
  stale ok or refusal never changes `identified`. `endpointKind` has an `onChange` calling `reidentifyBridge()`, which
  emits a fresh identify only when the socket is connected and the setting differs from the kind last sent. Op lookup
  uses `Object.hasOwn(OP_HANDLERS, op)`, so inherited names (`constructor`, `__proto__`) ack `OP_FAILED` unknown op.

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
  `terminalFontSize`, `terminalThemes`, `OnceInit` which asserts the `serverUrl` default `http://127.0.0.1:31416`
  matching the sidecar's IPv4 loopback bind, the `endpointKind` setting and `api.bridge.identified`; identify/ack
  behavior is in `foundryBridge.identify.test.js`); e2e in `tests/e2e/` (see `wiretap-build-test`).
