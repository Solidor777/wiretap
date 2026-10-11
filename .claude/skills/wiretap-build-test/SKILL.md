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
`typecheck` (tsc -p server/tsconfig.json), `stylelint`, `stylelint-fix`, `foundry:start` (`node scripts/e2e-foundry-server.mjs --standalone`).

## Test layout

| Dir | Kind |
|---|---|
| `tests/unit/` | vitest, happy-dom; client components/stores, `mcp` (incl. `startMcpServer` on port 0), `mcpWiring`, `mcpConfigFile`, `serverMode`, `shutdown`, `SuperviseServer`, `foundryBridge.{client,identify,server}`, `endpoints`, `gates` (every branch enumerated; no coverage provider is installed), `foundryBridge.gateState`, `origins`, `logThrottle`, `sidecarPty`, `terminalPayloads`, `budgets`, `docPath`, `handles` (count and entry caps, accounted bytes, LRU order, idle expiry on a fake clock and on the monotonic default, window and surrogate rules, bounded `paths` views, ownership, no file-system import), `contextBudget` (the real MCP server in-process with a fake GM client and the SDK client: per-tool name, definition and description sizes, tool count and total definition size from `shared/budgets.js` (hard breaches fail, warn breaches are printed with `console.warn`), a representative-result fixture for every listed tool run through the real enforcer and held to its budget constant, over-cap result to handle <= 256 B and `read_handle` slices within the cap, and tool names mentioned as `mcp__wiretap__<tool>` (letters, digits, underscores, hyphens between runs; trailing punctuation excluded) in the server `instructions` or any `.md` under a module-level `skills/` directory (none ships yet; a missing directory is a no-op) must be listed; the `instructions` length is held to `INSTRUCTIONS_MAX_CHARS` (600); the tool-count and total-size budgets count the real and test-registered tools but not the harness helper tool `mock_big_document` (`totals` vs `helperTotals`), which still meets the per-tool budgets and has a fixture; also asserted: `ERROR_MAX_FAILURES`, `RESULT_HARD_CAP_MAX_BYTES`, `PATHS_PER_CALL_MAX` through the SDK client; `startHarness({ tools, instructions })` closes the sidecar, GM socket, MCP server and client when setup fails; negative tests register oversized description, name, schema, a 31st tool, an oversized total, a missing fixture, an oversized fixture result and an instructions text over the limit or naming an unknown tool and a skill naming an unknown tool, in a test-local registry through the `tools` option and assert the exact failure text; the support code, fixtures (`FIXTURES`, keyed by tool name, synthetic `MOCK_` data) and `collectReport` live in `contextBudgetHarness.js`, which vitest does not collect), `resultBudget` (threshold, summary and key collisions, errors, never-fail-open cases, image hardening) |
| `tests/integration/terminal.test.js`, `serverModes.test.js`, `gateState.test.js` (gate snapshots over real sockets: identify and `bridge:gateState` paths, hostile snapshots, two endpoints, unregistered and non-GM sockets, no gate state in tool results), `endpointRouting.test.js` (two fake GM clients: route choice, fallback, override, v1 and non-GM refusal, byte limits), `endpointHealth.test.js` (ping and probe health with real sockets and fake timers: `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })` after the clients connect; waits use `setImmediate` and `Date.now`, never a faked timer), `originValidation.test.js` (hostile, allowed and absent `Origin` on the socket handshake and `/mcp`; the 403 `Origin not allowed` polling body, since the client only reports `websocket error`/`xhr poll error`; throttled refusal log lines; `Host` check), `serverStartup.test.js`, `serverDispose.test.js`, `resultHandles.test.js` (real MCP SDK client against a test-local tool passed to `startMcpServer` via `tools`, a fake GM client returning a 100 KB document, and echo tools proving `maxBytes` reaches a handler only when the tool declares it) | vitest, terminal relay; full vs mcp-only composition; startup failure on occupied ports; dispose ordering (mocked terminal/mcp failures) |
| `tests/e2e/` | Playwright against a live Foundry: `fixtures.js`, `global-setup.js`, `marker.js`, `sidecar.js` (starts a fresh sidecar per spec file), `users.js`, specs `smoke`, `spawn`, `terminal`, `toolbar` |
| `tests/measure/measureContext.mjs` | Manual, not in CI, no Foundry: `npx tsx tests/measure/measureContext.mjs` prints the real tool definitions' sizes and each fixture result against its budget (report only, writes no file; redirect into `debug/dumps/` to keep a run) |
| `tests/setup.js` | vitest setup with Foundry mocks (e.g. `HooksMock`) |

## Rules

- No e2e wait inside a loaded page longer than 1000 ms (`expect.poll`, `waitForFunction`, `toPass`, explicit
  `timeout:`). A longer wait is a defect to fix. World boot, login, reload, build and per-test limits are exempt.
- e2e needs Foundry on `:30000` with the module enabled and a GM user (see `tests/e2e/users.js`). Playwright's
  `webServer.command` is `node scripts/e2e-foundry-server.mjs` (`reuseExistingServer: true`, 120 s): if nothing
  answers on the port it runs `node main.js --dataPath=<userdata> --world=<world>` from the Foundry app dir, otherwise
  it reuses the running server. A server it launched is killed when the run ends (signals, process exit, or the
  watched process vanishing). Under Playwright the watched process is the nearest non-shell ancestor
  (`pickWatchPid`). `npm run foundry:start` passes `--standalone`: the watched process is the one that launched the run
  (`pickStandaloneWatchPid(ancestors, viaNpm)`: skip leading shells, skip the npm wrapper when `npm_execpath` is set,
  take the next ancestor, shells included; without npm the nearest ancestor; `process.ppid` when the chain is
  exhausted), so stopping the invoker stops Foundry. Defaults: userdata = three levels above the module folder, app dir = `<userdata>/../foundry`,
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
