---
name: wiretap-build-test
description: Wiretap build, lint, and test tooling — Vite build, vitest unit/integration tests, Playwright e2e harness with per-spec sidecar, eslint/stylelint, npm scripts. Use when running, writing, or changing tests or build/lint configuration.
paths:
  - "tests/**"
  - "vite.config.mjs"
  - "vitest.config.mjs"
  - "playwright.config.mjs"
  - "eslint.config.js"
  - ".stylelintrc.json"
  - "package.json"
---

# Wiretap build and test

Current-state reference; verify against code before relying on a detail. Core context: `wiretap-codebase-core`.

## npm scripts (from `package.json`)

`build` (vite build), `build:e2e` (vite build --mode e2e), `dev`, `test` (vitest run), `test:watch`, `test:e2e`
(playwright test; `:headed`, `:ui`), `eslint`, `eslint-fix`, `server` (tsx watch), `server:start` (tsx), `server:mcp` (tsx, `--mcp-only`),
`typecheck` (tsc -p server/tsconfig.json), `stylelint`, `stylelint-fix`.

## Test layout

| Dir | Kind |
|---|---|
| `tests/unit/` | vitest, happy-dom; client components/stores, `mcp`, `mcpWiring`, `mcpConfigFile`, `serverMode`, `shutdown`, `foundryBridge.{client,server}`, `sidecarPty` |
| `tests/integration/terminal.test.js`, `serverModes.test.js`, `serverStartup.test.js`, `serverDispose.test.js` | vitest, terminal relay; full vs mcp-only composition; startup failure on occupied ports; dispose ordering (mocked terminal/mcp failures) |
| `tests/e2e/` | Playwright against a live Foundry: `fixtures.js`, `global-setup.js`, `marker.js`, `sidecar.js` (starts a fresh sidecar per spec file), `users.js`, specs `smoke`, `spawn`, `terminal`, `toolbar` |
| `tests/setup.js` | vitest setup with Foundry mocks (e.g. `HooksMock`) |

## Rules

- No e2e wait inside a loaded page longer than 1000 ms (`expect.poll`, `waitForFunction`, `toPass`, explicit
  `timeout:`). A longer wait is a defect to fix. World boot, login, reload, build and per-test limits are exempt.
- e2e needs a live Foundry on `:30000` with the module enabled and a GM user (see `tests/e2e/users.js`).
- Tests that write files inject a root under the gitignored `test/tmp/` (`mcpConfigFile` uses a unique
  `<pid>-<counter>` root per test and asserts it does not exist yet, so a stale scratch fails loudly) or mock `node:fs`; no test and no product code calls a deletion API (`rm`, `unlink`, `rmdir`). Product code never reads
  a test-only env var. Stale files in `test/tmp/` stay until removed by hand.
- e2e/test code never ships; e2e build output goes to `test/build/`, stale files removed after each build.
- Lint/format rules live in `eslint.config.js`, `.stylelintrc.json`; `:global` is forbidden.
- Run `npm test`, `npm run typecheck` and `npm run eslint` before claiming a change is verified; report the output.
