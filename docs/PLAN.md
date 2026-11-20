# Wiretap plan: document skills for every type, plugin skills, seatless agents

Goals, the context-budget design, decisions, architecture, risk gates, specifications of the milestones still to do,
new skills and agents, risks and deferrals. Nothing else belongs here: work history, results and as-built notes are in
[`docs/PROGRESS.md`](PROGRESS.md), the current state of the code is in the `wiretap-*` skills, and specifications of
completed milestones are archived in [`docs/specs/2026-10-completed-milestone-specs.md`](specs/2026-10-completed-milestone-specs.md).
The documentation index is [`docs/README.md`](README.md).

Evidence labels: **MEASURED** (command or run named), **READ** (source location named), **INFERRED** (not verified; alternatives not excluded). "MEASURED (coord.)"
= measured by the coordinator's experiment agents (claude 2.1.296). Paths
under `foundry/` are relative to `C:\FoundryVTT\V14\dev\foundry\` (v14 stable, build 364, READ `package.json`).

**Project rule in force: no backwards compatibility** (READ `.claude/claude.md:25`). Wiretap is unpublished; tools,
APIs, settings, protocol events and file formats are renamed, reshaped or removed when the design calls for it. No
aliases, shims, deprecation paths or migrations appear anywhere in this plan.

## 1. Context and goals

Wiretap bridges MCP clients to a live Foundry world: a sidecar (Node) serves MCP over loopback and routes each call to a Foundry client endpoint (a human GM tab or a headless agent), where registered scripts run against Foundry's document APIs. Socket.IO is bound to `127.0.0.1`.

Goals:

- **G0 Minimal context use (TOP PRIORITY, cross-cutting).** Every tool definition, argument, result, image and error
  is budgeted (§2). It overrides convenience in every milestone.
- **G1 Core skills for every document type.** Read (whole, projected or path-scoped), create, update, replace and
  delete (D12) for all v14 primary and embedded types (READ `foundry/common/constants.mjs:332-424`), compendium
  content, open a sheet, rolls and table draws.
- **G2 Plugin skills.** Modules that depend on Wiretap register their own MCP tools; handlers run in the Foundry
  client.
- **G3 No human seat.** Skills work when no human has a GM tab open, on a headless server.

What "no seat" means (see §4.3): a Foundry *client* must still run for anything that needs system or module
code, sheets, derived data or plugin handlers. The seat is taken by a headless agent browser, not by a human. A
raw-socket path without any client bypasses all client-side logic and is safe only for reads of stored source data (D1);
it is not built (D27).

## 2. Context budget: top priority

**Requirement (D17):** minimising the MCP client's context use is a huge priority. "Context" = the
agent's context window: tool definitions, call arguments, tool results, screenshots/images and error text. The user
proposed pre-written scripts for actions such as opening a sheet, measuring an element and making an edit (adopted,
D18). Every milestone carries a context-budget acceptance criterion; M13's automated test enforces the budgets in
§2.6.

### 2.1 Cost model (derived)

Budgets are derived from measurements recorded in [`docs/experiments/2026-10-context-cost-model.md`](experiments/2026-10-context-cost-model.md) (tool-definition, result and image costs in Claude Code context tokens; path-scoped slice sizes) and from the shipped-surface calibration in [`docs/PROGRESS.md`](PROGRESS.md) "M13 calibration".

**Derived (INFERRED, arithmetic on the rows above):**

- **Per-call floor ≈ 170 tokens.** A call with a near-empty result still costs its `tool_use` block plus wrapper.
  A composite script that replaces N calls saves ≈ 170 × (N − 1) plus every intermediate result the agent would
  otherwise have read.
- **≈ 2 bytes of JSON per token** (18,343 B → 8,954; 6,507 B of schema → 3,113). A median dnd5e hero export would
  be ≈ 41k tokens if delivered; its `system` subtree ≈ 2.9k; `system.attributes.hp` sits at the call floor.
- **Embedded collections dominate exports** (91 % of the hero). Reads that address the actor's own data by path never
  pay for them.
- **Claude Code has an inline result cap** between 21.7 KB (the escaped 18 KB export, delivered) and 84.6 KB (refused)
  of text; the exact value was not read. Above it the agent must slice a saved file and pays for whatever it reads.
- **Deferred loading changes the calculus (MEASURED (coord.) R2–R4, R6).** An unused tool costs only its name
  (≈12–14 tokens). A schema costs ≈150–195 tokens once per session when ToolSearch loads it; R4 called `get_document`
  three times after one load. Descriptions are therefore paid on load, not every turn, in Claude Code. Claude Code
  defers by default and loads upfront only for some hosting setups or when `ENABLE_TOOL_SEARCH=false` (READ
  `code.claude.com/docs/en/mcp`, "Configure tool search"); such a client pays every definition on every request:
  ≈3.1k tokens for 16 tools, ≈6.7k for 40.
- **Results dominate.** Definitions cost hundreds of tokens once; one unshaped read costs thousands, or fails.

### 2.2 Mechanisms ranked

| # | Mechanism | Saving (evidence) | Build cost | Risk / mitigation | Where |
|---|---|---|---|---|---|
| 1 | Compact-by-default reads + `fields` projection + `paths` (path-scoped reads, §2.8) | Full 18 KB export 8,954 → projected +266 (≈96 above the floor); hero `system` 5.8 KB instead of 84.6 KB; a hero becomes readable at all (MEASURED (coord.)) | Low | Agent needs a field not in the view → `fields`/`paths` or explicit `mode:"full"` | M4 |
| 2 | Hard result cap + saved-result handles | Removes the "exceeds maximum allowed tokens" failure; export/import/copy without the body entering context (INFERRED from R4) | Medium (sidecar in-memory store) | Memory growth → bounded per-session LRU in memory; no files, so no deletion | M13 |
| 3 | Ack-only writes (`uuid`, changed paths) | +172 vs re-reading the document (+1,037 compact) (MEASURED (coord.)) | Low | Agent cannot see derived side effects → optional `paths` on the ack | M5 |
| 4 | Measurements instead of screenshots | +172 vs +972 for one 800×600 image (MEASURED (coord.), single sample) | Medium (needs DOM endpoint) | Visual-only questions remain → `screenshot` as capped last resort | M15b |
| 5 | Composite scripts (one call for N steps) | ≈170 per eliminated call + intermediate results (INFERRED from the floor) | Medium per script | Catalogue sprawl; each script is maintained API → catalogue reviewed per milestone | M15a |
| 6 | Skills as the discovery layer (§2.7) | Tool descriptions stay one line; how-to text is paid only when a skill is invoked (INFERRED; not measured) | Low | Skill text drifts from tools → M13 test checks referenced tool names exist | M14 |
| 7 | Pagination: default limit 20, max 100, continuation cursor | Bounded search results (INFERRED) | Low | Agent pages blindly → result carries `total` | M4 |
| 8 | Short actionable errors (≤ 512 B; first 10 validation failures + count) | Bounded; `getAllFailures()` can list every invalid field (READ `common/data/validation-failure.mjs:374`) | Low | Lost detail → `paths` re-check or `dryRun` | M1, M5 |
| 9 | Change-only reads: `diff_since(cursor)` and `ifModifiedSince` (`{unchanged:true}`) | Re-reads shrink to changed rows (INFERRED) | Low–medium | Clock basis = `_stats.modifiedTime` | M15a |
| 10 | Description and schema budgets | ≈150–195 tokens per loaded tool; names ≈13 always (MEASURED (coord.)) | Low | Terse descriptions mislead → skills carry the detail (row 6) | M13 |
| 11 | Server-side summarisation | Only deterministic (counts, tuples); LLM summarisation impossible (sampling `-32601`, MEASURED (coord.)) | — | Folded into compact views | M4 |

### 2.3 Scripts as the unit of work (D18)

Pre-written scripts are adopted, with these modifications:

- **Adopt.** Pre-written, parameterised, schema-validated routines that run in a Foundry client and return budgeted
  results. Measured wins: one call instead of N (≈170 tokens floor each plus intermediate results) and numbers instead
  of screenshots (+172 vs +972).
- **Each script is its own MCP tool**, not a generic `run_script(name, args)` dispatcher. In Claude Code a deferred
  tool costs ≈13 tokens until used and its schema ≈150 tokens once; a dispatcher needs `list_scripts` and
  `describe_script` round trips before the first call and loses the client-side schema check. The dispatcher mode for
  clients that do not defer is DEFERRED (D19, logged in `docs/TODO.md`).
- **One registry with the core tools.** The generic core tools are shipped scripts of the generic category: one
  registry, one validation path, one result enforcer. Task-shaped scripts call the same op functions (`ctx.core.*`).
- **Skills reference the tools** (§2.7) so descriptions stay short.
- **Combined with result shaping.** The largest measured saving is result shaping (rows 1–3 of §2.2), not the script
  mechanism. Both are required.

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
| Agent-saved | Source text saved by the agent through `save_script` | Per D21 (DECIDED option (b), §2.5) | Per D21 |
| Ad-hoc `run_js` | — | — | Not built (D22, DECIDED) |

**Execution context `ctx`:** `ctx.core.*` (the core op functions, gates apply), `ctx.shape` (projection, path
slices, compact view, ack), `ctx.dom` (only on a DOM-capable endpoint), `ctx.signal` (timeout). Arguments are
validated twice: on the sidecar (zod from JSON Schema, the M7 mechanism) and on the client (same schema). Every result
passes the sidecar enforcer: over budget → `{handle, bytes, summary}`.

**Where scripts run:**

- `api`: any client endpoint (agent or human GM tab). Raw socket (B) only for source reads (D1), if built (D27).
- `dom`: the agent endpoint by default; a human tab only with an explicit `endpoint` override (D25, DECIDED).
  `screenshot` is captured by the agent runner's Playwright page on the sidecar; the client supplies the region
  rectangle. Unit tests cannot measure layout: happy-dom (READ `vitest.config.mjs`) performs no layout, so sizes are
  mocked in unit tests and real only in e2e.
- `none`: the sidecar (handle slices, `list_endpoints`).

**Discovery:** standard `tools/list`, deferred by Claude Code; plugin and agent-saved scripts arrive via
`notifications/tools/list_changed` (M3). READ (`code.claude.com/docs/en/mcp`, "Dynamic tool updates"): an
interactive session re-fetches the list on `list_changed`; `-p` and the Agent SDK refresh the tool list. Measured behaviour of late-added tools is in `docs/experiments/2026-10-m3-results.md`.

### 2.5 Agent-saved scripts (D21, option (b))

Agent-saved scripts are governed by Claude Code's own permission rules and modes, plus minimal Wiretap safeguards. Analysis and rejected options: [`docs/specs/2026-10-d21-agent-script-permissions-analysis.md`](specs/2026-10-d21-agent-script-permissions-analysis.md).

Safeguards:

1. World gate `allowAgentScripts`, GM-only, default OFF (D8).
2. `save_script` carries `_meta["anthropic/requiresUserInteraction"]: true`, so a human sees the code on every save in every Claude Code mode.
3. Saved tools are named `agent__<name>`, so a user can write `ask` rules for `mcp__wiretap__agent__*`.
4. Code is hash-pinned at save and verified before each run.
5. Disable instead of delete.

Residual risk (stated, not hidden): only calls that pass through that Claude Code instance are checked, so a local process or non-Claude client can still save code when the gate is ON; calls of saved scripts follow the rules that match their names in each later session; a saved script runs with GM authority (S7). The permission model and example `ask` rules are documented in the README.

**Storage (option a or b), no deletion:** sidecar file `.wiretap/agent-scripts.json` (0o600, symlink refusal,
overwrite-only like `mcpConfigFile.ts`) holding `{name, version, sha256, code, inputSchema, requires, mutates,
savedAt, enabled}` entries; a new version marks the older `enabled: false`; `disable_script` sets `enabled: false`;
entries are never removed; per-script code cap 8 KB and a total-size cap. The sidecar, not a `wiretap.*` world
setting, holds them, so the §4.6 hard rule needs no exception. Execution: the client receives code over the bridge,
verifies `sha256`, checks `allowAgentScripts` in its own `game.settings`, and runs it through
`foundry.utils.AsyncFunction` (the mechanism of script macros, READ `client/documents/macro.mjs:146`).

**Security invariants (option b):**

- **S1** No saved script runs unless `allowAgentScripts` is ON in the executing client's `game.settings`; params
  never carry gate values.
- **S2** `save_script` always carries `requiresUserInteraction`; the M13 test asserts it.
- **S3** Execution requires `sha256(code) === entry.sha256` and `enabled: true`; any edit is a new version.
- **S4** Arguments are schema-validated before any handler runs.
- **S5** Shipped and plugin scripts that touch a gated category call `requireGate`.
- **S6** No API deletes an entry; disable only.
- **S7 Known limit (INFERRED).** A saved script runs with GM authority and can change gates or save more scripts;
  enabling `allowAgentScripts` reduces the hard rule to "no core skill can change a gate" (same caveat as
  `allowMacroExecution`). The gate hint says so.

### 2.6 Final budgets (D20)

Bytes are the enforced unit (deterministic, no API call). Tokens ≈ bytes / 2 (§2.1). In this document and in `shared/budgets.js`, 1 KB means 1000 bytes (5.8 KB = 5,817 B). **Principle:** everything
Wiretap constructs (definitions, compact views, acks, errors, layout trees) has a hard budget that fails CI; results
the agent explicitly asks for (`paths`, `fields`, `mode:"full"`, `read_handle`) are bounded only by the hard cap,
which the enforcer applies at runtime (over cap → handle). 

| Budget | Value | Kind | Rationale |
|---|---|---|---|
| Core/shipped tool name | ≤ 32 chars | CI hard | Names are always in context (≈13 tokens each at ≈25 chars, MEASURED (coord.)) |
| Plugin and agent-saved tool name | ≤ 64 chars | Registration refusal | `<moduleId>__<skill>`: module ids are outside Wiretap's control; 110-char names work (MEASURED (coord.)) |
| Definition `{name, description, inputSchema}` | ≤ 800 B | CI hard; registration refusal for plugins | Largest drafted core tool 787 B ≈ 380 tokens when loaded |
| Description | ≤ 160 chars target, ≤ 240 hard | CI warning above 160, hard above 240 | Paid on every load; ToolSearch keyword matching needs some text (INFERRED); skills carry detail (§2.7). Claude Code truncates at 2,048 (READ docs) |
| Always-listed tools (core + shipped) | ≤ 30 | CI hard | ≈ 400 tokens of names; raising it is a user decision |
| All definitions (core + shipped) | ≤ 16 KB | CI hard | ≈ 8k tokens for a non-deferring client |
| Ack (write) | ≤ 256 B per document | CI hard | +172 measured at 84 B |
| Compact default view | ≤ 2 KB per document; embedded tuples capped at 40 plus a total count | CI hard (synthetic fixtures) and e2e hard | 1,484 B measured with 31 tuples (≈43 B each); the cap makes the bound data-independent. Measured on titan: max 1,574 B |
| Projection / `paths` result | Hard cap only; ≤ 1 KB per 10 fields is the fixture target | CI warning on fixtures | Size is the agent's request; hero `system` = 5.8 KB is a legitimate request. Titan 10-field projections 199–1,224 B (E9; the 1,224 B one holds a long text leaf), consistent with warning-only |
| Search page | ≤ 4 KB, default limit 20, max 100 | CI hard | Rows `[uuid, name, type]` |
| Error | ≤ 512 B, first 10 failures + count | CI hard | — |
| Text result hard cap | **8 KB default**, per-call `maxBytes` up to 16 KB; over cap → `{handle, bytes, summary}` | Runtime enforcer; CI hard on the behaviour | 18 KB was +8,954 tokens; 8 KB ≈ 4k tokens fits hero `system` (5.8 KB) and the median item (2.1 KB); 16 KB stays below the measured Claude Code inline lower bound (21.7 KB). Titan full actor exports are 5,738–12,492 B (E9): 3 of the 4 measured exceed 8 KB, so a full actor read returns a handle unless `maxBytes` is raised; titan items (634–1,697 B) fit |
| `sheet_layout` | ≤ 4 KB | CI hard (fixture) and e2e hard | E9 prototype at depth 2: 401–441 B, but too shallow to be useful; the default depth is set in M15b by measurement |
| Image | `screenshot` only; default ≤ 480,000 px (the 800×600 area), aspect kept (D28); max 1280 px longest side; one per result | CI hard (capture unit) | +972 measured at 800×600; larger sizes not measured. Titan sheets are 850×926 (actor) and 700×650 (item) (E9): the actor sheet does not fit an 800×600 box without distortion-free downscaling to 551×600, so the default is expressed as area |
| Live recalibration | `tests/measure/measureContext.mjs`, manual, ≤ 6 `claude -p` runs | Report only | Tokenizers and Claude Code behaviour change between versions |

**Counting rule.** Every byte budget counts the raw UTF-8 bytes of the text a tool returns, not the JSON-escaped bytes
of the MCP wire message: quotes, backslashes and control characters in a result are escaped on the wire, so the wire
form of a result at the cap can be larger than the cap. Runtime bounds that protect the sidecar rather than the client
context: one stored result ≤ 8,000,000 B (`HANDLE_ENTRY_MAX_BYTES`), ≤ 1,024 stored results (`HANDLE_MAX_COUNT`), each
entry accounted as the larger of its UTF-8 size and twice its character count plus 256 B inside the 64 MB total, one
image ≤ 1,000,000 base64 characters (`IMAGE_DATA_MAX_BYTES`) and `image/png` only. The 480,000 px image area is a
capture-time default, not enforced by the result enforcer.

### 2.7 Skills as the discovery layer (D18)

Wiretap skills reference the MCP tools to point agents to them.

- **Developer skills** (`.claude/skills/wiretap-*`) and **user-facing skills shipped for MCP users** name the exact
  tools and the recipe ("read one field: `mcp__wiretap__get_document` with `paths`"). Tool descriptions then stay one
  line; examples and caveats live in skill bodies.
- **Interaction with deferral.** Claude Code lists skill names and descriptions at session start and loads a skill's
  body when it is invoked (INFERRED from how skills appear in this session's own context; not measured for cost). A
  skill that names tools lets the agent load exactly those schemas with `ToolSearch select:` (≈800 tokens for three,
  MEASURED (coord.) R4) instead of keyword-searching. The MCP server's `instructions` field is loaded at session start
  and truncated at 2,048 chars (READ docs, "Tool search for MCP server authors"); Wiretap uses it for a ≤ 600-char
  pointer to the skill and the tool families.
- **Not used by default:** `_meta["anthropic/alwaysLoad"]` (READ docs) would load a tool's schema upfront; it trades
  ≈150–195 tokens always against one ToolSearch round trip when needed.
- **Delivery of the user-facing skill:** the repo directory `skills/wiretap/` plus README install instructions. A test
  checks that every tool name a shipped skill mentions exists.

### 2.8 Path-scoped reads and writes (D26)

**Feasibility (READ).** `foundry.utils.getProperty` resolves dot paths and array indices but not embedded ids, and it
does not skip `__proto__`/`constructor`/`prototype` (only `setProperty` does) (READ
`common/utils/helpers.mjs:821-868`). v14 has explicit update operators `_replace` / `_del` (`ForcedReplacement`,
`ForcedDeletion`; READ `common/global.d.mts:6-7`, `common/abstract/data.mjs:867-874`). Wiretap therefore ships its
own small path resolver over the canonical export; writes reuse Foundry's update paths.

**A `paths` parameter on `get_document`, not a new tool.** Zero additional tool names (≈13 tokens
saved per session versus a new tool, MEASURED rate); `get_document`'s definition grows by an estimated 150 B
(INFERRED) and stays under 800 B; the same grammar serves `read_handle`, `update_documents` and `describe_schema`.

**Grammar (one resolver, shared by reads, writes, handles and schema):**

- Dot segments over the canonical export (§4.4, `keepId: true`): `system.attributes.hp`.
- Embedded collections by id: `items.<_id>.system.uses` (resolved by `_id`, not array order). Plain arrays by
  integer index: `system.traits.languages.value.0`.
- One wildcard segment per path, only over an embedded collection or array, returns `{<id or index>: value}`:
  `items.*.name`.
- `paths: string[]`, up to 20 paths per call; the result is `{values: {<path>: value}, missing: [<path>]}`. A missing
  path is listed in `missing`, not an error; all paths missing still returns `ok`.
- Refused segments: `__proto__`, `constructor`, `prototype`; error ≤ 256 B naming the segment.

**Source vs derived.** Default `source` (the export). `derived: true` resolves the same paths against the prepared
document (e.g. `system.attributes.hp.max` after `prepareData`); values are serialized through `toObject()` where
present and `Set` → array. Derived reads are client-only (never raw socket B).

**Interaction with D14/D24.** No `paths`/`fields` → the compact view (D24). `paths` → slices of the canonical export
with ids kept (D14), so `items.*.name` answers come back keyed by `_id` ready for writes. `mode:"full"` → the whole
export. All three pass the enforcer: a path result over the cap (e.g. `items` on the hero, 77 KB) becomes a handle,
and `read_handle(handle, path)` slices it with the same grammar.

**Path-scoped writes = `update_documents`, extended (no new tool).** `changes: {<path>: value}` with the same grammar:

- Paths on the document itself → `doc.update({...})` (dot keys merge recursively, as today).
- Paths into an embedded document (`items.<_id>.system.uses.value`) → grouped into one
  `parent.updateEmbeddedDocuments('Item', [{_id, 'system.uses.value': v}])` per collection.
- Per-patch `op: "set" | "replace" | "delete"` maps to a plain value, `_replace(value)` or `_del` on the client
  (operators cannot cross the JSON wire, so the client builds them).
- Wildcard writes are refused (an explicit id list is required).
- The result is the ack `{uuid, changed: [paths]}`, optionally with `paths` read back.

There is no separate `edit(uuid, patch)` script; `update_documents` covers it.

**Schema by example for a path.** `describe_schema(documentName, subtype, path)` returns the blank export's subtree
at `path` plus the field-walker constraints for that subtree (D15 scoping), so an agent can learn the shape of
`system.attributes` without the whole schema.

**Savings (INFERRED from the measured slices, §2.1):** reading `system.attributes.hp` instead of the hero export is
86 B vs 84,564 B (≈170 tokens at the floor vs an undeliverable result); `system` is 5,817 B (≈2.9k tokens) vs 84,564
B; `items.*.name` on the hero returns 31 short strings instead of 77 KB of items.

### 2.9 Script catalogue (shipped)

Budgets are the result cap in serialized bytes. "Replaces" counts the calls a generic-tools-only agent would make.

| Script | Purpose | Requires | Result budget | Gate | Replaces |
|---|---|---|---|---|---|
| `get_document(uuid, paths? \| fields? \| mode?)` | Compact view by default; path slices (§2.8); full export | api | 2 KB compact; hard cap otherwise | — | — |
| `update_documents(updates[], dryRun?)` | Path-scoped writes incl. embedded paths and `op` (§2.8) | api | 256 B ack per document | per category | read + update + re-read |
| `delete_documents(uuids[], dryRun?)` | Document deletion through Foundry document calls (D12) | api | 256 B ack; `dryRun` lists names | `allowDelete` (D12a) | — |
| `open_sheet(uuid, userId?)` | Render a sheet on the client of the connected user named by `userId` via the `wiretap.openSheet` query, else on the client running the call; never broadcast | api | 128 B `{ok, appId}` | — | — |
| `close_sheet(uuid, userId?)` | Close it the same way, via the `wiretap.closeSheet` query (READ `client/applications/api/application.mjs:950` `close`) | api | 128 B | — | — |
| `element_size(uuid, selector)` | `{x, y, w, h, scrollW, scrollH, visible}` of a selector inside the rendered sheet (`element` getter READ `application.mjs:327`) | dom | 256 B | — | screenshot |
| `sheet_layout(uuid, depth=2, maxNodes=40)` | Compact tree `[selector, w, h, overflow]` of the sheet parts | dom | 4 KB | — | screenshot + N sizes |
| `screenshot(uuid, selector?, maxSide=800)` | PNG, explicit last resort; default ≤ 800×600, hard max 1280 px longest side, one image per call | dom + runner | 1 image | — | — |
| `add_embedded(parentUuid, documentName, data[] \| fromUuids[])` | Add Items / ActiveEffects from data or compendium uuids | api | 256 B + 64 B per created | per category | N × (search + read + create) |
| `roll(formula, toChat=false)` | `{total, formula, dice}` | api | 512 B | — | — |
| `diff_since(cursor \| {uuid, handle})` | Documents changed since a cursor (`_stats.modifiedTime`), or changed paths vs a stored export (`foundry.utils.diffObject`) | api | 4 KB page | — | full re-reads |
| `export_to_handle(uuid, keepId=true)` | `toCompendium` (§4.4) into a sidecar handle; returns `{handle, bytes, summary}` | api + sidecar | 256 B | — | full read |
| `read_handle(handle, paths? , offset?, length?)` | Slice a stored result (§2.8 grammar) | none | hard cap | — | — |
| `import_from_handle(handle, mode: create \| replace, keepId?)` | Create a copy (`keepId: false`, `fromCompendium` strips `_id`) or replace in place (`keepId: true`, §4.4) | api | 256 B ack | compendium target → `allowCompendiumWrites` (proposed) | read + create with the body in context |
| `build_actor(spec)` | Composite: create an Actor, set fields, add Items from compendium uuids or data, add effects | api | 512 B | — | ≥ 5 (create, N searches, N embedded creates, update) |
| `inspect_sheet(uuid, selectors[])` | Composite: open, measure k selectors plus a layout summary, close | dom | 2 KB | — | 2 + k |
| `copy_document(uuid, target, overrides?)` | Composite: export → import to a folder or pack; the body never enters context | api | 256 B | as `import_from_handle` | read + create |
| `save_script(...)` / `disable_script(name)` | §2.5, only if D21 builds it | none | 256 B | `allowAgentScripts` | — |

The other generic core tools (M4/M5: `list_document_types`, `search_documents`, `describe_schema`,
`create_documents`, `replace_document`, `batch`, `draw_table`, `execute_macro`, `undo_last`, `list_endpoints`) are
entries of the same registry with the budgets of §2.6.

## 3. Decisions log

| # | Decision | Status |
|---|---|---|
| D1 | Seatless execution: headless browser client (A) and raw socket (B), B only where it adds no risk. **Boundary:** B-eligible = reads of stored source data only; every create, update and delete is A only (rule in §4.3, evidence in `docs/experiments/2026-10-m0-raw-socket-boundary.md`) | DECIDED |
| D2 | Must run on a headless server: `playwright-core` + Playwright Chromium build, `executablePath` configurable; no reliance on an installed Edge/Chrome. **Default agent profile: `chromium_headless_shell` with `core.noCanvas` on** (the smallest functional build, the agreed criterion) | DECIDED |
| D3 | Agent users: GM-client **client-scope** setting `[{userId, password}]` → pushed to the sidecar → module-local owner-only file; env-var provisioning also supported; passwords never sent back to any client | DECIDED |
| D4 | Agent role: **ASSISTANT**, on a dedicated user per agent. An ASSISTANT has `isGM === true`, runs every Wiretap op tested, never outranks a GAMEMASTER for `activeGM`, and cannot promote anyone to GAMEMASTER; so a human GAMEMASTER always stays the active GM when online. Implication: with no GAMEMASTER online the agent **is** the active GM and runs any system/module automation gated on `activeGM` in the headless page (with `core.noCanvas` on; whether such automation needs the canvas is not measured). A GAMEMASTER agent would compete with humans by id order (`wtx-gm` won over `E2E GM 1`). Agents never share a human's user: the stock join form refuses an already-active user (E1) | DECIDED |
| D5 | Routing: prefer an agent endpoint, fall back to a human GM tab, per-call `endpoint` override | DECIDED |
| D6 | Trust: loopback unauthenticated (same machine is trusted). External access is an opt-in bind that requires a bearer token on `/mcp` and a token on socket identify, plus TLS/reverse-proxy guidance. Reopens the loopback-only rule when enabled | DECIDED |
| D7 | Acting user: optional advisory `actAs` pre-check (`testUserPermission` / `canUserModify`); the write runs as the endpoint user | DECIDED |
| D8 | Every risky operation has a GM-only world setting (a gate), default OFF; gate settings can never be changed by any skill. Risky = irreversible, overwriting, arbitrary code, privilege or ownership escalation, file removal, external exposure or data at rest (rule in §4.6) | DECIDED |
| D9 | Plugin handlers run client-side by default. Opt-in sidecar plugins (Node handlers) are allowed per plugin id behind the `allowSidecarPlugins` gate (D31) | DECIDED |
| D10 | Plugin surface: `Hooks.callAll('wiretap.registerSkills', api)` + `api.registerSkill`, integer `apiVersion`, tool names `<moduleId>__<skill>`, no dots | DECIDED |
| D11 | MCP transport moves to stateful Streamable HTTP sessions with `notifications/tools/list_changed`; no sampling | DECIDED |
| D12 | Deletion: the ban is on deleting **files**. Foundry documents may be created, updated and deleted through Foundry document calls | DECIDED |
| D12a | Deletion is risky and gated: `delete_documents` needs `allowDelete` (default OFF); `User` deletion additionally needs `allowUserWrites`, `Setting` deletion `allowSettingWrites`; `dryRun` previews; Claude Code `ask` rules remain a second layer (README shows `"ask": ["mcp__wiretap__delete_documents"]`); compendium **pack** deletion is D30. `undo_last` needs `allowUndo` | DECIDED |
| D13 | Replace semantics fire normal update hooks (not `importFromJSON`'s `noHook: true`) | DECIDED |
| D14 | Canonical document representation = the `toCompendium` export format (as used by `exportToJSON`), with `keepId: true` for reads | DECIDED |
| D15 | `describe_schema` = "schema by example" (blank export per type/subtype) first; DataModel field-walker for constraints second, scoped by path (§2.8 grammar). **E8-driven design (M4):** without `path` it returns the blank export (titan Actor 4.85 KB, Items ≤ 648 B) plus a one-level outline of the schema; full constraints only with `path`, because the walker output for an Actor is 19.9 KB (above the 16 KB maximum cap) and Adventure 26.5 KB. For the 7 classes whose blank construction fails (ActorDelta, Drawing, Folder, Setting, TableResult, Tile, Wall) the example is built with the minimal required fields (parent, `type`, `key`) or omitted with the walker output only (approach INFERRED; M4 tests it) | DECIDED |
| D16 | `create_actor` is removed when `create_documents` lands; no alias (no-backwards-compatibility rule) | DECIDED |
| D17 | Context minimisation is a top-priority, cross-cutting requirement; every milestone has a context-budget criterion | DECIDED |
| D18 | Pre-written scripts, adopted as described in §2.3 (one registry with the core tools; each script its own deferred MCP tool; combined with result shaping); skills may reference tools as the discovery layer (§2.7) | DECIDED |
| D19 | Dispatcher mode (`list_scripts` / `describe_script` / `run_script`) for clients that do not defer tools | DEFERRED |
| D20 | Budgets of §2.6 enforced in bytes; constructed outputs CI-hard, requested outputs bounded by the runtime hard cap | DECIDED |
| D21 | Agent-saved scripts are governed by Claude Code permissions plus minimal Wiretap safeguards (§2.5) | DECIDED: option (b) |
| D22 | Ad-hoc agent code `run_js` is not built. Rationale: arbitrary GM-authority code per call defeats the gate hard rule (§4.6); its code travels in every call's arguments (the opposite of the context goal); `execute_macro` (gated) and D21 cover reuse | DECIDED |
| D23 | Saved-result handles: sidecar store per MCP session, LRU-bounded (64 MB total, 30 min idle). In memory by default and lost on sidecar restart; an opt-in setting persists them to a protected file (D32) | DECIDED |
| D24 | Default read view = compact; the canonical D14 export with `mode:"full"` or by `paths`, all under the hard cap | DECIDED |
| D25 | DOM scripts route to the agent endpoint by default; a human GM tab only by explicit `endpoint` override | DECIDED |
| D26 | Path-scoped reads and writes (§2.8): `paths` parameter on `get_document`, same grammar in `update_documents`, `read_handle`, `describe_schema`; no new tools; `edit` merged into `update_documents` | DECIDED |
| D27 | The raw-socket executor (M11) is not built; it is logged in `docs/TODO.md`. It could only serve source reads and valid system-field updates when no client is live, and the sidecar cannot tell valid from invalid values without the system's DataModels, which exist only in a client (§4.3); the agent runner (M9) provides a client at a measured 440 MB and 1.8 s | DROPPED |
| D28 | Screenshot default expressed as pixel area (≤ 480,000 px, the 800×600 area, aspect kept) instead of an 800×600 box ( in §2.6) | DECIDED |
| D29 | Multi-step undo: a bounded per-session ring of inverse operations (create, update, delete, replace, batch); `undo_last(n)` replays inverses; `User` and `Setting` writes are not undoable (M17) | DECIDED |
| D30 | Compendium pack tools `create_pack` and `delete_pack` for any unlocked world pack, behind `allowCompendiumWrites` (creation) and `allowPackDeletion` (deletion), with `dryRun`; `delete_pack` carries `_meta["anthropic/requiresUserInteraction"]: true` so Claude Code prompts on every call at every permission level; the Foundry server, not Wiretap code, removes pack files (M18) | DECIDED |
| D31 | Node-side plugin handlers run in the sidecar only for plugin ids the GM enables behind `allowSidecarPlugins` (default OFF); they reach Foundry only through the same scripts, gates and validation as client plugins (M20) | DECIDED |
| D32 | Handle persistence is opt-in (`persistHandles`, default OFF): a protected file under `.wiretap/`, overwrite-only, with the same size and idle bounds; the at-rest protection is specified at the M19 start (M19) | DECIDED |

## 4. Architecture

### 4.1 Components and where they run

| Component | Runs in | Role |
|---|---|---|
| MCP session server (`server/mcp*.ts`) | Sidecar (Node) | Stateful Streamable HTTP sessions; tool list = core tools + scripts + plugin tools of the routed endpoint; server `instructions` pointer (§2.7); sends `list_changed` |
| Result budget enforcer (`server/resultBudget.ts`) | Sidecar | Applies §2.6 caps to every tool result; over cap → handle + summary; caps error text |
| Handle store (`server/handles.ts`) | Sidecar, memory only | Per-session LRU of large results (D23); slices for `read_handle`, input for `import_from_handle` |
| Budget constants (`shared/budgets.js`) | Both | The §2.6 numbers; one source for enforcer, registration checks and tests |
| Path resolver (`shared/docPath.js`) | Both | §2.8 grammar: parse, refuse unsafe segments, resolve over an export, group embedded writes |
| Endpoint registry + router (`server/endpoints.ts`, replaces `gmSockets`) | Sidecar | Tracks identified GM endpoints `{socketId, userId, userName, kind: agent\|human, dom: bool, registeredAt}` (plus `gateState`, and `skills[]` from M7); routes per D5, DOM scripts per D25 |
| Script registry (`src/bridge/scripts/registry.js`) | Foundry client | Shipped and plugin scripts (core tools included), and agent-saved scripts if D21; validates args; emits `bridge:registry` |
| Shipped scripts (`src/bridge/scripts/*.js`) | Foundry client | §2.9 catalogue; static imports only |
| Op dispatcher (`src/bridge/ops/*`) | Foundry client (human GM tab or agent tab) | Core ops on `documentClass` APIs; gate checks; `actAs` pre-check; `ctx.core.*` for scripts |
| Gate settings (`src/settings/gates.js`) | Foundry client, world scope, `restricted` | Risk options (§4.6) |
| Agent-script store (`server/agentScripts.ts`) | Sidecar | `.wiretap/agent-scripts.json`, overwrite/version/disable only; only if D21 builds it |
| Agent credential store (`server/agentCredentials.ts`) | Sidecar | `.wiretap/agents.json` (0o600, symlink refusal, overwrite only) or env file |
| Agent runner (`server/agentRunner.ts`) | Sidecar host | Launches and supervises one headless browser context per agent user; captures `screenshot` regions |
| `wiretap.openSheet` user query | Every client with Wiretap (players too) | Renders a sheet on the chosen user's client (`CONFIG.queries`, READ `client/documents/user.mjs:289-321`) |

### 4.2 Data flow

```
MCP client ──HTTP (session id)──► sidecar MCP session server
   tools/list ◄── core tools + scripts + registry[routed endpoint].skills ──► list_changed on registry change
   tools/call ──► zod validation ──► router (D5: agent > human; DOM → agent per D25)
      └─► Socket.IO bridge:invoke {op|script, params, actAs?} ──► client registry ──► ops ──► Document APIs
   result ◄── resultBudget enforcer (cap → handle store) ◄── raw result
agent runner: credentials → playwright-core → /join as agent user → /game → Wiretap client identifies as kind=agent
GM human tab: settings UI → credentials pushed once over bridge:credentials → sidecar file (never echoed back)
```

### 4.3 Why a Foundry client is required (D1)

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

**Rule (D1).** An operation class may use a raw socket only if a client-path comparison shows no difference, invalid input is handled identically, no client `_pre*` hook exists for the class and the operation needs nothing client-only. Only reads of stored source data qualify; everything else runs on a client endpoint (agent or human tab). The raw-socket path is not built (D27). Rule detail and the measured table: [`docs/experiments/2026-10-m0-raw-socket-boundary.md`](experiments/2026-10-m0-raw-socket-boundary.md).

### 4.4 Canonical document representation (D14, view per D24, paths per D26)

- **Full reads** (`mode:"full"`, `export_to_handle`) produce `doc.toCompendium(null, {clearSource: false, keepId:
  true, clearSort: false, clearOwnership: false})` plus `uuid`. The defaults would drop `_id`, `sort`, `ownership` and
  `author` (READ `client-document.mjs:1113-1134`). Optionally prepared values are added under a separate `derived`
  key.
- **Default reads** return the compact view: `uuid`, `name`, `type`, `modified` (`_stats.modifiedTime`, the clock of
  `ifModifiedSince`), a per-type key-field list, and embedded documents as `[id, name, type]` tuples (first 40 plus a
  total count). `fields` returns a projection, `paths` path slices (§2.8), both of the canonical form.
- **Exclusions and redaction** apply in the one export function, so every read path (compact, `fields`, `paths`, full,
  search rows and filters, `describe_schema` examples) inherits them: a `Setting` in the `wiretap.` namespace, in the
  credential denylist (`core.rtcWorldSettings`: `client/av/settings.mjs:97-102` defines the TURN `username` and
  `password`, `:162-167` registers the world setting; the other core settings registered in `client/` hold interface,
  canvas, sheet and keybinding preferences) or with a key that names a secret is `DOC_EXCLUDED`. Every key matching
  `/pass(word|phrase)?|secret|token|api[-_]?key|credential|private[-_]?key/i` is dropped from a `Setting` `value` (JSON
  text) and from every `flags` object of the export, to depth 24 and 50,000 nodes per walk (the setting value and the
  rest of the export have separate budgets; a list is cut at the first member beyond a bound, so kept indexes never
  move; what lies beyond is dropped). A string inside that data which itself holds JSON (an object, a list or a string
  of JSON) is parsed and redacted with the same bounds, up to 4 levels of nesting (each level doubles the escaping); text that is not JSON is left as it
  is. A pack index path is never asked for when one of its segments matches the pattern (`PATH_EXCLUDED`), because index
  entries are raw source data. The
  `User` password fields are removed. Limitations: name-only matching (a secret under another name is exposed; `bypass`,
  `passive` or `tokenId` inside flags or a setting value are dropped); core schema fields and `system` data are not
  scanned because core names such as `prototypeToken` match the pattern; the setting-key test is narrower (it omits a bare
  `token`, which would refuse `core.tokenAutoRotate`); settings of other modules are readable. Owner decisions are in
  `docs/TODO.md`.
- **Create** takes the canonical shape. `exportToJSON` drops `_id`, `sort`, `ownership` and `author` by default; reads keep
  them (`keepId`, D14), and `import_from_handle` in `create` mode drops them so a copy gets new ids.
- **Replace** = `fromImport` → `collection.fromCompendium` → strip `preserveOnImport` → `update(data, {diff: false,
  recursive: false})` **with hooks** (D13). Input may be a handle.
- `exportToJSON` / `importFromJSON` themselves are world-documents only and trigger a download / notification (READ
  `:928-944`, `:1049-1068`). Wiretap calls the underlying steps and also covers embedded and compendium documents.

### 4.5 Bridge protocol additions (`shared/protocol.js`)

A mismatched `protocolVersion` is refused, not translated (no-backwards-compatibility rule).

- `bridge:identify` gains: `kind`, `dom` (can render and measure), `protocolVersion`, `token?` (external mode only),
  `gateState` (from M2).
- `bridge:registry` carries `{apiVersion, scripts: [ScriptDefinition]}`.
  Wire shape and routing: the `wiretap-mcp-bridge`, `wiretap-mcp-sessions` and `wiretap-scripts` skills.
- `bridge:credentials` (GM human tab → sidecar only) carries the agent list. It is never broadcast and never sent
  sidecar → client.
- `bridge:invoke` gains `actAs?`, `dryRun?`, `requestId`, and `code` + `sha256` for agent-saved scripts (if D21).

### 4.6 Risk gates (D8)

World-scope settings, `restricted: true` (GM only), `config: true`, all default `false`:

| Gate | Unlocks | Notes |
|---|---|---|
| `allowMacroExecution` | `execute_macro`; any write that sets a Macro's `command`, changes a Macro's `type` to script, or writes an Adventure's stored `macros` | Arbitrary code; see the known limit below |
| `allowDelete` | `delete_documents` | Irreversible; `dryRun` previews; Claude Code `ask` rules are a second layer |
| `allowReplace` | `replace_document` | Overwrites the document; omitted fields reset to defaults |
| `allowUndo` | `undo_last` | Replays inverse operations; each inverse also passes its original category gate |
| `allowPackDeletion` | `delete_pack` | Removes pack files through the Foundry server; always prompts (D30) |
| `allowUserWrites` | Create/update/delete of `User` documents (incl. role) | Password fields always refused |
| `allowSettingWrites` | `Setting` documents and world/user settings via skills | `wiretap.*` always refused |
| `allowFileUpload` | Base64 data in `FilePathField`s; file upload tool | Server also requires `FILES_UPLOAD` (READ `dist/database/sanitization.mjs`) |
| `allowOwnershipWrites` | Writes to `ownership` | Escalation-capable |
| `allowCompendiumWrites` | Writes into compendium packs | Escalation-capable |
| `allowModuleConfigWrites` | `core.moduleConfiguration` | Escalation-capable |
| `allowedPluginModules` | Plugin skills and scripts per module id | Default: none enabled |
| `allowSidecarPlugins` | Sidecar (Node) handlers of plugins the GM enables by id | Arbitrary Node code outside the browser; default OFF; see the known limit below |
| `allowAgentScripts` |, `disable_script`, running agent-saved scripts | Only with D21 option (b); arbitrary-code caveat |


**Risky-operation rule (D8).** Any tool, option or capability that is irreversible, overwrites data, runs arbitrary code, escalates privilege or ownership, removes files, exposes the sidecar externally or stores world data at rest has a world-scope `restricted` setting, default OFF, with a label and hint in `lang/en.json`, enforced on the executing client by `requireGate`. A milestone that adds such an operation adds its gate in the same milestone, and a test fails when a mutating script of a risky class declares no gate. Operations that only read, or write ordinary document data that a later `update_documents` can restore, need no gate.

**Hard rule.** No skill can change a gate. Enforcement:

1. Every write path refuses any `Setting` whose key starts with `wiretap.`, whatever the gate state. This covers the
   generic CRUD path (incl. path-scoped writes and deletes), the settings skills, batch, replace, scripts'
   `ctx.core.*`.
2. Gates are read only from `game.settings` on the executing client; params never carry a gate value.
3. Tests assert each path refuses `wiretap.*`.

**Known limit (INFERRED, stated in the UI hint).** Any arbitrary-code capability (`allowMacroExecution`,
`allowAgentScripts`, `allowSidecarPlugins`, any enabled plugin module) can call `game.settings.set` directly. When a GM enables one, the
guarantee is reduced to "no core skill can change a gate".

### 4.7 Trust boundaries

- **Default (D6):** both ports on `127.0.0.1`, no tokens. Any local process is trusted. This includes claiming a GM
  endpoint and receiving invocations (READ `server/foundryBridge.ts:40-44`), and calling any MCP tool without passing
  through Claude Code's permission system (§2.5 item 1).
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
- **Handles** hold world data scoped to the MCP session that created them: in sidecar memory by default, in a protected file only when `persistHandles` is on (D32).

### 4.8 Test-data cleanup pattern (adopted from TITAN, READ)

TITAN (`Data/systems/titan/tests/e2e/`) removes its e2e documents through Foundry document calls, never by touching
files:

- **Running list.** Every flow that creates a document records `{documentName, id, parent, packId?, sceneId?,
  createdBy}` in `test/state/registry.json` (READ `registry.js:5-20`, `record` at `:130`). The file outlives a spec,
  a reload and the worker process; it is overwritten, never deleted (READ `global-teardown.js:237-240`).
- **Teardown order** (READ `global-teardown.js:20-117`): tokens first (`token.parent.deleteEmbeddedDocuments`), then
  other embedded documents, world documents (`document.delete()`), folders, and last world compendia (unlocked, then
  `pack.deleteCompendium()`); chat messages since the run start via `ChatMessage.deleteDocuments(ids)` (`:150-155`);
  world settings restored to their recorded prior values.
- **Safety net.** A census counts `E2E `-prefixed documents of every world kind plus all combats, tokens whose actor
  does not resolve, and the E2E users' broken hotbar entries; a sweep deletes them (READ `census.js:5-35`,
  `:137-200`). The run **fails** if the sweep found anything the list did not record, or if the census is not zero
  (READ `global-teardown.js:250-260`).
- **World guard.** Census and sweep throw unless the page is in world `test-titan` (READ `census.js:21-35`).
- **Crash recovery.** `global-setup.js` tears down a list that a crashed run left before starting (READ
  `global-setup.js`, first lines of `globalSetup`).

Wiretap adopts the same pattern for its e2e suite, with its own prefix `Wiretap E2E ` (it does not start with
`E2E `, so TITAN's sweep never touches Wiretap documents and TITAN's documents never match Wiretap's census). The
running list is `test/state/registry.json`, gitignored and overwritten, never deleted. Constraint (READ `census.js:91-96,158-162`): TITAN's sweep deletes **every** combat and every
orphan token in `test-titan` and fails its run when it does; Wiretap tests must therefore not leave
combats or orphan tokens in that world, and must not run concurrently with a TITAN e2e run. The Wiretap e2e users
include `E2E GM 1` (READ `tests/e2e/users.js:2`); INFERRED: the same world.

## 5. Milestones

Every milestone follows `.claude/claude.md`:

- Consent at the start for any architecture, dependency, layout, naming or public-API choice it introduces.
- No backwards compatibility: replaced tools, events and formats are removed in the same milestone; no aliases or
  migrations.
- TDD.
- 120-column formatting, typed and commented declarations.
- No stubs.
- No file deletion in product or test code (no `fs.rm*`/`unlink*`/`rmdir*`, no recursive removal helpers): tests
  write under `test/tmp/` or mock `node:fs`. Foundry **documents** may be deleted through Foundry document calls
  (D12); test documents are cleaned up with the §4.8 pattern.
- e2e in-page waits ≤ 1000 ms.
- No dynamic imports in shipping builds.
- Implementation via `wiretap-coder` (sidecar, shared, tests) or `foundry-module-dev` (client `.js`/`.svelte`), then
  `wiretap-spec-reviewer` → `wiretap-code-reviewer`. `buddy-checking` for M9, M10, M16 (security or
  protocol).
- **Context-budget criterion (required, D17):** each milestone states one; from M13 on, every tool and result it adds
  is covered by the M13 budget test, and a budget breach fails the milestone. A budget is raised only by the user.
- **Final step (required): docs + `wiretap-*` skills + `graphify update .`**:
  - Update `docs/TODO.md`, `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md` and README as touched.
  - Update every `wiretap-*` skill whose paths changed, describing the current state; skills that reference MCP tools
    (§2.7) are updated with the tools.
  - Run `graphify update .`.
  - Commit each logical unit.

Test tiers:

- **Unit:** vitest with Foundry mocks in `tests/setup.js` (happy-dom: no layout, so DOM sizes are mocked).
- **Integration:** a real sidecar plus a **fake GM client** (`socket.io-client` answering `bridge:invoke` /
  `bridge:registry`) plus the SDK MCP client over Streamable HTTP.
- **Context budget (M13):** byte budgets over the real tool list and over representative results (synthetic
  fixtures), in CI.
- **Live e2e:** Playwright against Foundry on `:30000`, only where real Foundry behaviour is the subject; documents
  recorded and torn down per §4.8.

**Order:** M5 → M6 → M17 → M18 → M15a → M7 → M20 → M16 (if D21) → M8 → M9 → M15b → M10 → M19 → M12. M11 is dropped (D27).

### M5 — Core write tools

**Goal:** `create_documents`, `update_documents` (§2.8 path grammar incl. embedded paths and `op`),
`replace_document` (§4.4, hooks fire), `delete_documents` (D12; gate per D12a), `batch`
(`foundry.documents.modifyBatch`: validated first, **not atomic**, READ `server-backend.mjs` `#r`), `dryRun`
everywhere, advisory `actAs`. All registered as M14 scripts. `create_actor` is removed in this milestone, with its
tests and skill text (D16). **Depends on:** M2, M4. **In:**

- Gated `User`/`Setting`/file/ownership writes and deletes.
- Validation failures returned via `DataModelValidationError.getAllFailures()` (READ
  `common/data/validation-failure.mjs:374`), capped per the M1 error contract.
- Ack-only results `{uuid, changed[]}`; optional `paths` read back on the ack.
- `create_documents` and `replace_document` accept a handle instead of inline data.
- `delete_documents` `dryRun` returns `[uuid, name, type]` of what would be deleted, including embedded cascades.
- Optional idempotency key stored as a module flag.

**Out:** raw socket (M11); compendium pack deletion (not exposed, §9). **Tests:**

- Unit per op: happy path, validation failure, gate off/on, `wiretap.*` deny, `actAs` denial, ack shape, path
  grouping into `updateEmbeddedDocuments`, `op: replace|delete` → `_replace`/`_del`.
- Integration: fake client.
- e2e: create/update (incl. an embedded path)/replace/delete a test Actor with an embedded Item and an ActiveEffect;
  assert a `preUpdateActor` hook fired on replace; every created document is on the §4.8 running list.

**Acceptance:** every write path has the deny test; `create_actor` no longer exists anywhere in code, tests, README
or skills. **Context budget:** ack ≤ 256 B per document; a 50-document `batch` ack ≤ 4 KB; a validation error with 30
failures ≤ 512 B; `delete_documents` `dryRun` within the hard cap. **Risks:** batch partial commits (documented in
the tool description); irreversible deletes (D12a, `dryRun`).

### M6 — Sheets and gameplay

**Goal:**

- `open_sheet(uuid, userId?)`, a normal (`api`) tool: with `userId`, via the `wiretap.openSheet` user query on that
  connected user's client; without it, a local render on the client running the call. It never broadcasts. The query
  handler checks that the sender is a GM and that the target has OBSERVER.
- `close_sheet(uuid, userId?)`, the same way: with `userId`, via the `wiretap.closeSheet` user query on that user's
  client (the handler checks that the sender is a GM); without it, on the client running the call.
- `roll(formula, toChat=false)`.
- `draw_table(uuid, toChat?)`, `toChat` default false.
- `execute_macro(uuid, actorUuid?, tokenUuid?)` (gate `allowMacroExecution`): `actorUuid` and `tokenUuid` name the
  Actor and the Token (on the scene the executing client views) the macro acts on.
- A write that sets a Macro's `command` (create, update, replace or batch) also needs `allowMacroExecution`: the
  command is code that runs when a user executes the macro. So do an update that changes a Macro's `type` to script
  (stored text becomes code) and a write of an Adventure's stored `macros` (importing it creates them).

`undo_last` is built once, in M17. All as M14 scripts. `screenshot` is in M15b (it needs the agent runner). **Depends on:** M2, M5, M14. **Tests:** unit
(query handler checks); integration; e2e with a GM tab and a `wtx-player` context: the sheet opens on the player
client only with permission; an offline user gives a clear error (READ `user.mjs:306`); rolls with `toChat: true`
are recorded and torn down (§4.8). **Acceptance:** open-sheet semantics documented: on a chosen live user's client;
with no human connected, only data or measurements. **Context budget:** `open_sheet` / `close_sheet` ≤ 128 B; `roll`
≤ 512 B; `draw_table` ≤ 1 KB; `execute_macro` results pass the hard cap. **Risks:** ChatMessage spam from rolls.
Tool option `toChat` default false.

### M17 — Multi-step undo history

**Goal:** D29. `undo_last(n?)` undoes up to `n` (default 1, max 50) of the session's recorded writes, newest first.
**Depends on:** M5. **In:**

- A bounded per-session ring (50 steps) recording an inverse for each write: create → delete of the created uuids;
  update → the prior values of exactly the changed paths; delete → the canonical export (§4.4, `keepId: true`)
  re-created with the same ids; replace → the prior canonical export; batch → one step holding its operations' inverses.
- `User` and `Setting` writes, and operations whose inverse is no longer applicable (the target changed since), are not
  undone; the result lists each step as `undone`, `skipped` with a reason, or `failed`.
- `dryRun` lists the steps that would be undone. `undo_last` needs `allowUndo` (D12a); every inverse still passes the write
  guard of the original category.
- The ring lives in the executing client's memory; large step payloads go to the sidecar handle store.

**Tests:** unit per op kind (inverse correctness, ordering, skip on drift, ring bound); integration with the fake
client; e2e on a throwaway Actor: create → update → replace → delete, then undo all four. **Acceptance:** the Actor is
back to its pre-create state apart from documented non-reversible side effects. **Context budget:** the result ≤ 256 B
per step and ≤ 4 KB for 50. **Risks:** hooks and system side effects are not reverted; the tool description says so.

### M18 — Compendium pack tools

**Goal:** D30. `create_pack(label, type, name?)` and `delete_pack(id)` for world packs, `dryRun` on both.
**Depends on:** M5. **In:**

- Pack creation through Foundry's compendium creation call; deletion through `CompendiumCollection#deleteCompendium`
  after unlocking; `create_pack` behind `allowCompendiumWrites`, `delete_pack` behind `allowPackDeletion`; both refused for system and module packs.
- `delete_pack` always prompts the human, at every Claude Code permission level: the tool carries
  `_meta["anthropic/requiresUserInteraction"]: true` (§2.5 safeguard 2), which needs a tool-level `_meta` field in the
  script definition and its registry mapping. A test asserts the annotation is present and cannot be removed by a
  plugin or setting. The prompt is enforced by Claude Code, so a non-Claude client or local process is not prompted
  (§2.5 residual risk); the gate stays the Wiretap-side control.
- `dryRun` lists the pack and its document count; the tool description states that deletion is irreversible.
- Wiretap code never touches pack files; the Foundry server does (READ the server path at the milestone start).

**Tests:** unit with mocked collections (gate off/on, system pack refusal, dryRun no-write); e2e on a throwaway world
pack created and deleted through the tools, recorded on the §4.8 list. **Acceptance:** no file-deletion API in Wiretap
code (the source grep test is unchanged). **Context budget:** ack ≤ 256 B. **Risks:** deleting a pack with content the
user wants; `dryRun` and the always-on prompt are the guard.

### M15a — Script library: API and composite scripts

**Goal:** the `api` rows of §2.9 not built in M4–M6. **Depends on:** M5, M6, M13, M14. **In:** `add_embedded`,
`diff_since`, `export_to_handle`, `read_handle`, `import_from_handle`, `build_actor`, `copy_document`. **Consent at
start:** the catalogue (names are public API).

**Tests:** unit per script with mocked `game` (happy path, validation, gate, budget fixture); integration through the
fake client, including `copy_document` with a 100 KB synthetic source (the body never appears in any MCP message,
asserted on the SDK client's received payloads); e2e on titan: `build_actor` with 3 items and 1 effect from recorded
`Wiretap E2E ` data, torn down per §4.8. **Acceptance:** every §2.9 `api` script callable end to end. **Context
budget:** each result within its §2.9 budget in integration and e2e; `build_actor` uses one call where the
generic-tools path uses ≥ 5, demonstrated by an integration test counting `tools/call` requests for both paths.
**Risks:** composite scripts hide partial failure → the ack lists every created uuid and the first failure.

### M7 — Plugin skill API

**Goal:** D9/D10. **Depends on:** M3, M5, M14. **In:**

- `api.apiVersion` (integer).
- `api.registerSkill({name, description, inputSchema, handler, mutates})` and `api.registerScript(...)` (same
  registry; scripts add `requires` and `result.budgetBytes`, default budget = §2.6 compact).
- `Hooks.callAll('wiretap.registerSkills', api)` at Wiretap `ready`.
- Name sanitising to `<moduleId>__<skill>` (module id dots → refuse; any `.` refused; ≤ 64 chars).
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

**Deliverables:** README plugin-author guide (including the budgets and how to reference tools from a skill);
example spell-text → Item plugin under `examples/` (not shipped). The LLM parses; the handler maps deterministically
and uses `dryRun` first. **Acceptance:** fixture plugin works end to end; a disabled module's tools disappear after
reload. **Context budget:** plugin definitions and results are under the same §2.6 budgets as shipped scripts (tests
above). **Risks:** load-order assumptions. Mitigation: the hook fires at `ready`, after all esmodules have executed
(INFERRED; e2e asserts it).

### M16 — Agent-saved scripts (only if D21 builds them)

**Goal:** §2.5 per the chosen option, no file or entry deletion. **Depends on:** M2, M7, M14. **Consent at start:**
D21 option, `.wiretap/agent-scripts.json`, gate `allowAgentScripts` (option b). **In (option b; option a omits items
marked b):**

- `save_script` (b: gated, `_meta["anthropic/requiresUserInteraction"]: true`) and `disable_script`; tool names
  `agent__<name>`.
- `server/agentScripts.ts`: overwrite-only JSON store (0o600, symlink refusal like `mcpConfigFile.ts`), versions,
  `enabled` flag, 8 KB per-script code cap, total-size cap.
- Client execution: (b) gate check, `sha256` verification, `AsyncFunction` with `ctx`.
- README: the permission model, including the residual risks of §2.5 and example `ask` rules.

**Tests:** unit (store writer under `test/tmp/`; hash mismatch refused; disabled refused; no file-deletion API in the
module, asserted by a source grep test; (b) `requiresUserInteraction` present on `save_script`); integration (saved
script appears via `list_changed` and runs; (b) gate OFF → refused with a ≤ 256 B error); e2e (save → call → disable
→ the tool disappears). **Acceptance:** each invariant of the chosen option has a test. **Context budget:**
`save_script` ack ≤ 256 B; the saved script's code is never echoed back in any result; saved scripts obey §2.6 like
plugin scripts. **Risks:** §2.5 residual risks of the chosen option.

### M8 — Agent users and credentials

**Goal:** D3. **Depends on:** M1; uses M10's token when external. **In:**

- Client-scope setting `agentUsers` with a settings menu (ApplicationV2 form, `foundry-module-dev`) on GM clients:
  a user picker limited to non-human-assigned users plus a password field. The form shows each user's role and warns
  when it is not ASSISTANT (D4: a GAMEMASTER agent competes with humans for `activeGM`; a PLAYER or TRUSTED agent
  cannot run GM ops) and when the user has no password (P1: anonymous `/join` lists every user name).
- `bridge:credentials` push.
- `server/agentCredentials.ts` writes `.wiretap/agents.json` (0o600, symlink refusal, overwrite only, same pattern
  as `mcpConfigFile.ts`).
- Env provisioning `WIRETAP_AGENT_CREDENTIALS_FILE` (path to the same JSON shape); env wins over the stored file.
- Removing an agent = overwrite without it. Never a file delete.

**Tests:**

- Unit: file writer under `test/tmp/` with unique roots; refusal of symlinks; no echo of passwords in logs (logger
  mock).
- Integration: push → file contents; no event ever carries passwords sidecar → client (assert on all emitted
  payloads).

**Acceptance:** passwords absent from every log line and MCP result (tests). **Context budget:** no new MCP tool;
the M13 tool-count snapshot is unchanged. **Risks:** plaintext in the GM's `localStorage` (§4.7); documented.

### M9 — Headless agent runner

**Goal:** seatless operation on a headless server (D2), and the DOM endpoint for `dom` scripts.  **Depends on:** M1 (identify acknowledgement), M8. **New runtime dependency:** `playwright-core`
(consent at start). Browser via `WIRETAP_BROWSER_PATH` / sidecar config; no auto-download in product code. **In:**

- **Default profile (D2):** `chromium_headless_shell` (Playwright build 1223 measured), `core.noCanvas` on, set per
  context before the page loads (M0 used a localStorage init script; MEASURED to take effect). A drawn canvas costs
  ≈ 6 cores idle on the shell (E3), so canvas-on is never a default and is not offered without a measured need.
- One browser, one context per agent user (an ASSISTANT user, D4), a fixed viewport (M0 used 1920×1080) so
  measurements are reproducible.
- `/join` login, then wait for `game.ready` (boot is exempt from the 1000 ms rule).
- Identify with `kind: agent`, `dom: true`; **the agent is reported ready only after the sidecar acknowledges the
  identify** (M1). E3 and E7: a call made after identify was sent but before it completed failed with `No Foundry GM
  client connected`; identify travels over Engine.IO polling about 100 ms before the websocket upgrade.
- **Restart recovery (E7):** after a Foundry restart the page's socket reconnects (17.4 s in E7, bounded by the
  restart) and Foundry then redirects the page to `/join`; it never recovers on its own and the bridge does not
  re-identify. The runner watches for the `/join` navigation (and for a closed Foundry socket that stays closed),
  discards the context, logs in again with stored credentials in a fresh context, and waits for the identify
  acknowledgement. While recovering, the endpoint is marked unavailable so the router falls back (D5) or returns a
  ≤ 256 B "agent reconnecting" error.
- Region capture API for `screenshot` (page clip by a client-supplied rectangle, downscaled to the cap).
- Supervision with backoff on browser crash.
- `--agents` CLI flag / `WIRETAP_AGENTS=on`.
- Status in startup log and `list_endpoints` tool.

**Resource and recovery budgets** are the M0 E3 and E7 results (`docs/experiments/2026-10-m0-results.md`): launch to ready 1.8 s, 438.7 MB working set and 18.2 % of one core idle per agent on the headless shell build; recovery by fresh login after a Foundry restart in about 8 s warm.

**Tests:** unit (supervisor state machine with a fake launcher: login, identify-ack wait, `/join` redirect →
re-login, crash → backoff; capture downscaling); integration (fake launcher + fake client identify; a call during
identify gets the reconnecting error, not a wrong route); e2e (real launch as an ASSISTANT test user, identify,
`create_documents` round-trip with §4.8 teardown; a Foundry restart through the launcher → the agent re-identifies
without a human). **Acceptance:** the restart e2e passes; the agent's measured idle cost on the CI host is recorded
and within 1.5× the E3 medians or reported to the user. **Context budget:** `list_endpoints` ≤ 1 KB with two agents
and one human; capture output never exceeds the §2.6 pixel cap (unit); the reconnecting error ≤ 256 B. **Risks:**
RAM/CPU on small servers (E3 numbers are from one fast desktop host); with no GAMEMASTER online the agent becomes the
active GM and runs `activeGM` automation headless (D4).

### M15b — Script library: DOM scripts

**Goal:** the `dom` rows of §2.9: `element_size`, `sheet_layout`, `inspect_sheet`, `screenshot`. **Depends on:** M6, M9, M14. E9 input: offscreen sheets render headless with
`core.noCanvas` (actor 850×925 in 50 ms on the shell, item 700×650); the depth-2 `sheet_layout` prototype (401–441 B)
reached only the window header and content wrappers, so this milestone measures depths 3–6 on titan sheets and sets
the default depth to the shallowest that reaches the sheet's own parts within 4 KB. **In:** `ctx.dom`
(render-and-wait for the app's `rendered` state, READ `application.mjs:367`; rect and overflow reads; layout walk with
`maxNodes`); `screenshot` via the M9 capture API.

**Tests:** unit with mocked rects (happy-dom has no layout); integration with a fake DOM endpoint; e2e on the agent
endpoint against titan actor and item sheets: sizes are non-zero and stable across two runs; `inspect_sheet` equals
`open_sheet` + k × `element_size` + `close_sheet`. **Acceptance:** all §2.9 `dom` scripts work on the agent
endpoint; on a human-only setup they return the D25 error. **Context budget:** `element_size` ≤ 256 B,
`sheet_layout` ≤ 4 KB, `inspect_sheet` ≤ 2 KB, screenshot within the §2.6 default (D28), one image; e2e asserts
each. **Risks:**
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
Information exposure (MEASURED (coord.) M0 P1): Foundry's own anonymous session (`GET /join` cookie, no login)
receives the full user list with names and roles via `getJoinData`; agent user names are therefore visible to anyone
who can reach Foundry. The README's external-mode section says so and requires passwords on agent users (Wiretap's
external mode exposes the sidecar, not Foundry; Foundry's exposure is the GM's own configuration).

### M19 — Persistent handles

**Goal:** D32. **Depends on:** M13, M3. **In:**

- World-scope `restricted` setting `persistHandles` (default OFF); the sidecar learns it from the gate snapshot.
- A protected file under `.wiretap/` (0o600, symlink refusal, overwrite-only like `mcpConfigFile.ts`); entries keep the
  64 MB total, per-entry and 30 minute idle bounds, and expired entries are overwritten, never deleted.
- The at-rest protection (key handling) is specified in the first task of the milestone and approved before code.
- A restarted sidecar rebinds handles to a session by a stable owner token the client presents; a foreign owner reads
  nothing.

**Tests:** unit (round trip, bounds, symlink refusal, no deletion API), integration (restart keeps a handle readable by
its owner only). **Acceptance:** behaviour is unchanged with the setting OFF. **Context budget:** unchanged (handles
≤ 256 B). **Risks:** world data at rest; documented in the README.

### M20 — Sidecar plugins

**Goal:** D31. **Depends on:** M7, M2. **In:**

- A sidecar plugin directory; each plugin id is enabled by the GM through `allowSidecarPlugins` (a list, default empty).
- Node handlers register scripts into the same registry (`requires: 'none'`, or calling `ctx.core.*` through the client
  path); definitions obey the §2.6 budgets; names are `<pluginId>__<script>`.
- Handlers never receive gate values; gated categories still pass the client write guard.

**Tests:** unit (enablement, budget refusal, name rules); integration (a fixture plugin end to end, a disabled plugin
absent); the §4.6 hard-rule test for the new gate. **Acceptance:** disabling a plugin removes its tools without
restarting Foundry. **Context budget:** plugin definitions and results obey §2.6. **Risks:** arbitrary Node code (the
known limit of §4.6); the gate hint says so.

### M12 — Live e2e matrix and documentation

**Goal:** end-to-end coverage for human-tab, agent and (if any) raw endpoints. Close the related `docs/TODO.md` entries
(live bridge e2e, auto-wiring e2e). Final README, including a "Context budget" section with §2.6 and the permission
guidance of §2.5. **Depends on:** M6, M7, M9, M15a, M15b (and M10/M16 if built). **Acceptance:** full `npm test`,
`npm run typecheck`, `npm run eslint`, `npm run test:e2e` green with output reported; the Wiretap census (§4.8) is
zero after the run. **Context budget:** the e2e matrix asserts the §2.6 budget of every tool's live result on titan;
`tests/measure/measureContext.mjs` re-run against the real sidecar and recorded next to §2.1.

## 6. New skills and agents (core skill rule 3)

Evaluate at the end of the named milestone:

- `wiretap-plugin-api` (`src/bridge/skills.js`, `examples/**`): at M7, since it is a public API with a separate
  audience.
- `wiretap-agents` (`server/agentRunner.ts`, `server/agentCredentials.ts`): at M9, a new subsystem.
- Matching `-coder` / `-code-reviewer` agent variants only if those domains need specialised context.

Each creation also updates the subsystem table in `wiretap-codebase-core` and the skill list in `.claude/claude.md`.

## 7. Risks and open questions

- **The Foundry server accepts invalid `system` data over a raw socket** (MEASURED (coord.) M0 E2): wrong types and
  non-integers in integer fields are stored as sent, and a raw create with invalid `system` produces a document that
  live clients never show and a fresh load lists in `invalidDocumentIds`. Any GM-authenticated socket can do this, not
  only Wiretap. Wiretap never writes over B (D1), and its client path validates through the system DataModels.
- **Foundry server error noise** (MEASURED (coord.) M0): each rejected `modifyDocument` logs `TypeError: Cannot read
  properties of undefined (reading 'length')` in the server log (140 lines during M0); the caller still gets its
  reply. Log readers and e2e log assertions must not treat it as a Wiretap failure; it is a Foundry defect, not
  Wiretap's.
- **Anonymous user listing** (MEASURED (coord.) M0 P1): a session from `GET /join` without login receives every user's
  name and role. Relevant to M10 external guidance (agent users need passwords and neutral names).
- **Active GM with only the agent online** (MEASURED (coord.) M0 E4): an ASSISTANT agent becomes `activeGM` when no
  GAMEMASTER is online and runs `activeGM`-gated automation headless with `core.noCanvas` on; whether titan or other
  modules' automation needs the canvas is not measured. A GAMEMASTER agent would compete with humans by id order.
- **Runner recovery is login, not reconnect** (MEASURED (coord.) M0 E7): Foundry's restart drops sessions and sends
  the page to `/join`; any runner that only waits for a socket reconnect stays offline.
- `modifyBatch` is not atomic; users may assume transactions.
- Document deletes are irreversible apart from backups; `dryRun` and Claude Code `ask` rules are the guard (D12a).
- The arbitrary-code capabilities weaken the gate hard rule (§4.6), including agent-saved scripts (§2.5 S7).
- Claude Code permissions protect only calls made through Claude Code; loopback callers bypass them (§2.5).
- Elicitation is declared by Claude Code but untested. Not used.
- Dev `options.json` has `upnp: true` (READ). INFERRED: Foundry `:30000` may be reachable externally. Agent users must
  have passwords.
- Context measurements are single runs on one model's tokenizer (`claude-haiku-5-5`); other models may count
  differently. Byte budgets plus the recalibration script contain this.
- Claude Code's deferral, inline-result cap and `_meta` annotations are client behaviour that can change between
  versions (MEASURED (coord.) on 2.1.296; docs READ). The budgets do not depend on deferral; the
  per-script-tool exposure (D18) and D21 option (b) do.
- Script catalogue sprawl raises the always-listed name cost (≈13 tokens per tool); the ≤ 30 cap forces review.
- Shared `test-titan` world with TITAN e2e (§4.8): leftover combats or orphan tokens fail TITAN's run.

## 8. Out of scope / deferred (each logged in `docs/TODO.md`)

- MCP stdio transport; MCP sampling (unsupported by Claude Code, MEASURED (coord.)).
- Offline LevelDB/compendium writes while the world is stopped; a Foundry REST layer.
- True per-user execution for non-agent users via `User#query` (`actAs` stays advisory).
- Rate limiting / quotas per MCP session.
- Structured chat UI (existing TODO).
- Dispatcher exposure mode (D19; already in `docs/TODO.md`).

## 9. Open questions

- **Credential push in loopback mode.** The socket is unauthenticated by D6 and authenticated only in external mode
  (M10), so the credential push is protected only by the loopback trust assumption in the default mode.
- **Agent-saved script store growth.** No file or entry deletion is allowed, so `.wiretap/agent-scripts.json` only grows
  with versions; a total-size cap refuses new saves instead of pruning. Clearing it is a manual user action outside
  Wiretap.
- **Scripts as code execution.** Agent-saved scripts are arbitrary GM-authority code; the residual risk of §2.5 option
  (b) is stated there and is not removed by it.
