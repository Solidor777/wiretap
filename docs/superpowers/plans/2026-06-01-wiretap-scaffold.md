# Wiretap Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project rule:** All `.js` / `.svelte` / `.svelte.js` work is routed to the `foundry-module-dev` subagent (`.claude/agents/foundry-module-dev.md`), which must load `svelte-5`, `foundry-vtt`, and `foundry-svelte` skills first. Follow `.claude/CLAUDE.md` code style exactly (120-col wrap, typed+commented declarations, multi-line objects/arrays, no `:global`).

**Goal:** Stand up the Wiretap Foundry VTT module package (Svelte 5 + SCSS + Vite, titan-parity tooling) with a Wiretap sidebar tab that mounts a Svelte component and pops out like the Combat tab.

**Architecture:** Copy titan's proven build/lint/test configs verbatim (re-pointed IDs/paths); author a fresh minimal `src/`. The tab extends `foundry.applications.sidebar.AbstractSidebarTab` and mounts a Svelte 5 component via the `_renderHTML`/`_replaceHTML`/`_onClose` seam; pop-out is inherited from the base class.

**Tech Stack:** Foundry VTT v14 (ApplicationV2), Svelte 5 (runes), SCSS (sass-embedded), Vite 8 (ESM lib build), Vitest 4 + happy-dom + @testing-library/svelte (unit), Playwright (e2e), ESLint (jsdoc+svelte), Stylelint (scss).

**Reference source:** `C:\FoundryVTT\V14\dev\foundryuserdata\Data\systems\titan` (build configs) and `C:\FoundryVTT\V14\foundry\client\applications\sidebar\` (sidebar API).

**Spec:** `docs/superpowers/specs/2026-06-01-wiretap-scaffold-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `package.json` | Package metadata, scripts, dependency pins |
| `vite.config.mjs` | Production/e2e lib build + dev server proxy |
| `svelte.config.js` | Svelte preprocessor (SCSS + Root.scss prepend) |
| `vitest.config.mjs` | Unit test runner config |
| `playwright.config.mjs` | E2E runner config |
| `eslint.config.js` / `.stylelintrc.json` / `jsconfig.json` | Lint + IntelliSense |
| `module.json` | Foundry manifest |
| `lang/en.json` | Localization strings |
| `src/index.js` | Entry: import global SCSS, register hooks |
| `src/apps/WiretapSidebarTab.js` | Sidebar tab application; Svelte mount seam |
| `src/components/Wiretap.svelte` | Proof-of-pipeline UI (runes) |
| `src/hooks/OnceInit.js` | Register tab + module API + probe gate |
| `src/hooks/OnceReady.js` | Readiness log |
| `src/styles/Variables.scss` | SCSS variables/mixins (prepended) |
| `src/styles/Root.scss` | Forwards Variables (prepend entry point) |
| `src/styles/Global.scss` | Global module styles |
| `src/test-probe/registerProbe.js` | e2e-only API on the module |
| `tests/setup.js` | Vitest global mocks (foundry/Hooks/game) |
| `tests/unit/Wiretap.test.js` | Component unit test |
| `tests/e2e/users.js` / `fixtures.js` / `global-setup.js` / `smoke.spec.js` | E2E login + smoke test |

---

### Task 1: Package metadata and dependencies

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create `package.json`**

```json
{
   "name": "wiretap",
   "version": "0.0.1",
   "description": "Adds a tab and bridge for AI agents inside Foundry VTT.",
   "license": "MIT",
   "private": true,
   "type": "module",
   "author": "Solidor",
   "devDependencies": {
      "@playwright/test": "^1.60.0",
      "@sveltejs/vite-plugin-svelte": "^7.1.2",
      "@testing-library/jest-dom": "^6.9.1",
      "@testing-library/svelte": "^5.3.1",
      "@types/node": "^22.10.02",
      "autoprefixer": "^10.4.19",
      "esbuild": "^0.28.0",
      "eslint": "^9.3.0",
      "eslint-plugin-jsdoc": "^48.2.5",
      "eslint-plugin-svelte": "^2.39.0",
      "happy-dom": "^20.9.0",
      "sass-embedded": "^1.100.0",
      "stylelint": "^16.12.0",
      "stylelint-config-html": "^1.1.0",
      "stylelint-config-standard-scss": "^16.0.0",
      "svelte": "^5.0.0",
      "svelte-preprocess": "^6.0.2",
      "terser": "^5.48.0",
      "vite": "^8.0.14",
      "vitest": "^4.1.7"
   },
   "browserslist": [
      "defaults"
   ],
   "scripts": {
      "build": "vite build",
      "build:e2e": "vite build --mode e2e",
      "dev": "vite",
      "test": "vitest run",
      "test:watch": "vitest",
      "test:e2e": "playwright test",
      "test:e2e:headed": "playwright test --headed",
      "test:e2e:ui": "playwright test --ui",
      "eslint": "eslint .",
      "eslint-fix": "eslint . --fix",
      "stylelint": "stylelint \"src/**/*.{css,svelte}\"",
      "stylelint-fix": "stylelint \"src/**/*.{css,svelte}\" --fix"
   }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: completes; `node_modules/` populated; `package-lock.json` written.

- [ ] **Step 3: Install the Playwright browser (Chromium)**

Run: `npx playwright install chromium`
Expected: Chromium downloaded (or "is already installed").

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add package.json and install dependencies"
```

---

### Task 2: Build and tooling configs

**Files:**
- Create: `vite.config.mjs`, `svelte.config.js`, `vitest.config.mjs`, `playwright.config.mjs`, `eslint.config.js`, `.stylelintrc.json`, `jsconfig.json`

- [ ] **Step 1: Create `vite.config.mjs`** (titan's, re-pointed to `modules/wiretap` and `__WIRETAP_PROBE__`)

```js
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { sveltePreprocess } from 'svelte-preprocess';
import path from 'path';
import { fileURLToPath } from 'url';
import autoprefixer from 'autoprefixer';

const __filename = fileURLToPath(import.meta.url); // Resolved path to this config file.
const __dirname = path.dirname(__filename); // Directory containing this config file.

// Foundry package path used for the base URL and dev-server proxy rules.
const s_PACKAGE_ID = 'modules/wiretap';

const s_COMPRESS = true; // Compress the module bundle with terser.
const s_SOURCEMAPS = true; // Generate sourcemaps for the bundle.

export default ({ mode }) => {
   /** @type {import('vite').UserConfig} */
   return {
      root: 'src/',
      base: `/${s_PACKAGE_ID}/`,
      publicDir: false,
      cacheDir: '../.vite-cache',

      resolve: {
         conditions: ['import', 'browser'],
         alias: {
            '~/': `${path.resolve(__dirname, 'src')}/`,
            '$fonts/': `${path.resolve(__dirname, 'fonts')}/`,
         },
      },

      esbuild: {
         target: ['es2022'],
      },

      css: {
         postcss: {
            plugins: [autoprefixer()],
         },
         preprocessorOptions: {
            scss: {
               api: 'modern-compiler',
            },
         },
      },

      define: {
         'process.env.NODE_ENV': JSON.stringify('production'),
         // Probe harness gate: true only under `vite build --mode e2e`.
         __WIRETAP_PROBE__: JSON.stringify(mode === 'e2e'),
      },

      server: {
         port: 30001,
         open: '/game',
         proxy: {
            [`^(/${s_PACKAGE_ID}/(assets|lang|packs|style.css))`]: 'http://localhost:30000',
            [`^(?!/${s_PACKAGE_ID}/)`]: 'http://localhost:30000',
            '/socket.io': { target: 'ws://localhost:30000', ws: true },
         },
      },

      build: {
         outDir: __dirname,
         emptyOutDir: false,
         sourcemap: s_SOURCEMAPS,
         brotliSize: true,
         minify: s_COMPRESS ? 'terser' : false,
         target: ['es2022'],
         terserOptions: s_COMPRESS ? { ecma: 2022 } : void 0,
         lib: {
            entry: './index.js',
            formats: ['es'],
            fileName: 'index',
            cssFileName: 'style',
         },
      },

      plugins: [
         svelte({
            configFile: false,
            preprocess: sveltePreprocess({
               scss: {
                  api: 'modern',
                  prependData: '@use "src/styles/Root.scss" as *;',
               },
               postcss: {
                  plugins: [autoprefixer()],
               },
            }),
            onwarn: (warning, handler) => {
               if (warning.code === 'vite-plugin-svelte-preprocess-many-dependencies') {
                  return;
               }
               handler(warning);
            },
         }),
      ],
   };
};
```

- [ ] **Step 2: Create `svelte.config.js`** (verbatim from titan)

```js
import autoprefixer from 'autoprefixer';
import { sveltePreprocess } from 'svelte-preprocess';

const config = {
   preprocess: sveltePreprocess({
      scss: {
         api: 'modern',
         prependData: '@use "src/styles/Root.scss" as *;',
      },
      postcss: {
         plugins: [autoprefixer()],
      },
   }),
};

export default config;
```

- [ ] **Step 3: Create `vitest.config.mjs`** (verbatim from titan)

```js
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { sveltePreprocess } from 'svelte-preprocess';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
   plugins: [
      svelte({
         preprocess: sveltePreprocess({
            scss: { prependData: '@use "src/styles/Root.scss" as *;' },
         }),
      }),
   ],
   resolve: {
      conditions: ['browser'],
      dedupe: ['svelte'],
      alias: {
         '~/': `${path.resolve(__dirname, 'src')}/`,
         '$fonts/': `${path.resolve(__dirname, 'fonts')}/`,
      },
   },
   test: {
      environment: 'happy-dom',
      globals: true,
      setupFiles: ['./tests/setup.js'],
      include: ['tests/unit/**/*.test.js'],
   },
};
```

- [ ] **Step 4: Create `playwright.config.mjs`** (titan's, no global-setup yet — added in Task 10)

```js
import { defineConfig } from '@playwright/test';

export default defineConfig({
   testDir: './tests/e2e',
   timeout: 60_000,
   fullyParallel: false,
   workers: 1,
   use: {
      baseURL: 'http://localhost:30000',
      headless: true,
   },
   // Reuse a running Foundry on :30000; otherwise launch it directly and wait.
   webServer: {
      command: 'node foundry/main.js --dataPath=/foundryvtt/V14/dev/foundryuserdata',
      cwd: 'C:/FoundryVTT/V14/dev',
      url: 'http://localhost:30000',
      reuseExistingServer: true,
      timeout: 120_000,
   },
});
```

- [ ] **Step 5: Create `eslint.config.js`** (verbatim from titan)

Copy the exact contents of `C:\FoundryVTT\V14\dev\foundryuserdata\Data\systems\titan\eslint.config.js` (the jsdoc + svelte flat config with `augments → extends` tag preference and the `ignores` block). No changes are needed — it is package-agnostic.

- [ ] **Step 6: Create `.stylelintrc.json`** (verbatim from titan)

```json
{
   "extends": [
      "stylelint-config-standard-scss",
      "stylelint-config-html/svelte"
   ],
   "rules": {
      "font-family-name-quotes": "always-unless-keyword",
      "font-weight-notation": "named-where-possible",
      "function-url-no-scheme-relative": true,
      "function-url-quotes": "always",
      "value-keyword-case": "lower",
      "unit-disallowed-list": [
         "rem",
         "em"
      ],
      "no-descending-specificity": null,
      "no-duplicate-selectors": true,
      "font-family-no-missing-generic-family-keyword": null,
      "alpha-value-notation": "number",
      "property-no-unknown": [
         true,
         {
            "ignoreProperties": [
               "/^lost-/"
            ]
         }
      ]
   },
   "ignoreFiles": [
      "node_modules/*",
      "src/assets/**",
      "build/**"
   ]
}
```

- [ ] **Step 7: Create `jsconfig.json`**

```json
{
   "compilerOptions": {
      "baseUrl": "./",
      "paths": {
         "~/*": [
            "src/*"
         ]
      }
   },
   "include": [
      "**/*.js",
      "**/*.mjs",
      "../../../../foundry/common/**/*.mjs",
      "../../../../foundry/common/**/*.js",
      "../../../../foundry/public/scripts/**/*.mjs",
      "../../../../foundry/public/scripts/**/*.js"
   ]
}
```

- [ ] **Step 8: Commit**

```bash
git add vite.config.mjs svelte.config.js vitest.config.mjs playwright.config.mjs eslint.config.js .stylelintrc.json jsconfig.json
git commit -m "chore: add build, lint, and test configs (titan parity)"
```

---

### Task 3: Manifest and localization

**Files:**
- Create: `module.json`, `lang/en.json`

- [ ] **Step 1: Create `module.json`**

```json
{
   "id": "wiretap",
   "title": "Wiretap",
   "description": "Adds a tab and bridge for AI agents inside Foundry VTT.",
   "version": "0.0.1",
   "compatibility": {
      "minimum": "13",
      "verified": "14",
      "maximum": "14"
   },
   "authors": [
      {
         "name": "Solidor",
         "discord": "solidor"
      }
   ],
   "esmodules": [
      "index.js"
   ],
   "styles": [
      "style.css"
   ],
   "languages": [
      {
         "lang": "en",
         "name": "English",
         "path": "lang/en.json"
      }
   ],
   "socket": true,
   "url": "https://github.com/Solidor777/wiretap",
   "bugs": "https://github.com/Solidor777/wiretap/issues",
   "manifest": "https://github.com/Solidor777/wiretap/releases/latest/download/module.json",
   "download": "https://github.com/Solidor777/wiretap/releases/latest/download/wiretap.zip",
   "license": "LICENSE-MIT"
}
```

- [ ] **Step 2: Create `lang/en.json`**

```json
{
   "WIRETAP": {
      "Title": "Wiretap",
      "SidebarTab": "Wiretap"
   }
}
```

- [ ] **Step 3: Commit**

```bash
git add module.json lang/en.json
git commit -m "feat: add module manifest and English localization"
```

---

### Task 4: Styles scaffold

**Files:**
- Create: `src/styles/Variables.scss`, `src/styles/Root.scss`, `src/styles/Global.scss`

- [ ] **Step 1: Create `src/styles/Variables.scss`**

```scss
// Accent color for Wiretap UI surfaces.
$wiretap-accent: #4a9eff;

// Base padding unit for Wiretap panels (px; rem/em are stylelint-disallowed).
$wiretap-padding: 8px;
```

- [ ] **Step 2: Create `src/styles/Root.scss`** (prepend entry point; forwards variables/mixins to every component)

```scss
@forward 'Variables';
```

- [ ] **Step 3: Create `src/styles/Global.scss`** (global stylesheet; not a component, so it explicitly `@use`s variables)

```scss
@use 'Variables' as *;

// Layout for the Wiretap sidebar tab and its popped-out window.
.wiretap {
   display: flex;
   flex-direction: column;
   gap: $wiretap-padding;
   padding: $wiretap-padding;
}
```

- [ ] **Step 4: Lint the styles**

Run: `npm run stylelint`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add src/styles
git commit -m "feat: add SCSS variables, root prepend, and global styles"
```

---

### Task 5: Wiretap.svelte component (TDD)

**Files:**
- Create: `tests/setup.js`, `tests/unit/Wiretap.test.js`, `src/components/Wiretap.svelte`

- [ ] **Step 1: Create `tests/setup.js`** (vitest global mocks: foundry, Hooks, game)

```js
import { beforeEach } from 'vitest';

/** Minimal stand-in for foundry.abstract.Document (used for instanceof checks). */
class MockDocument {}

/**
 * Minimal recursive merge mirroring foundry.utils.mergeObject for plain objects.
 * @param {object} original - Target object (mutated).
 * @param {object} [other] - Source object.
 * @returns {object} The merged target.
 */
function mergeObject(original, other = {}) {
   for (const [key, value] of Object.entries(other)) {
      const isPlain = value && typeof value === 'object' && !Array.isArray(value);
      if (isPlain && original[key] && typeof original[key] === 'object') {
         mergeObject(original[key], value);
      } else {
         original[key] = value;
      }
   }
   return original;
}

globalThis.foundry = {
   abstract: { Document: MockDocument },
   utils: { mergeObject },
};

// Minimal game mock: i18n.localize returns the key so components render deterministically in tests.
globalThis.game = {
   i18n: {
      localize: (key) => key,
   },
};

/** Minimal Hooks mock supporting on/off/call. */
class HooksMock {
   constructor() {
      this.handlers = {};
   }

   on(name, fn) {
      (this.handlers[name] ??= new Set()).add(fn);
      return fn;
   }

   off(name, fn) {
      this.handlers[name]?.delete(fn);
   }

   call(name, ...args) {
      for (const fn of [...(this.handlers[name] ?? [])]) {
         fn(...args);
      }
   }
}

// Fresh Hooks per test so subscriber registrations never leak across tests.
beforeEach(() => {
   globalThis.Hooks = new HooksMock();
});
```

- [ ] **Step 2: Write the failing test — `tests/unit/Wiretap.test.js`**

```js
import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import Wiretap from '~/components/Wiretap.svelte';

describe('Wiretap.svelte', () => {
   // The component must render its localized title header.
   it('renders the title header', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('heading', { name: 'WIRETAP.Title' })).toBeTruthy();
   });

   // The counter button must increment on click, proving runes reactivity in the mount.
   it('increments the counter when clicked', async () => {
      render(Wiretap, { props: { foundryApp: {} } });
      const button = screen.getByRole('button');
      expect(button.textContent).toContain('0');
      await fireEvent.click(button);
      expect(button.textContent).toContain('1');
   });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/unit/Wiretap.test.js`
Expected: FAIL — cannot resolve `~/components/Wiretap.svelte` (file does not exist yet).

- [ ] **Step 4: Create `src/components/Wiretap.svelte`**

```svelte
<script>
   // Props supplied by WiretapSidebarTab when it mounts this component.
   let { foundryApp } = $props();

   // Reactive click counter proving Svelte 5 runes reactivity inside the Foundry mount.
   let count = $state(0);

   /**
    * Increment the demo counter.
    * @returns {void}
    */
   function increment() {
      count += 1;
   }
</script>

<section class="wiretap">
   <header class="wiretap__header">
      <i class="fa-solid fa-user-secret"></i>
      <h2>{game.i18n.localize('WIRETAP.Title')}</h2>
   </header>

   <p class="wiretap__placeholder">AI bridge coming soon.</p>

   <button
      type="button"
      class="wiretap__counter"
      onclick={increment}
   >
      Clicked {count} {count === 1 ? 'time' : 'times'}
   </button>
</section>

<style lang="scss">
   .wiretap {
      &__header {
         display: flex;
         align-items: center;
         gap: $wiretap-padding;

         i {
            color: $wiretap-accent;
         }
      }

      &__counter {
         border: 1px solid $wiretap-accent;
      }
   }
</style>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/unit/Wiretap.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add tests/setup.js tests/unit/Wiretap.test.js src/components/Wiretap.svelte
git commit -m "feat: add Wiretap proof-of-pipeline component with unit tests"
```

---

### Task 6: WiretapSidebarTab application

**Files:**
- Create: `src/apps/WiretapSidebarTab.js`

- [ ] **Step 1: Create `src/apps/WiretapSidebarTab.js`**

```js
import { mount, unmount } from 'svelte';
import Wiretap from '~/components/Wiretap.svelte';

/**
 * The Wiretap sidebar tab. Extends Foundry's AbstractSidebarTab (an ApplicationV2) and mounts the
 * Wiretap Svelte component into its content. Pop-out behavior is inherited from AbstractSidebarTab.
 * @extends {foundry.applications.sidebar.AbstractSidebarTab}
 */
export default class WiretapSidebarTab extends foundry.applications.sidebar.AbstractSidebarTab {

   /**
    * Handle returned by Svelte's mount(), retained so _onClose can unmount the component.
    * @type {object}
    */
   #mount = {};

   /**
    * The base name identifying this tab in Sidebar.TABS and CONFIG.ui.
    * @type {string}
    */
   static tabName = 'wiretap';

   /**
    * Build the props object handed verbatim to _replaceHTML.
    * @param {object} context - The render context (unused; reserved for future reactive data).
    * @param {object} options - The render options bag.
    * @returns {Promise<{ foundryApp: WiretapSidebarTab }>} The props for the Svelte component.
    */
   async _renderHTML(context, options) {
      return { foundryApp: this };
   }

   /**
    * Mount the Svelte component into the tab content on the first render only.
    * @param {{ foundryApp: WiretapSidebarTab }} result - The value returned by _renderHTML.
    * @param {HTMLElement} content - The content element to mount into.
    * @param {{ isFirstRender: boolean }} options - The render options bag.
    * @returns {void}
    */
   _replaceHTML(result, content, options) {
      if (options.isFirstRender) {
         this.#mount = mount(Wiretap, { target: content, props: result });
      }
   }

   /**
    * Tear down the mounted component when the tab (or its popout) closes.
    * @param {object} options - The close options bag.
    * @returns {void}
    */
   _onClose(options) {
      super._onClose(options);
      unmount(this.#mount, { outro: true });
   }
}
```

- [ ] **Step 2: Lint the new file**

Run: `npm run eslint -- src/apps/WiretapSidebarTab.js`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/apps/WiretapSidebarTab.js
git commit -m "feat: add WiretapSidebarTab with Svelte mount seam"
```

---

### Task 7: Hooks and entry point

**Files:**
- Create: `src/hooks/OnceInit.js`, `src/hooks/OnceReady.js`, `src/index.js`

- [ ] **Step 1: Create `src/hooks/OnceInit.js`**

```js
import WiretapSidebarTab from '~/apps/WiretapSidebarTab.js';

/**
 * Foundry `init` handler. Registers the Wiretap sidebar tab, exposes the module API, and installs the
 * test-only probe when built for e2e. Runs before the sidebar renders so the tab is available in time.
 * @returns {void}
 */
export default function onceInit() {
   // The v14 sidebar namespace; guard against a version where it is unavailable.
   const sidebar = foundry.applications.sidebar;
   if (!sidebar?.AbstractSidebarTab || !sidebar?.Sidebar) {
      console.error('Wiretap | AbstractSidebarTab unavailable; sidebar tab not registered.');
      return;
   }

   // Register the tab application class so the Sidebar instantiates ui.wiretap from it.
   CONFIG.ui.wiretap = WiretapSidebarTab;

   // Add the sidebar navigation button (icon + tooltip) for the Wiretap tab.
   sidebar.Sidebar.TABS.wiretap = {
      tooltip: 'WIRETAP.SidebarTab',
      icon: 'fa-solid fa-user-secret',
   };

   // The module entry, used to expose a public API object for downstream features and the e2e probe.
   const module = game.modules.get('wiretap');
   module.api = {};

   // Install the test-only probe harness when built for e2e. `__WIRETAP_PROBE__` is a Vite compile-time
   // constant (true only under `--mode e2e`); the production build sets it false so terser
   // dead-code-eliminates this branch and the dynamic import is never bundled.
   /* global __WIRETAP_PROBE__ */
   if (__WIRETAP_PROBE__) {
      import('~/test-probe/registerProbe.js').then((probe) => {
         probe.default(module.api);
      });
   }
}
```

- [ ] **Step 2: Create `src/hooks/OnceReady.js`**

```js
/**
 * Foundry `ready` handler. Logs that the Wiretap module finished booting.
 * @returns {void}
 */
export default function onceReady() {
   console.log('Wiretap | Module ready.');
}
```

- [ ] **Step 3: Create `src/index.js`** (module entry)

```js
import '~/styles/Global.scss';
import onceInit from '~/hooks/OnceInit.js';
import onceReady from '~/hooks/OnceReady.js';

Hooks.once('init', onceInit);
Hooks.once('ready', onceReady);
```

- [ ] **Step 4: Lint the new files**

Run: `npm run eslint -- src/hooks/OnceInit.js src/hooks/OnceReady.js src/index.js`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/OnceInit.js src/hooks/OnceReady.js src/index.js
git commit -m "feat: register sidebar tab via init/ready hooks and module entry"
```

---

### Task 8: Test probe harness

**Files:**
- Create: `src/test-probe/registerProbe.js`

- [ ] **Step 1: Create `src/test-probe/registerProbe.js`**

```js
/**
 * Install the test-only probe API on the module's public API object. Only imported when the bundle is
 * built with `--mode e2e` (gated by `__WIRETAP_PROBE__`). Lets e2e specs assert tab registration and
 * drive the tab without relying on private internals.
 * @param {object} api - The module API object (`game.modules.get('wiretap').api`) to extend.
 * @returns {void}
 */
export default function registerProbe(api) {
   api._probe = {
      /**
       * Whether the Wiretap sidebar tab is registered and instantiated.
       * @returns {boolean} True when CONFIG.ui.wiretap and ui.wiretap both exist.
       */
      tabRegistered() {
         return !!CONFIG.ui.wiretap && !!ui.wiretap;
      },

      /**
       * Activate the Wiretap tab in the sidebar.
       * @returns {void}
       */
      open() {
         ui.wiretap?.activate();
      },

      /**
       * Pop the Wiretap tab out into its own window.
       * @returns {Promise<foundry.applications.sidebar.AbstractSidebarTab>|void} The popout render.
       */
      popout() {
         return ui.wiretap?.renderPopout();
      },
   };
}
```

- [ ] **Step 2: Lint the new file**

Run: `npm run eslint -- src/test-probe/registerProbe.js`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/test-probe/registerProbe.js
git commit -m "feat: add e2e-gated probe harness"
```

---

### Task 9: Production build verification

**Files:**
- (none created; verifies build output)

- [ ] **Step 1: Run the production build**

Run: `npm run build`
Expected: completes; emits `index.js`, `index.js.map`, and `style.css` at the repo root.

- [ ] **Step 2: Verify the build artifacts exist**

Run: `node -e "['index.js','style.css'].forEach(f=>{if(!require('fs').existsSync(f))throw new Error('missing '+f)});console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 3: Verify the probe branch was dead-code-eliminated from the production bundle**

Run: `node -e "const s=require('fs').readFileSync('index.js','utf8');if(s.includes('registerProbe'))throw new Error('probe leaked into prod bundle');console.log('OK')"`
Expected: prints `OK` (production build excludes the probe).

- [ ] **Step 4: Run unit tests and lint as a full gate**

Run: `npm test && npm run eslint && npm run stylelint`
Expected: all PASS.

- [ ] **Step 5: Commit the build artifacts** (only those not gitignored)

Note: `index.js`, `index.js.map`, and `style.css` are gitignored (see `.gitignore`). This step commits nothing if the working tree is clean; it exists only to confirm there are no unexpected tracked changes.

```bash
git status --short
```

---

### Task 10: E2E smoke test

> **Prerequisite:** A Foundry v14 instance reachable on `http://localhost:30000` with a test world in which the `wiretap` module is enabled, plus a GM user named `E2E GM 1` (override via the `FOUNDRY_USER` env var). The e2e bundle must be built first (`npm run build:e2e`).

**Files:**
- Create: `tests/e2e/users.js`, `tests/e2e/fixtures.js`, `tests/e2e/global-setup.js`, `tests/e2e/smoke.spec.js`
- Modify: `playwright.config.mjs` (register `globalSetup`)

- [ ] **Step 1: Create `tests/e2e/users.js`**

```js
// Default GM display name used by the e2e login fixture when FOUNDRY_USER is unset.
export const DEFAULT_GM = 'E2E GM 1';
```

- [ ] **Step 2: Create `tests/e2e/fixtures.js`** (login helper, verified selectors from titan)

```js
import { DEFAULT_GM } from './users.js';

/**
 * Authenticate against the live Foundry v14 `/join` screen and wait for the world to become ready.
 * @param {import('@playwright/test').Page} page - The Playwright page to drive.
 * @param {string} [user] - Display name of the user to log in as. Defaults to FOUNDRY_USER or DEFAULT_GM.
 * @returns {Promise<void>} Resolves once `game.ready === true`.
 */
export async function login(page, user = process.env.FOUNDRY_USER || DEFAULT_GM) {
   // Navigate to the join screen and select the configured user.
   await page.goto('/join');
   await page.selectOption('select[name="userid"]', { label: user });

   // Fill the password only when one is configured (the test world has none by default).
   if (process.env.FOUNDRY_PASSWORD) {
      await page.fill('input[name="password"]', process.env.FOUNDRY_PASSWORD);
   }

   // Submit the join form and wait for the world to load and become ready.
   await page.click('button[name="join"]');
   await page.waitForURL('**/game');
   await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60_000 });
}
```

- [ ] **Step 3: Create `tests/e2e/global-setup.js`** (build the e2e bundle before the suite runs)

```js
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, derived from this setup file's location (tests/e2e/global-setup.js).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Playwright global setup: build the module with the e2e probe enabled so the live world loads a bundle
 * exposing `game.modules.get('wiretap').api._probe`.
 * @returns {Promise<void>} Resolves once `vite build --mode e2e` completes.
 */
export default async function globalSetup() {
   execSync('npm run build:e2e', { cwd: repoRoot, stdio: 'inherit' });
}
```

- [ ] **Step 4: Register `globalSetup` in `playwright.config.mjs`**

Add the `globalSetup` key to the `defineConfig` object (immediately after `workers: 1,`):

```js
   workers: 1,
   globalSetup: './tests/e2e/global-setup.js',
```

- [ ] **Step 5: Create `tests/e2e/smoke.spec.js`**

```js
import { test, expect } from '@playwright/test';
import { login } from './fixtures.js';

test.describe('wiretap scaffold smoke', () => {
   // A ready world with the wiretap module enabled is required for sidebar introspection.
   test.beforeEach(async ({ page }) => {
      await login(page);
   });

   // The module must be active and its sidebar tab registered in the live runtime.
   test('module is active and tab is registered', async ({ page }) => {
      const state = await page.evaluate(() => ({
         active: game.modules.get('wiretap')?.active === true,
         registered: game.modules.get('wiretap')?.api?._probe?.tabRegistered() === true,
      }));
      expect(state.active, 'wiretap module must be enabled in the test world').toBe(true);
      expect(state.registered, 'wiretap sidebar tab must be registered').toBe(true);
   });

   // The sidebar nav button must exist, and clicking it must mount the Svelte component.
   test('sidebar tab renders the mounted component', async ({ page }) => {
      const button = page.locator('#sidebar nav.tabs [data-tab="wiretap"]');
      await expect(button).toHaveCount(1);
      await button.click();
      await expect(page.locator('section.wiretap .wiretap__counter')).toBeVisible();
   });

   // Popping the tab out must mount the same component in a standalone window.
   test('tab pops out into its own window', async ({ page }) => {
      await page.evaluate(() => game.modules.get('wiretap').api._probe.popout());
      await expect(page.locator('.sidebar-popout section.wiretap')).toBeVisible();
   });
});
```

- [ ] **Step 6: Run the e2e suite**

Run: `npm run test:e2e`
Expected: 3 tests PASS (global setup builds the e2e bundle; the running Foundry world loads it).

- [ ] **Step 7: Commit**

```bash
git add tests/e2e playwright.config.mjs
git commit -m "test: add e2e smoke suite for sidebar tab and popout"
```

---

### Task 11: Project docs and TODO tracker

**Files:**
- Create: `README.md`, `CHANGELOG.md`, `LICENSE-MIT`, `TODO.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# Wiretap

A Foundry VTT v14 module that adds a tab and a bridge for AI agents inside Foundry. Built with
Svelte 5 (runes), SCSS, and Vite.

## Development

- `npm run dev` — Vite dev server (proxies to Foundry on :30000)
- `npm run build` — production build (emits `index.js` + `style.css`)
- `npm test` — unit tests (Vitest)
- `npm run test:e2e` — end-to-end tests (Playwright)
```

- [ ] **Step 2: Create `CHANGELOG.md`**

```markdown
# Changelog

## 0.0.1

- Initial package scaffold: Svelte 5 + SCSS + Vite build, Wiretap sidebar tab with pop-out.
```

- [ ] **Step 3: Create `LICENSE-MIT`**

Use the standard MIT license text, copyright `2026 Solidor`.

- [ ] **Step 4: Create `TODO.md`** (per project protocol)

```markdown
# Wiretap TODO

## Completed

- [x] Package scaffold (Svelte 5 + SCSS + Vite, titan-parity tooling)
- [x] Wiretap sidebar tab with Svelte mount + pop-out
- [x] Unit + e2e smoke tests

## Deferred (future specs)

- [ ] AI-agent bridge / transport (foundry-vtt-mcp–inspired Claude Code connection)
- [ ] Agent-driven document creation (actors, items, walls)
- [ ] Real chat/conversation UI inside the tab
- [ ] Settings, keybindings, fonts, compendium packs
```

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md LICENSE-MIT TODO.md
git commit -m "docs: add README, changelog, license, and TODO tracker"
```

---

## Self-review

**Spec coverage:**
- §3 file tree → Tasks 1–11 (every listed file has a creating task). ✓
- §4 configs → Task 2 (all 7 configs) + Task 1 (package.json). ✓
- §5 manifest → Task 3. ✓
- §6.1 sidebar tab → Task 6. §6.2 component → Task 5. §6.3 registration → Task 7. §6.4 other src/styles/lang → Tasks 3, 4, 7. ✓
- §7 testing → Task 5 (unit) + Task 10 (e2e + probe wiring) + Task 8 (probe). ✓
- §8 error handling → Task 7 (guarded registration) + Task 6 (`_onClose` unmount). ✓
- §10 definition of done → Tasks 9 + 10. ✓

**Placeholder scan:** No "TBD"/"add error handling"/"similar to" placeholders; every code step has complete content. `eslint.config.js` (Step 2.5) and `LICENSE-MIT` (Step 11.3) reference exact source/standard text rather than inlining boilerplate — both are unambiguous copies.

**Type consistency:** `WiretapSidebarTab` (default export) used consistently in Tasks 6 and 7. `module.api._probe.tabRegistered()` / `.open()` / `.popout()` defined in Task 8 and called identically in Task 10. `__WIRETAP_PROBE__` define (Task 2) matches the guard (Task 7) and gated import target (Task 8). `Root.scss`/`Variables.scss` names consistent across Tasks 2 and 4. Props key `foundryApp` consistent across Tasks 5 and 6.
