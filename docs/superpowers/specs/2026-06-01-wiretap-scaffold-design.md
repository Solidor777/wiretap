# Wiretap — Package Scaffold Design

**Date:** 2026-06-01
**Status:** Approved (design); pending implementation plan
**Scope:** Build/tooling scaffold + proof-of-pipeline UI only. The AI-agent bridge is out of scope (future specs).

## 1. Goal

Stand up the Wiretap Foundry VTT **module** package — Svelte 5 (runes) + SCSS + Vite — using the
`titan` system (`C:\FoundryVTT\V14\dev\foundryuserdata\Data\systems\titan`) as the proven build
reference and `adambdooley/foundry-vtt-mcp` as the conceptual inspiration for the eventual AI
bridge.

The scaffold proves one thing end-to-end:

> Vite → Svelte 5 + SCSS → a `module.json` that Foundry v14 loads → a **Wiretap** sidebar tab that
> mounts a Svelte component and pops out into its own window, exactly like the Combat tab.

No AI-bridge logic is built in this spec.

## 2. Approach

**C — Hybrid.** Copy titan's battle-tested *tooling/build* configs verbatim (re-pointing IDs and
paths), but author a **fresh, minimal `src/`** with no titan domain code.

Rejected alternatives:
- **A — Clone-and-strip:** leaves dead config references and titan cruft to hunt down.
- **B — Clean from scratch:** risks subtle drift from titan's proven Foundry+Vite+Svelte build
  (proxy rules, `cssFileName: 'style'`, probe gate).

## 3. Architecture & file tree

```
wiretap/
├── module.json                 # manifest (fresh; v14)
├── package.json                # copied from titan, re-pointed
├── vite.config.mjs             # copied; s_PACKAGE_ID → "modules/wiretap", probe define renamed
├── svelte.config.js            # copied verbatim
├── vitest.config.mjs           # copied verbatim
├── playwright.config.mjs       # copied; paths/URLs re-pointed
├── eslint.config.js            # copied verbatim
├── .stylelintrc.json           # copied verbatim
├── jsconfig.json               # copied; ~/* → src/*, foundry globs kept
├── .gitignore                  # already present (titan-derived) — keep
├── README.md / CHANGELOG.md / LICENSE-MIT
├── lang/en.json                # WIRETAP.* localization keys
├── src/
│   ├── index.js                # entry: import global SCSS, register hooks
│   ├── apps/
│   │   └── WiretapSidebarTab.js # extends AbstractSidebarTab; mounts Svelte; popout free
│   ├── components/
│   │   └── Wiretap.svelte      # proof-of-pipeline component (runes)
│   ├── hooks/
│   │   ├── OnceInit.js         # register CONFIG.ui.wiretap + Sidebar.TABS.wiretap
│   │   └── OnceReady.js        # readiness log
│   ├── styles/
│   │   ├── Root.scss           # vars/mixins auto-prepended to every component
│   │   ├── Global.scss         # global module styles
│   │   └── Mixins/             # (scaffold-empty, parity with titan)
│   └── test-probe/             # __WIRETAP_PROBE__ gated harness (e2e parity)
├── tests/
│   ├── unit/                   # one vitest smoke test
│   └── e2e/                    # one playwright smoke test
└── (build outputs: index.js, index.js.map, style.css — gitignored)
```

Build outputs land at the repo root (titan's pattern: `root: src/`, lib entry `src/index.js`,
`outDir: __dirname`, `cssFileName: 'style'`), so `module.json` points at `index.js` + `style.css`.

## 4. Build & tooling configs (copied + re-pointed)

| File | Change from titan |
|---|---|
| `package.json` | `name: "wiretap"`, fresh `description`/`author`, repo URL → `Solidor777/wiretap`; **scripts identical** (`build`, `build:e2e`, `dev`, `test`, `test:e2e`, `eslint`, `stylelint`); same devDependencies and exact version pins (`vite ^8`, `vitest ^4`, `svelte ^5`, vite-plugin-svelte, happy-dom, playwright, testing-library, eslint + jsdoc/svelte, stylelint + scss, sass-embedded, autoprefixer, terser). Drop titan runtime deps (`short-unique-id`, `tippy.js`). |
| `vite.config.mjs` | `s_PACKAGE_ID = "modules/wiretap"`; rename probe define `__TITAN_PROBE__` → `__WIRETAP_PROBE__`. Else verbatim: `root: src/`, ESM lib, `cssFileName: 'style'`, `outDir: __dirname`, dev proxy to `:30000`, `~/` + `$fonts/` aliases. |
| `svelte.config.js` | Verbatim — `sveltePreprocess` with `prependData: '@use "src/styles/Root.scss" as *;'`. |
| `vitest.config.mjs` | Verbatim. |
| `playwright.config.mjs` | Re-point titan paths/URLs to wiretap; else verbatim. |
| `eslint.config.js` | Verbatim (jsdoc + svelte rules enforce the CLAUDE.md style). |
| `.stylelintrc.json` | Verbatim (scss-standard + html). |
| `jsconfig.json` | `~/*` → `src/*`; keep foundry common/public globs for IntelliSense. |
| `fonts/` | Omitted; `$fonts/` alias stays but resolves to an (absent) dir until fonts are added. |

Exact titan version pins are copied so the build behaves identically to the known-good one.

## 5. Manifest (`module.json`)

```jsonc
{
  "id": "wiretap",
  "title": "Wiretap",
  "description": "Adds a tab and bridge for AI agents inside Foundry VTT.",
  "version": "0.0.1",
  "compatibility": { "minimum": "13", "verified": "14", "maximum": "14" },
  "authors": [{ "name": "Solidor", "discord": "solidor" }],
  "esmodules": ["index.js"],
  "styles": ["style.css"],
  "languages": [{ "lang": "en", "name": "English", "path": "lang/en.json" }],
  "socket": true,
  "url": "https://github.com/Solidor777/wiretap",
  "bugs": "https://github.com/Solidor777/wiretap/issues",
  "manifest": "https://github.com/Solidor777/wiretap/releases/latest/download/module.json",
  "download": "https://github.com/Solidor777/wiretap/releases/latest/download/wiretap.zip",
  "license": "LICENSE-MIT"
}
```

- `compatibility.minimum: "13"` — `AbstractSidebarTab` exists in v13, so a v13 floor is cheap;
  `verified`/`maximum` are `"14"`.
- `socket: true` — retained now since the eventual AI bridge will likely use Foundry's socket.
- No `documentTypes` / `packs` / `grid` — not needed for a UI/bridge module.

## 6. `src/` — proof-of-pipeline code

### 6.1 Sidebar tab — `src/apps/WiretapSidebarTab.js`

Plain `.js`, extends `foundry.applications.sidebar.AbstractSidebarTab` (which extends
`ApplicationV2`). Implements the three-method Svelte mount seam (per the `foundry-svelte`
`mounting-svelte-into-appv2` reference). Pop-out is inherited from `AbstractSidebarTab.renderPopout()`
— the base class re-instantiates the same class as a framed, positioned, minimizable window, and the
Sidebar wires the pop-out button / right-click to it. The same mount logic serves docked and popout
mode.

```js
import { mount, unmount } from 'svelte';
import Wiretap from '~/components/Wiretap.svelte';

export default class WiretapSidebarTab extends foundry.applications.sidebar.AbstractSidebarTab {
  #mount = {};                               // Handle returned by Svelte's mount(), used for teardown.
  static tabName = 'wiretap';                // Identifies this tab in Sidebar.TABS / CONFIG.ui.

  async _renderHTML(context, options) { return { foundryApp: this }; }

  _replaceHTML(result, content, options) {
    if (options.isFirstRender) {
      this.#mount = mount(Wiretap, { target: content, props: result });
    }
  }

  _onClose(options) { super._onClose(options); unmount(this.#mount, { outro: true }); }
}
```

Keeping the class as plain `.js` (no `$state` on the class) means it does not need
Svelte-compilation; the component owns its own reactive state. The Level-Up `$state`-proxy re-render
pattern is adopted later when there is real data to push from the application into the component.

### 6.2 Component — `src/components/Wiretap.svelte`

Minimal Svelte 5 (runes) component proving SCSS + reactivity compile and render:
- A header (e.g., the module title).
- A placeholder "AI bridge coming soon" panel.
- One `$state` counter button as a live-reactivity smoke check.

Styles scoped (no `:global`), `Root.scss` auto-prepended via the preprocessor.

### 6.3 Registration — `src/hooks/OnceInit.js`

```js
CONFIG.ui.wiretap = WiretapSidebarTab;                          // Sidebar instantiates ui.wiretap from this.
foundry.applications.sidebar.Sidebar.TABS.wiretap = {           // Adds the nav button (icon + tooltip).
  tooltip: 'WIRETAP.SidebarTab',
  icon: 'fa-solid fa-user-secret',
};
```

`init` fires before the sidebar renders, so the tab is registered in time. The registration is
guarded: if `foundry.applications.sidebar.AbstractSidebarTab` is unavailable (version mismatch), fail
loud with a clear `console.error` rather than silently no-op.

### 6.4 Other src files

- `src/hooks/OnceReady.js` — a readiness `console.log` (module booted).
- `src/index.js` — imports `~/styles/Global.scss` and the hook handlers; registers
  `Hooks.once('init', onceInit)` and `Hooks.once('ready', onceReady)`.
- `src/styles/Root.scss` — wiretap SCSS vars/mixins (auto-prepended). `Global.scss` — minimal global
  styling. `Mixins/` — empty (parity).
- `lang/en.json` — `{ "WIRETAP": { "SidebarTab": "Wiretap" } }`.

## 7. Testing (full parity)

- **vitest + happy-dom** — one unit smoke test: mount `Wiretap.svelte` via
  `@testing-library/svelte`, assert the header renders and the counter increments on click.
- **Playwright + probe harness** — mirror titan's `__WIRETAP_PROBE__` build-mode gate
  (`vite build --mode e2e` sets it true). `src/test-probe/` exposes a small probe so e2e can assert
  the tab registered and renders inside a live Foundry. One e2e smoke test: load Foundry, confirm the
  Wiretap sidebar button exists, clicking it shows the mounted component, and popping it out mounts a
  window too.

## 8. Error handling (scaffold-level)

- `OnceInit` registration guarded against a missing `AbstractSidebarTab` (loud `console.error`).
- The Sidebar already wraps tab render in `try/catch` (`Hooks.onError("Sidebar#render", …)`), so a
  mount failure surfaces in console without breaking the rest of the sidebar.
- `unmount` in `_onClose` is unconditional, preventing listener/effect leaks across open/close
  cycles.

## 9. Out of scope (future specs)

- The AI-agent bridge / transport (the `foundry-vtt-mcp`–inspired Claude Code connection).
- Agent-driven document creation (actors, items, walls).
- The real chat/conversation UI inside the tab.
- Settings, keybindings, fonts, compendium packs.

## 10. Definition of done

`npm run build` emits `index.js` + `style.css`; Foundry v14 loads the module; the **Wiretap** tab
(spy icon) appears in the sidebar; clicking it shows the Svelte component; the counter reacts;
it pops out into its own window; the unit + e2e smoke tests pass.
