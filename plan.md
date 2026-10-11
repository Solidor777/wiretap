# Wiretap plan: document skills for every type, plugin skills, seatless agents

Status: draft for approval (2026-10-10), revision 2 (context budget added as top priority, see §10). Baseline: HEAD
`048df55`. Evidence labels: **MEASURED** (command or run named), **READ** (source location named), **INFERRED** (not
verified; alternatives not excluded). Paths under `foundry/` are relative to `C:\FoundryVTT\V14\dev\foundry\` (v14
stable, build 364, READ `package.json`).

## 1. Context and goals

Wiretap today: one MCP tool, `create_actor`. The request path is MCP HTTP (`127.0.0.1:31417/mcp`, stateless; a new
`McpServer` is built per request, READ `server/mcp.ts:95-100`) → `bridge.invokeOnGM` (first identified GM socket, READ
`server/foundryBridge.ts:57-76`) → Socket.IO `bridge:invoke` → `OP_HANDLERS` on a GM browser client (READ
`src/bridge/foundryBridge.js:25-27`). Socket.IO is bound to `127.0.0.1` (READ `server/server.ts:30`). Identify trusts
the client's `isGM` claim (READ `server/foundryBridge.ts:40-44`).

Goals:

- **G0 Minimal context use (TOP PRIORITY, cross-cutting).** Every tool definition, argument, result, image and error
  is budgeted (§2). It overrides convenience in every milestone.
- **G1 Core skills for every document type.** Read, create, update, replace and (pending, see D12) delete for all
  v14 primary and embedded types (READ `foundry/common/constants.mjs:332-424`), compendium content, open a sheet,
  rolls and table draws.
- **G2 Plugin skills.** Modules that depend on Wiretap register their own MCP tools; handlers run in the Foundry
  client.
- **G3 No human seat.** Skills work when no human has a GM tab open, on a headless server.

What "no seat" means (READ, see §4.3): a Foundry *client* must still run for anything that needs system or module
code, sheets, derived data or plugin handlers. The seat is taken by a headless agent browser, not by a human. A
raw-socket path without any client is possible but bypasses all client-side logic; its use is limited to operations
that M0 certifies.

## 2. Context budget: top priority

**Requirement (user, 2026-10-10):** minimising the MCP client's context use is a huge priority. "Context" = the
agent's context window: tool definitions, call arguments, tool results, screenshots/images and error text. The user
proposed pre-written scripts for actions such as opening a sheet, measuring an element and making an edit. Every
milestone carries a context-budget acceptance criterion; M13's automated test enforces the budgets in §2.6.

### 2.1 Measured cost model

**Method (MEASURED, 2026-10-10).** A throwaway loopback MCP server in the session scratchpad (raw JSON-Schema tools,
canned results, `@modelcontextprotocol/sdk` 1.29.0 from the repo's `node_modules`, stateless like `server/mcp.ts`)
was driven by `claude -p --model haiku --output-format stream-json --verbose --strict-mcp-config --mcp-config <cfg>`
(claude 2.1.296; the run reports model `claude-haiku-5-5`). Six invocations (R1–R6). Context per turn = `input_tokens
+ cache_creation_input_tokens + cache_read_input_tokens` of each assistant message; the delta between consecutive
turns = the previous `tool_use` block plus its result. Payloads came from real dnd5e pack sources
(`Data/systems/dnd5e/packs/_source`, YAML → minified JSON) as a stand-in for a canonical actor export; titan
exports were not measured (M0 E9). Each figure is one run; token counts depend on input only, but only this one
model's tokenizer was measured.

| Item | Bytes | Context tokens | Run |
|---|---|---|---|
| Session baseline in this environment, 1 MCP tool | — | 44,216 | R1 |
| 16 MCP tools, none loaded (deferred) | 6,507 of schema not sent | 44,399 (+183, ≈12 per tool) | R2 vs R1 |
| 40 MCP tools, none loaded (deferred) | 12,717 of schema not sent | 44,736 (+337 for 24 more, ≈14 per tool) | R3 vs R2 |
| Load 16 core + meta schemas (one ToolSearch) | 6,507 | +3,113 (≈195 per tool) | R6 |
| Load 24 per-script schemas (one ToolSearch) | 6,210 | +3,542 (≈148 per tool) | R6 |
| Load 3 schemas (`get_document`, `run_script`, `update_documents`) | ≈1,500 | +801 | R4 |
| Smallest round trip: `element_size` numbers | 71 | +172 | R4, R5 |
| Ack-only write result | 84 | +172 | R4 |
| Projected view (10 fields) | 301 | +266 | R4 |
| Compact view (id, name, type, 31 item tuples) | 1,484 | +1,037 | R4 |
| Full export, median dnd5e humanoid monster (of 40) | 18,343 | +8,954 | R5 |
| Full export, median dnd5e premade hero (of 12; 31 items) | 84,564 | Not delivered: Claude Code replaced it with a 1.7 KB "exceeds maximum allowed tokens; output saved to file" notice (+895) | R4 |
| Screenshot PNG 800×600 (596 KB base64) | — | +972 | R5 |
| Same layout question answered as numbers | 71 | +172 | R5 |

Byte sizes of the sources (MEASURED, `payloads.mjs` in the scratchpad): dnd5e heroes min/median/max 56,966 / 84,564 /
118,811 bytes; dnd5e `monsters/humanoid` 8,587 / 18,343 / 85,190 bytes. Drafted core tool definitions: 170–787 bytes
each, 5,729 bytes for 13.

**Derived (INFERRED, arithmetic on the rows above):**

- **Per-call floor ≈ 170 tokens.** A call with a near-empty result still costs its `tool_use` block plus wrapper.
  A composite script that replaces N calls saves ≈ 170 × (N − 1) plus every intermediate result the agent would
  otherwise have read.
- **≈ 2 bytes of JSON per token** (18,343 B → 8,954; 6,507 B of schema → 3,113). A median dnd5e hero export would
  be ≈ 41k tokens if delivered.
- **Claude Code has an inline result cap** between 21.7 KB (the escaped 18 KB export, delivered) and 84.6 KB (refused)
  of text; the exact value was not read. Above it the agent must slice a saved file and pays for whatever it reads.
- **Deferred loading changes the calculus (MEASURED R2–R4, R6).** An unused tool costs only its name (≈12–14 tokens).
  A schema costs ≈150–195 tokens once per session when ToolSearch loads it; R4 called `get_document` three times
  after one load. Descriptions are therefore paid on load, not every turn, in Claude Code. A client that does not
  defer (not measured) would pay every definition on every request: ≈3.1k tokens for 16 tools, ≈6.7k for 40.
- **Results dominate.** Definitions cost hundreds of tokens once; one unshaped read costs thousands, or fails.

### 2.2 Mechanisms ranked

| # | Mechanism | Saving (evidence) | Build cost | Risk / mitigation | Where |
|---|---|---|---|---|---|
| 1 | Compact-by-default reads + `fields` projection | Full 18 KB export 8,954 → projected +266 (≈96 above the floor); a hero export becomes deliverable at all (MEASURED) | Low | Agent needs a field not in the view → `fields` or explicit `mode:"full"` | M4 |
| 2 | Hard result cap + saved-result handles | Removes the "exceeds maximum allowed tokens" failure; export/import/copy without the body entering context (INFERRED from R4) | Medium (sidecar in-memory store) | Memory growth → bounded per-session LRU in memory; no files, so no deletion | M13 |
| 3 | Ack-only writes (`uuid`, changed paths) | +172 vs re-reading the document (+1,037 compact) (MEASURED) | Low | Agent cannot see derived side effects → optional `fields` on the ack | M5 |
| 4 | Measurements instead of screenshots | +172 vs +972 for one 800×600 image (MEASURED, single sample) | Medium (needs DOM endpoint) | Visual-only questions remain → `screenshot` as capped last resort | M15 |
| 5 | Composite scripts (one call for N steps) | ≈170 per eliminated call + intermediate results (INFERRED from the floor) | Medium per script | Catalogue sprawl; each script is maintained API → catalogue reviewed per milestone | M15 |
| 6 | Pagination: default limit 20, max 100, continuation cursor | Bounded search results (INFERRED) | Low | Agent pages blindly → result carries `total` | M4 |
| 7 | Short actionable errors (≤ 512 B; first 10 validation failures + count) | Bounded; `getAllFailures()` can list every invalid field (READ `common/data/validation-failure.mjs:374`) | Low | Lost detail → `fields` re-check or `dryRun` | M1, M5 |
| 8 | Change-only reads: `diff_since(cursor)` and `ifModifiedSince` (`{unchanged:true}`) | Re-reads shrink to changed rows (INFERRED) | Low–medium | Clock basis = `_stats.modifiedTime` | M15 |
| 9 | Description and schema budgets | ≈150–195 tokens per loaded tool; names ≈13 always (MEASURED) | Low | Terse descriptions mislead → reviewed wording, examples only in README | M13 |
| 10 | Server-side summarisation | Only deterministic (counts, tuples); LLM summarisation impossible (sampling `-32601`, MEASURED by user) | — | Folded into compact views | M4 |

### 2.3 Verdict on the user's script proposal

**Recommendation: adopt, modified, and combined with result shaping** (D18, PENDING-USER).

- **Adopt.** Pre-written, parameterised, schema-validated routines that run in a Foundry client and return budgeted
  results. Measured wins: one call instead of N (≈170 tokens floor each plus intermediate results) and numbers instead
  of screenshots (+172 vs +972).
- **Modify the delivery.** Expose each script as its own MCP tool, not through one generic `run_script(name, args)`
  dispatcher. Evidence: in Claude Code a deferred tool costs ≈13 tokens until used and its schema ≈150 tokens once;
  a dispatcher needs `list_scripts` and `describe_script` round trips (≥ 2 × 170 floor plus listing and schema text)
  before the first call, and loses the client-side schema check. A dispatcher wins only for clients that do not defer
  tools (not measured). One registry feeds both exposures; `dispatcher` mode is built only if D19 asks for it.
- **Unify with the core tools.** The generic core tools (`get_document`, `search_documents`, `create_documents`,
  `update_documents`, …) are shipped scripts of the generic category: one registry, one validation path, one result
  enforcer. Task-shaped scripts call the same op functions (`ctx.core.*`).
- **Combine.** The largest measured saving is result shaping (rows 1–3 of §2.2), not the script mechanism. Both are
  required; scripts without shaping would still return 84 KB exports.

### 2.4 Script design

A **script** is a registered, named, versioned routine:

```
{ name, version, description, inputSchema, result: { budgetBytes, shape },
  requires: 'none' | 'api' | 'dom', mutates, gate?, handler(args, ctx) }
```

Sources, in trust order:

| Source | Code origin | Trust | Callable when |
|---|---|---|---|
| Shipped | `src/bridge/scripts/*.js`, static imports in the bundle | Vetted (repo review) | Always; gated categories call `requireGate` |
| Plugin | `api.registerScript` (M7; `registerSkill` writes the same registry) | Installed module code | Module listed in `allowedPluginModules` |
| Approved | Agent-proposed source text, approved by a GM in the Foundry UI | Human-reviewed | Gate `allowApprovedScripts` on, hash matches, `enabled` (D21) |
| Ad-hoc | `run_js(code)` sent by the agent | Untrusted | Not built unless D22; then gate `allowAdhocCode` |

**Execution context `ctx`:** `ctx.core.*` (the core op functions, gates apply), `ctx.shape` (projection, compact view,
ack), `ctx.dom` (only on a DOM-capable endpoint), `ctx.signal` (timeout). Arguments are validated twice: on the
sidecar (zod from JSON Schema, the M7 mechanism) and on the client (same schema). Every result passes the sidecar
enforcer: over budget → `{handle, bytes, summary}`.

**Where scripts run:**

- `api`: any client endpoint (agent or human GM tab). Raw socket (B) only for ops M0 certifies.
- `dom`: the agent endpoint by default; a human tab only with an explicit `endpoint` override, because rendering a
  sheet on a human's screen is disruptive (D25). `screenshot` is captured by the agent runner's Playwright page on
  the sidecar; the client supplies the region rectangle. Unit tests cannot measure layout: happy-dom (READ
  `vitest.config.mjs`) performs no layout, so sizes are mocked in unit tests and real only in e2e.
- `none`: the sidecar (handle slices, `list_endpoints`).

**Discovery:** standard `tools/list`, deferred by Claude Code; plugin and approved scripts arrive via
`notifications/tools/list_changed` (M3). Not measured: whether a tool added via `list_changed` is also deferred (M3
live check).

**Agent-authored scripts (D21), no deletion anywhere:**

1. The agent calls `propose_script({name, description, inputSchema, code, requires, mutates})`; `code` ≤ 8 KB. The
   sidecar appends one line to `.wiretap/script-proposals.jsonl` (append-only, never rewritten) and pushes it to
   human GM clients. A total-size cap refuses new proposals with a clear error; nothing is deleted.
2. A GM opens the "Script proposals" window (ApplicationV2, human-kind GM client only) and sees the code as escaped
   text. Approve or reject; a rejection is another appended record.
3. Approval appends `{name, version, sha256, code, inputSchema, requires, mutates, approvedBy, approvedAt, enabled:
   true}` to the world setting `wiretap.approvedScripts` (`restricted`, `config: false`). A newer version of a name
   sets `enabled: false` on the older entry. Disable = `enabled: false`. Entries are never removed.
4. Clients load approved scripts at `ready` and on `updateSetting`; the registry re-emits; the sidecar sends
   `list_changed`.

**Security invariants:**

- **S1** No MCP path writes `wiretap.approvedScripts`: it is a `wiretap.*` setting (§4.6 hard rule, all paths).
- **S2** The approve handler is reachable only from a UI event in a human-kind GM client, never from a bridge op.
- **S3** Execution requires `sha256(code) === entry.sha256` and `enabled: true`; any edit is a new proposal.
- **S4** Proposals are inert text until approved; the UI never renders them as HTML.
- **S5** Arguments are schema-validated before any handler runs.
- **S6** Params never carry gate values; gates are read from `game.settings` on the executing client.
- **S7** Shipped and plugin scripts that touch a gated category call `requireGate`.
- **S8 Known limit (INFERRED).** Approved and ad-hoc code runs with the endpoint user's authority (GM) and can call
  `game.settings.set` or the approve handler directly. Enabling `allowApprovedScripts` or `allowAdhocCode` reduces
  the hard rule to "no core skill can change a gate", the same caveat as `allowMacroExecution` (§4.6). The approval
  window says so. Approved code runs through `foundry.utils.AsyncFunction`, the same mechanism as script macros
  (READ `client/documents/macro.mjs:146`).

### 2.5 Script catalogue (shipped)

Budgets are the result cap in serialized bytes. "Replaces" counts the calls a generic-tools-only agent would make.

| Script | Purpose | Requires | Result budget | Gate | Replaces |
|---|---|---|---|---|---|
| `open_sheet(uuid, userId?)` | Render a sheet on the agent endpoint, or on a live user's client via the `wiretap.openSheet` query | dom | 128 B `{ok, appId}` | — | — |
| `close_sheet(uuid)` | Close it (READ `client/applications/api/application.mjs:950` `close`) | dom | 128 B | — | — |
| `element_size(uuid, selector)` | `{x, y, w, h, scrollW, scrollH, visible}` of a selector inside the rendered sheet (`element` getter READ `application.mjs:327`) | dom | 256 B | — | screenshot |
| `sheet_layout(uuid, depth=2, maxNodes=40)` | Compact tree `[selector, w, h, overflow]` of the sheet parts | dom | 4 KB | — | screenshot + N sizes |
| `screenshot(uuid, selector?, maxSide=800)` | PNG, explicit last resort; default ≤ 800×600 (+972 tokens MEASURED), hard max 1280 px longest side, one image per call | dom + runner | 1 image | — | — |
| `edit(uuid, patch, dryRun?)` | Dot-path update | api | 256 B ack | per category | read + update + re-read |
| `add_embedded(parentUuid, documentName, data[] \| fromUuids[])` | Add Items / ActiveEffects from data or compendium uuids | api | 256 B + 64 B per created | per category | N × (search + read + create) |
| `roll(formula, toChat=false)` | `{total, formula, dice}` | api | 512 B | — | — |
| `diff_since(cursor \| {uuid, handle})` | Documents changed since a cursor (`_stats.modifiedTime`), or changed paths vs a stored export (`foundry.utils.diffObject`) | api | 4 KB page | — | full re-reads |
| `export_to_handle(uuid, keepId=true)` | `toCompendium` (§4.4) into a sidecar handle; returns `{handle, bytes, summary}` | api + sidecar | 256 B | — | full read |
| `read_handle(handle, path?, offset?, length?)` | Slice a stored result | none | 4 KB | — | — |
| `import_from_handle(handle, mode: create \| replace, keepId?)` | Create a copy (`keepId: false`, `fromCompendium` strips `_id`) or replace in place (`keepId: true`, §4.4) | api | 256 B ack | compendium target → `allowCompendiumWrites` (proposed) | read + create with the body in context |
| `build_actor(spec)` | Composite: create an Actor, set fields, add Items from compendium uuids or data, add effects | api | 512 B | — | ≥ 5 (create, N searches, N embedded creates, update) |
| `inspect_sheet(uuid, selectors[])` | Composite: open, measure k selectors plus a layout summary, close | dom | 2 KB | — | 2 + k |
| `copy_document(uuid, target, overrides?)` | Composite: export → import to a folder or pack; the body never enters context | api | 256 B | as `import_from_handle` | read + create |
| `propose_script(...)` | §2.4 | none | 256 B | `allowApprovedScripts` | — |

The generic core tools (M4/M5: `list_document_types`, `get_document`, `search_documents`, `describe_schema`,
`create_documents`, `update_documents`, `replace_document`, `batch`, `draw_table`, `execute_macro`, `list_endpoints`)
are entries of the same registry with the budgets of §2.6.

### 2.6 Budgets (enforced by M13)

Bytes are the enforced unit (deterministic, no API call). Tokens ≈ bytes / 2 (§2.1). All values are D20 (PENDING-USER).

| Budget | Value | Basis |
|---|---|---|
| Tool name | ≤ 40 chars | Names are always in context (≈13 tokens each, MEASURED) |
| Definition `{name, description, inputSchema}` | ≤ 800 B | Largest drafted core tool 787 B ≈ 380 tokens when loaded (MEASURED rate) |
| Description | ≤ 160 chars | Paid on every load |
| Always-listed tools (core + shipped) | ≤ 30 | ≈ 400 tokens of names (MEASURED rate) |
| All definitions (core + shipped) | ≤ 16 KB | ≈ 8k tokens if a client loads all |
| Ack (write) | ≤ 256 B per document | +172 measured at 84 B |
| Projection (≤ 10 fields) | ≤ 1 KB per document | 301 B measured |
| Compact default view | ≤ 2 KB per document | 1,484 B measured for a 31-item actor |
| Search page | ≤ 4 KB, default limit 20, max 100 | — |
| Error | ≤ 512 B, first 10 failures + count | — |
| Any text result (hard cap) | ≤ 16 KB, else `{handle, bytes, summary}` | 18 KB → +8,954 tokens; 84 KB refused by Claude Code (MEASURED) |
| Image | `screenshot` only, default ≤ 800×600, max 1280 px side, one per result | +972 measured at 800×600 |

**Recalibration:** `tests/measure/measureContext.mjs` (manual, not CI, ≤ 6 `claude -p` runs) repeats §2.1 against a
synthetic loopback server and records the numbers in `docs/experiments/`.

## 3. Decisions log

| # | Decision | Status | Source |
|---|---|---|---|
| D1 | Seatless execution: headless browser client (A) and raw socket (B), B only where it adds no risk; the per-operation boundary is set by E2 | DECIDED (boundary PENDING-M0 E2) | User 2026-10-10 |
| D2 | Must run on a headless server: `playwright-core` + Playwright Chromium build, `executablePath` configurable; no reliance on an installed Edge/Chrome. Full build vs `chromium_headless_shell` | DECIDED (build choice PENDING-M0 E3) | User; MEASURED by user: chromium-1223 413 MB, headless_shell-1223 273 MB (Playwright 1.60.0) |
| D3 | Agent users: GM-client **client-scope** setting `[{userId, password}]` → pushed to the sidecar → module-local owner-only file; env-var provisioning also supported; passwords never sent back to any client | DECIDED (password-shape check PENDING-M0 P1) | User; READ `foundry/dist/database/documents/user.mjs` (`dump` deletes `password`, `passwordSalt`) |
| D4 | Agent role (ASSISTANT vs GAMEMASTER) and active-GM behaviour | PENDING-M0 E4 | READ `foundry/client/documents/collections/users.mjs:70-96` |
| D5 | Routing: prefer an agent endpoint, fall back to a human GM tab, per-call `endpoint` override | PENDING-USER (adopted recommendation) | Coordinator 2026-10-10 |
| D6 | Trust: loopback unauthenticated (same machine is trusted). External access is an opt-in bind that requires a bearer token on `/mcp` and a token on socket identify, plus TLS/reverse-proxy guidance. Reopens the loopback-only rule when enabled | DECIDED | User |
| D7 | Acting user: optional advisory `actAs` pre-check (`testUserPermission` / `canUserModify`); the write runs as the endpoint user | DECIDED | User |
| D8 | Risky capabilities are GM-only world settings, default OFF; gate settings can never be changed by any skill | DECIDED (gate list in §4.6; additions PENDING-USER) | User |
| D9 | Plugin handlers run client-side only | DECIDED | User |
| D10 | Plugin surface: `Hooks.callAll('wiretap.registerSkills', api)` + `api.registerSkill`, integer `apiVersion`, tool names `<moduleId>__<skill>`, no dots | DECIDED | User; MEASURED by user (claude 2.1.296): `.` rewritten to `_`; `__`, `-`, 110-char names work |
| D11 | MCP transport moves to stateful Streamable HTTP sessions with `notifications/tools/list_changed`; no sampling | DECIDED in principle; architecture change needs confirmation at M3 start | MEASURED by user (claude 2.1.296): stateless lists tools once; stateful list_changed honoured; sampling `-32601` |
| D12 | Delete tools (`delete_documents`, undo of a create): do they exist at all, and if so behind a gate? | PENDING-USER | §9 C1 (the "no deletion APIs" rule, possible conflict) |
| D13 | Replace semantics fire normal update hooks (not `importFromJSON`'s `noHook: true`) | DECIDED | User; READ `client-document.mjs:1065` |
| D14 | Canonical document representation = the `toCompendium` export format (as used by `exportToJSON`), with `keepId: true` for reads | DECIDED (the `keepId` detail is PENDING-USER; the default read *view* is affected by D24) | User; READ `client-document.mjs:928-944,1113-1134` |
| D15 | `describe_schema` = "schema by example" (blank export per type/subtype) first; DataModel field-walker for constraints second, scoped by path | PENDING-M0 E8 (sizes) | User; READ: no JSON-Schema export in `common/data/fields.mjs` |
| D16 | Fate of the existing `create_actor` tool once `create_documents` exists (remove vs keep as alias) | PENDING-USER | Public-API change |
| D17 | Context minimisation is a top-priority, cross-cutting requirement; every milestone has a context-budget criterion | DECIDED | User 2026-10-10 |
| D18 | The user's script proposal: adopt, modified (one registry with the core tools; each script its own deferred MCP tool, not a dispatcher) and combined with result shaping (§2.3) | PENDING-USER (recommendation) | User's proposal; MEASURED §2.1 R1–R6 |
| D19 | Script exposure for clients that do not defer tools: also build `list_scripts` / `describe_script` / `run_script` dispatcher mode? Recommendation: not now; build only if such a client is targeted | PENDING-USER | §2.3 |
| D20 | Budget values of §2.6, enforced in bytes by CI | PENDING-USER (recommend adopt) | MEASURED §2.1 |
| D21 | Agent-authored scripts: propose → GM approves in the Foundry UI → callable; gate `allowApprovedScripts` default OFF; append/disable only (§2.4). Recommendation: build after M7 | PENDING-USER | §2.4 S1–S8 |
| D22 | Ad-hoc agent code `run_js` (gate `allowAdhocCode`, default OFF). Recommendation: do not build; D21 covers reuse with human review, `execute_macro` covers GM-written code | PENDING-USER | §2.4 |
| D23 | Saved-result handles: in-memory sidecar store per MCP session, LRU-bounded (recommend 64 MB total, 30 min idle), lost on sidecar restart; never on disk | PENDING-USER (recommend adopt) | §2.2 row 2 |
| D24 | Default read view = compact (≤ 2 KB); the canonical D14 export only with `mode:"full"`, still under the 16 KB cap (else a handle). Changes the default of a DECIDED item | PENDING-USER | §9 C6; MEASURED: 84 KB export refused inline |
| D25 | DOM scripts route to the agent endpoint by default; a human GM tab only by explicit `endpoint` override | PENDING-USER (recommend adopt) | §2.4 |

## 4. Architecture

### 4.1 Components and where they run

| Component | Runs in | Role |
|---|---|---|
| MCP session server (`server/mcp*.ts`) | Sidecar (Node) | Stateful Streamable HTTP sessions; tool list = core tools + scripts + plugin tools of the routed endpoint; sends `list_changed` |
| Result budget enforcer (`server/resultBudget.ts`) | Sidecar | Applies §2.6 caps to every tool result; over cap → handle + summary; caps error text |
| Handle store (`server/handles.ts`) | Sidecar, memory only | Per-session LRU of large results (D23); slices for `read_handle`, input for `import_from_handle` |
| Budget constants (`shared/budgets.js`) | Both | The §2.6 numbers; one source for enforcer, registration checks and tests |
| Endpoint registry + router (`server/endpoints.ts`, replaces `gmSockets`) | Sidecar | Tracks identified endpoints `{socketId, userId, isGM, kind: agent\|human, dom: bool, skills[], gateState, fingerprint}`; routes per D5, DOM scripts per D25 |
| Script registry (`src/bridge/scripts/registry.js`) | Foundry client | Shipped, plugin and approved scripts (core tools included); validates args; emits `bridge:registry` |
| Shipped scripts (`src/bridge/scripts/*.js`) | Foundry client | §2.5 catalogue; static imports only |
| Op dispatcher (`src/bridge/ops/*`) | Foundry client (human GM tab or agent tab) | Core ops on `documentClass` APIs; gate checks; `actAs` pre-check; `ctx.core.*` for scripts |
| Gate settings (`src/settings/gates.js`) | Foundry client, world scope, `restricted` | Risk options (§4.6) |
| Approved-script store | Foundry world setting `wiretap.approvedScripts` | Append/disable only (D21) |
| Proposal log (`server/scriptProposals.ts`) | Sidecar | `.wiretap/script-proposals.jsonl`, append-only, size-capped (D21) |
| Agent credential store (`server/agentCredentials.ts`) | Sidecar | `.wiretap/agents.json` (0o600, symlink refusal, overwrite only) or env file |
| Agent runner (`server/agentRunner.ts`) | Sidecar host | Launches and supervises one headless browser context per agent user; captures `screenshot` regions |
| Raw-socket executor (`server/rawSocket.ts`) | Sidecar | Option B for M0-certified ops only, used when no client endpoint is live |
| `wiretap.openSheet` user query | Every client with Wiretap (players too) | Renders a sheet on the chosen user's client (`CONFIG.queries`, READ `client/documents/user.mjs:289-321`) |

### 4.2 Data flow

```
MCP client ──HTTP (session id)──► sidecar MCP session server
   tools/list ◄── core tools + scripts + registry[routed endpoint].skills ──► list_changed on registry change
   tools/call ──► zod validation ──► router (D5: agent > human > raw-socket-if-certified; DOM → agent per D25)
      ├─► Socket.IO bridge:invoke {op|script, params, actAs?} ──► client registry ──► ops ──► Document APIs
      └─► rawSocket (B): POST /join → socket.io-client with session cookie → modifyDocument  (certified ops only)
   result ◄── resultBudget enforcer (cap → handle store) ◄── raw result
agent runner: credentials → playwright-core → /join as agent user → /game → Wiretap client identifies as kind=agent
GM human tab: settings UI → credentials pushed once over bridge:credentials → sidecar file (never echoed back)
GM human tab: script proposals UI → approve → wiretap.approvedScripts (UI event only, never a bridge op)
```

### 4.3 Option A vs B: what each bypasses (READ)

- B authenticates as a user: `POST /join` (`userid`, `password`) creates a session (READ `dist/sessions.mjs`
  `authenticateUser`). The socket needs the `session` cookie (READ `dist/server/sockets.mjs` `activate`).
- Server-side work runs on B: `cleanData`, `canUserModify`, server `_preCreate`/`_onCreate`, `validate({strict})`
  (READ `dist/database/backend/server-backend.mjs` `_createDocuments`).
- B skips all client pre-work: system `_preCreate`, module `preCreate*` hooks, cleaning against the system DataModel
  (READ `client/data/client-backend.mjs:76-123`).
- The server has no system DataModels: `TypeDataField.getModelForType` reads `globalThis.CONFIG?.[doc].dataModels`
  (READ `common/data/fields.mjs` near line 4290), and a grep of `dist/` for `dataModels` finds nothing (MEASURED,
  grep). INFERRED: `system` data written over B is stored unvalidated. E2 measures this.
- There is no document REST API; the only route is `/api/status` (READ `dist/server/views/api.mjs`).

**Per-operation boundary rule (D1).** An operation class may use B only if all of these hold:

1. E2 shows a zero diff against the client path for every subtype in the reference world.
2. Invalid input is rejected (or handled identically) on B.
3. The runtime fingerprint (§4.5) shows no client hook or `_pre*` override for that document class.
4. The operation needs nothing client-only: plugins, sheets, derived data, rolls, macros, user queries, scripts with
   `requires: 'dom'`.

Everything else uses A (or a human tab). Until M0 reports, no operation is B-eligible.

### 4.4 Canonical document representation (D14, view per D24)

- **Full reads** (`mode:"full"`, `export_to_handle`) produce `doc.toCompendium(null, {clearSource: false, keepId:
  true, clearSort: false, clearOwnership: false})` plus `uuid`. The defaults would drop `_id`, `sort`, `ownership` and
  `author` (READ `client-document.mjs:1113-1134`). Optionally prepared values are added under a separate `derived`
  key.
- **Default reads** return the compact view (D24): `uuid`, `name`, `type`, a per-type key-field list, and embedded
  documents as `[id, name, type]` tuples. `fields` returns a projection of the canonical form.
- **Create** takes the canonical shape.
- **Replace** = `fromImport` → `collection.fromCompendium` → strip `preserveOnImport` → `update(data, {diff: false,
  recursive: false})` **with hooks** (D13). Input may be a handle.
- `exportToJSON` / `importFromJSON` themselves are world-documents only and trigger a download / notification (READ
  `:928-944`, `:1049-1068`). Wiretap calls the underlying steps and also covers embedded and compendium documents.

### 4.5 Bridge protocol additions (`shared/protocol.js`)

- `bridge:identify` gains: `kind`, `dom` (can render and measure), `protocolVersion`, `token?` (external mode only),
  `gateState`, `fingerprint` (per-document-class flags: `preCreate`/`preUpdate`/`preDelete` hook present, `_pre*`
  overridden).
- `bridge:registry` carries `{apiVersion, skills: [{name, moduleId, source: shipped|plugin|approved, description,
  inputSchema, mutates, requires, budgetBytes}]}`.
- `bridge:credentials` (GM human tab → sidecar only) carries the agent list. It is never broadcast and never sent
  sidecar → client.
- `bridge:proposals` (sidecar → human GM clients) carries pending proposals; approval never travels back over it.
- `bridge:invoke` gains `actAs?`, `dryRun?`, `requestId`.

### 4.6 Risk gates (D8)

World-scope settings, `restricted: true` (GM only), `config: true`, all default `false`:

| Gate | Unlocks | Notes |
|---|---|---|
| `allowMacroExecution` | `execute_macro` | Arbitrary code; see hard rule caveat below |
| `allowUndo` | `undo_last` | Depends on D12 for undoing creates |
| `allowUserWrites` | Create/update of `User` documents (incl. role) | Password fields always refused |
| `allowSettingWrites` | `Setting` documents and world/user settings via skills | `wiretap.*` always refused |
| `allowFileUpload` | Base64 data in `FilePathField`s; file upload tool | Server also requires `FILES_UPLOAD` (READ `dist/database/sanitization.mjs`) |
| `allowDelete` | `delete_documents` | Only if D12 = keep |
| `allowedPluginModules` | Plugin skills and scripts per module id | Default: none enabled |
| `allowApprovedScripts` | `propose_script` and execution of GM-approved scripts | Only if D21; arbitrary-code caveat |
| `allowAdhocCode` | `run_js` | Only if D22; arbitrary-code caveat |
| Proposed (PENDING-USER) | `allowOwnershipWrites`, `allowCompendiumWrites`, `allowModuleConfigWrites` (`core.moduleConfiguration`) | Each is escalation-capable |

**Hard rule.** No skill can change a gate. Enforcement:

1. Every write path refuses any `Setting` whose key starts with `wiretap.`, whatever the gate state. This covers the
   generic CRUD path, the settings skills, batch, replace, scripts' `ctx.core.*` and raw-socket B. It also protects
   `wiretap.approvedScripts`.
2. Gates are read only from `game.settings` on the executing client; params never carry a gate value.
3. B operations need a gate snapshot pushed by a live client. Without one, gated categories are denied.
4. Tests assert each path refuses `wiretap.*`.

**Known limit (INFERRED, stated in the UI hint).** Any arbitrary-code capability (`allowMacroExecution`,
`allowApprovedScripts`, `allowAdhocCode`, any enabled plugin module) can call `game.settings.set` directly. When a GM
enables one, the guarantee is reduced to "no core skill can change a gate".

### 4.7 Trust boundaries

- **Default (D6):** both ports on `127.0.0.1`, no tokens. Any local process is trusted. This includes claiming a GM
  endpoint and receiving invocations (READ `server/foundryBridge.ts:40-44`).
- **External opt-in (M10):**
  - `WIRETAP_BIND` (or a sidecar config file) sets a non-loopback address.
  - The sidecar refuses to start in external mode without `WIRETAP_TOKEN`.
  - `/mcp` requires `Authorization: Bearer`.
  - `bridge:identify` requires the token.
  - CORS origin becomes configurable (today hard-coded `http://localhost:30000`, READ `server/server.ts:38`).
  - Guidance: run behind a TLS reverse proxy; never expose plain HTTP.
  - This deliberately reopens the loopback-only rule (`wiretap-codebase-core`) for an explicit GM opt-in. The skill
    text changes accordingly.
- **Credentials:**
  - Client-scope settings live in the GM browser's `localStorage` (READ `client/helpers/client-settings.mjs:43`).
    Any script in that browser can read them (INFERRED).
  - The sidecar file is owner-only on POSIX. On Windows it relies on the directory ACL (same as `.wiretap/mcp-*.json`,
    READ `server/mcpConfigFile.ts`).
  - Passwords are never logged, never returned and never in MCP results.
- **Handles** hold world data in sidecar memory only, scoped to the MCP session that created them.

## 5. Milestones

Every milestone follows `.claude/claude.md`:

- Consent at the start for any architecture, dependency, layout, naming or public-API choice it introduces.
- TDD.
- 120-column formatting, typed and commented declarations.
- No stubs.
- No deletion APIs in product or test code: tests write under `test/tmp/` or mock `node:fs`.
- e2e in-page waits ≤ 1000 ms.
- No dynamic imports in shipping builds.
- Implementation via `wiretap-coder` (sidecar, shared, tests) or `foundry-module-dev` (client `.js`/`.svelte`), then
  `wiretap-spec-reviewer` → `wiretap-code-reviewer`. `buddy-checking` for M1, M3, M9, M10, M11, M14, M16 (security or
  protocol).
- **Context-budget criterion (required, D17):** each milestone states one; from M13 on, every tool and result it adds
  is covered by the M13 budget test, and a budget breach fails the milestone. A budget is raised only by the user.
- **Final step (required): docs + `wiretap-*` skills + `graphify update .`**:
  - Update `TODO.md`, `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md` and README as touched.
  - Update every `wiretap-*` skill whose paths changed, describing the current state.
  - Run `graphify update .`.
  - Commit each logical unit.

Test tiers:

- **Unit:** vitest with Foundry mocks in `tests/setup.js` (happy-dom: no layout, so DOM sizes are mocked).
- **Integration:** a real sidecar plus a **fake GM client** (`socket.io-client` answering `bridge:invoke` /
  `bridge:registry`) plus the SDK MCP client over Streamable HTTP.
- **Context budget (M13):** byte budgets over the real tool list and over representative results (synthetic
  fixtures), in CI.
- **Live e2e:** Playwright against Foundry on `:30000`, only where real Foundry behaviour is the subject.

**Order:** M0 ‖ M1 → M13 → M2 → M3 → M14 → M4 → M5 → M6 → M15a → M7 → M16 (if D21) → M8 → M9 → M15b → M10 → M11 →
M12.

### M0 — Experiments against an idle Foundry we own

**Goal:** turn the PENDING-M0 decisions into measured results. **Depends on:** the concurrent titan Playwright
session finishing (user instruction: wait, then run). **Produces:** `docs/experiments/2026-10-m0-results.md` (raw
numbers, commands, ids of everything created). No product code.

**Safety limits:**

- No deletes of any kind: documents, users, files.
- Created documents only inside folders named `Wiretap Experiments`. Names prefixed `wtx-`.
- Users limited to `wtx-assistant`, `wtx-gm`, `wtx-player`. Passwords are synthetic, from an env var, and never
  written to the repo or results.
- Record every created id.
- Experiment scripts live under `test/tmp/` (gitignored) or a scratch dir. Only the results doc is committed.

| Exp | Procedure | Pass / fail criteria | Unlocks |
|---|---|---|---|
| P1 password shape | As GM in the browser: `game.users.get(id)._source.password` and `toObject().password` for each `wtx-*` user. From Node: `getJoinData` socket payload `users[]` keys. | PASS = no password or hash anywhere client-visible. Any value present = FAIL → stop and report (D3 premise breaks) | D3 confirmed |
| E1 same user twice | Log `wtx-gm` in from two Playwright contexts. Check `game.users.get(id).active` and that both sockets stay connected for 60 s. Create a `wtx-` Folder in one; check the other receives the `createFolder` hook. | PASS = both stay connected and both receive broadcasts | Whether an agent may share a human's user (D3/D5) |
| E2 raw-socket fidelity | For each titan Actor subtype (`player`, `npc`): create `wtx-client-<type>` via `Actor.create` in a client, and `wtx-raw-<type>` via Node (`POST /join` → socket.io-client with cookie → `modifyDocument create`), same input. Read both via the client `toObject()`; diff excluding `_id`, `name`, `_stats` timestamps. Repeat for embedded Item and ActiveEffect (`parentUuid`), for update of a system field, and for invalid system data (wrong type, out-of-range). Also capture the client fingerprint (§4.5) per document class. | Per op class: PASS = empty diff for every subtype AND invalid data rejected or stored identically. Any diff = that op class is A-only | D1 boundary table |
| E3 headless cost | `playwright-core` with `executablePath` = (a) chromium-1223, (b) headless_shell-1223. ≥5 runs × `core.noCanvas` on/off as `wtx-assistant`. Measure launch→`game.ready` ms, browser-tree RSS after 60 s idle, mean CPU % over 60 s idle, and whether the Wiretap bridge identifies and `create_actor` round-trips. Report median and range. | Functional PASS required (ready, identify, create, sheet render offscreen). Build choice = smallest functional build; cost numbers go to the user for a budget | D2 build choice; agent runner defaults |
| E4 role behaviour | `wtx-assistant` (ASSISTANT) and `wtx-gm` (GAMEMASTER) with a human GAMEMASTER present and absent: read `game.users.activeGM` on each client. As ASSISTANT, try create/update on every world document type, compendium write, `Setting` write and `User` role change; record denials. | Recorded matrix; no pass/fail | D4 |
| E7 unattended re-login | Set `world` in `options.json` (READ `common/config.mjs:65`), restart Foundry, run the agent-runner prototype script with stored credentials. Measure time to agent identify; then restart Foundry again with the script running. | PASS = agent identifies after both restarts with no human | M9 reconnect design |
| E8 schema size | For each document type and subtype in the titan world: byte size of (a) blank export (`new cls({name, type}).toCompendium(...)`), (b) a field-walker JSON Schema prototype run in the console. Report bytes and chars/4 (labelled estimate). | Recorded table | D15 scoping thresholds |
| E9 titan result sizes | In the titan world, per Actor and Item subtype (`wtx-` documents plus the largest existing document per subtype, read only): bytes of the full `toCompendium` export, a compact-view prototype and a 10-field projection. On the headless agent (E3 build): `getBoundingClientRect` of 5 sheet selectors per sheet class with `core.noCanvas` on, a `sheet_layout` prototype's byte size, and the PNG pixel size of a default-sized sheet. | Recorded table; FLAG to the user any compact view > 2 KB or layout > 4 KB before M4/M15 | D20 budgets, D24, D25, `sheet_layout` design |

**Acceptance:** the results doc exists with every row filled or explicitly "not run: reason". The decisions table in
this plan is updated by the main thread, not by the experiment runner. **Context budget:** E9 is filled; every titan
size that breaks a §2.6 budget is listed with the proposed handling. **Risks:** sharing Foundry with titan e2e (run
only when idle); E7 needs control of the Foundry process.

### M1 — Endpoint registry, routing, protocol v2

**Goal:** replace `gmSockets` / first-socket routing with an explicit registry and router. **Depends on:** none (can
start before M0 finishes). **In:**

- `server/endpoints.ts`.
- `bridge:identify` v2 (`kind`, `dom`, `protocolVersion`, `gateState`, `fingerprint`).
- Routing per D5 with per-call `endpoint` override. The default order lives in one constant and is documented in the
  README; D5 is still PENDING-USER.
- `requestId`.
- Structured error contract `{code, message, failures?}`, message ≤ 512 B, `failures` capped at 10 plus a count.

**Out:** tokens (M10), raw socket (M11). **Tasks:**

1. Registry unit tests (add/update/remove on disconnect, kind priority).
2. Router.
3. Client identify v2.
4. `create_actor` ported unchanged on top.

**Tests:** unit (registry, router, error-contract truncation); integration with two fake GM clients (agent + human)
asserting route choice and fallback on disconnect. **Acceptance:** existing `create_actor` tests green; routing tests
green; old identify payload rejected with a clear log. **Context budget:** routing adds no fields to tool results; a
no-endpoint error is ≤ 256 B and names the fix ("open a GM tab or enable an agent"); the error-contract truncation is
unit-tested with a 50-failure input. **Risks:** a protocol break with an older client build. Mitigation:
`protocolVersion` check.

### M13 — Context-budget harness, result enforcer, handle store (new)

**Goal:** make §2.6 executable before any new tool exists. **Depends on:** M1. **Consent at start:** new files
`shared/budgets.js`, `server/resultBudget.ts`, `server/handles.ts`, `tests/measure/`; D20, D23. **In:**

- `shared/budgets.js`: the §2.6 numbers as named constants.
- `server/resultBudget.ts`: wraps every tool handler. Measures the serialized result; over the per-tool budget or the
  16 KB hard cap → stores the raw result in the handle store and returns `{handle, bytes, summary}` (summary =
  deterministic: top-level keys, counts, `name`/`type` if present). Caps error text. Refuses more than one image or an
  image above the pixel cap.
- `server/handles.ts`: per-session in-memory LRU (D23), opaque ids, `slice(handle, path?, offset, length)`; eviction
  is in memory only, nothing is written to disk.
- `tests/unit/contextBudget.test.js` (CI): builds the real MCP server in-process, lists tools with the SDK client and
  asserts per-tool name length, definition bytes, description length, total count and total bytes; runs each
  registered tool's representative-result fixture through the enforcer and asserts its budget; asserts an over-cap
  fixture becomes a handle. A tool without a fixture fails the test.
- Fixtures: synthetic, obviously fake documents generated in the test (e.g. an actor with 120 embedded items named
  `MOCK_ITEM_n`), sized to exceed the cap, not copied from any system's data.
- `tests/measure/measureContext.mjs`: manual live calibration per §2.6 (not run in CI; no Foundry needed).

**Tests:** unit (enforcer thresholds at budget − 1, budget, budget + 1; handle LRU eviction; slice bounds; summary
determinism). Integration: fake GM client returns a 100 KB result → the MCP client receives a handle ≤ 256 B, and
`read_handle` slices return ≤ 4 KB. **Acceptance:** the budget test runs in `npm test` and fails on a deliberately
oversized definition in a test-local registry. **Context budget:** this milestone's own surface (`read_handle`) is
inside §2.6; the live calibration has been run once and its numbers recorded next to §2.1's. **Risks:** byte budgets
diverge from token reality on other tokenizers → recalibration script; budgets change only by user decision.

### M2 — Risk-gate options

**Goal:** the gate settings and enforcement points before any write skill exists. **Depends on:** M1. **In:**

- World-scope `restricted` settings (§4.6), labels and hints in `lang/en.json`, including the arbitrary-code caveat.
- Gate check helper `requireGate(name)`.
- The `wiretap.*` setting deny rule as a shared function used by every write path.
- `gateState` pushed on identify and on change (`updateSetting` hook).

**Out:** the gated tools themselves (M5/M6). **Tests:**

- Unit: each gate default off.
- Unit: the deny rule for `wiretap.*` keys on create/update/replace/batch.
- Integration: gate snapshot reaches the sidecar.
- e2e: as GM, toggling a gate in the settings UI updates the snapshot.

**Acceptance:** the deny function has 100% branch tests; no API path exists to set a `wiretap.*` setting from params.
**Context budget:** a gate denial is one error ≤ 256 B naming the gate and stating that only a GM can enable it in
the settings; gate state never appears in results except as one compact line in `list_endpoints`. **Risks:** a missed
write path. Mitigation: M4/M5 acceptance includes the deny test per path.

### M3 — Stateful MCP sessions (architecture change: confirm at start)

**Goal:** sessions with an SSE GET stream and `notifications/tools/list_changed` (D11). **Depends on:** M1, M13.
**In:**

- `sessionIdGenerator`.
- A per-session `McpServer` holding the tool set of its routed endpoint.
- GET/POST/DELETE per the Streamable HTTP spec. HTTP `DELETE` ends a session in memory; it is not a file-deletion
  API.
- Idle-session expiry (in-memory); expiry also releases that session's handles (D23).
- `list_changed` on registry/endpoint change.

**Out:** auth (M10). **Tests:**

- Integration with the SDK client: a session is created; a tool registered later (fake client emits
  `bridge:registry`) appears after `list_changed`; the session ends cleanly.
- Live check against `claude` 2.1.296 repeating the user's measurement, recorded in the results doc.

**Acceptance:** a late tool is callable in the same session; the stateless path is gone. **Context budget:** the
live check also records (same method as §2.1) whether a tool added by `list_changed` is deferred and its name cost;
`list_changed` fires at most once per registry change (debounced), so the client does not re-list on every identify.
**Risks:** session leak under abandoned clients. Mitigation: expiry with tests.

### M14 — Script runtime (new)

**Goal:** one registry for core tools, shipped scripts and (later) plugin and approved scripts (§2.4). **Depends on:**
M1, M3, M13. **Consent at start:** D18, D19, layout `src/bridge/scripts/`. **In:**

- `src/bridge/scripts/registry.js`: `{name, version, description, inputSchema, result.budgetBytes, requires, mutates,
  gate?, handler}`; registration checks the §2.6 definition budgets and refuses with a logged reason.
- Client-side argument validation against the same JSON Schema the sidecar converts to zod.
- `ctx` (`core`, `shape`, `dom`, `signal`); `ctx.shape` implements compact view, projection and ack.
- Sidecar mapping registry → MCP tools (exposure mode `tools`; `dispatcher` only if D19).
- Routing by `requires` (D25): `dom` scripts need an endpoint with `dom: true`.
- `create_actor` re-registered through the registry (fate per D16).

**Tests:** unit (registration budget refusal, validation, `ctx.shape` outputs, `requires` routing); integration (fake
client registers a script → tool listed → call → enforcer). **Acceptance:** `create_actor` works through the
registry; a `dom` script with only a non-DOM endpoint returns a ≤ 256 B error naming the missing endpoint kind.
**Context budget:** every registered entry has a budget-test fixture (M13 test enforces); `ctx.shape` outputs meet
§2.6 on the synthetic fixtures. **Risks:** a second abstraction over ops → scripts call ops, never the reverse.

### M4 — Core read tools

**Goal:** `list_document_types`, `get_document`, `search_documents`, `describe_schema`, registered as M14 scripts.
**Depends on:** M1, M3, M14. The `describe_schema` scoping thresholds are **BLOCKED-BY-M0 (E8)**; the compact-view
key-field lists per titan subtype are **BLOCKED-BY-M0 (E9)**. **In:**

- Primary, embedded (via `parentUuid`) and compendium (`pack`) reads.
- Default compact view; `fields` projection; `mode:"full"` canonical representation (§4.4, D24); `ifModifiedSince`.
- Optional `derived`, only with `fields` or `mode:"full"`.
- `search_documents`: default limit 20, max 100, cursor, `total`; rows are `[uuid, name, type]` unless `fields`.
- `describe_schema(documentName, subtype, path?)` returning the blank export plus constraints (choices, min/max,
  integer, required, nullable, blank) from a field-walker over `CONFIG[doc].dataModels[subtype].schema` and the core
  schema; scoped by `path` when above the E8 threshold.
- `wiretap.*` settings and `User` password fields excluded from all reads.

**Tests:**

- Unit: field-walker over each core field class with mocked fields; representation function; exclusions; compact
  view and projection sizes on synthetic fixtures.
- Integration: fake client.
- e2e: read a `wtx-`-style test document created by the spec in a `Wiretap E2E` folder (never deleted; reused by
  name).

**Acceptance:** every type in `ALL_DOCUMENT_TYPES` can be listed and read in the titan world (e2e enumerates).
**Context budget:** compact ≤ 2 KB and projection ≤ 1 KB per document for every titan subtype in e2e; a full read
above 16 KB returns a handle; `describe_schema` without `path` ≤ 16 KB for every titan subtype (else it must require
`path`). **Risks:** schema output size (E8).

### M5 — Core write tools

**Goal:** `create_documents`, `update_documents` (dot-path), `replace_document` (§4.4, hooks fire), `batch`
(`foundry.documents.modifyBatch`: validated first, **not atomic**, READ `server-backend.mjs` `#r`), `dryRun`
everywhere, advisory `actAs`. `delete_documents` only if D12 = keep, behind `allowDelete`. All registered as M14
scripts. **Depends on:** M2, M4. D16 decided before starting. **In:**

- Gated `User`/`Setting`/file/ownership writes.
- Validation failures returned via `DataModelValidationError.getAllFailures()` (READ
  `common/data/validation-failure.mjs:374`), capped per the M1 error contract.
- Ack-only results `{uuid, changed[]}`; optional `fields` on the ack.
- `create_documents` and `replace_document` accept a handle instead of inline data.
- Optional idempotency key stored as a module flag.

**Out:** raw socket (M11). **Tests:**

- Unit per op: happy path, validation failure, gate off/on, `wiretap.*` deny, `actAs` denial, ack shape.
- Integration: fake client.
- e2e: create/update/replace a test Actor with an embedded Item and an ActiveEffect in the `Wiretap E2E` folder;
  assert a `preUpdateActor` hook fired on replace.

**Acceptance:** every write path has the deny test; `create_actor` handled per D16. **Context budget:** ack ≤ 256 B
per document; a 50-document `batch` ack ≤ 4 KB; a validation error with 30 failures ≤ 512 B. **Risks:** batch
partial commits. Documented in the tool description.

### M6 — Sheets and gameplay

**Goal:**

- `open_sheet(uuid, userId?)` via the `wiretap.openSheet` user query (human clients) or a local render (agent
  endpoint). The query handler checks that the sender is a GM and that the target has OBSERVER.
- `close_sheet(uuid)`.
- `roll(formula)`.
- `draw_table(uuid)`.
- `execute_macro` (gate).
- `undo_last` (gate; scope per D12).

All as M14 scripts. `screenshot` moves to M15b (it needs the agent runner). **Depends on:** M2, M5, M14. **Tests:**
unit (query handler checks); integration; e2e with a GM tab and a `wtx-player` context: the sheet opens on the player
client only with permission; an offline user gives a clear error (READ `user.mjs:306`). **Acceptance:** open-sheet
semantics documented: on a chosen live user's client; with no human connected, only data or measurements.
**Context budget:** `open_sheet` / `close_sheet` ≤ 128 B; `roll` ≤ 512 B; `draw_table` ≤ 1 KB; `execute_macro`
results pass the 16 KB cap. **Risks:** ChatMessage spam from rolls. Tool option `toChat` default false.

### M15a — Script library: API and composite scripts (new)

**Goal:** the `api` rows of §2.5. **Depends on:** M5, M6, M13, M14. **In:** `edit`, `add_embedded`, `diff_since`,
`export_to_handle`, `read_handle`, `import_from_handle`, `build_actor`, `copy_document`. **Consent at start:** the
catalogue (names are public API).

**Tests:** unit per script with mocked `game` (happy path, validation, gate, budget fixture); integration through the
fake client, including `copy_document` with a 100 KB synthetic source (the body never appears in any MCP message,
asserted on the SDK client's received payloads); e2e on titan: `build_actor` with 3 items and 1 effect from
`wtx-`/`Wiretap E2E` data. **Acceptance:** every §2.5 `api` script callable end to end. **Context budget:** each
result within its §2.5 budget in integration and e2e; `build_actor` uses one call where the generic-tools path uses
≥ 5, demonstrated by an integration test counting `tools/call` requests for both paths. **Risks:** composite scripts
hide partial failure → the ack lists every created uuid and the first failure.

### M7 — Plugin skill API

**Goal:** D9/D10. **Depends on:** M3, M5, M14. **In:**

- `api.apiVersion` (integer).
- `api.registerSkill({name, description, inputSchema, handler, mutates})` and `api.registerScript(...)` (same
  registry; scripts add `requires` and `result.budgetBytes`, default budget = §2.6 compact).
- `Hooks.callAll('wiretap.registerSkills', api)` at Wiretap `ready`.
- Name sanitising to `<moduleId>__<skill>` (module id dots → refuse; any `.` refused).
- Collision rejection.
- Registration refuses definitions over the §2.6 budgets, with a logged reason.
- `allowedPluginModules` gate.
- `ctx.core.*` = the same functions as the core ops (gates still apply).
- `bridge:registry` on change → `list_changed`.
- Sidecar converts JSON Schema → zod with zod 4.4.3 `fromJSONSchema` (READ
  `node_modules/zod/v4/classic/from-json-schema.d.ts`). Unconvertible schemas are refused at registration with a
  logged reason.

**Out:** Node-side plugin code (D9). **Tests:**

- Unit: registry, sanitiser, version check, gate, budget refusal.
- Integration: fake client registers mid-session → tool callable; an oversized plugin result becomes a handle.
- e2e: a fixture plugin module built only into `test/build/` registers `wtx_fixture__echo` and calls
  `ctx.core.create_documents`.

**Deliverables:** README plugin-author guide (including the budgets); example spell-text → Item plugin under
`examples/` (not shipped). The LLM parses; the handler maps deterministically and uses `dryRun` first.
**Acceptance:** fixture plugin works end to end; a disabled module's tools disappear after reload. **Context budget:**
plugin definitions and results are under the same §2.6 budgets as shipped scripts (tests above). **Risks:** load-order
assumptions. Mitigation: the hook fires at `ready`, after all esmodules have executed (INFERRED; e2e asserts it).

### M16 — Agent-authored scripts with GM approval (new; only if D21)

**Goal:** §2.4 propose → approve → callable, append/disable only. **Depends on:** M2, M7, M14. **Consent at start:**
D21, gate `allowApprovedScripts`, setting `wiretap.approvedScripts`, file `.wiretap/script-proposals.jsonl`. **In:**

- `propose_script` tool (gated); sidecar `server/scriptProposals.ts` (append-only JSONL, per-proposal 8 KB code cap,
  total-size cap, symlink refusal like `mcpConfigFile.ts`).
- `bridge:proposals` push to human-kind GM clients only.
- "Script proposals" ApplicationV2 window (`foundry-module-dev`): escaped code view, approve, reject, disable.
- Approved-script loader: hash check, `enabled`, `AsyncFunction` execution with `ctx`.

**Tests:** unit (append-only writer under `test/tmp/`; hash mismatch refused; disabled refused; no deletion API in
the module, asserted by a source grep test); integration (proposal reaches only human-kind clients; no bridge op can
reach the approve handler: enumerate `OP_HANDLERS`/registry names); e2e (GM approves in the UI → tool appears via
`list_changed` → callable; `update_documents` on `wiretap.approvedScripts` refused). **Acceptance:** S1–S7 each have a
test. **Context budget:** `propose_script` ack ≤ 256 B; approved scripts obey §2.6 like plugin scripts. **Risks:** S8
(arbitrary code under GM authority); stated in the gate hint and the approval window.

### M8 — Agent users and credentials

**Goal:** D3. **Depends on:** M1; uses M10's token when external. **BLOCKED-BY-M0 (P1)** for the premise. **In:**

- Client-scope setting `agentUsers` with a settings menu (ApplicationV2 form, `foundry-module-dev`) on GM clients:
  a user picker limited to non-human-assigned users plus a password field.
- `bridge:credentials` push.
- `server/agentCredentials.ts` writes `.wiretap/agents.json` (0o600, symlink refusal, overwrite only, same pattern
  as `mcpConfigFile.ts`).
- Env provisioning `WIRETAP_AGENT_CREDENTIALS_FILE` (path to the same JSON shape); env wins over the stored file.
- Removing an agent = overwrite without it. Never a delete.

**Tests:**

- Unit: file writer under `test/tmp/` with unique roots; refusal of symlinks; no echo of passwords in logs (logger
  mock).
- Integration: push → file contents; no event ever carries passwords sidecar → client (assert on all emitted
  payloads).

**Acceptance:** passwords absent from every log line and MCP result (tests). **Context budget:** no new MCP tool;
the M13 tool-count snapshot is unchanged. **Risks:** plaintext in the GM's `localStorage` (§4.7); documented.

### M9 — Headless agent runner

**Goal:** seatless operation on a headless server (D2), and the DOM endpoint for `dom` scripts. **BLOCKED-BY-M0 (E1,
E3, E4, E7, E9)** for build choice, role, reconnect policy, cost budget and headless layout feasibility. **Depends
on:** M1, M8. **New runtime dependency:** `playwright-core` (consent at start). Browser via `WIRETAP_BROWSER_PATH` /
sidecar config; no auto-download in product code. **In:**

- One browser, one context per agent user, a fixed viewport so measurements are reproducible.
- `/join` login, then wait for `game.ready` (boot is exempt from the 1000 ms rule).
- `core.noCanvas` per E3.
- Identify with `kind: agent`, `dom: true`.
- Region capture API for `screenshot` (page clip by a client-supplied rectangle, downscaled to the cap).
- Supervision with backoff on crash or Foundry restart.
- `--agents` CLI flag / `WIRETAP_AGENTS=on`.
- Status in startup log and `list_endpoints` tool.

**Tests:** unit (supervisor state machine with a fake launcher; capture downscaling); integration (fake launcher +
fake client identify); e2e (real launch as `wtx-assistant`, identify, `create_documents` round-trip). **Acceptance:**
E7-style restart recovery passes in e2e or a scripted check. **Context budget:** `list_endpoints` ≤ 1 KB with two
agents and one human; capture output never exceeds the §2.6 pixel cap (unit). **Risks:** RAM/CPU on small servers (E3
numbers); active-GM takeover (E4).

### M15b — Script library: DOM scripts (new)

**Goal:** the `dom` rows of §2.5: `element_size`, `sheet_layout`, `inspect_sheet`, `screenshot` (and `open_sheet` /
`close_sheet` on the agent endpoint). **Depends on:** M6, M9, M14. **BLOCKED-BY-M0 (E9)** for `sheet_layout` shape.
**In:** `ctx.dom` (render-and-wait for the app's `rendered` state, READ `application.mjs:367`; rect and overflow
reads; layout walk with `maxNodes`); `screenshot` via the M9 capture API.

**Tests:** unit with mocked rects (happy-dom has no layout); integration with a fake DOM endpoint; e2e on the agent
endpoint against titan actor and item sheets: sizes are non-zero and stable across two runs; `inspect_sheet` equals
`open_sheet` + k × `element_size` + `close_sheet`. **Acceptance:** all §2.5 `dom` scripts work on the agent
endpoint; on a human-only setup they return the D25 error. **Context budget:** `element_size` ≤ 256 B,
`sheet_layout` ≤ 4 KB, `inspect_sheet` ≤ 2 KB, screenshot ≤ default 800×600, one image; e2e asserts each. **Risks:**
headless layout differs from a human's window size → results report the viewport.

### M10 — External access opt-in

**Goal:** D6. **Depends on:** M1, M3. **In:**

- Bind address config.
- Mandatory `WIRETAP_TOKEN` in external mode; refuse to start without it.
- Bearer check on every `/mcp` request.
- Token on `bridge:identify`; the client setting `sidecarToken` is client-scope.
- Configurable CORS origin.
- README TLS/reverse-proxy section.
- Startup warning when external.
- Update `wiretap-codebase-core` "loopback only" text to "loopback by default; external opt-in requires tokens".

**Tests:** integration (no token → 401 / identify refused; constant-time compare; loopback mode unchanged);
`serverModes` style bind assertions. **Acceptance:** external mode cannot start without a token (test). **Context
budget:** a 401 body is ≤ 128 B and never echoes the supplied token. **Risks:** token in the GM's `localStorage`.

### M11 — Raw-socket executor (option B)

**Goal:** B for M0-certified operation classes only, when no client endpoint is live. **BLOCKED-BY-M0 (E2)**. If E2
certifies nothing, this milestone is dropped and logged. **Depends on:** M5, M8, M2 (gate snapshot). **In:**

- `server/rawSocket.ts` (login with an agent credential, `modifyDocument`).
- Eligibility = E2 table ∩ last client fingerprint ∩ gate snapshot.
- `wiretap.*` deny.
- Results marked `executor: "raw"` and shaped by the same `ctx.shape` rules (compact / projection / ack) on the
  sidecar.

**Tests:** unit (eligibility); integration against a fake Foundry socket server; e2e for each certified op comparing
with the client path. **Acceptance:** an ineligible op with no client gives a clear "needs a Foundry client" error.
**Context budget:** raw results equal the client-path results plus at most 20 B (`executor`), asserted per certified
op.

### M12 — Live e2e matrix and documentation

**Goal:** end-to-end coverage for human-tab, agent and (if any) raw endpoints. Close the related `TODO.md` entries
(live bridge e2e, auto-wiring e2e). Final README, including a "Context budget" section with §2.6. **Depends on:** M6,
M7, M9, M15a, M15b (and M10/M11/M16 if built). **Acceptance:** full `npm test`, `npm run typecheck`, `npm run eslint`,
`npm run test:e2e` green with output reported. **Context budget:** the e2e matrix asserts the §2.6 budget of every
tool's live result on titan; `tests/measure/measureContext.mjs` re-run against the real sidecar and recorded next to
§2.1.

## 6. New skills and agents (core skill rule 3)

Evaluate at the end of the named milestone:

- `wiretap-mcp-tools` (`src/bridge/ops/**`, `server/mcp*.ts`, `server/resultBudget.ts`, `server/handles.ts`,
  `shared/budgets.js`): when M4/M5/M13 push `wiretap-mcp-bridge` past about 250 lines.
- `wiretap-scripts` (`src/bridge/scripts/**`, `server/scriptProposals.ts`): at M14, a new subsystem with its own
  budgets and catalogue.
- `wiretap-plugin-api` (`src/bridge/skills.js`, `examples/**`): at M7, since it is a public API with a separate
  audience.
- `wiretap-agents` (`server/agentRunner.ts`, `server/agentCredentials.ts`, `server/rawSocket.ts`): at M9, a new
  subsystem.
- `wiretap-build-test` gains the budget-test tier and `tests/measure/` at M13.
- Matching `-coder` / `-code-reviewer` agent variants only if those domains need specialised context.

Each creation also updates the subsystem table in `wiretap-codebase-core` and the skill list in `.claude/claude.md`.

## 7. Risks and open questions

- E2 may show B is never safe (INFERRED likely for system-typed documents). Then D1 reduces to A-only in practice.
- An agent with the GAMEMASTER role can become `activeGM` and take module automation (READ `users.mjs:87-96`). E4.
- `modifyBatch` is not atomic; users may assume transactions.
- The arbitrary-code capabilities weaken the gate hard rule (§4.6), including approved and ad-hoc scripts (S8).
- Elicitation is declared by Claude Code but untested. Not used.
- Dev `options.json` has `upnp: true` (READ). INFERRED: Foundry `:30000` may be reachable externally. Agent users must
  have passwords.
- `.gitignore` lists e2e chunks at the repo root (`/*-????????.js`) while the rules say e2e builds to `test/build/`.
  Out of this plan; flag only.
- Context measurements are single runs on one model's tokenizer (`claude-haiku-5-5`); other models may count
  differently. Byte budgets plus the recalibration script contain this.
- Claude Code's deferral and inline-result cap are client behaviour that can change between versions (MEASURED on
  2.1.296 only). The budgets do not depend on deferral; the per-script-tool exposure (D18) does.
- Script catalogue sprawl raises the always-listed name cost (≈13 tokens per tool); the ≤ 30 cap forces review.

## 8. Out of scope / deferred (log in `TODO.md` when this plan is accepted)

- MCP stdio transport; MCP sampling (unsupported by Claude Code, MEASURED by user).
- Offline LevelDB/compendium writes while the world is stopped; a Foundry REST layer.
- True per-user execution for non-agent users via `User#query` (only advisory `actAs` is built).
- Wiretap-level multi-step undo history beyond `undo_last` (if D12 allows).
- Rate limiting / quotas per MCP session.
- Node-side plugin handlers.
- Structured chat UI (existing TODO).
- Dispatcher exposure mode (`run_script` / `list_scripts` / `describe_script`) unless D19 asks for it.
- Ad-hoc `run_js` unless D22 asks for it.
- Persisting handles across sidecar restarts.

## 9. Contradictions and items needing confirmation

- **C1 Deletion.** "No deletion APIs anywhere" (user, rescinded) is stated for filesystem/product code. A
  `delete_documents` skill and undo-of-create are *Foundry document* deletions. Is a gated delete skill allowed?
  (D12.) Until answered the plan builds no delete skill, and M0 deletes nothing. Scripts follow the same rule: no
  script deletes documents, and script storage is append/disable only.
- **C2 Test files.** The brief says "fixed names under `test/tmp`". The `wiretap-build-test` skill says unique
  `<pid>-<counter>` roots that must not pre-exist. The plan follows the skill (fixed names collide with stale files
  that cannot be deleted).
- **C3 "Authenticated sidecar socket" for credential push.** In the default loopback mode the socket is
  unauthenticated by D6. It is authenticated only in external mode (M10).
- **C4 Build hygiene.** `.claude/claude.md` says stale built files are deleted after every build, which conflicts
  with the no-deletion rule. Not touched by this plan.
- **C5 `exportToJSON` format.** It drops `_id`, `sort`, `ownership`, `author` by default (READ
  `client-document.mjs:1113-1134`). Reads use `keepId` and keep ownership and sort. Confirm (D14). For handles:
  `export_to_handle` keeps ids (round trip / replace in the same world); `import_from_handle` in `create` mode drops
  them so a copy gets new ids.
- **C6 D14 vs the context priority.** D14 (DECIDED) makes the `toCompendium` export the read representation. The
  measured cost (18 KB → 8,954 tokens; 84 KB refused inline by Claude Code) makes it unusable as the default. The plan
  keeps it canonical for `mode:"full"`, handles, create and replace, and proposes the compact view as the default
  (D24). This changes a user decision and needs confirmation.
- **C7 Scripts as code execution.** The user's proposal is a context mechanism; approved and ad-hoc scripts are also
  arbitrary code under GM authority. The plan separates vetted code (shipped, plugin: no extra gate) from
  agent-supplied code (gated, default OFF, D21/D22).
- **C8 Append-only proposal log vs disk growth.** No deletion is allowed, so `.wiretap/script-proposals.jsonl` only
  grows; a total-size cap refuses new proposals instead of pruning. Clearing it is a manual user action outside
  Wiretap.

## 10. Changes made in this revision

- Added G0 and new §2 "Context budget: top priority": measured cost model (6 `claude -p` runs, raw numbers), mechanism
  ranking, verdict on the user's script proposal, script design and security invariants, shipped catalogue, budgets.
- Renumbered: old §2 Decisions → §3, §3 Architecture → §4 (subsections 4.1–4.7), §4 Milestones → §5, §5 → §6, §6 → §7,
  §7 → §8, §8 → §9; all cross-references updated.
- Decisions: added D17 (DECIDED by user) and D18–D25 (PENDING-USER with recommendations); D14 annotated (view per
  D24).
- Architecture: added result enforcer, handle store, budget constants, script registry, shipped scripts,
  approved-script store, proposal log; `dom` endpoint flag; `bridge:proposals`; registry fields `source`, `requires`,
  `budgetBytes`; gates `allowApprovedScripts`, `allowAdhocCode`; data flow shows validation and the enforcer.
- Milestones: new M13 (budget harness, enforcer, handles), M14 (script runtime), M15a (API and composite scripts),
  M15b (DOM scripts), M16 (agent-authored scripts, only if D21); explicit order line. M0 gains E9. M1 error-contract
  caps. M3 depends on M13 and checks `list_changed` deferral. M4/M5/M6 register through M14 with compact/ack defaults;
  `screenshot` moved from M6 to M15b. M7 adds `registerScript` and budget refusal. M9 adds `dom: true`, fixed
  viewport, capture API, E9 dependency. M11 shapes raw results. M12 asserts live budgets. Every milestone has a
  "Context budget" acceptance line; the shared rules list makes it required.
- Skills: `wiretap-scripts` added; `wiretap-mcp-tools` and `wiretap-build-test` scopes extended.
- Risks, out-of-scope and contradictions C6–C8 added; C1 and C5 extended.
