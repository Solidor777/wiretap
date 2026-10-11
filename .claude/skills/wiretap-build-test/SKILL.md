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
  - "scripts/**"
---

# Wiretap build and test

Current-state reference; verify against code before relying on a detail. Core context: `wiretap-codebase-core`.

## npm scripts (from `package.json`)

`build` (vite build), `build:e2e` (vite build --mode e2e), `dev`, `test` (vitest run), `test:watch`, `test:e2e`
(playwright test; `:headed`, `:ui`), `eslint`, `eslint-fix`, `server` (tsx watch), `server:start` (tsx), `server:mcp` (tsx, `--mcp-only`),
`typecheck` (tsc -p server/tsconfig.json), `stylelint`, `stylelint-fix`, `foundry:start` (`node scripts/e2e-foundry-server.mjs`).

## Test layout

| Dir | Kind |
|---|---|
| `tests/unit/` | vitest, happy-dom; client components/stores, `mcp` (incl. `startMcpServer` on port 0), `mcpWiring`, `mcpConfigFile`, `serverMode`, `shutdown`, `SuperviseServer`, `foundryBridge.{client,identify,server}`, `endpoints`, `origins`, `logThrottle`, `sidecarPty` |
| `tests/integration/terminal.test.js`, `serverModes.test.js`, `endpointRouting.test.js` (two fake v2 GM clients: route choice, fallback, override, v1 and non-GM refusal, byte limits), `originValidation.test.js` (hostile, allowed and absent `Origin` on the socket handshake and `/mcp`; the 403 `Origin not allowed` polling body, since the client only reports `websocket error`/`xhr poll error`; throttled refusal log lines; `Host` check), `serverStartup.test.js`, `serverDispose.test.js` | vitest, terminal relay; full vs mcp-only composition; startup failure on occupied ports; dispose ordering (mocked terminal/mcp failures) |
| `tests/e2e/` | Playwright against a live Foundry: `fixtures.js`, `global-setup.js`, `marker.js`, `sidecar.js` (starts a fresh sidecar per spec file), `users.js`, specs `smoke`, `spawn`, `terminal`, `toolbar` |
| `tests/setup.js` | vitest setup with Foundry mocks (e.g. `HooksMock`) |

## Rules

- No e2e wait inside a loaded page longer than 1000 ms (`expect.poll`, `waitForFunction`, `toPass`, explicit
  `timeout:`). A longer wait is a defect to fix. World boot, login, reload, build and per-test limits are exempt.
- e2e needs Foundry on `:30000` with the module enabled and a GM user (see `tests/e2e/users.js`). Playwright's
  `webServer.command` is `node scripts/e2e-foundry-server.mjs` (`reuseExistingServer: true`, 120 s): if nothing
  answers on the port it runs `node main.js --dataPath=<userdata> --world=<world>` from the Foundry app dir, otherwise
  it reuses the running server. A server it launched is killed when the run ends (signals, process exit, or the
  watched parent runner vanishing). `npm run foundry:start` runs the same launcher standalone and keeps the server up
  until that process ends. Defaults: userdata = three levels above the module folder, app dir = `<userdata>/../foundry`,
  port `30000`, world `test-titan`, log `debug/dumps/e2e-server.log` (gitignored `debug/`). Overrides:
  `FOUNDRY_DATA_PATH`, `FOUNDRY_APP_DIR`, `FOUNDRY_PORT`, `FOUNDRY_WORLD`, `FOUNDRY_SERVER_LOG`. The launcher does not
  enable the module; the launched world must already have it enabled. `scripts/lib/superviseServer.mjs` holds the
  injectable parts, unit-tested in `tests/unit/SuperviseServer.test.js` with ephemeral ports and idle node processes
  (no Foundry, never `:30000`).
- Tests that write files inject a root under the gitignored `test/tmp/` (`mcpConfigFile` uses a unique
  `<timestamp>-<pid>-<counter>` root per test and asserts it does not exist yet, so a stale scratch fails loudly) or mock `node:fs`; no test and no product code calls a deletion API (`rm`, `unlink`, `rmdir`). Product code never reads
  a test-only env var. Stale files in `test/tmp/` stay until removed by hand.
- e2e/test code never ships; e2e build output goes to `test/build/`, stale files removed after each build.
- Lint/format rules live in `eslint.config.js`, `.stylelintrc.json`; `:global` is forbidden.
- Run `npm test`, `npm run typecheck` and `npm run eslint` before claiming a change is verified; report the output.
