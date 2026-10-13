# Wiretap plan: document skills for every type, plugin skills, seatless agents

Forward-looking plan and design reference: goals, the context-budget design, decisions, architecture, risk gates,
milestone specifications, new skills and agents, risks and deferrals. Work history (milestone completion, results,
deviations, calibration measurements and the revision history) is in [`docs/PROGRESS.md`](PROGRESS.md). The
documentation index is [`docs/README.md`](README.md).

Evidence labels: **MEASURED** (command or run named), **READ** (source location named), **INFERRED** (not verified; alternatives not excluded). "MEASURED (coord.)"
= measured by the coordinator's experiment agents in the planning session (claude 2.1.296), not by the user. Paths
under `foundry/` are relative to `C:\FoundryVTT\V14\dev\foundry\` (v14 stable, build 364, READ `package.json`).

**Project rule in force: no backwards compatibility** (READ `.claude/claude.md:25`). Wiretap is unpublished; tools,
APIs, settings, protocol events and file formats are renamed, reshaped or removed when the design calls for it. No
aliases, shims, deprecation paths or migrations appear anywhere in this plan.

## 1. Context and goals

Wiretap at the plan baseline (HEAD `048df55`, before M1; the line citations below describe that snapshot, and M1
replaced `invokeOnGM` and the first-socket routing with the endpoint registry and router): one MCP tool,
`create_actor`. The request path was MCP HTTP (`127.0.0.1:31417/mcp`, stateless; a new
`McpServer` is built per request, READ `server/mcp.ts:95-100`) → `bridge.invokeOnGM` (first identified GM socket, READ
`server/foundryBridge.ts:57-76`) → Socket.IO `bridge:invoke` → `OP_HANDLERS` on a GM browser client (READ
`src/bridge/foundryBridge.js:25-27`). Socket.IO is bound to `127.0.0.1` (READ `server/server.ts:30`). Identify trusts
the client's `isGM` claim (READ `server/foundryBridge.ts:40-44`).

Goals:

- **G0 Minimal context use (TOP PRIORITY, cross-cutting).** Every tool definition, argument, result, image and error
  is budgeted (§2). It overrides convenience in every milestone.
- **G1 Core skills for every document type.** Read (whole, projected or path-scoped), create, update, replace and
  delete (D12) for all v14 primary and embedded types (READ `foundry/common/constants.mjs:332-424`), compendium
  content, open a sheet, rolls and table draws.
- **G2 Plugin skills.** Modules that depend on Wiretap register their own MCP tools; handlers run in the Foundry
  client.
- **G3 No human seat.** Skills work when no human has a GM tab open, on a headless server.

What "no seat" means (READ, see §4.3): a Foundry *client* must still run for anything that needs system or module
code, sheets, derived data or plugin handlers. The seat is taken by a headless agent browser, not by a human. A
raw-socket path without any client is possible but bypasses all client-side logic; M0 certified it for reads of stored
source data only (D1), and whether to build it at all is D27.

## 2. Context budget: top priority

**Requirement (user, 2026-10-10, D17):** minimising the MCP client's context use is a huge priority. "Context" = the
agent's context window: tool definitions, call arguments, tool results, screenshots/images and error text. The user
proposed pre-written scripts for actions such as opening a sheet, measuring an element and making an edit (adopted,
D18). Every milestone carries a context-budget acceptance criterion; M13's automated test enforces the budgets in
§2.6.

### 2.1 Measured cost model

**Method (MEASURED (coord.), 2026-10-10).** A throwaway loopback MCP server in the session scratchpad (raw
JSON-Schema tools, canned results, `@modelcontextprotocol/sdk` 1.29.0 from the repo's `node_modules`, stateless like
`server/mcp.ts`) was driven by `claude -p --model haiku --output-format stream-json --verbose --strict-mcp-config
--mcp-config <cfg>` (claude 2.1.296; the run reports model `claude-haiku-5-5`). Six invocations (R1–R6). Context per
turn = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of each assistant message; the delta
between consecutive turns = the previous `tool_use` block plus its result. Payloads came from real dnd5e pack sources
(`Data/systems/dnd5e/packs/_source`, YAML → minified JSON) as a stand-in for a canonical actor export; titan exports
were not measured (M0 E9). Each figure is one run; token counts depend on input only, but only this one model's
tokenizer was measured.

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

Byte sizes of the sources (MEASURED (coord.), `payloads.mjs` in the scratchpad): dnd5e heroes min/median/max 56,966 /
84,564 / 118,811 bytes; dnd5e `monsters/humanoid` 8,587 / 18,343 / 85,190 bytes. Drafted core tool definitions:
170–787 bytes each, 5,729 bytes for 13.

Path-scoped slices of the same two documents (MEASURED (coord.) 2026-10-11, `pathsizes.mjs`, bytes of minified JSON;
tokens ≈ bytes / 2, INFERRED from the ratio below):

| Path | Median hero | Median monster |
|---|---|---|
| (whole document) | 84,564 | 18,343 |
| `items` | 77,115 (91 %) | 12,247 (67 %) |
| `system` | 5,817 | 4,522 |
| `system.skills` | 1,981 | 1,981 |
| `system.attributes` | 696 | 641 |
| `system.abilities` | 468 | 468 |
| `system.attributes.hp` | 86 | 62 |
| `prototypeToken` | 1,149 | 1,135 |
| One embedded item, median of the actor's items | 2,113 (31 items, max 17,615) | 1,756 (7 items) |

**Shipped-surface calibration table (MEASURED 2026-10-11, `npx tsx tests/measure/measureContext.mjs`):** moved to
[`docs/PROGRESS.md`](PROGRESS.md) (section "M13 calibration"); the budgets it is held to are §2.6.

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

### 2.3 Verdict on the user's script proposal (D18, DECIDED)

The user's proposal is adopted with these modifications (agreed by the user 2026-10-11):

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
interactive session re-fetches the list on `list_changed`; `-p` and the Agent SDK refresh the tool list. M3 result
(MEASURED, `docs/experiments/2026-10-m3-results.md`, claude 2.1.296, `-p`): a tool added by `list_changed` is deferred
like the initial ones (found through `ToolSearch`, callable in the same session); one late tool added a composite 98
tokens to the context against about 13 for a tool present at session start; the composite is not isolated into the name
and the announcement wording.

### 2.5 Agent-saved scripts and Claude Code permissions (D21, DECIDED: option (b))

**The user's position (2026-10-11):** agent-authored scripts should be governed by "whatever allow permission is set
to match normal Claude Code operations", i.e. Claude Code's own allow/ask/deny rules and permission modes, instead of
a separate approval in the Foundry UI.

**What Claude Code's permission system does for MCP tools (READ `code.claude.com/docs/en/permissions` and
`/docs/en/mcp`, fetched 2026-10-11):**

- Rules name a server or a tool: `mcp__wiretap`, `mcp__wiretap__*`, `mcp__wiretap__<tool>`; allow globs work only
  after a literal `mcp__<server>__` prefix (`mcp__github__get_*` matches its `get_` tools).
- Evaluation order is deny → ask → allow; a matching ask rule prompts even when an allow rule also matches.
- Settings-file rules cannot match MCP tool **arguments**: "it skips any `mcp__` rule that has parentheses". Argument
  matching for MCP tools exists only as a deny rule passed with `--disallowedTools`.
- Rules are enforced by Claude Code, not by the model; PreToolUse hooks can deny or force a prompt but do not
  override deny/ask rules.
- `dontAsk` auto-denies anything that would prompt but still runs tools pre-approved by allow rules;
  `bypassPermissions` skips prompts (except a listed set of actions).
- A server can set `_meta["anthropic/requiresUserInteraction"]: true` on a tool: Claude Code then prompts on every
  call "even in `acceptEdits`, `auto`, and `bypassPermissions`", offers no "don't ask again", allow rules do not skip
  it, `dontAsk` denies it, and an `allow` from `--permission-prompt-tool` is converted to a deny (v2.1.214+).
- Not stated in the permission table that was read: how long a "don't ask again" answer lasts for an MCP tool.

**What it cannot guarantee (INFERRED from the above and from D6):**

1. **Only calls that pass through that Claude Code instance are checked.** The MCP endpoint is unauthenticated on
   loopback (D6): any local process, another MCP client, or `claude -p --allowedTools mcp__wiretap` reaches
   `save_script` with no prompt at all. `_meta` annotations are Claude-Code-specific; other clients ignore them.
2. **The human sees what was saved only if a prompt appears.** In `bypassPermissions`/`auto`, or with a server-wide
   allow rule (`mcp__wiretap`), a save is not prompted. With a prompt, the code is visible in the call arguments.
3. **A saved script persists and becomes a new tool.** Later calls are governed by whatever rule matches the new
   tool's name in each later session, on each machine; a broad allow (`mcp__wiretap__*`) auto-approves every future
   saved script. Persistence outlives the session in which the human approved the save.
4. **Self-escalation.** A saved script runs with the endpoint user's authority (GM) and can call
   `game.settings.set` on Wiretap gates (the §4.6 known limit), create macros, or save further scripts.

**Options:**

| Option | What it is | Residual risk |
|---|---|---|
| (a) As the user states | `save_script` and saved-script tools governed only by Claude Code rules and modes | Items 1–4 in full: any local process or non-Claude client can save and run GM code; bypass/auto modes save without a human; saved code persists |
| (b) (a) + minimal Wiretap safeguards **(recommended)** | (1) world gate `allowAgentScripts`, GM-only, default OFF (consistent with D8); (2) `save_script` carries `_meta["anthropic/requiresUserInteraction"]: true`, so a human sees the code on every save in every Claude Code mode; (3) saved tools are named `agent__<name>` so a user can write `ask` rules for `mcp__wiretap__agent__*`; (4) code is hash-pinned at save and verified before each run; (5) disable instead of delete | With the gate ON: a non-Claude client or local process can still save code without a human (item 1); calls of saved scripts follow normal rules (item 3); item 4 remains. Cost: one gate, one annotation, a name prefix |
| (c) Foundry-UI approval (revision 2 design) | GM approves each proposal in a Wiretap window | Strongest for other clients, but contradicts the user's stated preference and adds a UI |

**Recommendation: (b).** It follows the user's model (Claude Code permissions decide), adds one human checkpoint that
Claude Code itself enforces even in bypass mode, and keeps the facility off unless a GM opts in. Decision is the
user's.

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
which the enforcer applies at runtime (over cap → handle). Changes from revision 2 are marked †; adoption is DECIDED,
the † changes are DECIDED (accepted 2026-10-11).

| Budget | Value | Kind | Rationale |
|---|---|---|---|
| Core/shipped tool name | ≤ 32 chars † (was 40) | CI hard | Names are always in context (≈13 tokens each at ≈25 chars, MEASURED (coord.)) |
| Plugin and agent-saved tool name | ≤ 64 chars † | Registration refusal | `<moduleId>__<skill>`: module ids are outside Wiretap's control; 110-char names work (MEASURED (coord.)) |
| Definition `{name, description, inputSchema}` | ≤ 800 B | CI hard; registration refusal for plugins | Largest drafted core tool 787 B ≈ 380 tokens when loaded |
| Description | ≤ 160 chars target, ≤ 240 hard † | CI warning above 160, hard above 240 | Paid on every load; ToolSearch keyword matching needs some text (INFERRED); skills carry detail (§2.7). Claude Code truncates at 2,048 (READ docs) |
| Always-listed tools (core + shipped) | ≤ 30 | CI hard | ≈ 400 tokens of names; raising it is a user decision |
| All definitions (core + shipped) | ≤ 16 KB | CI hard | ≈ 8k tokens for a non-deferring client |
| Ack (write) | ≤ 256 B per document | CI hard | +172 measured at 84 B |
| Compact default view | ≤ 2 KB per document; embedded tuples capped at 40 plus a total count † | CI hard (synthetic fixtures) and e2e hard | 1,484 B measured with 31 tuples (≈43 B each); the cap makes the bound data-independent. **Confirmed on titan (M0 E9): max 1,574 B** |
| Projection / `paths` result | Hard cap only; ≤ 1 KB per 10 fields is the fixture target | CI warning on fixtures | Size is the agent's request; hero `system` = 5.8 KB is a legitimate request. Titan 10-field projections 199–1,224 B (E9; the 1,224 B one holds a long text leaf), consistent with warning-only |
| Search page | ≤ 4 KB, default limit 20, max 100 | CI hard | Rows `[uuid, name, type]` |
| Error | ≤ 512 B, first 10 failures + count | CI hard | — |
| Text result hard cap | **8 KB default** †, per-call `maxBytes` up to 16 KB; over cap → `{handle, bytes, summary}` | Runtime enforcer; CI hard on the behaviour | 18 KB was +8,954 tokens; 8 KB ≈ 4k tokens fits hero `system` (5.8 KB) and the median item (2.1 KB); 16 KB stays below the measured Claude Code inline lower bound (21.7 KB). Titan full actor exports are 5,738–12,492 B (E9): 3 of the 4 measured exceed 8 KB, so a full actor read returns a handle unless `maxBytes` is raised; titan items (634–1,697 B) fit |
| `sheet_layout` | ≤ 4 KB | CI hard (fixture) and e2e hard | E9 prototype at depth 2: 401–441 B, but too shallow to be useful; the default depth is set in M15b by measurement |
| Image | `screenshot` only; default ≤ 480,000 px (the 800×600 area), aspect kept ‡ (D28, DECIDED); max 1280 px longest side; one per result | CI hard (capture unit) | +972 measured at 800×600; larger sizes not measured. Titan sheets are 850×926 (actor) and 700×650 (item) (E9): the actor sheet does not fit an 800×600 box without distortion-free downscaling to 551×600, so the default is expressed as area |
| Live recalibration | `tests/measure/measureContext.mjs`, manual, ≤ 6 `claude -p` runs | Report only | Tokenizers and Claude Code behaviour change between versions |

**Counting rule.** Every byte budget counts the raw UTF-8 bytes of the text a tool returns, not the JSON-escaped bytes
of the MCP wire message: quotes, backslashes and control characters in a result are escaped on the wire, so the wire
form of a result at the cap can be larger than the cap. Runtime bounds that protect the sidecar rather than the client
context: one stored result ≤ 8,000,000 B (`HANDLE_ENTRY_MAX_BYTES`), ≤ 1,024 stored results (`HANDLE_MAX_COUNT`), each
entry accounted as the larger of its UTF-8 size and twice its character count plus 256 B inside the 64 MB total, one
image ≤ 1,000,000 base64 characters (`IMAGE_DATA_MAX_BYTES`) and `image/png` only. The 480,000 px image area is a
capture-time default, not enforced by the result enforcer.

### 2.7 Skills as the discovery layer (part of D18, DECIDED)

The user's addition: Wiretap skills may reference the MCP tools to point agents to them.

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
- **Delivery of user-facing skills** (repo directory, Claude Code plugin, or install instructions) is a layout choice
  made with consent at M14. The M13 test checks that every tool name a shipped skill mentions exists.

### 2.8 Path-scoped reads and writes (user request A; D26, DECIDED)

**Feasibility (READ).** `foundry.utils.getProperty` resolves dot paths and array indices but not embedded ids, and it
does not skip `__proto__`/`constructor`/`prototype` (only `setProperty` does) (READ
`common/utils/helpers.mjs:821-868`). v14 has explicit update operators `_replace` / `_del` (`ForcedReplacement`,
`ForcedDeletion`; READ `common/global.d.mts:6-7`, `common/abstract/data.mjs:867-874`). Wiretap therefore ships its
own small path resolver over the canonical export; writes reuse Foundry's update paths.

**Recommendation: a `paths` parameter on `get_document`, not a new tool.** Zero additional tool names (≈13 tokens
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

The revision 2 `edit(uuid, patch)` script is merged into `update_documents` (one tool fewer).

**Schema by example for a path.** `describe_schema(documentName, subtype, path)` returns the blank export's subtree
at `path` plus the field-walker constraints for that subtree (D15 scoping), so an agent can learn the shape of
`system.attributes` without the whole schema.

**Savings (INFERRED from the measured slices, §2.1):** reading `system.attributes.hp` instead of the hero export is
86 B vs 84,564 B (≈170 tokens at the floor vs an undeliverable result); `system` is 5,817 B (≈2.9k tokens) vs 84,564
B; `items.*.name` on the hero returns 31 short strings instead of 77 KB of items.

**Resolver notes (DECIDED; implemented in `shared/docPath.js`).**

- Limits: a path is at most 512 bytes and 16 segments (`PATH_LIMIT`, bytes checked first, before splitting); error
  texts stay within 256 B and never echo more than a refused segment. A `.` always splits segments, so a key
  containing a literal `.` cannot be addressed.
- Refused segments are `prototype` and every member of `Object.prototype` (`__proto__`, `constructor`, `toString`,
  `valueOf`, `__defineGetter__`, `hasOwnProperty`, ...): Foundry's `setProperty` tests for `undefined` and sees
  inherited members (`PATH_UNSAFE_SEGMENT`). Resolution itself reads own properties only.
- Reads: after an array, a canonical integer is an index and any other name is an element `_id`; when an in-range
  index and the `_id` of a different element collide, the lookup is not found. Embedded writes address documents by
  `_id` only: a purely numeric segment after the collection is `PATH_INVALID`.
- Wildcard results are keyed by the element's own string `_id`, else its index. If two resolved elements produce the
  same key, the whole wildcard lookup is not found with code `PATH_AMBIGUOUS` (no silent overwrite; `resolvePaths` lists
  the path in `missing`). An empty array under a wildcard is found as `{}`; a non-empty array where no element resolves
  is not found. Repeated read paths are read once (first kept).
- `groupWrites(patches, embeddedCollections)` returns `{ok, document, embedded}`; `embedded` is
  `[{collection, entries: [{_id, changes}]}]` with paths relative to the embedded document. `collection` is the
  collection name as written in the path (`items`); the client maps it to the document name (`Item`). It refuses a
  path that is a prefix of another patch path (`PATH_CONFLICT`), a set or replace value with an own `__proto__`,
  `constructor` or `prototype` key at any depth up to 32 levels or nested deeper than that (`PATH_UNSAFE_VALUE`), and an
  `embeddedCollections` that is not an array of strings (`PATH_INVALID`, never a throw).
- Error codes: `PATH_INVALID`, `PATH_UNSAFE_SEGMENT`, `PATH_WILDCARD_WRITE`, `PATH_LIMIT`, `PATH_INVALID_OP`,
  `PATH_DUPLICATE`, `PATH_AMBIGUOUS`, `PATH_CONFLICT`, `PATH_UNSAFE_VALUE`.

### 2.9 Script catalogue (shipped)

Budgets are the result cap in serialized bytes. "Replaces" counts the calls a generic-tools-only agent would make.

| Script | Purpose | Requires | Result budget | Gate | Replaces |
|---|---|---|---|---|---|
| `get_document(uuid, paths? \| fields? \| mode?)` | Compact view by default; path slices (§2.8); full export | api | 2 KB compact; hard cap otherwise | — | — |
| `update_documents(updates[], dryRun?)` | Path-scoped writes incl. embedded paths and `op` (§2.8) | api | 256 B ack per document | per category | read + update + re-read |
| `delete_documents(uuids[], dryRun?)` | Document deletion through Foundry document calls (D12) | api | 256 B ack; `dryRun` lists names | D12a | — |
| `open_sheet(uuid, userId?)` | Render a sheet on the agent endpoint, or on a live user's client via the `wiretap.openSheet` query | dom | 128 B `{ok, appId}` | — | — |
| `close_sheet(uuid)` | Close it (READ `client/applications/api/application.mjs:950` `close`) | dom | 128 B | — | — |
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

| # | Decision | Status | Source |
|---|---|---|---|
| D1 | Seatless execution: headless browser client (A) and raw socket (B), B only where it adds no risk. **Boundary (E2, applying the §4.3 rule):** B-eligible = reads of stored source data only. Updates of system fields with valid values were identical, but the update class fails rule 2 (the server stored invalid values the client refuses), so updates are A only; every create (Actor, Item, embedded Item/ActiveEffect, Scene and other classes with a client `_preCreate`) is A only; delete fidelity was not measured, so delete is A only. Table in §4.3 | DECIDED | User 2026-10-10; MEASURED (coord.) M0 E2 (`docs/experiments/2026-10-m0-results.md`) |
| D2 | Must run on a headless server: `playwright-core` + Playwright Chromium build, `executablePath` configurable; no reliance on an installed Edge/Chrome. **Default agent profile: `chromium_headless_shell` with `core.noCanvas` on** (the smallest functional build, the agreed criterion) | DECIDED | User; MEASURED (coord.) M0 E3: shell/noCanvas median ready 1.8 s, 438.7 MB working set, 18.2 % of one core idle; full build 2.9 s, 547.3 MB, 42.1 %; shell with a drawn canvas 608 % idle |
| D3 | Agent users: GM-client **client-scope** setting `[{userId, password}]` → pushed to the sidecar → module-local owner-only file; env-var provisioning also supported; passwords never sent back to any client | DECIDED (premise confirmed: P1 PASS) | User; READ `foundry/dist/database/documents/user.mjs`; MEASURED (coord.) M0 P1: no password, hash or salt client-visible for any role on any path |
| D4 | Agent role: **ASSISTANT**, on a dedicated user per agent. An ASSISTANT has `isGM === true`, runs every Wiretap op tested, never outranks a GAMEMASTER for `activeGM`, and cannot promote anyone to GAMEMASTER; so a human GAMEMASTER always stays the active GM when online. Implication: with no GAMEMASTER online the agent **is** the active GM and runs any system/module automation gated on `activeGM` in the headless page (with `core.noCanvas` on; whether such automation needs the canvas is not measured). A GAMEMASTER agent would compete with humans by id order (`wtx-gm` won over `E2E GM 1`). Agents never share a human's user: the stock join form refuses an already-active user (E1) | DECIDED (per M0 evidence) | MEASURED (coord.) M0 E1, E4; READ `users.mjs:70-96`, `common/documents/user.mjs:124` |
| D5 | Routing: prefer an agent endpoint, fall back to a human GM tab, per-call `endpoint` override | DECIDED | User 2026-10-11 |
| D6 | Trust: loopback unauthenticated (same machine is trusted). External access is an opt-in bind that requires a bearer token on `/mcp` and a token on socket identify, plus TLS/reverse-proxy guidance. Reopens the loopback-only rule when enabled | DECIDED | User |
| D7 | Acting user: optional advisory `actAs` pre-check (`testUserPermission` / `canUserModify`); the write runs as the endpoint user | DECIDED | User |
| D8 | Risky capabilities are GM-only world settings, default OFF; gate settings can never be changed by any skill | DECIDED (gate list in §4.6; the three proposed additions are DECIDED, see §4.6) | User |
| D9 | Plugin handlers run client-side only | DECIDED | User |
| D10 | Plugin surface: `Hooks.callAll('wiretap.registerSkills', api)` + `api.registerSkill`, integer `apiVersion`, tool names `<moduleId>__<skill>`, no dots | DECIDED | User; MEASURED (coord.) (claude 2.1.296): `.` rewritten to `_`; `__`, `-`, 110-char names work |
| D11 | MCP transport moves to stateful Streamable HTTP sessions with `notifications/tools/list_changed`; no sampling | DECIDED | User 2026-10-11; MEASURED (coord.) (claude 2.1.296): stateless lists tools once; stateful list_changed honoured; sampling `-32601` |
| D12 | Deletion: the ban is on deleting **files**. Foundry documents may be created, updated and deleted through Foundry document calls; `delete_documents` and undo of a create are built | DECIDED | User 2026-10-11 |
| D12a | Is `delete_documents` behind a GM gate? Recommendation: no gate for ordinary documents (Claude Code `ask` rules govern it, README shows `"ask": ["mcp__wiretap__delete_documents"]`); `dryRun` preview; `User` deletion stays under `allowUserWrites`, `Setting` under `allowSettingWrites`; compendium **pack** deletion is not exposed (§9 C1). `allowUndo` follows the same answer | DECIDED (user accepted the recommendation, 2026-10-11) | §9 C1 |
| D13 | Replace semantics fire normal update hooks (not `importFromJSON`'s `noHook: true`) | DECIDED | User; READ `client-document.mjs:1065` |
| D14 | Canonical document representation = the `toCompendium` export format (as used by `exportToJSON`), with `keepId: true` for reads | DECIDED (incl. `keepId`) | User 2026-10-11; READ `client-document.mjs:928-944,1113-1134` |
| D15 | `describe_schema` = "schema by example" (blank export per type/subtype) first; DataModel field-walker for constraints second, scoped by path (§2.8 grammar). **E8-driven design (M4):** without `path` it returns the blank export (titan Actor 4.85 KB, Items ≤ 648 B) plus a one-level outline of the schema; full constraints only with `path`, because the walker output for an Actor is 19.9 KB (above the 16 KB maximum cap) and Adventure 26.5 KB. For the 7 classes whose blank construction fails (ActorDelta, Drawing, Folder, Setting, TableResult, Tile, Wall) the example is built with the minimal required fields (parent, `type`, `key`) or omitted with the walker output only (approach INFERRED; M4 tests it) | DECIDED | User; READ: no JSON-Schema export in `common/data/fields.mjs`; MEASURED (coord.) M0 E8 |
| D16 | `create_actor` is removed when `create_documents` lands; no alias (no-backwards-compatibility rule) | DECIDED | User 2026-10-11; READ `.claude/claude.md:25` |
| D17 | Context minimisation is a top-priority, cross-cutting requirement; every milestone has a context-budget criterion | DECIDED | User 2026-10-10 |
| D18 | The user's script proposal: adopted as modified in §2.3 (one registry with the core tools; each script its own deferred MCP tool; combined with result shaping); skills may reference tools as the discovery layer (§2.7) | DECIDED | User 2026-10-11; MEASURED (coord.) §2.1 R1–R6 |
| D19 | Dispatcher mode (`list_scripts` / `describe_script` / `run_script`) for clients that do not defer tools | DEFERRED (logged in `docs/TODO.md`) | User 2026-10-11 |
| D20 | Budgets of §2.6 enforced in bytes; constructed outputs CI-hard, requested outputs bounded by the runtime hard cap | DECIDED (adoption); the † value changes of revision 3 DECIDED (accepted 2026-10-11) | User 2026-10-11; MEASURED (coord.) §2.1 |
| D21 | Agent-saved scripts governed by Claude Code permissions (user's position); option (a) as stated vs (b) with minimal Wiretap safeguards (recommended) vs (c) Foundry-UI approval | DECIDED: option (b) (accepted 2026-10-11) | §2.5; READ Claude Code permission and MCP docs |
| D22 | Ad-hoc agent code `run_js` is not built. Rationale: arbitrary GM-authority code per call defeats the gate hard rule (§4.6); its code travels in every call's arguments (the opposite of the context goal); `execute_macro` (gated) and D21 cover reuse | DECIDED (coordinator's judgement, delegated by the user) | User 2026-10-11 |
| D23 | Saved-result handles: in-memory sidecar store per MCP session, LRU-bounded (64 MB total, 30 min idle), lost on sidecar restart; never on disk | DECIDED | User 2026-10-11 |
| D24 | Default read view = compact; the canonical D14 export with `mode:"full"` or by `paths`, all under the hard cap | DECIDED (in principle) | User 2026-10-11 ("I think this can work") |
| D25 | DOM scripts route to the agent endpoint by default; a human GM tab only by explicit `endpoint` override | DECIDED | User 2026-10-11 |
| D26 | Path-scoped reads and writes (§2.8): `paths` parameter on `get_document`, same grammar in `update_documents`, `read_handle`, `describe_schema`; no new tools; `edit` merged into `update_documents` | DECIDED (accepted 2026-10-11; recommendation) | User request 2026-10-11; READ `helpers.mjs:821-868`, `global.d.mts:6-7` |
| D27 | Build M11 (raw-socket executor) at all? Recommendation: **no; drop it and log it in `docs/TODO.md`.** After E2 it could only serve source reads and valid system-field updates when no client is live, and the sidecar cannot tell valid from invalid values without the system's DataModels, which exist only in a client (READ §4.3); the agent runner (M9) already provides a client for about 440 MB and 1.8 s | DECIDED: drop (user accepted, 2026-10-11) | MEASURED (coord.) M0 E2, E3 |
| D28 | Screenshot default expressed as pixel area (≤ 480,000 px, the 800×600 area, aspect kept) instead of an 800×600 box (‡ in §2.6) | DECIDED (user accepted, 2026-10-11) | MEASURED (coord.) M0 E9: titan actor sheet 850×926 |

## 4. Architecture

### 4.1 Components and where they run

| Component | Runs in | Role |
|---|---|---|
| MCP session server (`server/mcp*.ts`) | Sidecar (Node) | Stateful Streamable HTTP sessions; tool list = core tools + scripts + plugin tools of the routed endpoint; server `instructions` pointer (§2.7); sends `list_changed` |
| Result budget enforcer (`server/resultBudget.ts`) | Sidecar | Applies §2.6 caps to every tool result; over cap → handle + summary; caps error text |
| Handle store (`server/handles.ts`) | Sidecar, memory only | Per-session LRU of large results (D23); slices for `read_handle`, input for `import_from_handle` |
| Budget constants (`shared/budgets.js`) | Both | The §2.6 numbers; one source for enforcer, registration checks and tests |
| Path resolver (`shared/docPath.js`) | Both | §2.8 grammar: parse, refuse unsafe segments, resolve over an export, group embedded writes |
| Endpoint registry + router (`server/endpoints.ts`, replaces `gmSockets`) | Sidecar | Tracks identified GM endpoints `{socketId, userId, userName, kind: agent\|human, dom: bool, registeredAt}` (`skills[]` arrives with M7 and `gateState` with M2); routes per D5, DOM scripts per D25 |
| Script registry (`src/bridge/scripts/registry.js`) | Foundry client | Shipped and plugin scripts (core tools included), and agent-saved scripts if D21; validates args; emits `bridge:registry` |
| Shipped scripts (`src/bridge/scripts/*.js`) | Foundry client | §2.9 catalogue; static imports only |
| Op dispatcher (`src/bridge/ops/*`) | Foundry client (human GM tab or agent tab) | Core ops on `documentClass` APIs; gate checks; `actAs` pre-check; `ctx.core.*` for scripts |
| Gate settings (`src/settings/gates.js`) | Foundry client, world scope, `restricted` | Risk options (§4.6) |
| Agent-script store (`server/agentScripts.ts`) | Sidecar | `.wiretap/agent-scripts.json`, overwrite/version/disable only; only if D21 builds it |
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
4. The operation needs nothing client-only: plugins, sheets, derived data (incl. `derived: true` path reads), rolls,
   macros, user queries, scripts with `requires: 'dom'`.

Everything else uses A (or a human tab).

**Result of M0 E2 (MEASURED (coord.), `docs/experiments/2026-10-m0-results.md`):**

| Operation class | Rule 1 (diff) | Rule 2 (invalid input) | Rule 3 (fingerprint) | B-eligible |
|---|---|---|---|---|
| Read stored source (`modifyDocument get`, `world`, `getJoinData`) | — (source data; no derived values; raw-created documents have sparse `system`) | — | — | **yes** |
| Create Actor (`player` 9/21 diff paths client/stored, `npc` 6/17) | fail | fail (server stores invalid `system`) | titan Actor `_preCreate` | no |
| Create Item, 7 subtypes (1–2 / 8–14) and embedded Item (1–2 / 12) | fail | fail | titan Item `_preCreate` | no |
| Create embedded ActiveEffect, 3 subtypes (1–2 / 1) | fail | fail | titan AE `_preCreate` | no |
| Create Scene (0 Levels; `view()` throws) and other classes with a core `_preCreate` | fail | — | core `_preCreate` | no |
| Update a system field with a valid value (player, npc) | pass (0 / 0) | **fail** (wrong type and 2.5-in-integer stored as sent; live clients diverge) | Actor/Item: no `_preUpdate`; AE: `_preUpdate` | no |
| Unknown subtype | — | server rejects | — | n/a |
| Delete | not measured | not measured | Cards, ActorDelta `_preDelete` | no |

Replaying the client's exact emitted create payload over B matched the client result except `flags.titan`, so B adds
nothing when a client must build the payload anyway.

### 4.4 Canonical document representation (D14, view per D24, paths per D26)

- **Full reads** (`mode:"full"`, `export_to_handle`) produce `doc.toCompendium(null, {clearSource: false, keepId:
  true, clearSort: false, clearOwnership: false})` plus `uuid`. The defaults would drop `_id`, `sort`, `ownership` and
  `author` (READ `client-document.mjs:1113-1134`). Optionally prepared values are added under a separate `derived`
  key.
- **Default reads** return the compact view: `uuid`, `name`, `type`, a per-type key-field list, and embedded documents
  as `[id, name, type]` tuples (first 40 plus a total count). `fields` returns a projection, `paths` path slices
  (§2.8), both of the canonical form.
- **Create** takes the canonical shape.
- **Replace** = `fromImport` → `collection.fromCompendium` → strip `preserveOnImport` → `update(data, {diff: false,
  recursive: false})` **with hooks** (D13). Input may be a handle.
- `exportToJSON` / `importFromJSON` themselves are world-documents only and trigger a download / notification (READ
  `:928-944`, `:1049-1068`). Wiretap calls the underlying steps and also covers embedded and compendium documents.

### 4.5 Bridge protocol additions (`shared/protocol.js`)

Protocol v2 replaces v1; a mismatched `protocolVersion` is refused, not translated (no-backwards-compatibility rule).

- `bridge:identify` gains: `kind`, `dom` (can render and measure), `protocolVersion`, `token?` (external mode only),
  `gateState` (from M2). The per-class `fingerprint` was only for raw-socket eligibility and is dropped with M11 (D27).
- `bridge:registry` carries `{apiVersion, skills: [{name, moduleId, source: shipped|plugin|agent, description,
  inputSchema, mutates, requires, budgetBytes}]}`.
  **As built in M3** (the script registry of M14 reshapes this): the payload is a plain array of `{name, description,
  inputSchema, budgetBytes?, gate?, moduleId?}`; each event replaces the endpoint's whole list (an empty array clears
  it); the ack is `{ok, accepted, refused}` (`NOT_GM` for an unregistered socket, `OP_FAILED` for a non-array payload,
  which also clears the list). The sidecar sanitizes every entry: names of at most 32 characters
  (`CORE_TOOL_NAME_MAX_CHARS`) and at most 30 tools in all (`ALWAYS_LISTED_TOOLS_MAX` less the built-in tools) apply to
  every registry tool, plugin names of 64 characters are not yet accepted; the JSON Schema is a documented subset
  (depth 4, 64 nodes, 32 properties, string enums of at most 32 values) and `$ref`, combinators, `pattern`, `format`,
  `default`, `const` and `Object.prototype`-named properties are refused. A call runs the `callTool` op with
  `{name, arguments}`; the executing endpoint is resolved by name at call time and its own declaration of the tool
  supplies the gate and the result budget (`TOOL_GONE` when it no longer registers the name, `GATE_DENIED` when its
  declared gate differs from the listed one). An MCP session picks its endpoint kind with `?endpoint=human|agent` on
  the initialize URL.
- `bridge:credentials` (GM human tab → sidecar only) carries the agent list. It is never broadcast and never sent
  sidecar → client.
- `bridge:invoke` gains `actAs?`, `dryRun?`, `requestId`, and `code` + `sha256` for agent-saved scripts (if D21).

### 4.6 Risk gates (D8)

World-scope settings, `restricted: true` (GM only), `config: true`, all default `false`:

| Gate | Unlocks | Notes |
|---|---|---|
| `allowMacroExecution` | `execute_macro` | Arbitrary code; see hard rule caveat below |
| `allowUndo` | `undo_last` | Exists only if D12a chooses a gate |
| `allowUserWrites` | Create/update/delete of `User` documents (incl. role) | Password fields always refused |
| `allowSettingWrites` | `Setting` documents and world/user settings via skills | `wiretap.*` always refused |
| `allowFileUpload` | Base64 data in `FilePathField`s; file upload tool | Server also requires `FILES_UPLOAD` (READ `dist/database/sanitization.mjs`) |
| `allowDelete` | `delete_documents` | Exists only if D12a chooses a gate (recommendation: none) |
| `allowedPluginModules` | Plugin skills and scripts per module id | Default: none enabled |
| `allowAgentScripts` | `save_script`, `disable_script`, running agent-saved scripts | Only if D21 = (b); arbitrary-code caveat |
| DECIDED (accepted 2026-10-11) | `allowOwnershipWrites`, `allowCompendiumWrites`, `allowModuleConfigWrites` (`core.moduleConfiguration`) | Each is escalation-capable |

**Hard rule.** No skill can change a gate. Enforcement:

1. Every write path refuses any `Setting` whose key starts with `wiretap.`, whatever the gate state. This covers the
   generic CRUD path (incl. path-scoped writes and deletes), the settings skills, batch, replace, scripts'
   `ctx.core.*` and raw-socket B.
2. Gates are read only from `game.settings` on the executing client; params never carry a gate value.
3. B operations need a gate snapshot pushed by a live client. Without one, gated categories are denied.
4. Tests assert each path refuses `wiretap.*`.

**Known limit (INFERRED, stated in the UI hint).** Any arbitrary-code capability (`allowMacroExecution`,
`allowAgentScripts`, any enabled plugin module) can call `game.settings.set` directly. When a GM enables one, the
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
- **Handles** hold world data in sidecar memory only, scoped to the MCP session that created them.

### 4.8 Test-data cleanup pattern (READ from titan, adopted)

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

Wiretap adopts the same pattern for M0 and its e2e suite, with its own prefixes (`wtx-` for experiments, `Wiretap
E2E ` for e2e; neither starts with `E2E `, so TITAN's sweep never touches them, and TITAN's documents never match
Wiretap's census). Constraint (READ `census.js:91-96,158-162`): TITAN's sweep deletes **every** combat and every
orphan token in `test-titan` and fails its run when it does; Wiretap tests and experiments must therefore not leave
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
  `wiretap-spec-reviewer` → `wiretap-code-reviewer`. `buddy-checking` for M1, M3, M9, M10, M11, M14, M16 (security or
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

**Order:** M0 ‖ M1 → M13 → M2 → M3 → M14 → M4 → M5 → M6 → M15a → M7 → M16 (if D21) → M8 → M9 → M15b → M10 →
M12 (M11 dropped, D27).

### M0 — Experiments against Foundry

**Status:** Done: see [`docs/PROGRESS.md`](PROGRESS.md) (outcomes and deviations); the specification below is
kept as the reference.


**Depends on:** the launcher; no concurrent TITAN e2e run (§4.8). **Produces:** `docs/experiments/2026-10-m0-results.md`.
No product code.

**Safety limits:**

- No file deletion of any kind. Documents: only the `wtx-` documents an experiment created may be deleted, and only
  through Foundry document calls (`document.delete()`, `deleteEmbeddedDocuments`, `Document.deleteDocuments`); the
  experiment's running list (§4.8 pattern) records each id at creation, and a final census of `wtx-` names must be
  zero. Users (`wtx-*`) are not deleted (`User` deletion is outside M0).
- Created documents only inside folders named `Wiretap Experiments`. Names prefixed `wtx-`.
- Users limited to `wtx-assistant`, `wtx-gm`, `wtx-player`. Passwords are synthetic, from an env var, and never
  written to the repo or results.
- No combats and no tokens left in the world after an experiment (TITAN's sweep, §4.8).
- Experiment scripts live under `test/tmp/` (gitignored) or a scratch dir. Only the results doc is committed.

| Exp | Procedure | Pass / fail criteria | Unlocks |
|---|---|---|---|
| P1 password shape | As GM in the browser: `game.users.get(id)._source.password` and `toObject().password` for each `wtx-*` user. From Node: `getJoinData` socket payload `users[]` keys. | PASS = no password or hash anywhere client-visible. Any value present = FAIL → stop and report (D3 premise breaks) | D3 confirmed |
| E1 same user twice | Log `wtx-gm` in from two Playwright contexts. Check `game.users.get(id).active` and that both sockets stay connected for 60 s. Create a `wtx-` Folder in one; check the other receives the `createFolder` hook. | PASS = both stay connected and both receive broadcasts | Whether an agent may share a human's user (D3/D5) |
| E2 raw-socket fidelity | For each titan Actor subtype (`player`, `npc`): create `wtx-client-<type>` via `Actor.create` in a client, and `wtx-raw-<type>` via Node (`POST /join` → socket.io-client with cookie → `modifyDocument create`), same input. Read both via the client `toObject()`; diff excluding `_id`, `name`, `_stats` timestamps. Repeat for embedded Item and ActiveEffect (`parentUuid`), for update of a system field, for **delete** (client `delete()` vs raw `modifyDocument delete`: hooks and embedded cascade), and for invalid system data (wrong type, out-of-range). Also capture the client fingerprint (§4.5) per document class. | Per op class: PASS = empty diff for every subtype AND invalid data rejected or stored identically. Any diff = that op class is A-only | D1 boundary table |
| E3 headless cost | `playwright-core` with `executablePath` = (a) chromium-1223, (b) headless_shell-1223. ≥5 runs × `core.noCanvas` on/off as `wtx-assistant`. Measure launch→`game.ready` ms, browser-tree RSS after 60 s idle, mean CPU % over 60 s idle, and whether the Wiretap bridge identifies and `create_actor` round-trips. Report median and range. | Functional PASS required (ready, identify, create, sheet render offscreen). Build choice = smallest functional build; cost numbers go to the user for a budget | D2 build choice; agent runner defaults |
| E4 role behaviour | `wtx-assistant` (ASSISTANT) and `wtx-gm` (GAMEMASTER) with a human GAMEMASTER present and absent: read `game.users.activeGM` on each client. As ASSISTANT, try create/update/delete on every world document type, compendium write, `Setting` write and `User` role change; record denials. | Recorded matrix; no pass/fail | D4 |
| E7 unattended re-login | Set `world` in `options.json` (READ `common/config.mjs:65`), restart Foundry, run the agent-runner prototype script with stored credentials. Measure time to agent identify; then restart Foundry again with the script running. | PASS = agent identifies after both restarts with no human | M9 reconnect design |
| E8 schema size | For each document type and subtype in the titan world: byte size of (a) blank export (`new cls({name, type}).toCompendium(...)`), (b) a field-walker JSON Schema prototype run in the console, (c) both scoped to each top-level `system.*` path. Report bytes and bytes / 2 (estimate per §2.1). | Recorded table | D15 scoping thresholds, D26 |
| E9 titan result sizes | In the titan world, per Actor and Item subtype (`wtx-` documents plus the largest existing document per subtype, read only): bytes of the full `toCompendium` export, a compact-view prototype, a 10-field projection, and each top-level `system.*` path and `items` (the §2.1 path table for titan). On the headless agent (E3 build): `getBoundingClientRect` of 5 sheet selectors per sheet class with `core.noCanvas` on, a `sheet_layout` prototype's byte size, and the PNG pixel size of a default-sized sheet. | Recorded table; FLAG to the user any compact view > 2 KB or layout > 4 KB before M4/M15 | D20 values, D26, D25, `sheet_layout` design |

**Acceptance:** the results doc exists with every row filled or explicitly "not run: reason"; the `wtx-` census is
zero apart from the `wtx-*` users and the `Wiretap Experiments` folder contents the results doc lists as kept. The
decisions table in this plan is updated by the main thread, not by the experiment runner. **Context budget:** E9 is
filled; every titan size that breaks a §2.6 budget is listed with the proposed handling. **Risks:** sharing the world
with TITAN e2e (§4.8); E7 needs control of the Foundry process (the launcher).

### M1 — Endpoint registry, routing, protocol v2

Done: see [`docs/PROGRESS.md`](PROGRESS.md).

**Goal:** replace `gmSockets` / first-socket routing with an explicit registry and router. **Depends on:** none (can
start before M0 finishes). **In:**

- `server/endpoints.ts`.
- `bridge:identify` v2 (`kind`, `dom`, `protocolVersion`; `gateState` arrives with M2, and `fingerprint` is dropped
  with M11/D27); v1 identify removed. Detailed design: `docs/specs/2026-10-11-wiretap-m1-endpoint-registry-design.md`. The
  sidecar acknowledges identify after the endpoint is registered (Socket.IO ack); the client exposes an "identified"
  state that the M9 runner waits on (M0 E3/E7: calls between identify-sent and registration failed).
- Routing per D5 (DECIDED) with per-call `endpoint` override. The default order lives in one constant and is
  documented in the README.
- `requestId`.
- Structured error contract `{code, message, failures?}`, message ≤ 512 B, `failures` capped at 10 plus a count.

**Out:** tokens (M10), raw socket (M11). **Tasks:**

1. Registry unit tests (add/update/remove on disconnect, kind priority).
2. Router.
3. Client identify v2.
4. `create_actor` runs on top of the router until M5 removes it (D16).

**Tests:** unit (registry, router, error-contract truncation); integration with two fake GM clients (agent + human)
asserting route choice and fallback on disconnect. **Acceptance:** existing `create_actor` tests green; routing tests
green; a v1 identify payload is refused with a clear log (no translation). **Context budget:** routing adds no fields
to tool results; a no-endpoint error is ≤ 256 B and names the fix ("open a GM tab or enable an agent"); the
error-contract truncation is unit-tested with a 50-failure input. **Risks:** a stale client build after an update →
refused with a "reload Foundry" message.

### M13 — Context-budget harness, result enforcer, handle store, path resolver

Done: see [`docs/PROGRESS.md`](PROGRESS.md).

**Goal:** make §2.6 executable before any new tool exists. **Depends on:** M1. **Consent at start:** new files
`shared/budgets.js`, `shared/docPath.js`, `server/resultBudget.ts`, `server/handles.ts`, `tests/measure/`. **In:**

- `shared/budgets.js`: the §2.6 numbers as named constants, each tagged `hard` or `warn`.
- `shared/docPath.js`: the §2.8 grammar (parse, unsafe-segment refusal, resolve over an export by `_id` and index, one
  wildcard, missing-path list, grouping of embedded writes).
- `server/resultBudget.ts`: wraps every tool handler. Measures the serialized result; over the per-tool budget or the
  hard cap (8 KB default, `maxBytes` ≤ 16 KB) → stores the raw result in the handle store and returns `{handle,
  bytes, summary}` (summary = deterministic: top-level keys, counts, `name`/`type` if present). Caps error text.
  Refuses more than one image or an image above the pixel cap.
- `server/handles.ts`: per-session in-memory LRU (D23: 64 MB, 30 min idle), opaque ids, `slice(handle, paths?,
  offset, length)` with the §2.8 grammar; eviction is in memory only, nothing is written to disk.
- `tests/unit/contextBudget.test.js` (CI): builds the real MCP server in-process, lists tools with the SDK client and
  asserts per-tool name length, definition bytes, description length, total count and total bytes (hard vs warn per
  §2.6; warnings printed, hard limits fail); runs each registered tool's representative-result fixture through the
  enforcer and asserts its budget; asserts an over-cap fixture becomes a handle; asserts every tool name mentioned in
  a shipped skill or the server `instructions` exists (§2.7). A tool without a fixture fails the test.
- Fixtures: synthetic, obviously fake documents generated in the test (e.g. an actor with 120 embedded items named
  `MOCK_ITEM_n`), sized to exceed the cap, not copied from any system's data.
- `tests/measure/measureContext.mjs`: manual live calibration per §2.6 (not run in CI; no Foundry needed).

**Tests:** unit (enforcer thresholds at budget − 1, budget, budget + 1; handle LRU eviction; slice bounds; summary
determinism; path grammar incl. `_id` resolution, index, wildcard, missing, `__proto__` refusal). Integration: fake
GM client returns a 100 KB result → the MCP client receives a handle ≤ 256 B, and `read_handle` slices return within
the cap. **Acceptance:** the budget test runs in `npm test` and fails on a deliberately oversized definition in a
test-local registry. **Context budget:** this milestone's own surface (`read_handle`) is inside §2.6; the live
calibration has been run once and its numbers recorded next to §2.1's. **Risks:** byte budgets diverge from token
reality on other tokenizers → recalibration script; budgets change only by user decision.

### M2 — Risk-gate options

Done: see [`docs/PROGRESS.md`](PROGRESS.md).

**Goal:** the gate settings and enforcement points before any write skill exists. **Depends on:** M1. **In:**

- World-scope `restricted` settings (§4.6, with D12a and D21 deciding which exist), labels and hints in
  `lang/en.json`, including the arbitrary-code caveat.
- Gate check helper `requireGate(name)`.
- The `wiretap.*` setting deny rule as a shared function used by every write path (update, replace, batch, delete).
- `gateState` pushed on identify and on change (`updateSetting` hook).

**Out:** the gated tools themselves (M5/M6). **Tests:**

- Unit: each gate default off.
- Unit: the deny rule for `wiretap.*` keys on create/update/replace/batch/delete.
- Integration: gate snapshot reaches the sidecar.
- e2e: as GM, toggling a gate in the settings UI updates the snapshot; the setting is restored afterwards (§4.8).

**Acceptance:** the deny function has 100% branch tests; no API path exists to set a `wiretap.*` setting from params.
**Context budget:** a gate denial is one error ≤ 256 B naming the gate and stating that only a GM can enable it in
the settings; gate state never appears in results except as one compact line in `list_endpoints`. **Risks:** a missed
write path. Mitigation: M4/M5 acceptance includes the deny test per path.

### M3 — Stateful MCP sessions

Done: see [`docs/PROGRESS.md`](PROGRESS.md).

**Goal:** sessions with an SSE GET stream and `notifications/tools/list_changed` (D11, DECIDED). **Depends on:** M1,
M13. **In:**

- `sessionIdGenerator`; the stateless path is removed.
- A per-session `McpServer` holding the tool set of its routed endpoint.
- Server `instructions`: the ≤ 600-char pointer of §2.7.
- GET/POST/DELETE per the Streamable HTTP spec. HTTP `DELETE` ends a session in memory; it is not a file-deletion
  API.
- Idle-session expiry (in-memory); expiry also releases that session's handles (D23).
- `list_changed` on registry/endpoint change.

**Out:** auth (M10). **Tests:**

- Integration with the SDK client: a session is created; a tool registered later (fake client emits
  `bridge:registry`) appears after `list_changed`; the session ends cleanly.
- Live check against `claude` 2.1.296 repeating the coordinator's earlier measurement, recorded in the results doc.

**Acceptance:** a late tool is callable in the same session. **Context budget:** the live check also records (same
method as §2.1) whether a tool added by `list_changed` is deferred and its name cost, and the context cost of the
server `instructions`; `list_changed` fires at most once per registry change (debounced), so the client does not
re-list on every identify. **Risks:** session leak under abandoned clients. Mitigation: expiry with tests.

### M14 — Script runtime and the discovery layer

**Goal:** one registry for core tools, shipped scripts and plugin scripts (§2.4), and the skills that point to them
(§2.7). **Depends on:** M1, M3, M13. **Consent at start:** layout `src/bridge/scripts/`; delivery of user-facing
skills (§2.7). **In:**

- `src/bridge/scripts/registry.js`: `{name, version, description, inputSchema, result.budgetBytes, requires, mutates,
  gate?, handler}`; registration checks the §2.6 definition budgets and refuses with a logged reason.
- Client-side argument validation against the same JSON Schema the sidecar converts to zod.
- `ctx` (`core`, `shape`, `dom`, `signal`); `ctx.shape` implements compact view (40-tuple cap), projection, path
  slices (`shared/docPath.js`) and ack.
- Sidecar mapping registry → MCP tools (one tool per script; dispatcher deferred, D19).
- Routing by `requires` (D25): `dom` scripts need an endpoint with `dom: true`.
- `create_actor` moves onto the registry unchanged until M5 removes it (D16).
- A user-facing Wiretap skill (recipes naming the tools) and the `wiretap-mcp-bridge` developer skill updated to
  reference the tools.

**Tests:** unit (registration budget refusal, validation, `ctx.shape` outputs, `requires` routing); integration (fake
client registers a script → tool listed → call → enforcer). **Acceptance:** `create_actor` works through the
registry; a `dom` script with only a non-DOM endpoint returns a ≤ 256 B error naming the missing endpoint kind.
**Context budget:** every registered entry has a budget-test fixture (M13 test enforces); `ctx.shape` outputs meet
§2.6 on the synthetic fixtures; the skill-reference check of M13 passes. **Risks:** a second abstraction over ops →
scripts call ops, never the reverse.

### M4 — Core read tools

**Goal:** `list_document_types`, `get_document` (compact / `fields` / `paths` / `mode:"full"`), `search_documents`,
`describe_schema` (with `path`), registered as M14 scripts. **Depends on:** M1, M3, M13, M14. M0 inputs are in (E8,
E9): the compact view starts from the E9 prototype (uuid, name, type, up to 24 system leaves matched by a key-name
pattern, embedded tuples; ≤ 1,574 B on titan) and the per-subtype key-field lists are fixed and reviewed in this
milestone. **In:**

- Primary, embedded (via `parentUuid` or a path into the parent) and compendium (`pack`) reads.
- Default compact view; `fields` projection; `paths` (§2.8, incl. `derived: true` on client endpoints); `mode:"full"`
  canonical representation (§4.4); `ifModifiedSince`.
- `search_documents`: default limit 20, max 100, cursor, `total`; rows are `[uuid, name, type]` unless `fields`.
- `describe_schema(documentName, subtype, path?)` per D15: without `path`, the blank export plus a one-level schema
  outline (top-level field names and field classes); with `path`, the blank export's subtree plus constraints
  (choices, min/max, integer, required, nullable, blank) from a field-walker over
  `CONFIG[doc].dataModels[subtype].schema` and the core schema. The walker marks free-form fields (ObjectField 158,
  AnyField 3, JSONField 2, TypedObjectField 3 occurrences in E8) as free-form instead of expanding them, refers to
  embedded collections (EmbeddedCollectionField 39, EmbeddedCollectionDeltaField 4) by document name instead of
  inlining them (the inlining is what made Adventure 26.5 KB), and resolves TypeDataField (15) by subtype. Blank
  examples for ActorDelta, Drawing, Folder, Setting, TableResult, Tile and Wall use the minimal required fields or
  are omitted (E8: blank construction fails).
- `wiretap.*` settings and `User` password fields excluded from all reads, including any path that reaches them.

**Tests:**

- Unit: field-walker over each core field class with mocked fields; representation function; exclusions (a path to a
  password field returns it in `missing`, never the value); compact view, projection and path sizes on synthetic
  fixtures.
- Integration: fake client.
- e2e: read `Wiretap E2E ` documents the spec creates and records; teardown per §4.8.

**Acceptance:** every type in `ALL_DOCUMENT_TYPES` can be listed and read in the titan world (e2e enumerates); `paths`
returns `system.attributes`-style slices and `items.*.name` keyed by `_id` on a titan actor. **Context budget:**
compact ≤ 2 KB per document for every titan subtype in e2e (hard); a `paths` or full read above the hard cap returns a
handle; `describe_schema` without `path` within the 8 KB default cap for every titan document type and subtype (E8:
the blank Actor export alone is 4.85 KB, so the outline has ≈ 3 KB); a titan full actor read (5.7–12.5 KB, E9)
returns a handle at the default cap and inline with `maxBytes: 16384`. **Risks:** schema output size (E8: an
unscoped Actor walk is 19.9 KB, which is why constraints need `path`).

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

**Out:** raw socket (M11); compendium pack deletion (not exposed, §9 C1). **Tests:**

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

- `open_sheet(uuid, userId?)` via the `wiretap.openSheet` user query (human clients) or a local render (agent
  endpoint). The query handler checks that the sender is a GM and that the target has OBSERVER.
- `close_sheet(uuid)`.
- `roll(formula)`.
- `draw_table(uuid)`.
- `execute_macro` (gate).
- `undo_last` (gate per D12a; undoes the session's last create by deleting it, or its last update).

All as M14 scripts. `screenshot` is in M15b (it needs the agent runner). **Depends on:** M2, M5, M14. **Tests:** unit
(query handler checks); integration; e2e with a GM tab and a `wtx-player` context: the sheet opens on the player
client only with permission; an offline user gives a clear error (READ `user.mjs:306`); rolls with `toChat: true`
are recorded and torn down (§4.8). **Acceptance:** open-sheet semantics documented: on a chosen live user's client;
with no human connected, only data or measurements. **Context budget:** `open_sheet` / `close_sheet` ≤ 128 B; `roll`
≤ 512 B; `draw_table` ≤ 1 KB; `execute_macro` results pass the hard cap. **Risks:** ChatMessage spam from rolls.
Tool option `toChat` default false.

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

**Goal:** D3. **Depends on:** M1; uses M10's token when external. The P1 premise is confirmed (M0). **In:**

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

**Goal:** seatless operation on a headless server (D2), and the DOM endpoint for `dom` scripts. All M0 inputs are in
(E1, E3, E4, E7, E9). **Depends on:** M1 (identify acknowledgement), M8. **New runtime dependency:** `playwright-core`
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

**Resource budget per agent (MEASURED (coord.) E3 on one host, i7-13700K, 5 runs, median):** launch → ready 1.8 s,
438.7 MB working set / 294.8 MB private for the browser process tree, 18.2 % of one logical core idle, 5 processes,
273 MB on disk for the shell build. Other hosts not measured. **Recovery budget (E7, one run):** fresh login → ready
2.1 s; restart flag → agent usable 7.8 s with a warm Foundry restart (4.9 s spawn → listening); with a cold start
(26.5 s spawn → listening, launcher log) recovery is INFERRED at ≈ 30 s.

**Tests:** unit (supervisor state machine with a fake launcher: login, identify-ack wait, `/join` redirect →
re-login, crash → backoff; capture downscaling); integration (fake launcher + fake client identify; a call during
identify gets the reconnecting error, not a wrong route); e2e (real launch as an ASSISTANT test user, identify,
`create_documents` round-trip with §4.8 teardown; a Foundry restart through the launcher → the agent re-identifies
without a human). **Acceptance:** the restart e2e passes; the agent's measured idle cost on the CI host is recorded
and within 1.5× the E3 medians or reported to the user. **Context budget:** `list_endpoints` ≤ 1 KB with two agents
and one human; capture output never exceeds the §2.6 pixel cap (unit); the reconnecting error ≤ 256 B. **Risks:**
RAM/CPU on small servers (E3 numbers are from one fast desktop host); with no GAMEMASTER online the agent becomes the
active GM and runs `activeGM` automation headless (D4); the launcher does not stop Foundry when its `npm` wrapper is
stopped (`docs/OPEN_BUGS.md`), which matters for the restart e2e.

### M15b — Script library: DOM scripts

**Goal:** the `dom` rows of §2.9: `element_size`, `sheet_layout`, `inspect_sheet`, `screenshot` (and `open_sheet` /
`close_sheet` on the agent endpoint). **Depends on:** M6, M9, M14. E9 input: offscreen sheets render headless with
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

### M11 — Raw-socket executor (option B)

**Status: DROPPED (D27 DECIDED 2026-10-11, user accepted the recommendation); not built, logged in `docs/TODO.md`.** E2 certifies reads of stored source data only
(§4.3). What a read-only B would add: answers when no client endpoint is live, limited to source data (no derived
values, no compact view key fields that depend on prepared data, sparse `system` for raw-created documents). What it
costs: a second login path and executor, a second shaping path, and an always-present risk that a later change routes
a write over it; the server stores invalid `system` values (E2), which the sidecar cannot detect without the
system's DataModels. The M9 runner provides a full client for ≈ 440 MB and 1.8 s (E3), and recovers from a restart in
≈ 8 s warm (E7). D27 = drop: this milestone is logged in `docs/TODO.md` and removed from the order; the read-only form below is kept
only as the scope to revisit if a raw-socket path is ever wanted. **Depends on:** M5, M8, M2 (gate snapshot). **In (read-only form):**

- `server/rawSocket.ts` (login with an agent credential, `modifyDocument` with action `get` only; any other action is
  refused in code, not by configuration).
- Eligibility = reads only ∩ gate snapshot.
- `wiretap.*` deny.
- Results marked `executor: "raw"` and shaped by the same `ctx.shape` rules (compact / projection / path slices /
  ack) on the sidecar.

**Tests:** unit (eligibility; non-`get` actions refused); integration against a fake Foundry socket server; e2e
comparing raw reads with the client path's source data. **Acceptance:** an ineligible op with no client gives a clear
"needs a Foundry client" error.
**Context budget:** raw results equal the client-path results plus at most 20 B (`executor`), asserted per certified
op.

### M12 — Live e2e matrix and documentation

**Goal:** end-to-end coverage for human-tab, agent and (if any) raw endpoints. Close the related `docs/TODO.md` entries
(live bridge e2e, auto-wiring e2e). Final README, including a "Context budget" section with §2.6 and the permission
guidance of §2.5. **Depends on:** M6, M7, M9, M15a, M15b (and M10/M11/M16 if built). **Acceptance:** full `npm test`,
`npm run typecheck`, `npm run eslint`, `npm run test:e2e` green with output reported; the Wiretap census (§4.8) is
zero after the run. **Context budget:** the e2e matrix asserts the §2.6 budget of every tool's live result on titan;
`tests/measure/measureContext.mjs` re-run against the real sidecar and recorded next to §2.1.

## 6. New skills and agents (core skill rule 3)

Evaluate at the end of the named milestone:

- `wiretap-mcp-tools` (`src/bridge/ops/**`, `server/mcp*.ts`, `server/resultBudget.ts`, `server/handles.ts`,
  `shared/budgets.js`, `shared/docPath.js`): when M4/M5/M13 push `wiretap-mcp-bridge` past about 250 lines.
- `wiretap-scripts` (`src/bridge/scripts/**`, `server/agentScripts.ts`): at M14, a new subsystem with its own budgets
  and catalogue.
- `wiretap-plugin-api` (`src/bridge/skills.js`, `examples/**`): at M7, since it is a public API with a separate
  audience.
- `wiretap-agents` (`server/agentRunner.ts`, `server/agentCredentials.ts`, `server/rawSocket.ts`): at M9, a new
  subsystem.
- `wiretap-build-test` gains the budget-test tier, `tests/measure/` and the §4.8 e2e registry/census at M13/M4.
- The user-facing skill for MCP users (§2.7) at M14; its location is a consent item.
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
- **Launcher defect** (MEASURED, `docs/OPEN_BUGS.md`): stopping `npm run foundry:start` leaves the supervisor and
  Foundry running.
- `modifyBatch` is not atomic; users may assume transactions.
- Document deletes are irreversible apart from backups; `dryRun` and Claude Code `ask` rules are the guard (D12a).
- The arbitrary-code capabilities weaken the gate hard rule (§4.6), including agent-saved scripts (§2.5 S7).
- Claude Code permissions protect only calls made through Claude Code; loopback callers bypass them (§2.5).
- Elicitation is declared by Claude Code but untested. Not used.
- Dev `options.json` has `upnp: true` (READ). INFERRED: Foundry `:30000` may be reachable externally. Agent users must
  have passwords.
- The rules in `.claude/claude.md` say e2e builds to `test/build/`, while the e2e build writes to `dist/` (the root
  ignore lines for e2e chunks are gone). Out of this plan; flag only.
- Context measurements are single runs on one model's tokenizer (`claude-haiku-5-5`); other models may count
  differently. Byte budgets plus the recalibration script contain this.
- Claude Code's deferral, inline-result cap and `_meta` annotations are client behaviour that can change between
  versions (MEASURED (coord.) on 2.1.296; docs READ 2026-10-11). The budgets do not depend on deferral; the
  per-script-tool exposure (D18) and D21 option (b) do.
- Script catalogue sprawl raises the always-listed name cost (≈13 tokens per tool); the ≤ 30 cap forces review.
- Shared `test-titan` world with TITAN e2e (§4.8): leftover combats or orphan tokens fail TITAN's run.

## 8. Out of scope / deferred (log in `docs/TODO.md` when this plan is accepted)

- MCP stdio transport; MCP sampling (unsupported by Claude Code, MEASURED (coord.)).
- Offline LevelDB/compendium writes while the world is stopped; a Foundry REST layer.
- True per-user execution for non-agent users via `User#query` (only advisory `actAs` is built).
- Wiretap-level multi-step undo history beyond `undo_last`.
- Rate limiting / quotas per MCP session.
- Node-side plugin handlers.
- Structured chat UI (existing TODO).
- Dispatcher exposure mode (D19; already in `docs/TODO.md`).
- Persisting handles across sidecar restarts.
- Compendium pack creation/deletion tools (§9 C1).

## 9. Contradictions and items needing confirmation

- **C1 Deletion (resolved, one residue).** The user clarified that the ban is on deleting files; Foundry documents
  may be deleted through Foundry document calls (D12). Residue: `CompendiumCollection#deleteCompendium` (used by
  TITAN's teardown, READ `global-teardown.js:113`) makes the Foundry server delete the pack's LevelDB files on disk
  (INFERRED from what a world pack is; the server code was not read). It is a Foundry call but removes files, so the
  plan does not expose pack deletion; Wiretap tests do not create world packs. Confirm with the user before any pack
  tool exists.
- **C2 Test files.** The brief says "fixed names under `test/tmp`". The `wiretap-build-test` skill says unique
  `<pid>-<counter>` roots that must not pre-exist. The plan follows the skill. The §4.8 running list is a fixed,
  overwritten file outside `test/tmp/` (TITAN uses `test/state/registry.json`); its Wiretap location is DECIDED
  (accepted 2026-10-11): `test/state/registry.json`, gitignored, overwritten, never deleted (same as TITAN).
- **C3 "Authenticated sidecar socket" for credential push.** In the default loopback mode the socket is
  unauthenticated by D6. It is authenticated only in external mode (M10).
- **C4 Build hygiene.** `.claude/claude.md` says stale built files are deleted after every build, which conflicts
  with the no-file-deletion rule. Not touched by this plan.
- **C5 `exportToJSON` format.** It drops `_id`, `sort`, `ownership`, `author` by default (READ
  `client-document.mjs:1113-1134`). Reads keep them (`keepId`, D14 DECIDED). `export_to_handle` keeps ids;
  `import_from_handle` in `create` mode drops them so a copy gets new ids.
- **C6 D14 vs the context priority (resolved).** The user agreed (D24) that the compact view is the default and the
  D14 export is reached with `mode:"full"` or `paths`.
- **C7 Scripts as code execution.** Shipped and plugin scripts are vetted or installed code. Agent-saved scripts are
  arbitrary GM-authority code; under the user's position (D21 a) the only checkpoint is Claude Code's permission
  system, which loopback callers and non-Claude clients bypass and which does not prompt in bypass/auto modes or
  under broad allow rules (§2.5). Option (b) narrows but does not remove this; the residual risk is stated, not
  hidden.
- **C8 Agent-script store growth.** No file or entry deletion is allowed, so `.wiretap/agent-scripts.json` only grows
  with versions; a total-size cap refuses new saves instead of pruning. Clearing it is a manual user action outside
  Wiretap.
- **C9 Rule source for "no backwards compatibility".** READ `.claude/claude.md:25` ("until further notice"). Plan
  items that assumed compatibility (the `create_actor` alias option, protocol v1 support) are removed; the protocol
  version check remains as a refusal, which the rule does not forbid.

## 10. Changes made in this revision

The revision history (revisions 2 to 6) is in [`docs/PROGRESS.md`](PROGRESS.md), section "Revision history". The
section number stays because other documents cite it.
