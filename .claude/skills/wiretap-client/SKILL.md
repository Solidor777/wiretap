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

- Vite builds `src/index.js` to `dist/index.js` and `dist/style.css` (named by `module.json`). `src/index.js` imports `~/styles/Global.scss`, `hooks/OnceInit.js`, `hooks/OnceReady.js` (`~` aliases `src/`).
- `OnceInit.js` sets `CONFIG.ui.wiretap = WiretapSidebarTab` (guarded on `foundry.applications.sidebar`
  availability) and registers the client settings `serverUrl`, `terminalCommand`, `terminalTheme`,
  `terminalFontSize` under module id `wiretap`, the risk-gate world settings (`registerGateSettings()` from
  `settings/gates.js`), plus the hidden client-scope `endpointKind` (`human` default, `agent`;
  `config: false`, no lang keys) that supplies `kind` in the bridge identify. It sets
  `game.modules.get('wiretap').api = { bridge: { get identified() } }`, a getter over `bridgeState.identified` exported
  by `bridge/foundryBridge.js` (true only after an ok identify ack; false on disconnect, refusal or a new identify) so
  a Playwright page can wait on it. The e2e probe (`test-probe/registerProbe.js`) is loaded from there
  by a guarded dynamic import that is only valid in the e2e build.
- `OnceReady.js` connects the shared `connection` (TerminalConnection), registers the shipped scripts
  (`registerShippedScripts()`, see `wiretap-scripts`) and calls `initFoundryBridge(connection)` (see `wiretap-mcp-bridge`);
  all three are GM-only. `initFoundryBridge` emits the identify (protocol v4, with `gateState: readGateState()`; it also pushes `BRIDGE_GATE_STATE` on gate setting changes)
  `{ protocolVersion, userId, userName, isGM, kind, dom: true }` with an ack callback on every (re)connect; a refused
  ack is logged with `console.error` (`Wiretap | bridge identify refused (<code>): <message>`, plus a reload-Foundry
  hint for `PROTOCOL_MISMATCH`). Op failures ack `{ ok: false, error: { code: OP_FAILED, message } }`.
  Each identify gets a per-attempt token (also bumped on disconnect); an ack for any earlier token is ignored, so a
  stale ok or refusal never changes `identified`. `endpointKind` has an `onChange` calling `reidentifyBridge()`, which
  emits a fresh identify only when the socket is connected and the setting differs from the kind last sent. The op
  table built by `initFoundryBridge(connection, { scripts? })` holds one op, `callTool`, served from the script registry
  (default: the client's own); lookup uses `Object.hasOwn`, so inherited names (`constructor`, `__proto__`) and the
  removed `createActor` ack `OP_FAILED` unknown op. The `BRIDGE_INVOKE` listener runs wholly inside one `try`, so a request
  that is not an object, an unreadable op or a missing or throwing ack callback never becomes an unhandled rejection
  (`replyInvoke` ignores a missing ack and logs a throwing one). A failed op acks the `code` of a thrown `ScriptError` and `OP_FAILED`
  otherwise, with the message bounded to 256 bytes. After each ok identify ack (and, queued as one microtask per task, on every registry change while
  identified and connected) the bridge emits `bridge:registry` `{ apiVersion, scripts }` with an ack callback: counts of
  refused entries are logged with `console.warn`, a failed registry with `console.error`.
  `initFoundryBridge` also registers a `BRIDGE_PING` listener that acks `{ ok: true }` and does nothing else; it
  ignores identify state and does nothing when the ack argument is absent or not a function.

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
| `settings/gates.js` | `registerGateSettings()`: one world-scope, `restricted`, `config: true`, default-closed setting per `GATES` entry of `shared/gates.js` (iterated, no second list); a `boolean` gate is a Boolean, `allowedPluginModules` a String of comma-separated module ids (default `''`; Foundry has no list-of-strings setting editor). `gateLangKey(name, 'Name' \| 'Hint')` derives the `lang/en.json` key `WIRETAP.Settings.Gates.<Name with first letter upper-cased>.<Name\|Hint>`; the hints of `allowMacroExecution`, `allowAgentScripts` and `allowedPluginModules` state the arbitrary-code caveat |
| `bridge/scripts/**` | The client script runtime: registry, `callTool` dispatcher, `ctx`, the shipped scripts `create_actor`, `list_document_types`, `get_document`, `search_documents` and `describe_schema`, the canonical document export (see `wiretap-scripts`) |
| `bridge/gates.js` | `readGateState()` (reads `game.settings` for every gate, a throwing read leaves the gate out, parses the module string, returns `sanitizeGateState(raw)`), `requireGate(name, moduleId?)` (`gateDenial(readGateState(), name, moduleId)`: reads this client's settings at call time, params never carry a gate value) and `gateNameFromSettingKey(key)` (gate name for a `wiretap.<gate>` key, else null) |
| `test-probe/registerProbe.js` | e2e-only probe (must never ship in the production build); `_probe.scripts.registerE2e()` registers the e2e-only `e2e_gated` script |

## Rules specific to this subsystem

- Pure Svelte 5 runes mounted directly into ApplicationV2; never TyphonJS.
- Terminal wire constants come from `$shared/protocol.js` (`TERMINAL_*`), never string literals.
- Settings, localization strings (`lang/en.json`) and keys must stay in sync when adding UI.
- Unit tests live in `tests/unit/` (`Wiretap`, `TerminalToolbar`, `TerminalConnection*`, `terminalController`,
  `terminalFontSize`, `terminalThemes`, `OnceInit` which asserts the `serverUrl` default `http://127.0.0.1:31416`
  matching the sidecar's IPv4 loopback bind, the `endpointKind` setting and `api.bridge.identified`; identify/ack and `BRIDGE_PING`
  behavior is in `foundryBridge.identify.test.js`; gates: `gateSettings` (registration iterates `GATES`, lang keys for every gate, caveat text), `bridgeGates` (`readGateState` with hostile values, `requireGate`), `foundryBridge.gatePush` (identify payload and push), `foundryBridge.noSettingWrites`); e2e in `tests/e2e/` (see `wiretap-build-test`).
