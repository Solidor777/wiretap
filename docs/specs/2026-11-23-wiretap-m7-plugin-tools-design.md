# M7 — Plugin tools: design

Status: approved by the owner in conversation on 2026-11-23 ("write the design, approve when it lands").

## Intent

Any Foundry module author, not only the owner, can give the agent new tools. A module registers its tools through a
public Wiretap API; Wiretap lists them to the agent beside its own tools. The GM decides which modules' tools the agent
sees. The audience is everyone, so every message an author can receive must say exactly what to change, and the
author guide must work for someone who has never read Wiretap's code.

## Goals

- A public client-side API: `api.apiVersion`, `api.registerTool(...)`, and the hook
  `Hooks.callAll('wiretap.registerTools', api)` fired at Wiretap `ready`.
- Plugin tools are full peers of the built-in tools: same definition fields, same registry, same routing, same
  `ctx` (including `ctx.core.*` with every risk gate still applied), same result enforcer.
- No cap on the number of tools or on their total definition size, for plugins or for Wiretap's own tools.
- Per-tool context guidelines are best practices: Wiretap holds its own tools to them (the build fails), plugins only
  get warnings.
- A plugin works with its descriptions alone; an optional guide skill shipped by the plugin makes workflows better.
- README plugin-author guide and an example plugin under `examples/` (not shipped).

## Non-goals

- Node-side (sidecar) plugin handlers: M20 (D31).
- An unregister call. A disabled module's tools disappear after the next reload.
- Wiretap delivering a plugin's guide text to the agent (no new tool or MCP resource for guides).
- Proving which module is calling. All module code runs in one browser page with full access; any module can claim
  another's id. `allowedPluginModules` controls what the agent sees; it is not a wall between modules. The guide says so.

## Anti-goals

- A plugin author hits a refusal for a size or count guideline. Guidelines only warn.
- A refusal message an outside author cannot act on.
- Wiretap's own tools quietly drifting past the per-tool guidelines (their build checks stay).

## Decisions (the owner's, from the conversation)

1. **Audience: everyone.** Outside authors are first-class.
2. **No tool cap.** `ALWAYS_LISTED_TOOLS_MAX` (30) and `ALL_DEFINITIONS_MAX_BYTES` (16 KB) are removed everywhere:
   the budget entries, the client registry checks (`src/bridge/scripts/registry.js`), the sidecar checks
   (`server/toolRegistry.ts` room and bytes-left, `server/mcp.ts` `registryRoom` slice), and the context-budget CI
   breaches (`tests/unit/contextBudgetHarness.js`). The measurement report (`tests/measure/measureContext.mjs`) may
   keep reporting totals as information. PLAN.md §2.6's "raising it is a user decision" row is replaced by this
   decision.
3. **Best practices, not limits, for plugins.** Wiretap's own (shipped) tools keep every per-tool check as a hard
   refusal and a CI failure. For plugin tools the same checks produce a warning and the tool is accepted.
4. **Discovery is A + B.** (A) every plugin tool's name and description must let the agent find and use it with no
   guide; (B) a plugin may also ship a Claude Code skill folder, installed by the user like `skills/wiretap`. Wiretap
   builds nothing for B; the author guide teaches both, descriptions first.
5. **Naming (owner delegated; Claude's call):** `api.registerTool` and hook `wiretap.registerTools`. `registerSkill`
   and the plan's separate `api.registerScript` are dropped: one call, the existing optional fields stay optional.
   "Skill" means only the guide folder. This edits D10 in PLAN.md.

## How each existing check treats a plugin tool

Three groups. The split was confirmed by the owner.

| Group | Checks | Shipped tool | Plugin tool |
|---|---|---|---|
| Best practice | definition ≤ `DEFINITION_MAX_BYTES` (800 B); description ≤ 240 chars and the 160 target; `result.budgetBytes` above `RESULT_HARD_CAP_MAX_BYTES`; schema complexity limits in `shared/schemaValidate.js` (`SCHEMA_DEPTH_MAX` 4, `SCHEMA_NODES_MAX` 64, `SCHEMA_PROPERTIES_MAX` 32, `SCHEMA_ENUM_MAX` 32, `SCHEMA_ENUM_VALUE_MAX_CHARS` 64, `SCHEMA_BOUND_MAX`, and the required array `maxItems` ≤ 1000) | Refused; CI fails | Accepted with a warning |
| Needed to work | name format `<moduleId>__<tool>` from the allowed charset, no dots (D10), at most 50 characters (see "Settled points"); not reserved, not an `Object.prototype` member; unique; `moduleId` an active module; required fields present and typed (`version`, `description` non-empty with no control characters, `inputSchema`, `requires` `api`/`dom`, `mutates` boolean, `result.budgetBytes` a positive integer); schema keywords the converter supports (no `$ref`, combinators, `pattern`, `format`, `default`, `const`, unknown keywords); `handler` a function; `gate` a known gate | Refused | Refused, with a message saying what to change |
| Server protection | Socket.IO `maxHttpBufferSize` (1,000,000 B) on the registry message; the registry push rate limit; handle store bounds; MCP body limit | Unchanged | Unchanged |

Large results: a plugin result over the runtime hard cap becomes a `{handle, bytes, summary}` saved result, as for
shipped tools. A plugin that declares `result.budgetBytes` above `RESULT_HARD_CAP_MAX_BYTES` is warned and its
effective budget is the hard cap (Claude Code refuses large inline results; PLAN.md §2.1).

Hostile-payload bound: the sidecar's "examine at most twice the tool cap" entry limit goes away with the cap. The
registry message is already bounded by `maxHttpBufferSize`, so work per push stays linear in at most 1 MB. A schema
depth ceiling stays as server protection so a deeply nested schema cannot exhaust the converter's recursion (see
"Left to the builder").

Warnings go to the client console and the sidecar log (Claude's call), one line each, naming the tool, the measured
value and the guideline.

## The API

- `api.apiVersion`: an integer (`SCRIPT_API_VERSION`, currently 1). A plugin compares it before registering.
- `Hooks.callAll('wiretap.registerTools', api)`: fired once from Wiretap's `ready`, after the shipped tools are
  registered. A plugin may also call `api.registerTool` later in the session; each accepted tool is pushed to the
  sidecar (existing `subscribe` → `queueRegistryPush`) and sessions get `tools/list_changed`.
- `api.registerTool({ moduleId, name, version, description, inputSchema, handler, mutates, requires, result?, gate?,
  handleArgs?, strictNested?, requiresUserInteraction? })` returns `{ ok: true, name }` or `{ ok: false, reason }` and
  never throws (as `ScriptRegistry.register` today). The author passes the short `name`; Wiretap builds
  `<moduleId>__<name>`. `result` is optional for plugins and defaults to the §2.6 compact budget (2 KB) per the plan.
  `requires` and `mutates` stay required, never defaulted.
- `moduleId` must name a module that is active in this world (`game.modules.get(id)?.active`).
- Collision: a name already registered (shipped or plugin) is refused.
- Handlers receive the same `ctx` as shipped scripts; `ctx.core.*` are the same functions the core tools use and every
  risk gate applies inside them.

## Visibility and the `allowedPluginModules` gate

A plugin tool is callable only while its `moduleId` is in the GM's `allowedPluginModules` setting. The existing
pieces: `shared/gates.js` (`isModuleId`, the gate predicate with a module id), `src/bridge/gates.js`
`requireGate(name, moduleId)`, and the sidecar's `RequiredGate { gate, moduleId }` judged against the endpoint's gate
snapshot (`server/endpoints.ts`). The client re-enforces at call time, as for every gate.

Two gates (Claude's call): a plugin tool may also declare its own risk `gate` (for example `allowDelete`). Both must
be open: the module gate for its `moduleId` and the declared gate. The sidecar checks both against the picked
endpoint's snapshot before sending, so `RequiredGate` becomes able to carry more than one gate (a list, or a module
id beside the declared gate; the builder picks the shape), and the client re-enforces both. A tool of a module that is not
allowed is not listed to the agent. Whether the client filters it out of the pushed registry or the sidecar filters it
by the snapshot is left to the builder; the result must be that the listing follows a settings change without a
reload.

## Schema protection limits (owner's decisions, 2026-11-23, after the first schema review)

- **Depth:** a schema nested deeper than 32 levels is refused for every source. It is server protection against
  stack exhaustion, not a "needed to work" rule; the 4-level guideline still only warns for plugins.
- **Expanded nodes:** a schema passed in code may reuse one object in several places. Reuse is allowed and each reused
  piece is counted every time it appears. A schema that expands past about 60,000 nodes (what one 900,000-byte
  registry message can carry) is refused for every source, on both sides, as protection; the walk stops as soon as it
  passes the limit. The 64-node guideline still only warns for plugins.
- Linear work: schema checks cost time linear in the schema's size on both sides (no per-property list scans).

## Settled points (from the builder check)

- **Name length is needed to work (owner's decision, 2026-11-23).** Claude Code lists each tool as
  `mcp__wiretap__<name>` (14 characters of prefix), and several Claude Code bug reports describe the Anthropic API
  refusing tool names over 64 characters. So a plugin name `<moduleId>__<tool>` over 50 characters is refused, with a
  message giving the limit and the reason. This replaces the older measurement in PLAN.md §2.6 that 110-character
  names worked.
- **Warnings already have a channel.** `validateScriptDefinition` returns `{ ok: true, definition, warnings }`; the
  plugin path adds its best-practice findings to `warnings`. The schema limits in `shared/schemaValidate.js`
  (`compileSchema`) and `server/toolRegistry.ts` (`jsonSchemaToZodShape`) refuse today; both gain the same
  plugin-or-shipped switch so a plugin schema over a complexity limit warns, while unsupported keywords and the
  server-protection depth ceiling still refuse.
- **Trusting `moduleId` to pick the source** is accepted: the pushing client is an identified GM browser, a shipped
  definition can never carry `moduleId` (`shared/scripts.js:350`), and choosing the plugin route only makes the checks
  less strict for that one tool, never another.
- **Push size (Claude's call).** The registry message is bounded by Socket.IO `maxHttpBufferSize` (1,000,000 B); an
  over-size message is dropped whole, which would take Wiretap's own tools down with it. The client therefore measures
  the payload before pushing. If it would exceed the bound, it leaves out plugin tools, most recently registered
  first, until it fits, and logs one warning per tool left out that names the message bound. Shipped tools are always
  included. This is server protection (group 3), not a guideline. At about 800 B per definition it starts near 1,200
  plugin tools.
- **Non-GM clients (Claude's call).** The hook fires and `api.registerTool` works on every client, so a plugin needs no
  role check. Only GM bridge endpoints push a registry, so only their tools reach the agent. The guide says so.
- **`result` default applies only to plugins.** Shipped definitions keep `result.budgetBytes` required; the plugin route
  fills the compact default (2 KB) when `result` is absent, before validation.

## Wire changes

- A registry entry from a plugin carries `moduleId`; the sidecar validates such an entry as source `plugin`
  (`validateScriptDefinition(entry, 'plugin')`), every other entry as `shipped`. The "not supported by this version"
  refusal for plugin definitions is removed; agent definitions stay refused (M16).
- The validator gains the warn-not-refuse path for plugin definitions (the best-practice group above); shipped
  definitions keep hard refusals. One shared validator still judges both sides.
- No change to `PROTOCOL_VERSION` is required unless the builder finds an incompatibility; `SCRIPT_API_VERSION` stays 1
  unless the registry payload shape changes.

## Plan edits this design makes

- D10: `registerTool` / `wiretap.registerTools`; no `registerSkill`, no separate `registerScript` on the public API.
- §2.6: the always-listed and all-definitions rows are removed; the per-tool rows say "registration warning for
  plugins" instead of "registration refusal".
- M7 section: In, Tests and Deliverables updated to this design (zod `fromJSONSchema` is not used: the sidecar's
  existing converter `jsonSchemaToZodShape` stays the single converter, so plugins and shipped tools share one schema
  rule set; the plugin-side difference is only warn vs refuse).
- PLAN.md §2.7 / M7 deliverables: the author guide covers descriptions that stand alone and an optional guide skill.

## Tests (from the plan, adjusted)

- Unit: the plugin route of the shared validator (each best-practice check warns for plugin and refuses for shipped;
  each needed-to-work check refuses for both); the name builder; `apiVersion`; collision; active-module check; the
  gate; the removed count and total checks (many tools accepted on both sides).
- Integration: a fake client registers a plugin tool mid-session → `tools/list_changed` → the tool is callable; an
  oversized plugin result becomes a handle; a plugin tool of a module not in `allowedPluginModules` is not listed and a
  call is `GATE_DENIED`; a settings change updates the listing.
- e2e: a fixture plugin registers `<fixtureModuleId>__echo` through the real hook at `ready`, and a call runs
  `ctx.core.create_documents` (with §4.8 teardown). It also asserts the hook fires after every module's code has run.
  The fixture is a real, separate Foundry module (owner's decision): `wiretap-e2e-plugin`, installed at
  `<Foundry Data>/modules/wiretap-e2e-plugin` (the owner authorized this one folder outside the repo). Its source
  lives in the repo under `tests/e2e/` (Claude's call) and the e2e global setup writes it to that folder, overwriting
  and never deleting. The e2e run enables it in the test world at the start and disables it at the end (in `finally`),
  restoring the world's module configuration as it found it, because the world and the modules folder are shared with
  the titan e2e suite. It is never part of the shipping build.
- Context budget: Wiretap's own tools still pass every per-tool CI check; the count and total breaches are gone.

## Deliverables

- README plugin-author guide: the API, the hook timing, naming, the three check groups with each warning and refusal
  explained, how to write descriptions that stand alone, how to write and ship an optional guide skill that names the
  tools, the context cost of many tools (≈13 tokens per listed name per session in Claude Code; full definitions on
  every request for clients that do not defer tools), and the module-identity limit.
- `examples/` spell-text → Item plugin (not shipped): the LLM parses, the handler maps deterministically and calls
  `dryRun` first; its descriptions work without a guide and it ships a small guide skill.
- Skills and tracking docs updated per `.claude/CLAUDE.md`.

## Approaches considered

- **Plugins under the same caps as shipped tools.** Rejected: about 8 slots for all plugins; the owner wants no cap.
- **Plugins get a separate capped budget.** Rejected by the owner: no cap at all.
- **Chosen: no caps; per-tool guidelines hard for shipped, warnings for plugins; needed-to-work rules refuse for both.**
- Discovery: descriptions only (A), plugin-shipped guide skill (B), Wiretap-served guide (C). Chosen A + B; C is a new
  feature nobody asked for.
- Schema conversion: zod `fromJSONSchema` (plan) vs the existing `jsonSchemaToZodShape`. Chosen the existing one: one
  rule set on both sides, already mirrored in the client validator.

## Left to the builder

- Where `allowedPluginModules` filtering of the listing happens (client push or sidecar snapshot), as long as a
  settings change updates the listing without a reload.
- The schema depth ceiling kept as server protection for plugin schemas (Claude's proposal: 32 levels), and any other
  recursion bound the converter or the client validator needs on untrusted input.
- Warning text wording and log throttling (reuse the existing throttled logger).
- The order of tasks and files touched.

## Open questions

None. Every question from the conversation and the builder check is answered above.
