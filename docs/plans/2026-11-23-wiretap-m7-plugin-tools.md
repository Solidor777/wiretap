# Wiretap M7 "Plugin tools" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `parallel-subagent-development` with `dispatching-sdd-agents` to
> implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Every task brief is the task's text plus the
> whole "Global Constraints" section, copied verbatim: the implementer does not read this file.

**Goal:** any Foundry module can give the agent new tools through a public Wiretap API (`api.apiVersion`,
`api.registerTool`, hook `wiretap.registerTools`); the GM chooses which modules' tools the agent sees; the 30-tool and
16 KB caps are gone for every tool; per-tool guidelines stay hard for Wiretap's own tools and only warn for plugin tools.

**Architecture:** one shared validator (`shared/scripts.js`) and one shared schema rule set (`shared/schemaValidate.js`
mirrored by `jsonSchemaToZodShape` in `server/toolRegistry.ts`) gain a `plugin` route that turns the best-practice checks
into warnings while the needed-to-work checks still refuse. The client registry accepts plugin definitions (which carry
`moduleId`) from a frozen API object passed to the hook at Wiretap `ready`; the sidecar picks the plugin route for every
registry entry that carries `moduleId`, attaches two gates to such a tool (`allowedPluginModules` for its module, then its
declared gate), judges both on the picked endpoint's snapshot, and lists the tool only while the snapshot allows its
module. The client re-enforces both gates in `callTool` and trims plugin definitions from a registry push that would
exceed the Socket.IO message bound.

**Tech Stack:** JavaScript ES modules (Foundry v14 client under `src/`, plain shared modules under `shared/`),
TypeScript sidecar under `server/` run by `tsx`, zod 4.4.3, MCP SDK 1.29.0, vitest 4 + happy-dom, Playwright (headless)
on the live `test-titan` world.

**Spec:** `docs/specs/2026-11-23-wiretap-m7-plugin-tools-design.md` (approved by the owner 2026-11-23), with
`docs/PLAN.md` M7 (line ~698) and §2.6 (line ~172); the design overrides PLAN.md where they differ.

## Model/Effort directives

Execution method: parallel

- Implementers (project rule, `.claude/CLAUDE.md`): `wiretap-coder` for `server/`, `shared/`, tests, build config,
  `scripts/` and docs; `foundry-module-dev` for client `.js` under `src/` and the example plugin. The task headers name
  the agent. The `dispatching-sdd-agents` tiers choose only the model and effort these agents run at.
- Review: per review group (see `## Lanes`), `wiretap-spec-reviewer` then `wiretap-code-reviewer`; at most three fix
  rounds per group; a third round that leaves findings open goes to the drift check of `dispatching-sdd-agents`.
- Escalation of a BLOCKED implementer: the `dispatching-sdd-agents` ladder (Sonnet high, then Opus high).
- Final review: one whole-branch review by `sdd-final-reviewer`; its dispatch carries the Global Constraints below.
- High-risk tasks (offer `buddy-checking` with the two wiretap reviewers): Task 1 (the validator is the trust boundary
  for untrusted registry entries), Task 2 (the schema converter judges untrusted schemas), Task 3 (gate checks, routing,
  untrusted registry input), Task 4 (client gate re-enforcement and the push bound), Task 6 (the public API contract).
  Task 9 writes the shared world's module configuration and one folder outside the repo.

## Buddy-check directives

- Plan buddy check: declined (not offered separately; the owner chose task cross-checks).
- Flagged tasks: 1, 2, 3, 4, 6 — buddy check (`wiretap-spec-reviewer` and `wiretap-code-reviewer` as the two seats)
  replaces the group review for each, run alone on landing. Owner's decision, 2026-11-23.
- Unflagged tasks showing risk signals: ask.

## Global Constraints

Every task's requirements include each line below.

- **Scope.** The owner asked for M7 as `docs/specs/2026-11-23-wiretap-m7-plugin-tools-design.md` states it. Build
  exactly that. Non-goals: no Node-side plugin handlers; no unregister call; no Wiretap tool or MCP resource that serves a
  plugin's guide text; no proof of which module is calling. Nothing outside the task's own files changes; a defect found
  elsewhere is reported, not fixed.
- **Builders carry this line word for word:** "No unrequested features, shims or defensive code. A guard against input
  the product cannot send is not requested." Registry entries over Socket.IO and plugin calls of `api.registerTool` are
  untrusted input, so their bounds are requested.
- **No backwards compatibility.** Rename and remove freely: no aliases, shims or deprecation paths. No dynamic imports
  and no test code in shipping builds.
- **Public API (exact names).** `api.apiVersion` is `SCRIPT_API_VERSION` (1). The hook is
  `Hooks.callAll('wiretap.registerTools', api)`, fired once from Wiretap's `ready` on every client, after the shipped
  tools are registered. `api.registerTool(input)` returns `{ ok: true, name }` or `{ ok: false, reason }` and never
  throws. The author passes the short `name`; Wiretap registers `<moduleId>__<name>`. `result` is optional for plugins
  and defaults to `{ budgetBytes: 2000 }` (`COMPACT_VIEW_MAX_BYTES`); `requires` and `mutates` stay required.
  `moduleId` must name a module active in this world (`game.modules.get(id)?.active === true`).
- **Three check groups.**

  | Group | Checks | Shipped tool | Plugin tool |
  |---|---|---|---|
  | Best practice | listed definition ≤ 800 B (`DEFINITION_MAX_BYTES`); description ≤ 240 chars and the 160 target; `result.budgetBytes` ≤ 16,000 (`RESULT_HARD_CAP_MAX_BYTES`); schema depth ≤ 4, nodes ≤ 64, properties ≤ 32, enum ≤ 32 values of ≤ 64 chars, bounds ≤ 100,000, every array declares `maxItems` ≤ 1000, schema-node descriptions ≤ 240 chars | Refused; CI fails | Accepted with a warning |
  | Needed to work | name `<moduleId>__<tool>` of `[a-z0-9_-]`, no dots, at most 50 characters (`PLUGIN_TOOL_NAME_MAX_CHARS` = 50, owner's decision: Claude Code lists each tool as `mcp__wiretap__<name>`, 14 characters of prefix, and the Anthropic API refuses tool names over 64 characters); not reserved, not an `Object.prototype` member; unique; `moduleId` an active module; `version` semver-like ≤ 32 chars; `description` non-empty with no control characters; `inputSchema` an object; `result.budgetBytes` a positive integer; `requires` `api` or `dom`; `mutates` boolean; `handler` a function; `gate` a known gate other than `allowedPluginModules`; `handleArgs`, `strictNested`, `requiresUserInteraction` well formed; schema keywords the converter supports (no `$ref`, combinators, `pattern`, `format`, `default`, `const`, unknown keywords); bounds non-negative integers; enums non-empty string lists; property names `[A-Za-z_][A-Za-z0-9_]{0,63}` not `Object.prototype` members; schema depth ≤ 32 (`SCHEMA_PLUGIN_DEPTH_MAX`, server protection) | Refused | Refused, with a message saying what to change |
  | Server protection | Socket.IO `maxHttpBufferSize` 1,000,000 B; registry push rate 2/s; handle store bounds; MCP body limit 1,048,576 B | Unchanged | Unchanged |

- **Warning texts (exact).** `${n}` is the measured value; every limit is rendered from its constant, not a literal.
  Definition level, plugin route of `validateScriptDefinition` only:
  - (W1 is not used: a plugin name over 50 characters is refused with R6.)
  - W2 `description is ${n} characters, over the 240-character guideline` (replaces W3 when both apply)
  - W3 `description is ${n} characters, over the 160-character target` (the existing text, both sources)
  - W4 `result.budgetBytes is ${n}, over the 16000-byte result cap; the cap applies`

  Listed definition, plugin route of the client registry and of the sidecar's `sanitizeTool` only:
  - W5 `listed definition is ${n} bytes, over the 800-byte guideline`

  Schema, plugin route of `compileSchema` and `jsonSchemaToZodShape` only: at most one line per guideline, carrying the
  largest measured value, in this order (`SCHEMA_GUIDELINES`):
  - S1 `schema nests objects and arrays ${n} levels deep, over the 4-level guideline`
  - S2 `schema has ${n} nodes, over the 64-node guideline`
  - S3 `an object schema has ${n} properties, over the 32-property guideline`
  - S4 `an enum has ${n} values, over the 32-value guideline`
  - S5 `an enum value is ${n} characters, over the 64-character guideline`
  - S6 `a length or item bound is ${n}, over the 100000 guideline`
  - S7 `an array schema declares no maxItems; the guideline is a maxItems of at most 1000`
  - S8 `an array schema allows ${n} items, over the 1000-item guideline`
  - S9 `a schema description is ${n} characters, over the 240-character guideline`

  Log lines: client `Wiretap | script registry warning for "<name>": <text>`; sidecar
  `Wiretap sidecar | registry warning for tool "<name>": <text>` (the existing formats).
- **Refusal texts for outside authors (exact).** `${id}` and `${name}` are cut with `cleanForLog(text, 64)` of
  `shared/logText.js`.
  - R1 (validator, plugin route) `moduleId must be your module's id from module.json: 1 to 64 characters of a-z, 0-9, _
    or - (no dots or capitals), starting with a letter or digit`
  - R2 (validator, plugin route) `name must be <moduleId>__<tool>, where <tool> uses only a-z, 0-9, _ and -`
  - R3 (API) `moduleId "${id}" is not an active module in this world: pass your own module's id and enable the module`
  - R4 (API) `registerTool takes one object: { moduleId, name, version, description, inputSchema, handler, mutates,
    requires }`
  - R5 (registry, both routes) `name "${name}" is already registered: choose another tool name`
  - R6 (validator, plugin route) `name is ${n} characters; Claude Code lists it as mcp__wiretap__<name> and the API
    accepts at most 64, so <moduleId>__<tool> may be at most 50 characters`
- **Agents.** Implementers: `foundry-module-dev` for client `.js` under `src/` and `examples/`; `wiretap-coder` for
  `server/`, `shared/`, tests, `scripts/`, docs and skills. Reviewers: `wiretap-spec-reviewer` then
  `wiretap-code-reviewer`.
- **Skills first.** Before reading or editing a subsystem's files, read its skill under `.claude/skills/`:
  `wiretap-codebase-core` always; `wiretap-mcp-sessions` for `shared/scripts.js` and `server/toolRegistry.ts`;
  `wiretap-scripts` for `src/bridge/scripts/**` and `shared/schemaValidate.js`; `wiretap-mcp-bridge` for
  `server/endpoints.ts`, `server/mcp.ts`, `src/bridge/foundryBridge.js`, `src/bridge/gates.js` and `shared/gates.js`;
  `wiretap-client` for `src/hooks/**` and `lang/**`; `wiretap-build-test` for `tests/**` and `scripts/**`. For Foundry
  behaviour invoke `foundry-vtt:foundry-vtt`. The Foundry v14 source is at `C:\FoundryVTT\V14\dev\foundry\`.
- **TDD, no stubs.** Write the failing test, see it fail, write the code, see it pass. No placeholder bodies.
- **Formatting.** 3-space indentation as the existing files use; 120-character lines; multi-line `{}` on every
  conditional; objects with more than one property and arrays with more than one entry are multi-line; every variable
  typed with a one-line comment (JSDoc `@type` in `.js`, a type annotation and a `//` comment in `.ts`); every function a
  JSDoc block with typed params (`{Type} [optional] - text`) and a typed return (async included); objects typed with
  `@typedef`. No `:global` CSS.
- **Comments.** Present tense, what or why only. No task, step, plan or milestone references, no history ("previously",
  "replaced", "was"), no review notes. Cite the Foundry source file for any Foundry behaviour a comment relies on.
  Persistent client diagnostics go through the registry's log sink (`registry.log`), never `console.log`. A `TODO:`
  describes the work only and is logged in `docs/TODO.md`. Fix any comment in a touched scope that the code contradicts
  (for example "plugin skills" where the code now says plugin tools).
- **Naming.** "Skill" means only a guide folder. Code, messages and docs say "plugin tool", never "plugin skill".
- **Errors.** A client failure throws `new ScriptError(code, message)` of `src/bridge/scripts/registry.js` (message at
  most 256 B). No message echoes unbounded caller text.
- **e2e.** Headless Playwright only (`npx playwright test <spec>`, never the Playwright MCP `browser_*` tools). It uses
  the live Foundry on port 30000 and the sidecar ports 31416 to 31419; the Foundry user data and the `test-titan` world
  are shared with another project's e2e suite. Confirm all five ports are free and no other e2e run is active first. It
  overwrites `dist/`: afterwards run `npm run build`, recycle the e2e chunks (`dist/registerProbe.js`,
  `dist/registerProbe.js.map`, `dist/TerminalConnection.svelte.js`, `dist/TerminalConnection.svelte.js.map`) with
  `trash`, then `npm run check:release`. Every wait inside a loaded page is at most 1000 ms (`expect.poll`,
  `waitForFunction`, `toPass`, `timeout:`); world boot, login, reload, the build and per-test limits are exempt. Every
  e2e document name carries the `Wiretap E2E ` prefix and is recorded with `recordDocument` of `tests/e2e/registry.js`
  right after creation. Never create a document with malformed data on the shared world.
- **No permanent deletes** anywhere (`tests/unit/noPermanentDelete.test.js` enforces it); a file that must go is
  recycled with `trash`. Debug output goes under `debug/dumps/`.
- **Outside the repo.** The only folder outside the repo any task writes is
  `C:\FoundryVTT\V14\dev\foundryuserdata\Data\modules\wiretap-e2e-plugin` (the owner authorized it), and only Task 9
  writes it, overwriting and never deleting.
- **Fixtures.** Synthetic values only (`MOCK_` names, `example.com`); no PII.
- **Commands.** `npm test` (vitest, heavy: run the task's own files with `npx vitest run <files>`; the full suite runs at
  wave ends), `npm run typecheck`, `npm run eslint`, `npm run build`, `npm run check:release`,
  `npx playwright test <spec>`. After code changes run `graphify update .`.
- **Commits.** Commit each task as one logical unit once its checks pass; stage only the task's own files. Do not push.
  Every commit message ends with these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01GuTjnVcBBhMc6dNdtbAsMo`.
- **Repeat errors.** The second occurrence of the same failure ends the task: report the count and a diagnosis instead of
  patching the symptom again.

## Review Focus

Inputs the design implies but does not spell out, most likely to bite first; each has a test in the owning task.

1. A plugin calls `registerTool` while the bridge is not identified (before the first identify ack, or while the sidecar
   is down): its tool must reach the sidecar with the next identify's push. Test: Task 4 (`foundryBridge.scripts`).
2. A gate-state push that changes only another gate (for example `allowDelete`) while sessions list a plugin tool must
   send no `tools/list_changed`; only an `allowedPluginModules` change may. Tests: Task 3 (registry notify), Task 5
   (over real sockets).
3. A buggy or hostile client sends a plugin schema nested thousands of levels deep: both the client compile and the
   sidecar conversion refuse it at the 32-level ceiling without a stack overflow. Test: Task 2.
4. A plugin handler that calls a gated core operation (`ctx.core.deleteDocuments` with `allowDelete` closed) must be
   denied naming that gate even though the plugin tool declares no gate and its module is allowed. Test: Task 4
   (`riskGates`).
5. Two modules whose built names collide (`foo` + `bar__baz` and `foo__bar` + `baz` both give `foo__bar__baz`): the
   second is refused with R5 and the first keeps its own module gate. Test: Task 6.

## Decisions the design left to the builder

- `allowedPluginModules` filtering happens on the sidecar: `router.tools()` lists a plugin tool only while the routed
  endpoint's snapshot allows its module, and `setGateState` notifies subscribers when the sanitized module list changes,
  so the debounced session sync follows a settings change without a reload. The client pushes every plugin tool.
- `RequiredGate` keeps its shape `{ gate, moduleId? }`; `RegistryTool.gate?` becomes `RegistryTool.gates:
  RequiredGate[]` (plugin: the module gate first, then the declared gate). Plain `invoke` keeps its single
  `requireGate` option.
- Schema depth ceiling for every source: 32 (`SCHEMA_PLUGIN_DEPTH_MAX`). No node ceiling beyond the message bound.
- A plugin array schema without `maxItems` warns (S7): the design lists the required `maxItems` as a best practice.
- The listed-size guideline warns once, on the listed form (W5); the plugin route of the validator does not measure the
  raw definition size (it still refuses a schema that cannot be serialized).
- The client push bound is `REGISTRY_WIRE_MAX_BYTES` = 900,000 B of payload JSON, the same margin below
  `maxHttpBufferSize` (1,000,000 B) that `RESULT_WIRE_MAX_BYTES` uses for results.
- The hook argument is a frozen `pluginApi` object (`src/bridge/pluginApi.js`); `game.modules.get('wiretap').api` is not
  changed.
- The plugin route of the sidecar is chosen by an own `moduleId` property on the entry (the design's "trusting moduleId
  to pick the source").
- A wire entry without `result` is refused for every source; only the API fills the plugin default.
- The e2e fixture is written by the e2e global setup and also by `scripts/e2e-foundry-server.mjs` before it launches
  Foundry, because Playwright starts the web server before the global setup (read: `node_modules/playwright/lib/runner/
  index.js:5828-5834`, plugin setup tasks precede global setup tasks) and Foundry is expected to discover module folders
  only at server start (Unverified; the spec fails loudly when the module is absent).
- A new codebase skill `wiretap-plugin-api` is created (the `.claude/CLAUDE.md` growth rule and PLAN.md §6).

## File structure

| File | Task | Responsibility |
|---|---|---|
| `shared/scripts.js` | 1 | Plugin route of `validateScriptDefinition`: W2 to W4, R6, R1, R2, `moduleId` kept, budget clamp |
| `shared/gates.js` | 1 | `allowedPluginModules` unlock text and typedef say "plugin tools" |
| `shared/schemaValidate.js` | 2 | `compileSchema` `source` option, warnings S1 to S9, `SCHEMA_PLUGIN_DEPTH_MAX`, `SCHEMA_GUIDELINES`, `guidelineWarning`, `isWellFormedDescription` |
| `server/toolRegistry.ts` | 2, 3 | Task 2: `jsonSchemaToZodShape` `source` parameter and warnings. Task 3: plugin route in `sanitizeTool`, `gates` list, no count, total or examine bound |
| `server/endpoints.ts` | 3 | Both gates judged per call, `sameGates`, `tools()` filter, `setGateState` notify |
| `server/mcp.ts` | 3 | No `registryRoom` slice |
| `src/bridge/scripts/registry.js` | 4 | `register(definition, handler, source)`; plugin warnings; no count or total check |
| `src/bridge/scripts/callTool.js` | 4 | Module gate, then declared gate, for plugin tools |
| `src/bridge/scripts/registryPayload.js` (new) | 4 | `buildRegistryPayload`, `REGISTRY_WIRE_MAX_BYTES` |
| `src/bridge/foundryBridge.js` | 4 | `sendRegistry` sends `buildRegistryPayload(...)` |
| `src/bridge/pluginApi.js` (new) | 6 | `createPluginApi`, `pluginApi`, `PLUGIN_HOOK` |
| `src/hooks/OnceReady.js` | 6 | Fires the hook on every client after the shipped tools |
| `lang/en.json` | 6 | `allowedPluginModules` hint says "plugin tools" |
| `shared/budgets.js` | 7 | `ALWAYS_LISTED_TOOLS_MAX` and `ALL_DEFINITIONS_MAX_BYTES` removed |
| `examples/spell-text-plugin/**` (new) | 8 | Example plugin and its guide skill (not shipped) |
| `tests/e2e/plugin-fixture/**`, `tests/e2e/pluginFixtureInstall.js`, `tests/e2e/pluginFixture.js`, `tests/e2e/pluginTools.spec.js` (new) | 9 | The fixture module, its installer, its enable and restore, the live spec |
| `README.md`, `docs/PLAN.md`, `docs/PROGRESS.md`, `docs/TODO.md`, `docs/OPEN_BUGS.md` | 10 | Author guide and tracking docs |
| `.claude/skills/**`, `.claude/CLAUDE.md` | 11 | Skills to the current state; new `wiretap-plugin-api` |

## Lanes

| Task | Writes | Shared resources | Waits on | Review group | Review timing | Risky |
|---|---|---|---|---|---|---|
| T1 validator plugin route | `shared/scripts.js`, `shared/gates.js`, `shared/budgets.js` (the one name entry), `tests/unit/scripts.test.js`, `tests/unit/budgets.test.js` | none | none | G1 shared rules | on landing | yes |
| T2 schema plugin switch | `shared/schemaValidate.js`, `server/toolRegistry.ts` (converter only), `tests/unit/schemaValidate.test.js`, `tests/unit/schemaStrict.test.js` | none | none | G1 shared rules | on landing | yes |
| T3 sidecar registry and routing | `server/toolRegistry.ts`, `server/endpoints.ts`, `server/mcp.ts`, `tests/unit/toolRegistry.test.js`, `tests/unit/toolRegistry.logs.test.js`, `tests/unit/endpoints.test.js`, `tests/integration/mcpSessions.test.js`, `tests/unit/contextBudgetHarness.js`, `tests/unit/contextBudget.test.js` | none | T1, T2 | G2 sidecar | on landing | yes |
| T4 client registry, callTool, push bound | `src/bridge/scripts/registry.js`, `src/bridge/scripts/callTool.js`, `src/bridge/scripts/registryPayload.js`, `src/bridge/foundryBridge.js`, `tests/unit/scriptRegistry.test.js`, `tests/unit/callTool.test.js`, `tests/unit/registryPayload.test.js`, `tests/unit/foundryBridge.scripts.test.js`, `tests/unit/riskGates.test.js` | none | T1, T2 | G3 client | on landing | yes |
| T5 plugin integration tests | `tests/integration/pluginTools.test.js` | none | T3 | G2 sidecar | on landing | no |
| T6 public API and hook | `src/bridge/pluginApi.js`, `src/hooks/OnceReady.js`, `lang/en.json`, `tests/unit/pluginApi.test.js`, `tests/unit/OnceReady.test.js` | none | T4 | G3 client | on landing | yes |
| T7 budget entries removed | `shared/budgets.js`, `tests/unit/budgets.test.js`, `tests/unit/writeScripts.test.js`, `tests/measure/measureContext.mjs` | none | T3, T4 | G4 budgets | on landing | no |
| T8 example plugin | `examples/spell-text-plugin/**`, `tests/unit/examplePlugin.test.js` | none | T1, T2 | G5 example | phase end | no |
| T9 e2e fixture and spec | `tests/e2e/plugin-fixture/**`, `tests/e2e/pluginFixtureInstall.js`, `tests/e2e/pluginFixture.js`, `tests/e2e/pluginTools.spec.js`, `tests/e2e/global-setup.js`, `tests/e2e/global-teardown.js`, `scripts/e2e-foundry-server.mjs`, `tests/unit/pluginFixtureInstall.test.js`; outside the repo `Data/modules/wiretap-e2e-plugin/` | Foundry :30000, sidecar ports 31416-31419, `dist/`, the shared `Data/modules` folder | T3, T4, T6 | G6 e2e | on landing | yes |
| T10 author guide and tracking docs | `README.md`, `docs/PLAN.md`, `docs/PROGRESS.md`, `docs/TODO.md`, `docs/OPEN_BUGS.md` | none | T1-T9 | G7 docs | phase end | no |
| T11 skills | `.claude/skills/**`, `.claude/CLAUDE.md` | none | T1-T9 | G7 docs | phase end | no |

Waves: W1 T1, T2. W2 T3, T4, T8. W3 T5, T6, T7. W4 T9. W5 T10, T11. Run the full `npm test`, `npm run typecheck` and
`npm run eslint` once at each wave end, not inside tasks.

| Stop | Where | Kind |
|---|---|---|
| The design does not settle whether a check is best practice or needed to work | any task | stops this lane |
| A `PROTOCOL_VERSION` or `SCRIPT_API_VERSION` change looks necessary | T3, T4 | stops this lane |
| Ports 30000 or 31416-31419 are busy, or another project's e2e run is active | T9 step 1 | stops this lane |
| The fixture module is absent from `game.modules` on a server that was already running (Foundry needs a restart, which only the owner may do on the shared server) | T9 step 6 | stops this lane |
| The world's module configuration cannot be restored to what the run found | T9 any step | stops everything |
| A write outside the repo other than the authorized fixture folder | any task | stops everything |
| An e2e wait inside a loaded page needs more than 1000 ms | T9 | stops this lane |
| A `SKILL.md` cannot stay under 20,000 characters without cutting content | T11 | stops this lane |

---

### Task 1: The shared validator's plugin route

Agent: `wiretap-coder`. The owner asked that plugin tools be accepted with warnings for best-practice checks and
refused, with a message saying what to change, for checks a tool cannot work without. This task delivers that rule in
the one validator both sides use.

**Files:**
- Modify: `shared/scripts.js` (`nameProblem`, `validateScriptDefinition`, the module header comment)
- Modify: `shared/gates.js` (the `allowedPluginModules` entry's `unlocks` text and the `GateState` typedef line)
- Test: `tests/unit/scripts.test.js` (replace the two "then refuses it as not supported" plugin tests at ~492-519 and the
  `name must be <moduleId>__<skill>` expectation at ~767)

**Interfaces:**
- Consumes: `getBudget` (`shared/budgets.js`), `isModuleId` (`shared/gates.js`), `CONTROL_PATTERN`, `cleanForLog`
  (`shared/logText.js`).
- Produces: `validateScriptDefinition(input: unknown, source: 'shipped' | 'plugin' | 'agent'): { ok: true, definition:
  ScriptDefinition, warnings: string[] } | { ok: false, reason: string }`. For `plugin` the definition carries
  `moduleId` and `result.budgetBytes` is at most `RESULT_HARD_CAP_MAX_BYTES` (clamped). The `agent` route is still
  refused as `agent scripts are not supported by this version of Wiretap` after its checks.

- [ ] **Step 1: Write the failing tests** in `tests/unit/scripts.test.js` (`script(name, overrides)` is the existing
  builder of `tests/unit/scriptFixtures.js`):

```js
const plugin = (name, overrides = {}) => validateScriptDefinition(
   script(name, { moduleId: 'my-module', ...overrides }), 'plugin');

it('accepts a valid plugin script and keeps its moduleId', () => {
   const outcome = plugin('my-module__tool');
   expect(outcome.ok).toBe(true);
   expect(outcome.definition.moduleId).toBe('my-module');
   expect(outcome.definition.name).toBe('my-module__tool');
   expect(outcome.warnings).toEqual([]);
});

it('accepts a plugin name of 50 characters and refuses 51 with the prefix explained', () => {
   expect(plugin(`my-module__${'a'.repeat(39)}`).ok).toBe(true); // 50 characters
   expect(plugin(`my-module__${'a'.repeat(40)}`).reason).toBe( // 51 characters
      'name is 51 characters; Claude Code lists it as mcp__wiretap__<name> and the API accepts at most 64, so ' +
         '<moduleId>__<tool> may be at most 50 characters',
   );
});

it('warns for a plugin description over 240 characters with the 240 line only; refuses it for a shipped script', () => {
   expect(plugin('my-module__tool', { description: 'd'.repeat(300) }).warnings).toEqual([
      'description is 300 characters, over the 240-character guideline',
   ]);
   expect(validateScriptDefinition(script('tool', { description: 'd'.repeat(300) }), 'shipped').ok).toBe(false);
});

it('keeps the 160-character target warning for both sources', () => {
   expect(plugin('my-module__tool', { description: 'd'.repeat(200) }).warnings).toEqual([
      'description is 200 characters, over the 160-character target',
   ]);
});

it('clamps a plugin result budget over the hard cap to the cap with a warning; refuses it for a shipped script', () => {
   const outcome = plugin('my-module__tool', { result: { budgetBytes: 50000 } });
   expect(outcome.definition.result).toEqual({ budgetBytes: 16000 });
   expect(outcome.warnings).toEqual(['result.budgetBytes is 50000, over the 16000-byte result cap; the cap applies']);
   expect(validateScriptDefinition(script('tool', { result: { budgetBytes: 50000 } }), 'shipped').ok).toBe(false);
});

it('does not refuse or warn for a plugin definition over 800 raw bytes; refuses it for a shipped script', () => {
   const inputSchema = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
         `p${index}`,
         { type: 'string', description: 'd'.repeat(60) },
      ])),
   };
   expect(plugin('my-module__tool', { inputSchema }).warnings).toEqual([]);
   expect(validateScriptDefinition(script('tool', { inputSchema }), 'shipped').reason).toContain('definition is');
});

it('names what to change when a plugin moduleId is not a module id', () => {
   expect(plugin('my.module__tool', { moduleId: 'my.module' }).reason).toBe(
      'moduleId must be your module\'s id from module.json: 1 to 64 characters of a-z, 0-9, _ or - (no dots or ' +
         'capitals), starting with a letter or digit',
   );
});

it('names the <moduleId>__<tool> form when a plugin name breaks it', () => {
   for (const name of ['other__tool', 'my-module__', 'my-module__Tool', 'my-module__a.b']) {
      expect(plugin(name).reason, name).toBe(
         'name must be <moduleId>__<tool>, where <tool> uses only a-z, 0-9, _ and -',
      );
   }
});
```

  Add one `it.each` named `refuses each needed-to-work rule for both sources` over these overrides, asserting
  `ok === false` for `validateScriptDefinition(script('tool', overrides), 'shipped')` and for
  `plugin('my-module__tool', overrides)`: `{ version: undefined }`, `{ version: '1.0' }`, `{ description: '' }`,
  `{ description: 'a\nb' }`, `{ inputSchema: 'x' }`, `{ result: undefined }`, `{ result: { budgetBytes: 0 } }`,
  `{ result: { budgetBytes: 1.5 } }`, `{ requires: 'everywhere' }`, `{ mutates: undefined }`, `{ mutates: 'no' }`,
  `{ gate: 'allowedPluginModules' }`, `{ gate: 'noSuchGate' }`, `{ handleArgs: ['missing'] }`,
  `{ strictNested: false }`, `{ requiresUserInteraction: false }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/scripts.test.js`
Expected: FAIL; the plugin cases report `plugin scripts are not supported by this version of Wiretap`.

- [ ] **Step 3: Implement the plugin route in `shared/scripts.js`**

  - `nameProblem(name, source, moduleId)`: for `plugin`, refuse with R2 when `PLUGIN_NAME_PATTERN` or the
    `<moduleId>__<tool>` prefix fails, and with R6 when the name is over `PLUGIN_TOOL_NAME_MAX_CHARS`; `shipped` and
    `agent` keep their existing checks and messages.
  - `shared/budgets.js`: `PLUGIN_TOOL_NAME_MAX_CHARS` becomes 50, its comment stating the reason (the 14-character
    `mcp__wiretap__` prefix Claude Code adds and the API's 64-character tool-name limit); update
    `tests/unit/budgets.test.js` and the existing `scripts.test.js` case at ~501 if they pin 64.
  - `validateScriptDefinition`: the plugin `moduleId` check refuses with R1; the description check refuses an empty or
    control-character description for every source but refuses length only for `shipped` and `agent`; the budget check
    refuses a non-integer or a value below 1 for every source, refuses over the cap for `shipped` and `agent`, and for
    `plugin` clamps to `RESULT_HARD_CAP_MAX_BYTES` with W4; the raw `DEFINITION_MAX_BYTES` refusal applies to `shipped`
    and `agent` only (`definitionBytes` still runs for every source, so an unserializable schema is refused); the
    "not supported" refusal stays only for `agent`; plugin warnings are W2 or W3, then W4; the normalized
    definition copies `moduleId` when the source is `plugin`.
  - Update the module header: plugin names are `<moduleId>__<tool>` of at most 50 characters and why; say which
    checks warn for plugins.
  - `shared/gates.js`: `unlocks` of `allowedPluginModules` becomes `'Plugin tools of the listed module ids; none by
    default.'` and the `GateState` line `Ids of the modules whose plugin tools are enabled.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/scripts.test.js tests/unit/gates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/scripts.js shared/gates.js tests/unit/scripts.test.js
git commit -m "feat(shared): plugin route of the script validator warns for guidelines"
```

---

### Task 2: The schema rule set's plugin switch, on both sides

Agent: `wiretap-coder`. Delivers the warn-not-refuse rule for plugin argument schemas in the client validator and the
sidecar converter, which must stay one rule set (the parity fixtures).

**Files:**
- Modify: `shared/schemaValidate.js` (`compileSchema`, `compileNode`, `compileString`, `compileArray`, `compileObject`,
  header comment)
- Modify: `server/toolRegistry.ts` (`convertNode`, `convertObjectShape`, `jsonSchemaToZodShape`, `ShapeOutcome`,
  `ConvertState` only; `sanitizeTool` and `sanitizeRegistry` belong to Task 3)
- Test: `tests/unit/schemaValidate.test.js` (parity fixtures), `tests/unit/schemaStrict.test.js` (only if a call site
  breaks)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (in `shared/schemaValidate.js`):
  - `compileSchema(schema: unknown, options?: { strictNested?: boolean, source?: 'shipped' | 'plugin' }):
    { ok: true, validate: ArgumentValidator, listed: Record<string, unknown>, warnings: string[] } | { ok: false,
    reason: string }`; `warnings` is always `[]` for `shipped`.
  - `SCHEMA_PLUGIN_DEPTH_MAX = 32`: refused for every source with `schema nests objects and arrays deeper than 32 levels`.
  - `SCHEMA_GUIDELINES: readonly string[]` = `['depth', 'nodes', 'properties', 'enumValues', 'enumValueChars', 'bound',
    'maxItemsMissing', 'maxItems', 'descriptionChars']` and `guidelineWarning(guideline: string, measured: number):
    string` returning S1 to S9 in that order.
  - `isWellFormedDescription(value: unknown): value is string` (non-empty string with no control characters).
- Produces (in `server/toolRegistry.ts`): `jsonSchemaToZodShape(schema: unknown, strictNested?: boolean, source?:
  'shipped' | 'plugin'): { ok: true, shape: ZodRawShape, strict: boolean, warnings: string[] } | { ok: false, reason:
  string }`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/schemaValidate.test.js`:

```js
const depth = (levels) => { // an object chain `levels` deep with a string leaf
   let node = { type: 'string' };
   for (let level = 1; level < levels; level += 1) {
      node = { type: 'object', properties: { n: node } };
   }
   return { type: 'object', properties: { n: node } };
};
const booleans = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`b${i}`, { type: 'boolean' }]));

it.each([
   ['depth', depth(5), 'schema nests objects and arrays 5 levels deep, over the 4-level guideline'],
   ['nodes', { type: 'object', properties: { a: { type: 'object', properties: booleans(32) },
      b: { type: 'object', properties: booleans(32) } } }, 'schema has 67 nodes, over the 64-node guideline'],
   ['properties', { type: 'object', properties: booleans(33) },
      'an object schema has 33 properties, over the 32-property guideline'],
   ['enum values', { type: 'object', properties: { e: { type: 'string',
      enum: Array.from({ length: 33 }, (_, i) => `v${i}`) } } }, 'an enum has 33 values, over the 32-value guideline'],
   ['enum value length', { type: 'object', properties: { e: { type: 'string', enum: ['v'.repeat(65)] } } },
      'an enum value is 65 characters, over the 64-character guideline'],
   ['bound', { type: 'object', properties: { s: { type: 'string', maxLength: 100001 } } },
      'a length or item bound is 100001, over the 100000 guideline'],
   ['no maxItems', { type: 'object', properties: { l: { type: 'array', items: { type: 'string' } } } },
      'an array schema declares no maxItems; the guideline is a maxItems of at most 1000'],
   ['maxItems', { type: 'object', properties: { l: { type: 'array', maxItems: 1001, items: { type: 'string' } } } },
      'an array schema allows 1001 items, over the 1000-item guideline'],
   ['description', { type: 'object', properties: { s: { type: 'string', description: 'd'.repeat(241) } } },
      'a schema description is 241 characters, over the 240-character guideline'],
])('a plugin schema over the %s guideline compiles with one warning on both sides; a shipped one is refused',
   (_, schema, warning) => {
      const client = compileSchema(schema, { source: 'plugin' });
      const sidecar = jsonSchemaToZodShape(schema, false, 'plugin');
      expect(client.ok).toBe(true);
      expect(client.warnings).toEqual([warning]);
      expect(sidecar.ok).toBe(true);
      expect(sidecar.warnings).toEqual([warning]);
      expect(client.listed).toEqual(toJsonSchemaCompat(argumentSchema(sidecar), {
         strictUnions: true,
         pipeStrategy: 'input',
      }));
      expect(compileSchema(schema).ok).toBe(false);
      expect(jsonSchemaToZodShape(schema).ok).toBe(false);
   });

it('warns once per guideline, in guideline order, with the largest measured value', () => {
   const schema = { type: 'object', properties: {
      a: { type: 'string', enum: Array.from({ length: 33 }, (_, i) => `a${i}`) },
      b: { type: 'string', enum: Array.from({ length: 40 }, (_, i) => `b${i}`) },
      c: { type: 'string', maxLength: 100001 },
   } };
   const expected = [
      'an enum has 40 values, over the 32-value guideline',
      'a length or item bound is 100001, over the 100000 guideline',
   ];
   expect(compileSchema(schema, { source: 'plugin' }).warnings).toEqual(expected);
   expect(jsonSchemaToZodShape(schema, false, 'plugin').warnings).toEqual(expected);
});

it('refuses a plugin schema deeper than 32 levels on both sides without overflowing the stack', () => {
   for (const levels of [33, 5000]) {
      const client = compileSchema(depth(levels), { source: 'plugin' });
      const sidecar = jsonSchemaToZodShape(depth(levels), false, 'plugin');
      expect(client).toEqual({ ok: false, reason: 'schema nests objects and arrays deeper than 32 levels' });
      expect(sidecar).toEqual({ ok: false, reason: 'schema nests objects and arrays deeper than 32 levels' });
   }
   expect(compileSchema(depth(32), { source: 'plugin' }).ok).toBe(true);
});
```

  Add `it.each` named `refuses what the converter cannot support for plugin schemas as for shipped ones`, asserting
  `ok === false` on both sides with `source: 'plugin'` for: a `$ref` keyword, `oneOf`, `pattern`, `format`, `default`,
  `const`, an unknown keyword `x`, `additionalProperties: true`, `maxLength: 1.5`, `minItems: -1`, `enum: []`,
  `enum: [1]`, a property named `__proto__` (own key), a property named `a-b`, `description: 'a\nb'`, `description: ''`,
  a root that is not `type: 'object'`. Add `it('returns no warnings for a shipped schema that compiles')` asserting
  `compileSchema(validSchema).warnings` and `jsonSchemaToZodShape(validSchema).warnings` equal `[]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/schemaValidate.test.js`
Expected: FAIL (`warnings` undefined; shipped limits refuse the plugin cases).

- [ ] **Step 3: Implement the switch in `shared/schemaValidate.js` and `server/toolRegistry.ts`**

  Thread `source` through the compile/convert state. For `plugin`, record each guideline's largest measured value during
  the walk instead of throwing, and after the walk emit `guidelineWarning` lines in `SCHEMA_GUIDELINES` order. The depth
  ceiling check runs at node entry before descending, so recursion never exceeds 33 frames. A plugin array with no
  `maxItems` has no `.max()` in zod and no `maxItems` in the listed form. The sidecar imports `SCHEMA_PLUGIN_DEPTH_MAX`,
  `SCHEMA_GUIDELINES`, `guidelineWarning` and `isWellFormedDescription` from `shared/schemaValidate.js`, as it imports
  the other limits. Update both header comments to name the plugin switch.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/schemaValidate.test.js tests/unit/schemaStrict.test.js tests/unit/toolRegistry.test.js && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add shared/schemaValidate.js server/toolRegistry.ts tests/unit/schemaValidate.test.js tests/unit/schemaStrict.test.js
git commit -m "feat(schema): plugin schemas warn for complexity guidelines on both sides"
```

---

### Task 3: Sidecar registry and routing for plugin tools

Agent: `wiretap-coder`. Delivers, on the sidecar: no tool cap, the plugin route for entries that carry `moduleId`, the
two gates per plugin tool, and a listing that follows `allowedPluginModules` without a reload.

**Files:**
- Modify: `server/toolRegistry.ts` (`RegistryTool`, `sanitizeTool`, `sanitizeRegistry`)
- Modify: `server/endpoints.ts` (`sameGate` → `sameGates`, `dispatch`, `tools`, `setGateState`, the `subscribe` doc
  comment)
- Modify: `server/mcp.ts:675-676, 714` (remove `registryRoom` and its slice; keep the `fixedNames` filter)
- Test: `tests/unit/toolRegistry.test.js`, `tests/unit/toolRegistry.logs.test.js` (if a line format test breaks),
  `tests/unit/endpoints.test.js`, `tests/integration/mcpSessions.test.js` (~686, ~716-724), `tests/unit/contextBudget
  Harness.js:1482-1483`, `tests/unit/contextBudget.test.js` (~284-341, ~532-552)

**Interfaces:**
- Consumes: Task 1 `validateScriptDefinition(entry, 'plugin')`; Task 2 `jsonSchemaToZodShape(schema, strictNested,
  source)` returning `warnings`.
- Produces:
  - `RegistryTool.gates: RequiredGate[]` replaces `RegistryTool.gate?`. Shipped: `[]` or `[{ gate }]`. Plugin:
    `[{ gate: 'allowedPluginModules', moduleId }]` followed by `{ gate }` when declared. `signature` covers `gates`.
  - `sanitizeRegistry(payload, log): RegistryOutcome` examines every entry; no count, total or examine bound.
  - `Router.tools(options)` omits a tool whose `allowedPluginModules` entry is closed on the endpoint's snapshot.
  - `EndpointRegistry.setGateState(socketId, gateState)` calls the subscribers when the sanitized
    `allowedPluginModules` list differs (same ids in the same order) from the stored one, and only then.

- [ ] **Step 1: Write the failing tests**

  `tests/unit/toolRegistry.test.js` (`run(entries)` and `entry(overrides)` are the file's helpers):

```js
it('validates an entry that carries moduleId by the plugin rules and gates it by its module first', () => {
   const { outcome } = run([entry({ name: 'my-mod__echo', moduleId: 'my-mod', gate: 'allowDelete' })]);
   expect(outcome.tools[0].gates).toEqual([
      { gate: 'allowedPluginModules', moduleId: 'my-mod' },
      { gate: 'allowDelete' },
   ]);
});

it('lists a shipped gate as a one-entry list and no gate as an empty list', () => {
   expect(run([entry({ gate: 'allowUserWrites' })]).outcome.tools[0].gates).toEqual([{ gate: 'allowUserWrites' }]);
   expect(run([entry()]).outcome.tools[0].gates).toEqual([]);
});

it('accepts a plugin entry over the per-tool guidelines and logs one warning line for each', () => {
   const { outcome, lines } = run([entry({
      name: 'my-mod__big', moduleId: 'my-mod', description: 'd'.repeat(200), inputSchema: paddedSchema(1500),
   })]);
   expect(outcome.tools).toHaveLength(1);
   expect(lines).toEqual([
      'Wiretap sidecar | registry warning for tool "my-mod__big": description is 200 characters, over the ' +
         '160-character target',
      expect.stringMatching(/^Wiretap sidecar \| registry warning for tool "my-mod__big": listed definition is \d+ bytes, over the 800-byte guideline$/),
   ]);
});

it('uses the hard cap as the budget of a plugin tool that declares more', () => {
   const { outcome } = run([entry({ name: 'my-mod__echo', moduleId: 'my-mod', result: { budgetBytes: 50000 } })]);
   expect(outcome.tools[0].budgetBytes).toBe(16000);
});

it('refuses an entry whose moduleId is not a module id, naming what to change', () => {
   const { outcome, lines } = run([entry({ name: 'x__echo', moduleId: 5 })]);
   expect(outcome.tools).toEqual([]);
   expect(lines[0]).toContain('moduleId must be your module');
});

it('accepts every entry of a large registry', () => {
   const { outcome, lines } = run(Array.from({ length: 200 }, (_, index) => entry({ name: `tool_${index}` })));
   expect(outcome.tools).toHaveLength(200);
   expect(outcome.refused).toBe(0);
   expect(lines).toEqual([]);
});

it('judges every entry of an enormous payload', () => {
   const { outcome } = run(Array.from({ length: 50_000 }, () => null));
   expect(outcome.tools).toEqual([]);
   expect(outcome.refused).toBe(50_000);
});
```

  Remove the `sanitizeRegistry: total definition budget` and `sanitizeRegistry: tool count budget` describes; update the
  `tool.gate` assertion at ~64 to `tool.gates`.

  `tests/unit/endpoints.test.js`, in `router invokeTool` (the file's `tool(name, overrides)` builds through
  `sanitizeRegistry`; `plugin = tool('my-mod__echo', { moduleId: 'my-mod', gate: 'allowDelete' })`):
  - `denies a plugin tool whose module the picked endpoint does not allow, sending nothing`: snapshot
    `{ ...closedGateState(), allowDelete: true }` → rejects `{ code: GATE_DENIED }`, message contains
    `allowedPluginModules`; `sent` equals `[]`.
  - `denies a plugin tool whose declared gate is closed while its module is allowed`: snapshot
    `{ ...closedGateState(), allowedPluginModules: ['my-mod'] }` → `GATE_DENIED` containing `allowDelete`; `sent` `[]`.
  - `runs a plugin tool when its module and its declared gate are both open`: both open → `result` `'ran'`, one send.
  - `denies when the picked endpoint's gates differ from the listed tool's`: the listed endpoint registers
    `tool('my-mod__echo', { moduleId: 'my-mod' })` (module gate only); the picked endpoint registers `plugin` (module
    gate plus `allowDelete`), both gates open on the picked snapshot → rejects `{ code: GATE_DENIED }` as the existing
    declared-versus-listed gate test does; `sent` equals `[]`.
  - `lists a plugin tool only while the routed endpoint's snapshot allows its module`: `router.tools()` names equal
    `['shipped_one']` with the module closed and `['shipped_one', 'my-mod__echo']` after
    `registry.setGateState('a', { ...closedGateState(), allowedPluginModules: ['my-mod'] })`.
  - In the registry describe: `notifies subscribers when allowedPluginModules changes and not for another gate`: a
    `vi.fn()` subscriber is called 0 times for `{ ...closedGateState(), allowDelete: true }`, 1 time for
    `allowedPluginModules: ['my-mod']`, 0 times for the same list again, 1 time for `[]`.

  `tests/integration/mcpSessions.test.js`: delete the `names.length <= ALWAYS_LISTED_TOOLS_MAX` line (~686); replace
  `never lists more than the always-listed tool budget` (~716) with `lists every tool an endpoint registers`: 40 entries
  → `ack` equals `{ ok: true, accepted: 40, refused: 0 }` and `toolNames(client)` has length 45.

  `tests/unit/contextBudget.test.js`: delete `fails a 31st tool` and `fails when all definitions together exceed their
  total`; rename `does not count the helper tool toward the tool count, but counts the tools under test` to `does not
  count the helper tool toward the totals` with 25 fillers (listing 31, `totals.count` 30, `helperTotals.count` 1,
  `failures` `[]`); replace `lists no more tools than the always-listed budget however many the endpoint registers` with
  `lists every tool the endpoint registers`: `ack.accepted` equals `40 + SHIPPED_COUNT`, `ack.refused` equals 0, the
  report's `failures` equal `[]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/toolRegistry.test.js tests/unit/endpoints.test.js tests/unit/contextBudget.test.js tests/integration/mcpSessions.test.js`
Expected: FAIL (`gates` undefined, plugin entries refused for `moduleId`, 25-tool cap).

- [ ] **Step 3: Implement**

  - `sanitizeTool(entry, seen)`: source `plugin` when the entry has an own `moduleId` that is not `undefined`, else
    `shipped`; pass `source` to `jsonSchemaToZodShape`; for `plugin` a listed definition over `DEFINITION_MAX_BYTES` adds
    W5 instead of refusing; warnings are the validator's, then the schema's, then W5; build `gates` as in Interfaces.
  - `sanitizeRegistry`: drop `room`, `examineMax`, `bytesLeft` and the summary line; loop over every entry; update its
    JSDoc to say the payload is bounded by `maxHttpBufferSize` (1,000,000 B) and the caller's throttled logger bounds the
    log output.
  - `server/endpoints.ts`: `sameGates(a: RequiredGate[], b: RequiredGate[]): boolean` (same length, same `gate` and
    `moduleId` at each index); `dispatch` judges `declared.gates` for a registry call or `[options.requireGate]` for a
    plain call, in order, throwing the first denial; `tools()` filters as in Interfaces with `isModuleAllowed` of
    `shared/gates.js`; `setGateState` notifies as in Interfaces; the `subscribe` comment says an `allowedPluginModules`
    change notifies and other gate or settings changes do not.
  - `server/mcp.ts`: remove `registryRoom`, the `.slice(0, registryRoom)` and the `getBudget` import if unused; update
    the `syncRegistryTools` JSDoc.
  - `tests/unit/contextBudgetHarness.js`: remove the two `breach(...)` lines for the removed caps; keep `totals` as
    information.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/toolRegistry.test.js tests/unit/toolRegistry.logs.test.js tests/unit/endpoints.test.js tests/unit/contextBudget.test.js tests/integration/mcpSessions.test.js tests/integration/mcpHardening.test.js tests/integration/scriptRegistry.test.js && npm run typecheck && npm run eslint`
Expected: PASS; typecheck and eslint exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/toolRegistry.ts server/endpoints.ts server/mcp.ts tests/unit/toolRegistry.test.js tests/unit/toolRegistry.logs.test.js tests/unit/endpoints.test.js tests/integration/mcpSessions.test.js tests/unit/contextBudgetHarness.js tests/unit/contextBudget.test.js
git commit -m "feat(sidecar): plugin tools with module and declared gates, no tool cap"
```

---

### Task 4: Client registry, call gates and the push bound

Agent: `foundry-module-dev`. Delivers, on the Foundry client: no tool cap, the plugin route of the registry, both gates
re-enforced at call time, and a registry push that never exceeds the sidecar's message bound because of plugin tools.

**Files:**
- Modify: `src/bridge/scripts/registry.js` (`register`, `RegisteredScript`, the factory JSDoc)
- Modify: `src/bridge/scripts/callTool.js` (the gate block in `callTool`)
- Create: `src/bridge/scripts/registryPayload.js`
- Modify: `src/bridge/foundryBridge.js:254-281` (`sendRegistry`)
- Test: `tests/unit/scriptRegistry.test.js` (replace the count and total tests at ~200-225),
  `tests/unit/callTool.test.js`, `tests/unit/registryPayload.test.js` (new), `tests/unit/foundryBridge.scripts.test.js`,
  `tests/unit/riskGates.test.js`

**Interfaces:**
- Consumes: Task 1 `validateScriptDefinition(definition, 'plugin')`; Task 2 `compileSchema(schema, { strictNested,
  source })` with `warnings`; `requireGate(name, moduleId?)` of `src/bridge/gates.js`; `utf8Bytes` of `shared/utf8.js`.
- Produces:
  - `ScriptRegistry.register(definition: unknown, handler: unknown, source?: 'shipped' | 'plugin'):
    RegistrationOutcome` (default `'shipped'`); duplicate names refused with R5 on both routes; `RegisteredScript` loses
    `listedBytes`.
  - `REGISTRY_WIRE_MAX_BYTES = 900_000` and `buildRegistryPayload(definitions: ScriptDefinition[], log: (line: string)
    => void): ScriptRegistryPayload` in `src/bridge/scripts/registryPayload.js`.
  - `callTool` order: lookup (`TOOL_GONE`) → for a definition with `moduleId`, `requireGate('allowedPluginModules',
    moduleId)` → declared `gate` → argument validation → `SCRIPT_BUSY` → run.

- [ ] **Step 1: Write the failing tests**

  `tests/unit/scriptRegistry.test.js` (`lines` collects the registry's log sink):

```js
it('accepts more scripts than any former cap', () => {
   for (let index = 0; index < 100; index += 1) {
      expect(registry.register(script(`tool_${index}`), () => null).ok).toBe(true);
   }
   expect(registry.definitions()).toHaveLength(100);
});

it('registers a plugin script and logs one warning line per guideline', () => {
   const outcome = registry.register(script('my-mod__big', {
      moduleId: 'my-mod', description: 'd'.repeat(200), inputSchema: paddedSchema(1500),
   }), () => null, 'plugin');
   expect(outcome).toEqual({ ok: true, name: 'my-mod__big' });
   expect(lines).toEqual([
      'Wiretap | script registry warning for "my-mod__big": description is 200 characters, over the 160-character target',
      expect.stringMatching(/^Wiretap \| script registry warning for "my-mod__big": listed definition is \d+ bytes, over the 800-byte guideline$/),
   ]);
});

it('refuses on the plugin route what a plugin cannot work without', () => {
   const def = script('my-mod__tool', { moduleId: 'my-mod' });
   expect(registry.register(def, 'not a function', 'plugin').reason).toBe('handler must be a function');
   expect(registry.register({ ...def, requires: 'none' }, () => null, 'plugin').ok).toBe(false);
   expect(registry.register(script('my-mod__tool'), () => null, 'plugin').reason).toContain('moduleId must be');
   expect(registry.register(def, () => null, 'plugin').ok).toBe(true);
   expect(registry.register(def, () => null, 'plugin').reason)
      .toBe('name "my-mod__tool" is already registered: choose another tool name');
});

it('keeps the hard refusals of the shipped route', () => {
   expect(registry.register(script('big', { inputSchema: paddedSchema(1500) }), () => null).reason)
      .toMatch(/listed definition is \d+ bytes, at most 800 bytes/);
});
```

  `tests/unit/registryPayload.test.js` (new):

```js
const shipped = (name, size = 10) => ({ name, description: 'd'.repeat(size) });
const plugin = (name, size) => ({ name, moduleId: 'p', description: 'd'.repeat(size) });

it('holds every definition when the payload fits', () => {
   const log = vi.fn();
   const definitions = [shipped('a'), plugin('p__1', 10)];
   expect(buildRegistryPayload(definitions, log)).toEqual({ apiVersion: 1, scripts: definitions });
   expect(log).not.toHaveBeenCalled();
});

it('leaves out plugin definitions, most recently registered first, until the payload fits', () => {
   const log = vi.fn();
   const definitions = [shipped('a'), plugin('p__1', 400_000), plugin('p__2', 400_000), plugin('p__3', 400_000)];
   expect(buildRegistryPayload(definitions, log).scripts.map((d) => d.name)).toEqual(['a', 'p__1', 'p__2']);
   expect(log.mock.calls).toEqual([[
      'Wiretap | registry push left out plugin tool "p__3": the registry message would exceed 900000 bytes (the ' +
         'sidecar\'s Socket.IO message bound is 1000000 bytes)',
   ]]);
});

it('always keeps shipped definitions', () => {
   const definitions = [shipped('a', 950_000), plugin('p__1', 10)];
   expect(buildRegistryPayload(definitions, () => undefined).scripts.map((d) => d.name)).toEqual(['a']);
});
```

  `tests/unit/callTool.test.js` (a registry with one plugin script `my-mod__tool`, `gate: 'allowDelete'`, and a
  `vi.fn()` handler; the gate settings come from the file's existing `game.settings.get` mock):
  - `denies a plugin tool whose module allowedPluginModules does not list, before validating or running`: rejects
    `{ code: 'GATE_DENIED' }` with a message containing `allowedPluginModules`; the handler was not called; invalid
    arguments still give `GATE_DENIED`, not `ARGS_INVALID`.
  - `denies a plugin tool whose declared gate is closed while its module is listed`: setting value `'my-mod'` →
    `GATE_DENIED` containing `allowDelete`.
  - `runs a plugin tool when its module is listed and its declared gate is open`.

  `tests/unit/riskGates.test.js` (Review Focus 4): `a plugin tool whose handler deletes is denied naming allowDelete
  while it is closed, though its module is listed`: `gates.allowedPluginModules = 'mock-plugin'`; a fresh
  `createScriptRegistry({ log: () => undefined })` registers `script('mock-plugin__wipe', { moduleId: 'mock-plugin',
  mutates: true })` with handler `(args, ctx) => ctx.core.deleteDocuments({ uuids: [actor.uuid] })` on the `'plugin'`
  route; `createCallTool({ registry })({ name: 'mock-plugin__wipe' })` rejects with `code` `GATE_DENIED` and a message
  containing `allowDelete`; the actor is unchanged, checked the way the file's existing "changes nothing" tests check.

  `tests/unit/foundryBridge.scripts.test.js` (Review Focus 1): `pushes a plugin tool registered while disconnected
  with the next identify`: with the socket mock disconnected, register a plugin script on the wired registry; no
  `bridge:registry` emit happens; connect and ack the identify; the next `bridge:registry` payload's `scripts` names
  include the plugin tool.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/scriptRegistry.test.js tests/unit/registryPayload.test.js tests/unit/callTool.test.js tests/unit/riskGates.test.js tests/unit/foundryBridge.scripts.test.js`
Expected: FAIL (25-script cap, missing module, plugin route refused).

- [ ] **Step 3: Implement**

  - `registry.js`: `register(definition, handler, source = 'shipped')` validates with `source`; compiles with
    `compileSchema(inputSchema, { strictNested, source })`; on `shipped` a listed definition over
    `DEFINITION_MAX_BYTES` is refused as today, on `plugin` it adds W5; logs every warning (validator, schema, W5) in
    that order; removes the count and total checks and `listedBytes`; the factory JSDoc no longer mentions the
    tool-count or total budgets.
  - `callTool.js`: the module gate check for a definition with `moduleId`, then the declared gate, both through
    `requireGate` and thrown as `ScriptError(GATE_DENIED, denial.message)`.
  - `registryPayload.js`: measure each definition's JSON once; drop plugin entries (own `moduleId`) from the end of the
    list until `utf8Bytes(JSON.stringify(payload)) <= REGISTRY_WIRE_MAX_BYTES`, logging one line per entry left out;
    `apiVersion` is `SCRIPT_API_VERSION`. Its header comment names `maxHttpBufferSize` (1,000,000 B, the engine.io
    default the sidecar keeps) and why the shipped entries always stay.
  - `foundryBridge.js`: `sendRegistry` emits `buildRegistryPayload(scripts.definitions(), scripts.log)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/scriptRegistry.test.js tests/unit/registryPayload.test.js tests/unit/callTool.test.js tests/unit/riskGates.test.js tests/unit/foundryBridge.scripts.test.js tests/unit/foundryBridge.client.test.js && npm run eslint`
Expected: PASS; eslint exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/scripts/registry.js src/bridge/scripts/callTool.js src/bridge/scripts/registryPayload.js src/bridge/foundryBridge.js tests/unit/scriptRegistry.test.js tests/unit/callTool.test.js tests/unit/registryPayload.test.js tests/unit/foundryBridge.scripts.test.js tests/unit/riskGates.test.js
git commit -m "feat(client): plugin route of the script registry, both call gates, push bound"
```

---

### Task 5: Plugin tools through the real sidecar

Agent: `wiretap-coder`. Delivers the design's integration tests: a plugin tool registered mid-session is listed and
callable, an oversized result becomes a handle, a module that is not allowed is not listed and its call is denied, and
the listing follows a settings change.

**Files:**
- Create: `tests/integration/pluginTools.test.js`

**Interfaces:**
- Consumes: Task 3 (sidecar plugin route, gates, listing filter, notify on module-list change); `createHarness()` of
  `tests/integration/mcpHarness.js` (`start({ sessions })`, `connectGm({ answer })` with `register`, `pushGates`,
  `invokes`; `connectClient()`, `toolNames(client)`, `cleanup()`); `closedGateState()` of `shared/gates.js`;
  `ToolListChangedNotificationSchema` of `@modelcontextprotocol/sdk/types.js`.
- Produces: nothing other tasks use.

The plugin entry used below is `pluginEntry = entry('my-mod__echo', { moduleId: 'my-mod' })`; `allow = { ...closedGate
State(), allowedPluginModules: ['my-mod'] }`.

- [ ] **Step 1: Write the tests**
  - `lists a plugin tool registered mid-session after one tools/list_changed and runs it`: `gm.pushGates(allow)`; open
    the client; register `pluginEntry`; await one list-changed notification; `toolNames` contains `my-mod__echo`;
    `client.callTool({ name: 'my-mod__echo', arguments: { text: 'hi' } })` returns text `'done'`;
    `gm.invokes[0].params.name` equals `'my-mod__echo'`.
  - `returns a handle for a plugin result over its 2000-byte budget`: register
    `entry('my-mod__echo', { moduleId: 'my-mod', result: { budgetBytes: 2000 } })` with `answer` returning
    `{ ok: true, result: 'x'.repeat(5000) }`; `JSON.parse(result.content[0].text)` matches
    `{ handle: expect.any(String), bytes: expect.any(Number) }` and its `bytes` is greater than 2000.
  - `does not list a plugin tool of a module allowedPluginModules does not list`: gates closed; register; after the
    register ack `toolNames` does not contain `my-mod__echo` and contains the shipped `entry('plain')` registered
    beside it.
  - `refuses a call with GATE_DENIED and sends nothing when the module is removed before the list change`:
    `start({ sessions: { listChangedQuietMs: 60_000, listChangedMaxWaitMs: 60_000 } })`; `pushGates(allow)`; register;
    open the client (lists the tool); `pushGates(closedGateState())`; the call's result has `isError: true` and text
    containing `GATE_DENIED`; `gm.invokes` equals `[]`.
  - `follows a settings change: listed when the module is added, gone when it is removed`: gates closed, register,
    client open (not listed); `pushGates(allow)` → one notification → listed; `pushGates(closedGateState())` → one
    notification → not listed.
  - `sends no tools/list_changed when a gate push changes only another gate` (Review Focus 2): listed with `allow`;
    count notifications; `pushGates({ ...allow, allowDelete: true })`; wait 300 ms; the count is still 0 and the tool is
    still listed.
  - `lists many plugin and shipped tools together`: `pushGates({ ...closedGateState(), allowedPluginModules:
    ['my-mod'] })`; register 100 entries `my-mod__t${i}` with `moduleId: 'my-mod'` and 5 shipped `s${i}`; ack
    `{ ok: true, accepted: 105, refused: 0 }`; `toolNames` length 110.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/integration/pluginTools.test.js`
Expected: PASS (Task 3 has landed). A failure here is a Task 3 defect: report it with the failing assertion; do not
change `server/`.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/pluginTools.test.js
git commit -m "test(integration): plugin tools listed, gated and callable through the sidecar"
```

---

### Task 6: The public API and the hook

Agent: `foundry-module-dev`. Delivers the public client API (`api.apiVersion`, `api.registerTool`) and the
`wiretap.registerTools` hook fired at Wiretap `ready` on every client.

**Files:**
- Create: `src/bridge/pluginApi.js`
- Modify: `src/hooks/OnceReady.js`
- Modify: `lang/en.json:95` (the `AllowedPluginModules.Hint`: "plugin tools" in place of "plugin skills and scripts";
  "A plugin tool is arbitrary code ..." in place of "A plugin script ...")
- Test: `tests/unit/pluginApi.test.js` (new), `tests/unit/OnceReady.test.js`

**Interfaces:**
- Consumes: Task 4 `ScriptRegistry.register(definition, handler, 'plugin')`, `scriptRegistry`; `SCRIPT_API_VERSION`
  (`shared/scripts.js`); `isModuleId` (`shared/gates.js`); `getBudget('COMPACT_VIEW_MAX_BYTES')`; `cleanForLog`.
- Produces (in `src/bridge/pluginApi.js`):
  - `PLUGIN_HOOK = 'wiretap.registerTools'`.
  - `@typedef PluginToolInput`: `{ moduleId, name, version, description, inputSchema, handler, mutates, requires,
    result?, gate?, handleArgs?, strictNested?, requiresUserInteraction? }`.
  - `createPluginApi({ registry: ScriptRegistry, isModuleActive: (id: string) => boolean }): Readonly<{ apiVersion:
    number, registerTool: (input: unknown) => RegistrationOutcome }>` (frozen).
  - `pluginApi`: `createPluginApi({ registry: scriptRegistry, isModuleActive: (id) => game.modules?.get(id)?.active
    === true })` (Foundry `Module#active` is a non-writable boolean; read: `client/packages/module.mjs:13-21`).

- [ ] **Step 1: Write the failing tests**

  `tests/unit/pluginApi.test.js` (`lines` collects the registry log; `active = new Set(['my-mod', 'foo', 'foo__bar'])`;
  `registry = createScriptRegistry({ log: (l) => lines.push(l) })` and `api = createPluginApi({ registry,
  isModuleActive: (id) => active.has(id) })`, both rebuilt in `beforeEach`; `tool(overrides)` returns `{ moduleId: 'my-mod', name: 'echo', version: '1.0.0', description:
  'Echo a text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, handler: () => null,
  mutates: false, requires: 'api', ...overrides }`):

```js
it('exposes the script API version on a frozen object', () => {
   expect(api.apiVersion).toBe(SCRIPT_API_VERSION);
   expect(api.apiVersion).toBe(1);
   expect(Object.isFrozen(api)).toBe(true);
});

it('registers <moduleId>__<name> as a plugin script and fills the 2000-byte result default', () => {
   expect(api.registerTool(tool())).toEqual({ ok: true, name: 'my-mod__echo' });
   const { definition } = registry.get('my-mod__echo');
   expect(definition.result).toEqual({ budgetBytes: 2000 });
   expect(definition.moduleId).toBe('my-mod');
});

it('keeps a declared result budget and passes the optional fields through', () => {
   api.registerTool(tool({ result: { budgetBytes: 500 }, gate: 'allowDelete', strictNested: true,
      requiresUserInteraction: true, handleArgs: ['text'] }));
   expect(registry.get('my-mod__echo').definition).toMatchObject({ result: { budgetBytes: 500 }, gate: 'allowDelete',
      strictNested: true, requiresUserInteraction: true, handleArgs: ['text'] });
});

it('refuses a module that is not active in this world', () => {
   expect(api.registerTool(tool({ moduleId: 'sleeper' }))).toEqual({ ok: false,
      reason: 'moduleId "sleeper" is not an active module in this world: pass your own module\'s id and enable the module' });
   expect(lines.join('\n')).toContain('sleeper');
});

it('refuses a built name two modules collide on, keeping the first module\'s gate', () => {
   expect(api.registerTool(tool({ moduleId: 'foo', name: 'bar__baz' })).ok).toBe(true);
   expect(api.registerTool(tool({ moduleId: 'foo__bar', name: 'baz' }))).toEqual({ ok: false,
      reason: 'name "foo__bar__baz" is already registered: choose another tool name' });
   expect(registry.get('foo__bar__baz').definition.moduleId).toBe('foo');
});

it('never throws', () => {
   expect(api.registerTool(null)).toEqual({ ok: false, reason: 'registerTool takes one object: { moduleId, name, ' +
      'version, description, inputSchema, handler, mutates, requires }' });
   const hostile = { get moduleId() { throw new Error('boom'); } };
   expect(api.registerTool(hostile).ok).toBe(false);
});

it('refuses a tool that leaves out requires or mutates', () => {
   expect(api.registerTool(tool({ mutates: undefined })).reason).toContain('mutates');
   expect(api.registerTool(tool({ requires: undefined })).reason).toContain('requires');
});
```

  `tests/unit/OnceReady.test.js` (add `vi.mock('~/bridge/pluginApi.js', () => ({ PLUGIN_HOOK: 'wiretap.registerTools',
  pluginApi: SENTINEL }))` with a frozen sentinel object, and `globalThis.Hooks.callAll = vi.fn((name, api) =>
  calls.push(`hook:${name}:${api === SENTINEL}`))` in `beforeEach`):
  - The GM test expects `calls` to equal `['connect:http://127.0.0.1:31416', 'registerShippedScripts',
    'initFoundryBridge', 'hook:wiretap.registerTools:true']`.
  - The non-GM test (renamed `fires the hook but connects and registers nothing for a user who is not a GM`) expects
    `['hook:wiretap.registerTools:true']`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/pluginApi.test.js tests/unit/OnceReady.test.js`
Expected: FAIL (module `~/bridge/pluginApi.js` not found; no hook call).

- [ ] **Step 3: Implement**

  - `createPluginApi`: read own properties only; refuse a non-object with R4; refuse a bad `moduleId` with R1 (so the
    message is the validator's) and an inactive one with R3; build `<moduleId>__<name>`; fill `result` when it is
    `undefined`; copy each optional field only when the input has it; call `registry.register(definition, handler,
    'plugin')`; log API-level refusals through `registry.log` as `Wiretap | plugin tool refused "<label>": <reason>`;
    wrap everything in `try` so an unreadable input returns `{ ok: false, reason: 'the registration could not be
    processed' }`. The JSDoc of `registerTool` states that any module can claim any id (module identity is not proven)
    and that only GM clients push their tools.
  - `OnceReady.js`: after the GM block, `Hooks.callAll(PLUGIN_HOOK, pluginApi)` for every user; update the JSDoc (the
    hook fires after the shipped scripts registered and after every module's code ran, because Foundry calls `ready`
    after `setup`, read: `client/game.mjs:740, 777-779`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/pluginApi.test.js tests/unit/OnceReady.test.js tests/unit/scriptRegistry.test.js && npm run eslint`
Expected: PASS; eslint exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/pluginApi.js src/hooks/OnceReady.js lang/en.json tests/unit/pluginApi.test.js tests/unit/OnceReady.test.js
git commit -m "feat(client): public plugin API and the wiretap.registerTools hook"
```

---

### Task 7: The two cap budgets removed

Agent: `wiretap-coder`. Delivers the removal of `ALWAYS_LISTED_TOOLS_MAX` and `ALL_DEFINITIONS_MAX_BYTES` from the
budget table, after Tasks 3 and 4 stopped reading them; the measurement report keeps totals as information.

**Files:**
- Modify: `shared/budgets.js:89-92` (remove both entries; leave `PLUGIN_TOOL_NAME_MAX_CHARS` as Task 1 set it)
- Modify: `tests/unit/budgets.test.js:66-72`, `tests/unit/writeScripts.test.js:~152` (remove the total assertion; keep
  the per-definition checks), `tests/measure/measureContext.mjs:54-57`

**Interfaces:**
- Consumes: Task 3 and Task 4 (no remaining reader of the two names in `server/`, `src/`).
- Produces: `getBudget('ALWAYS_LISTED_TOOLS_MAX')` and `getBudget('ALL_DEFINITIONS_MAX_BYTES')` throw `Unknown budget`.

- [ ] **Step 1: Write the failing test** in `tests/unit/budgets.test.js`: `it('has no tool count or total definition
  budget')` asserting `Object.hasOwn(BUDGETS, 'ALWAYS_LISTED_TOOLS_MAX')` and `Object.hasOwn(BUDGETS,
  'ALL_DEFINITIONS_MAX_BYTES')` are `false` and `() => getBudget('ALWAYS_LISTED_TOOLS_MAX')` throws
  `'Unknown budget: ALWAYS_LISTED_TOOLS_MAX'`; remove both names from the file's expected name list.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/budgets.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** the removal; `measureContext.mjs` prints `total: ${n} tools, ${bytes} bytes, about
  ${tokens} tokens` with no maximum; `writeScripts.test.js` drops the `ALL_DEFINITIONS_MAX_BYTES` expectation.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/unit/budgets.test.js tests/unit/writeScripts.test.js tests/unit/contextBudget.test.js && npm run typecheck && npx tsx tests/measure/measureContext.mjs`
Expected: PASS; typecheck exits 0; the measurement prints a `total:` line with no `max` and `Hard failures: 0`. Then a
Grep for `ALWAYS_LISTED_TOOLS_MAX|ALL_DEFINITIONS_MAX_BYTES` over `server/`, `shared/`, `src/`, `tests/` and `scripts/`
returns no match.

- [ ] **Step 5: Commit**

```bash
git add shared/budgets.js tests/unit/budgets.test.js tests/unit/writeScripts.test.js tests/measure/measureContext.mjs
git commit -m "refactor(budgets): remove the tool count and total definition budgets"
```

---

### Task 8: The example spell-text plugin

Agent: `foundry-module-dev`. Delivers the design's example under `examples/` (not shipped): an agent parses spell text,
the plugin's handler maps the fields to an Item deterministically and calls `dryRun` first; its description works
without a guide, and it ships a small guide skill.

**Files:**
- Create: `examples/spell-text-plugin/module.json` (id `wiretap-example-spells`, title `Wiretap Example: Spells From
  Text`, version `1.0.0`, `compatibility` `{ "minimum": "14", "verified": "14" }`, `esmodules` `["index.js"]`,
  `relationships.requires` `[{ "id": "wiretap", "type": "module" }]`)
- Create: `examples/spell-text-plugin/spellTool.js` (`SPELL_FIELD_PATHS`, `mapSpell`, `createSpellTool`,
  `createSpellHandler`)
- Create: `examples/spell-text-plugin/index.js` (the hook registration)
- Create: `examples/spell-text-plugin/skills/wiretap-example-spells/SKILL.md`
- Test: `tests/unit/examplePlugin.test.js`

**Interfaces:**
- Consumes: Task 1 `validateScriptDefinition(definition, 'plugin')`; Task 2 `compileSchema(schema, { source: 'plugin' })`;
  `definitionBytes` of `shared/scripts.js`; the public API names of the Global Constraints (the example imports nothing
  from Wiretap).
- Produces (in `spellTool.js`):
  - `SPELL_FIELD_PATHS`: `{ level: 'system.level', school: 'system.school', castingTime: 'system.castingTime', range:
    'system.range', duration: 'system.duration', components: 'system.components', text: 'system.description' }` (the one
    table an author edits for their game system).
  - `mapSpell(args: SpellArgs): { name: string, type: string, system: Record<string, unknown> }`.
  - `createSpellTool`: `{ name: 'create_spell', version: '1.0.0', description, inputSchema, mutates: true, requires:
    'api' }`; arguments `name` (string, 1 to 100), `itemType` (string, 1 to 32), `level` (integer 0 to 9), `school`,
    `castingTime`, `range`, `duration` (strings, at most 64), `components` (array of enum `V`, `S`, `M`, `maxItems` 3),
    `text` (string, at most 4000); required `name`, `itemType`, `text`; `additionalProperties: false`.
  - `createSpellHandler(args: SpellArgs, ctx: { core: { createDocuments: Function } }): Promise<unknown>`: calls
    `ctx.core.createDocuments({ documentName: 'Item', data: [mapSpell(args)], dryRun: true })`, then, if that resolved,
    `ctx.core.createDocuments({ documentName: 'Item', data: [mapSpell(args)] })` and returns its rows.

- [ ] **Step 1: Write the failing tests** in `tests/unit/examplePlugin.test.js`:

```js
const full = { ...createSpellTool, name: 'wiretap-example-spells__create_spell', moduleId: 'wiretap-example-spells',
   result: { budgetBytes: 2000 } };

it('follows every guideline: no warning on the plugin route', () => {
   const validated = validateScriptDefinition(full, 'plugin');
   expect(validated.ok).toBe(true);
   expect(validated.warnings).toEqual([]);
   const compiled = compileSchema(full.inputSchema, { source: 'plugin' });
   expect(compiled.warnings).toEqual([]);
   expect(definitionBytes(full.name, full.description, compiled.listed)).toBeLessThanOrEqual(800);
   expect(full.description.length).toBeLessThanOrEqual(160);
});

it('maps the parsed fields deterministically', () => {
   expect(mapSpell({ name: 'MOCK Spark', itemType: 'spell', level: 1, school: 'MOCK school', components: ['V', 'S'],
      text: 'MOCK text.' })).toEqual({ name: 'MOCK Spark', type: 'spell',
      system: { level: 1, school: 'MOCK school', components: ['V', 'S'], description: 'MOCK text.' } });
});

it('previews with dryRun first and creates only after the preview succeeds', async () => {
   const createDocuments = vi.fn(async (params) => [{ uuid: params.dryRun ? null : 'Item.MOCKITEM00000001',
      name: 'MOCK Spark', type: 'spell' }]);
   const args = { name: 'MOCK Spark', itemType: 'spell', text: 'MOCK text.' };
   const rows = await createSpellHandler(args, { core: { createDocuments } });
   expect(createDocuments.mock.calls).toEqual([
      [{ documentName: 'Item', data: [mapSpell(args)], dryRun: true }],
      [{ documentName: 'Item', data: [mapSpell(args)] }],
   ]);
   expect(rows[0].uuid).toBe('Item.MOCKITEM00000001');
});

it('creates nothing when the preview fails', async () => {
   const createDocuments = vi.fn(async () => { throw new Error('MOCK refusal'); });
   await expect(createSpellHandler({ name: 'x', itemType: 'spell', text: 'y' }, { core: { createDocuments } }))
      .rejects.toThrow('MOCK refusal');
   expect(createDocuments).toHaveBeenCalledTimes(1);
});
```

  Also: `registers create_spell through the hook when the API version is 1, and not otherwise` (set
  `globalThis.Hooks = { once: vi.fn() }`, import `examples/spell-text-plugin/index.js`, call the captured callback with
  `{ apiVersion: 1, registerTool: vi.fn(() => ({ ok: true })) }` → `registerTool` called once with an object matching
  `{ moduleId: 'wiretap-example-spells', name: 'create_spell', handler: createSpellHandler }`; with `apiVersion: 2` it
  is not called); and `the guide skill names its tool` (the SKILL.md text has YAML frontmatter with `name:
  wiretap-example-spells` and a `description:` line, and contains `mcp__wiretap__wiretap-example-spells__create_spell`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/examplePlugin.test.js`
Expected: FAIL (files missing).

- [ ] **Step 3: Implement** the four files. `index.js` uses `Hooks.once('wiretap.registerTools', (api) => ...)`, checks
  `api.apiVersion === 1` and otherwise writes one `console.warn` naming the version it supports (the example is an
  outside author's module, so it has no Wiretap logger); a refused registration is also reported with `console.warn`
  and the returned `reason`. The description says what the tool does and what the agent passes, so it works with no
  guide. The SKILL.md (under 40 lines) tells the agent to read the spell text, fill the arguments, and call the tool;
  it says the plugin previews first.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/examplePlugin.test.js && npm run eslint`
Expected: PASS; eslint exits 0. Confirm `npm run build` output (`dist/index.js`) does not change because of the
example: nothing under `src/` imports `examples/`.

- [ ] **Step 5: Commit**

```bash
git add examples/spell-text-plugin tests/unit/examplePlugin.test.js
git commit -m "docs(examples): spell-text plugin that previews with dryRun before it creates"
```

---

### Task 9: The e2e fixture plugin on the live world

Agent: `wiretap-coder`. Delivers the design's e2e test: a real, separate fixture module registers
`wiretap-e2e-plugin__echo` through the real hook at `ready`, the hook fires after every module's code ran, a call runs
`ctx.core.createDocuments` with the §4.8 teardown, and a disabled module's tools are gone after a reload (PLAN.md M7
acceptance). The run restores the shared world's module configuration as it found it.

**Files:**
- Create: `tests/e2e/plugin-fixture/module.json` (id `wiretap-e2e-plugin`, title `Wiretap E2E Plugin`, version `1.0.0`,
  `compatibility` `{ "minimum": "14", "verified": "14" }`, `esmodules` `["index.js"]`)
- Create: `tests/e2e/plugin-fixture/index.js`
- Create: `tests/e2e/pluginFixtureInstall.js` (Node `fs` only; no Playwright import, so the launcher can load it)
- Create: `tests/e2e/pluginFixture.js` (page-side enable and restore, the pending record)
- Create: `tests/e2e/pluginTools.spec.js`
- Modify: `tests/e2e/global-setup.js`, `tests/e2e/global-teardown.js`, `scripts/e2e-foundry-server.mjs` (one call before
  `superviseServer`)
- Test: `tests/unit/pluginFixtureInstall.test.js`
- Outside the repo (authorized): `C:\FoundryVTT\V14\dev\foundryuserdata\Data\modules\wiretap-e2e-plugin\`

**Interfaces:**
- Consumes: Tasks 3, 4, 6 (the whole plugin path); `login` (`tests/e2e/fixtures.js`); `startGateSidecar`, `stopSidecar`
  (`tests/e2e/sidecar.js`); `recordGateSettings`, `restoreGateSettings`, `readSidecarGateState` (`tests/e2e/gates.js`);
  `E2E_PREFIX`, `recordDocument`, `settleRegistry`, `assertSettled`, `teardownRecorded` (`tests/e2e/registry.js`);
  `idOf` (`tests/e2e/writeHelpers.js`); `E2E_MCP_PORT` (`tests/e2e/ports.js`).
- Produces:
  - `pluginFixtureInstall.js`: `FIXTURE_MODULE_ID = 'wiretap-e2e-plugin'`, `FIXTURE_FILES = ['module.json',
    'index.js']`, `fixtureInstallDir(dataPath?: string): string` (default `process.env.FOUNDRY_DATA_PATH ??
    path.resolve(repoRoot, '..', '..', '..')`, the same default as `scripts/e2e-foundry-server.mjs`; returns
    `path.join(dataPath, 'Data', 'modules', FIXTURE_MODULE_ID)`), `installFixturePlugin(dataPath?: string): string`
    (creates the folder with `recursive: true`, writes each of `FIXTURE_FILES` from `tests/e2e/plugin-fixture/`,
    returns the folder; overwrites, never deletes).
  - `pluginFixture.js`: `FIXTURE_TOOL_NAME = 'wiretap-e2e-plugin__echo'`; `enableFixturePlugin(page): Promise<void>`
    (records `{ pending: true, world, prior: boolean | null }` in `test/state/plugin-fixture.json`, `prior` null when
    the key is absent; sets `core.moduleConfiguration` with the fixture `true` through `game.settings.set('core',
    'moduleConfiguration', next)`, as Foundry's module management does, read:
    `client/applications/sidebar/apps/module-management.mjs:504-507`; reloads and waits for `game.ready`);
    `restoreFixturePlugin(page): Promise<void>` (a no-op unless the record is pending for this world; puts the key back
    as recorded, removing it when `prior` was null; marks the record restored); `restorePendingFixtureRecord():
    Promise<void>` (from a headless browser of its own, as `restorePendingGateRecord` does).
  - The fixture's state: `game.modules.get('wiretap-e2e-plugin').api.state = { setupSeenAtHook: boolean, hookCalls:
    number, apiVersion: number, outcome: { ok, name?, reason? } }`, set in its `init` hook.

- [ ] **Step 1: Check the shared resources.** Ports 30000, 31416, 31417, 31418 and 31419 are free (PowerShell
  `Get-NetTCPConnection -LocalPort <port> -State Listen` returns nothing for each) and no other project's e2e run is
  active. If not, stop this lane and report.

- [ ] **Step 2: Write the failing installer test** in `tests/unit/pluginFixtureInstall.test.js` (scratch roots under
  `test/tmp/` named `<timestamp>-<pid>-<counter>`):
  - `installs the fixture files into <dataPath>/Data/modules/wiretap-e2e-plugin`: returns that path; both files equal
    their sources byte for byte.
  - `overwrites an earlier install and leaves extra files in place`: a stale `index.js` and an extra `notes.txt` exist
    first; after install `index.js` equals the source and `notes.txt` still exists.

- [ ] **Step 3: Run it to verify it fails, implement `pluginFixtureInstall.js` and the two fixture files, and run it to
  pass**

Run: `npx vitest run tests/unit/pluginFixtureInstall.test.js tests/unit/noPermanentDelete.test.js`
Expected: first FAIL (module missing), then PASS.

  The fixture `index.js` (plain browser ES module, no imports): `Hooks.once('init')` sets the `api.state` object;
  `Hooks.once('setup')` sets a module-level `setupSeen = true`; `Hooks.on('wiretap.registerTools', (api) => ...)`
  increments `hookCalls`, stores `setupSeenAtHook = setupSeen` and `apiVersion = api.apiVersion`, and stores
  `outcome = api.registerTool({ moduleId: 'wiretap-e2e-plugin', name: 'echo', version: '1.0.0', description: 'E2E
  fixture: creates an Actor named by text and echoes the text.', inputSchema: { type: 'object', properties: { text: {
  type: 'string', minLength: 1, maxLength: 64 } }, required: ['text'], additionalProperties: false }, mutates: true,
  requires: 'api', handler })`, where `handler(args, ctx)` creates one Actor `{ name: args.text, type: <the first
  entry of game.documentTypes.Actor other than CONST.BASE_DOCUMENT_TYPE, else 'base'> }` through
  `ctx.core.createDocuments({ documentName: 'Actor', data: [...] })` and returns `{ echo: args.text, created: rows }`.

- [ ] **Step 4: Wire the installer and the restore.** `global-setup.js` calls `installFixturePlugin()` after
  `check:build`, then `restorePendingFixtureRecord()` beside the existing restores; `global-teardown.js` calls
  `restorePendingFixtureRecord()` first; `scripts/e2e-foundry-server.mjs` calls `installFixturePlugin(dataPath)` before
  `superviseServer` (a comment says why: Playwright starts the web server before the global setup, and Foundry reads
  module folders when it starts).

- [ ] **Step 5: Write `tests/e2e/pluginTools.spec.js`**

  `beforeAll`/`afterAll` start and stop the gate sidecar. `beforeEach`: `login`; `restoreGateSettings`;
  `restoreFixturePlugin`; `teardownRecorded`; `recordGateSettings`; assert
  `game.modules.get('wiretap-e2e-plugin') !== undefined` with the message `the Foundry server started before the fixture
  module was installed at <fixtureInstallDir()>; restart Foundry once so it finds the module`; `enableFixturePlugin`;
  poll `api.bridge.identified` (1000 ms); connect the SDK client to `E2E_MCP_PORT`. `afterEach`, in `try`/`finally`:
  close the client; `settleRegistry`; `restoreGateSettings`; in `finally` `restoreFixturePlugin`; then `assertSettled`.

  One test, `the fixture registers through the hook at ready, is listed only while allowed, runs ctx.core, and is gone
  after it is disabled`:

```js
const state = await page.evaluate(() => game.modules.get('wiretap-e2e-plugin').api.state);
expect(state).toEqual({ setupSeenAtHook: true, hookCalls: 1, apiVersion: 1,
   outcome: { ok: true, name: 'wiretap-e2e-plugin__echo' } });
expect(await toolNames()).not.toContain('wiretap-e2e-plugin__echo');

await page.evaluate(() => game.settings.set('wiretap', 'allowedPluginModules', 'wiretap-e2e-plugin'));
await expect.poll(toolNames, { timeout: 1000 }).toContain('wiretap-e2e-plugin__echo');

const text = `${E2E_PREFIX}Plugin ${Date.now()}`;
const call = await callText('wiretap-e2e-plugin__echo', { text });
const reply = call.isError ? undefined : JSON.parse(call.text);
if (reply?.created?.[0]) {
   await recordDocument(page, { documentName: 'Actor', id: idOf(reply.created[0].uuid), uuid: reply.created[0].uuid,
      createdBy: 'pluginTools.spec' });
}
expect(call.isError, call.text).toBe(false);
expect(reply).toEqual({ echo: text, created: [{ uuid: expect.stringMatching(/^Actor\.[A-Za-z0-9]{16}$/), name: text,
   type: expect.any(String) }] });
expect(await page.evaluate(async (uuid) => (await fromUuid(uuid))?.name, reply.created[0].uuid)).toBe(text);

await restoreFixturePlugin(page); // the module is disabled again; the gate stays open
await page.reload();
await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60_000 });
await expect.poll(() => page.evaluate(() => game.modules.get('wiretap').api.bridge.identified), { timeout: 1000 })
   .toBe(true);
await expect.poll(toolNames, { timeout: 1000 }).not.toContain('wiretap-e2e-plugin__echo');
```

  (`toolNames` and `callText` are the helpers of `tests/e2e/scripts.spec.js`, copied into this spec.) When the record's
  `prior` was `true` (the fixture was already enabled when the run started), the last three lines are skipped with a
  logged note through `e2eLog`, because the module stays enabled.

- [ ] **Step 6: Run the e2e specs**

Run: `npx playwright test tests/e2e/pluginTools.spec.js tests/e2e/scripts.spec.js tests/e2e/gates.spec.js`
Expected: all pass. The fixture folder exists at `C:\FoundryVTT\V14\dev\foundryuserdata\Data\modules\wiretap-e2e-plugin`
and `test/state/plugin-fixture.json` holds `"pending": false`. If the spec fails on the "server started before the
fixture module was installed" assertion, stop this lane and report: only the owner restarts the shared Foundry server.
After the run, read `game.settings.get('core', 'moduleConfiguration')['wiretap-e2e-plugin']` in a fresh login: it equals
the recorded `prior` (absent when `prior` is null). If it does not, stop everything and report.

- [ ] **Step 7: Restore the production build**

Run: `npm run build`, then recycle `dist/registerProbe.js`, `dist/registerProbe.js.map`,
`dist/TerminalConnection.svelte.js` and `dist/TerminalConnection.svelte.js.map` with `trash`, then
`npm run check:release`.
Expected: `check:release` exits 0 (only `index.js`, `index.js.map`, `style.css` in `dist/`).

- [ ] **Step 8: Commit**

```bash
git add tests/e2e/plugin-fixture tests/e2e/pluginFixtureInstall.js tests/e2e/pluginFixture.js tests/e2e/pluginTools.spec.js tests/e2e/global-setup.js tests/e2e/global-teardown.js scripts/e2e-foundry-server.mjs tests/unit/pluginFixtureInstall.test.js
git commit -m "test(e2e): fixture plugin module registers through the real hook on the live world"
```

---

### Task 10: The plugin-author guide and the tracking docs

Agent: `wiretap-coder`. Delivers the README plugin-author guide the design requires and the tracking-doc updates the
project rules require at the end of a plan. `docs/PLAN.md` stays forward-looking: no as-built notes, counts or dates.

**Files:**
- Modify: `README.md` (new section `## Plugin tools (for module authors)` after "Wiretap skill for Claude Code"; the
  "Registered scripts" bullet of "MCP sessions and registered tools" (~103-126); the `allowedPluginModules` row of the
  gate table (~591) and the "Known limit" paragraph (~610))
- Modify: `docs/PLAN.md` (D10 row ~312; §2.4 source table Plugin row ~115; §2.6 rows ~182-186; §2.7 ~205-221; §4.1
  endpoint row ~351 "and `skills[]` from M7" → "and `tools`"; M7 section ~698-728; §6 M7 bullet ~892)
- Modify: `docs/PROGRESS.md` (milestone table row and an M7 entry), `docs/TODO.md` and `docs/OPEN_BUGS.md` (only for
  items deferred or found during the run; nothing is invented)

**Interfaces:**
- Consumes: the merged code of Tasks 1 to 9 (read the code; every claim in the guide is read from it or measured).
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the README guide.** It covers, in this order: what a plugin tool is and that the GM must list the
  module in `allowedPluginModules`; a complete minimal example (`Hooks.once('wiretap.registerTools', (api) => ...)`,
  checking `api.apiVersion === 1`, one `api.registerTool({...})` call, reading `{ ok, name, reason }`); the hook timing
  (once at Wiretap `ready`, after every module's code ran; `registerTool` also works later in the session; it works on
  every client but only GM clients push tools to the agent); naming (`<moduleId>__<name>`, the charset, no dots or
  capitals, long names warn); every field with required and optional marked and the `result` default of 2,000 B;
  `ctx` (`core`, `shape`, `signal`, `log`, `dom`) and that every risk gate applies inside `ctx.core`; the two gates of a
  plugin tool; the three check groups with every warning W2 to W5 and S1 to S9 and every refusal R1 to R6 explained
  with what to change; large results become handles; descriptions that stand alone (what the tool does, what to pass,
  what it returns, within 160 characters); an optional guide skill folder that names the tools as
  `mcp__wiretap__<moduleId>__<tool>` and how a user installs it (the same steps as `skills/wiretap`), descriptions
  first; the context cost of many tools (about 13 tokens per listed name per session in Claude Code, PLAN.md §2.6; full
  definitions on every request for clients that do not defer tools); the module-identity limit (any module can claim
  any id; `allowedPluginModules` controls what the agent sees, it is not a wall between modules); a pointer to
  `examples/spell-text-plugin/`. The "Registered scripts" bullet drops the claim that the sidecar refuses every entry
  over the budgets and states the shipped/plugin split; the gate row reads "Plugin tools of the module ids listed".

- [ ] **Step 2: Edit `docs/PLAN.md`** as the design's "Plan edits this design makes" lists: D10 becomes
  `Hooks.callAll('wiretap.registerTools', api)` + `api.registerTool`, integer `apiVersion`, tool names
  `<moduleId>__<tool>`, no dots, no `registerSkill` and no separate `registerScript`; §2.4's Plugin row names
  `api.registerTool`; §2.6 removes the always-listed and all-definitions rows, states that the number of tools and their
  total size are not capped (owner decision), and the per-tool rows say "registration warning for plugins" in place of
  "registration refusal"; §2.7 says the author guide covers descriptions that stand alone and an optional guide skill;
  the M7 section (renamed "M7 — Plugin tools") states In, Tests and Deliverables of the design, with the sidecar's
  existing `jsonSchemaToZodShape` as the one converter (no zod `fromJSONSchema`); §6 drops the M7 bullet.

- [ ] **Step 3: Update `docs/PROGRESS.md`** with the M7 row and entry (what shipped, the commits, the test counts from
  the last full `npm test` run, the e2e result, anything measured). Log in `docs/TODO.md` only work deferred during the
  run, and in `docs/OPEN_BUGS.md` only bugs found and not fixed.

- [ ] **Step 4: Verify**

  A Grep for `registerSkill|registerScript|wiretap\.registerSkills|ALWAYS_LISTED_TOOLS_MAX|ALL_DEFINITIONS_MAX_BYTES|
  plugin skills` over `README.md` and `docs/PLAN.md` returns no match. Every tool name the README guide writes as
  `mcp__wiretap__...` exists (shipped names, the example's name). Run `npx vitest run tests/unit/shippedSkill.test.js`:
  PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/PLAN.md docs/PROGRESS.md docs/TODO.md docs/OPEN_BUGS.md
git commit -m "docs: plugin-author guide; PLAN and PROGRESS for plugin tools"
```

---

### Task 11: Codebase skills to the current state

Agent: `wiretap-coder`. Delivers the mandatory skill update of `.claude/CLAUDE.md` ("a plan is not complete until this
is done") and the new subsystem skill its growth rule calls for.

**Files:**
- Create: `.claude/skills/wiretap-plugin-api/SKILL.md` (`paths:` `src/bridge/pluginApi.js`,
  `src/bridge/scripts/registryPayload.js`, `examples/**`, `tests/unit/pluginApi.test.js`,
  `tests/unit/registryPayload.test.js`, `tests/unit/examplePlugin.test.js`, `tests/integration/pluginTools.test.js`,
  `tests/e2e/plugin-fixture/**`, `tests/e2e/pluginFixture*.js`, `tests/e2e/pluginTools.spec.js`,
  `tests/unit/pluginFixtureInstall.test.js`)
- Modify: `.claude/skills/wiretap-scripts/SKILL.md` (Registration section: the two routes, no count or total check;
  `callTool` order with the module gate; `compileSchema` `source` and `warnings`; pointer to `wiretap-plugin-api`)
- Modify: `.claude/skills/wiretap-mcp-sessions/SKILL.md` (Tool registry section: plugin route by `moduleId`, warnings,
  `gates`, no count, total or examine bound; `jsonSchemaToZodShape` `source`)
- Modify: `.claude/skills/wiretap-mcp-bridge/SKILL.md` (router: both gates, `sameGates`, `tools()` filter,
  `setGateState` notify)
- Modify: `.claude/skills/wiretap-client/SKILL.md` (OnceReady fires the hook on every client)
- Modify: `.claude/skills/wiretap-build-test/SKILL.md` and its `references/context-budget-test.md` and
  `references/e2e-foundry-server.md` (the fixture install in the launcher and the global setup, `pluginTools` spec,
  `test/state/plugin-fixture.json`, the removed cap tests)
- Modify: `.claude/skills/wiretap-sidecar/references/script-definition.md` (plugin route, W2 to W4, R6, no "not supported"
  for plugins)
- Modify: `.claude/skills/wiretap-codebase-core/SKILL.md` (subsystem map row for `wiretap-plugin-api`)
- Modify: `.claude/CLAUDE.md` (the skills table row for `wiretap-plugin-api`)

**Interfaces:**
- Consumes: the merged code of Tasks 1 to 9; every claim is read from the code or measured (core skill rule 4).
- Produces: nothing other tasks use.

- [ ] **Step 1: Write and update the skills** to the current state, no changelog. The new skill holds: the public API
  and hook, the plugin route through both registries, the three check groups with the warning and refusal texts, the
  two gates and where each is judged, the sidecar listing filter, the push bound, the e2e fixture and its restore, and
  the example. Existing skills describe their own files and point to it for plugin detail.

- [ ] **Step 2: Measure.** Run `wc -c .claude/skills/*/SKILL.md`. Every `SKILL.md` is under 20,000 characters; one over
  it moves detail into its `references/` with a pointer (never cut). If that is not possible without cutting content,
  stop this lane and report.

- [ ] **Step 3: Verify** that every path in each touched skill's `paths:` exists (Glob each), and that a Grep for
  `ALWAYS_LISTED_TOOLS_MAX|ALL_DEFINITIONS_MAX_BYTES|plugin skills|not supported by this version` over
  `.claude/skills/` matches only the agent-script refusal text. Run `graphify update .`.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills .claude/CLAUDE.md
git commit -m "docs(skills): plugin tools in the codebase skills; new wiretap-plugin-api skill"
```
