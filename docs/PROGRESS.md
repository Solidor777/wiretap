# Wiretap progress

Work history for the plan in [`PLAN.md`](PLAN.md): which milestones are done, when, with which commits, the results
they produced, and the revision history of the plan. The plan holds the forward-looking design; this file holds what
has happened. Update the completion table when a milestone finishes. Index of all docs: [`README.md`](README.md).

## Milestone completion

Dates and commits are read from `git log` (author dates). A milestone's range lists its feature, documentation and
follow-up commits in order. Test counts at each milestone's completion are not recorded in any commit message or
document, so none are stated here; the count at the time this file was written is below the table.

| Milestone | Status | Date | Commits | Results and specs |
|---|---|---|---|---|
| M0 Experiments against Foundry | Done | 2026-10-11 | `14dc1c9` (results and plan revision 5) | [`experiments/2026-10-m0-results.md`](experiments/2026-10-m0-results.md); outcomes below |
| M1 Endpoint registry, routing, protocol v2 | Done | 2026-10-11 | `df905f0` (spec), `7f5ba95`, `75e41e3`, `fb88bd8`; health addendum `d2bc99e`, `1e6c00a`, `b6504cf`; spec addendum `3162b32` | [`specs/2026-10-11-wiretap-m1-endpoint-registry-design.md`](specs/2026-10-11-wiretap-m1-endpoint-registry-design.md) |
| M13 Context-budget harness, result enforcer, handle store, path resolver | Done | 2026-10-11 | `e672583`, `c810a24`, `1701020`, `ffce097`, `1cf0aac`, `7816dbf` | calibration table below; `tests/measure/measureContext.mjs` |
| M2 Risk-gate options | Done | 2026-10-11 | `718b5b4`, `b38193d`, `4f1fcba`, `efdae9b` (protocol version 3) | gate table in `shared/gates.js`; PLAN.md section 4.6 |
| M3 Stateful MCP sessions | Done | 2026-10-12 to 2026-10-13 | `0de73da` (sessions, registry, HTTP hardening), `1030fdb` (build output to `dist/`), `36f2b59` (skills, results, rules) | [`experiments/2026-10-m3-results.md`](experiments/2026-10-m3-results.md) (live check run 2026-10-12) |
| M14 Script runtime and the discovery layer | Done | 2026-10-13 | `8786fdd`, `a6a9d6c`, `43b7e57`, `f7fac20` | [`PLAN.md`](PLAN.md) section 4.5 as-built note; client runtime in `src/bridge/scripts/`; user-facing skill `skills/wiretap/SKILL.md` |
| M5 Core write tools | Done | 2026-10-13 to 2026-11-20 | `248ee4a`, `948f4cc`, `f9e4fe0` (phase A); `9511623`, `1f4fd50` (phase B) | [`PLAN.md`](PLAN.md) M5 as-built notes (phase A and review fixes); `create_documents`, `update_documents`, `delete_documents` in `src/bridge/scripts/`; measured after the review fixes: `npm test` 74 files, 2016 passed, 1 skipped; headless e2e 40 passed, 1 skipped; 8 tools, 4,490 B of definitions (`tests/measure/measureContext.mjs`). Phase B and review fixes (2026-10-13, MEASURED): `replace_document`, `batch`, `actAs`, `idempotencyKey`, handle inputs, strict arguments, the `_id` and `flags.wiretap` guard rules, batch settle and repair; `npm test` 89 files, 2274 passed, 1 skipped; headless e2e 54 passed, 1 skipped; 10 tools, 6,202 B of definitions (`replace_document` 562 B, `batch` 795 B); 50-document `create_documents` ack 3,541 B; mutation runs: round 1 `mutation-m5b.txt` (17 killed), round 2 `mutation-m5c.txt` (39, 37 killed, 2 equivalent), round 3 `mutation-m5d.txt` (20 plus 1 re-run, all killed but one equivalent: the `flags` value wrap by prefix-stripped key), round 4 `mutation-m5e.txt` (15, all killed); e2e output in `debug/dumps/e2e-final-m5e.txt`; `allowDelete` and `allowReplace` gates added |
| M4 Core read tools | Done | 2026-10-13 | `4d18a51`, `5e1c59f`, `b27144b`, `5fd4801` | [`PLAN.md`](PLAN.md) M4 as-built notes (phases A and B); [`experiments/2026-10-m4-keyfields.md`](experiments/2026-10-m4-keyfields.md); `list_document_types`, `get_document`, `search_documents`, `describe_schema` in `src/bridge/scripts/` |
| M6 Sheets and gameplay | Done | 2026-11-20 | `fab9300` (plan); `823e070`, `3aeba20`, `c601f8b`, `e5da1ff`, `acec4dd`, `f3b7d38` (tasks 1 to 6); `bbbdcd1`, `4dbf3bf`, `15984e8`, `f08ec17`, `11940fe`, `44c9ac5`, `7fe13ce`, `c3f5129` (buddy-check fixes and plan edits); `8c58704`, `6bc5b2a`, `9e245a2` (e2e); `6a3f7cb`, `717da53` (docs); `418e6f9`, `7887884` (final-review minors) | [`plans/2026-11-20-wiretap-m6-sheets-gameplay.md`](plans/2026-11-20-wiretap-m6-sheets-gameplay.md); as-built notes below; `open_sheet`, `close_sheet`, `roll`, `draw_table`, `execute_macro` in `src/bridge/scripts/`; 15 tools, 8,149 B of definitions |
| M21 Document backups | Done | 2026-11-21 | `253257f`, `3914297` (design and plan); `393ac25`, `302d9f9`, `517fb81`, `723a3ad`, `76b9ad8`, `9a6f979`, `a8b78d1`, `9c30bb4`, `e4c2085`, `b61251f`, `cd2967a`, `d5b3960`, `da9bd16`, `fa9e809` (features and fixes); `80403c5`, `79f94ac`, `8f820be`, `f9bc54a` (tests); merges `1881516`, `8570e4f`, `18fc7b1`, `f5409a4`, `ec5a77e`, `8433951`, `176d540`, `eb570e0`, `b70cbc1`, `640f155`; `docs: close M21; progress, README and skills` | [`specs/2026-11-21-wiretap-backups-design.md`](specs/2026-11-21-wiretap-backups-design.md), [`plans/2026-11-21-wiretap-m21-backups.md`](plans/2026-11-21-wiretap-m21-backups.md); as-built notes below; `backup_documents`, `list_backups`, `restore_backup`, `delete_backup` in `server/backupTools.ts`; 19 tools, 10,426 B of definitions |
| M18 Compendium pack tools | Done | 2026-11-21 | `10ffd14`, `75ef915` (design and plan); `a7ce589`, `b4f9f24`, `214426b`, `3b6787b`, `d372696`, `72c6af2`, `b41ab2e` (features and fix); `a48ffd2`, `869a36d`, `989582d`, `e15d83b`, `1361027` (tests); merges `c9773e5`, `ae02d1c`, `f239556`, `5d8da73`, `853581a`, `f47640c`, `9cbf590`, `bab19f8`, `02bda56`, `86aaa0e`, `bf0b67e`; `7c3bbb6`, `343465e` and the final-review docs commit (docs) | [`specs/2026-11-21-wiretap-pack-tools-design.md`](specs/2026-11-21-wiretap-pack-tools-design.md), [`plans/2026-11-21-wiretap-m18-pack-tools.md`](plans/2026-11-21-wiretap-m18-pack-tools.md); as-built notes below; `create_pack`, `delete_pack` in `src/bridge/scripts/`; the `allowPackDeletion` gate; 21 tools, 11,330 B of definitions |

Current suite (MEASURED 2026-11-21, `npm test`): 129 test files passed, 2880 tests passed, 2 skipped (2882). Headless
e2e: the last full run (before M6) was 56 passed, 1 skipped (`keyFields.measure.spec.js`, skipped unless
`WIRETAP_MEASURE_KEYFIELDS=1`); the three M6 specs, the M21 specs `backupTools.spec.js` and `gates.spec.js`, and the
M18 spec `packTools.spec.js` were run on their own (see M6, M21 and M18 below). A full e2e run after M6 has not been
made.

Next milestone in the order of PLAN.md section 5: M15a (M17 dropped by D29, revision 7; M21 added by D33, revision 8,
and done; M18 done).

## M0 status and deviations

**Status: DONE 2026-10-11.** Results: [`experiments/2026-10-m0-results.md`](experiments/2026-10-m0-results.md)
(condensed from the raw JSON in the session scratchpad and checked against it). Run on the launcher
(`npm run foundry:start`; spawn → listening 26.5 s cold, 4.9 s warm). Every experiment ran; deviations from the
procedure in the M0 specification (docs/PLAN.md, M0): E2 did not measure delete fidelity; E7 ran one restart (not two) as the pre-existing GAMEMASTER
`E2E GM 1` and used the launcher's `--world` flag instead of `options.json`; the three `wtx-*` users were deleted at the
end through Foundry document deletion (the M0 safety limit said they would be kept). No files were deleted.

**Outcomes:**

| Exp | Outcome (MEASURED (coord.)) | Decision |
|---|---|---|
| P1 | PASS: no password, hash or salt client-visible for any role on any path; an anonymous `/join` session receives the full user list (names, roles) | D3 premise holds |
| E1 | PASS at socket level (12 samples over 55 s, broadcasts in 14–15 ms), but the stock join form refuses an already-active user | D4: dedicated agent users |
| E2 | Every create class differs; valid system-field updates identical; server stores invalid `system` data; unknown subtype rejected; raw Scene broken | D1 boundary (§4.3), D27 |
| E3 | Shell + noCanvas: ready 1.8 s, 438.7 MB WS / 294.8 MB private, 18.2 % of one core idle, 5 processes; drawn canvas on the shell 608 %; an MCP call before identify completes fails | D2 profile; M9 |
| E4 | ASSISTANT `isGM` true, never outranks a GAMEMASTER for `activeGM`, cannot promote to GAMEMASTER; can create Users, Settings, compendium entries | D4 |
| E7 | After a restart the page reconnects in 17.4 s, is then redirected to `/join` and stays there; the bridge does not re-identify; a fresh login recovers in 2.1 s (7.8 s after the restart flag) | M9 recovery design |
| E8 | Actor schema walk 19.9 KB, Items 2.0–2.6 KB, Adventure 26.5 KB; blank export Actor 4.85 KB; 7 classes cannot be constructed blank | D15 |
| E9 | Titan full actor exports 5.7–12.5 KB; compact ≤ 1,574 B; projections 199–1,224 B; `sheet_layout` depth 2 too shallow (≤ 441 B); actor sheet 850×926 PNG 111–115 KB | §2.6 confirmed except D28 |

## M13 calibration

**Shipped surface against the PLAN.md §2.6 budgets (MEASURED 2026-10-11, `npx tsx tests/measure/measureContext.mjs`, in-process
real MCP server with a fake GM client, synthetic `MOCK_` fixtures; sizes are UTF-8 bytes counted as PLAN.md §2.6 counts them;
the token column is bytes / 2, INFERRED from the ratio above, not a live Claude Code count; the live `/context`
comparison of the script's header has not been run):**

| Item | Bytes | Budget | Est. tokens |
|---|---|---|---|
| `create_actor` definition (name 12 chars, description 152 chars) | 503 | 800 | 252 |
| `read_handle` definition (name 11 chars, description 87 chars) | 766 | 800 | 383 |
| All shipped definitions (2 tools) | 1,269 | 16,000 (30 tools) | 635 |
| `create_actor` ack, typical | 61 | 256 | 31 |
| `create_actor` ack, every field at its 256-byte bound (becomes a handle) | 81 | 256 | 41 |
| `create_actor` failure, 2,600-character message | 512 | 512 | 256 |
| `read_handle` default window | 7,977 | 8,000 | 3,989 |
| `read_handle` `paths` window cut at the cap | 7,992 | 8,000 | 3,996 |
| Result of 100 KB, handle response | 197 | 256 | 99 |

## Baseline notes

- The plan was written against HEAD `048df55` (before M1). The line citations in PLAN.md section 1 describe that
  snapshot; M1 replaced `invokeOnGM` and first-socket routing with the endpoint registry and router.
- The plan header stated "draft for approval, revision 5 (2026-10-11: M0 done and folded in, results in
  `experiments/2026-10-m0-results.md`; see section 10)" and "Baseline: HEAD `048df55`". The latest revision entry below
  is revision 6.

## Revision history

### Revision entries (moved from PLAN.md section 10)

**Revision 3 (2026-10-11):**

- Evidence labels: every "MEASURED by user" is now "MEASURED (coord.)" (the coordinator's experiment agents), defined
  in the header.
- Header: the no-backwards-compatibility rule; applied throughout (D16 removal, protocol v1 refused, `create_actor`
  removed in M5, M1/M14 wording).
- Decisions: DECIDED D5, D11, D12, D14 (incl. `keepId`), D16, D18 (incl. skills as discovery), D20 (adoption), D22 (not
  built), D23, D24, D25; D19 DEFERRED; new D12a (delete gate, PENDING-USER), D21 restated around Claude Code
  permissions (PENDING-USER), new D26 path-scoped reads/writes (PENDING-USER).
- §2: path-slice measurements (`pathsizes.mjs`, no new `claude -p` runs); deferral facts cross-checked against the
  Claude Code docs; ranking adds skills and paths; §2.5 rewritten (Claude Code permission facts READ, options a/b/c,
  recommendation b, sidecar store instead of a `wiretap.*` setting, invariants S1–S7); §2.6 final budgets with hard vs
  warning and † changes (core names 32, plugin names 64, description 160/240, compact tuple cap 40, hard cap 8 KB
  default with `maxBytes` ≤ 16 KB); new §2.7 skills as discovery layer; new §2.8 path-scoped reads and writes;
  catalogue renumbered §2.9 (`get_document`/`update_documents`/`delete_documents` rows, `edit` merged into
  `update_documents`, `propose_script` replaced by `save_script`/`disable_script`).
- Architecture: path resolver `shared/docPath.js`; agent-script store replaces the proposal log and the approval UI;
  `bridge:proposals` removed; server `instructions`; gates `allowAgentScripts` (replaces `allowApprovedScripts`),
  `allowAdhocCode` removed; `allowDelete`/`allowUndo` per D12a; new §4.8 test-data cleanup pattern read from TITAN.
- Milestones: shared rules split file deletion (banned) from document deletion (allowed); M0 status and launcher
  prerequisite, delete-only-own-`wtx-` rule, delete in E2/E4, path sizes in E8/E9, no combats/tokens left; M1 v1
  refused; M13 adds `docPath.js`, hard/warn budgets and the skill-reference check; M3 no longer "confirm at start",
  adds `instructions`; M14 adds the discovery layer; M4 `paths`; M5 path writes, `delete_documents`, `create_actor`
  removal; M6 `undo_last` per D12a; M16 rewritten for D21 options; e2e milestones use the §4.8 teardown; M12 census.
- §7–§9: risks for deletes, permission bypass, shared world; C1 and C6 resolved (C1 keeps the pack-deletion residue);
  C7, C8 updated; C9 added.

**Revision 2 (2026-10-10):** added G0 and §2 (cost model, ranking, script verdict, design, catalogue, budgets);
renumbered sections; D17–D25; architecture components for budgets, handles and scripts; milestones M13–M16; a
context-budget criterion in every milestone.

**Revision 4 (2026-10-11):** the user accepted the open recommendations: D12a (no gate for ordinary document
deletes; `User`/`Setting` deletes stay behind their gates; no pack deletion), D20 † value changes (8 KB default hard
cap, name and description limits), D21 option (b) (Claude Code permissions plus the minimal Wiretap safeguards), D26
(`paths` parameter on `get_document`, shared grammar), the three proposed extra gates (`allowOwnershipWrites`,
`allowCompendiumWrites`, `allowModuleConfigWrites`) and the e2e running-list location. No PENDING-USER decisions
remain except those that wait on M0 results.

**Revision 5 (2026-10-11): M0 results folded in.**

- M0 marked DONE with an outcome table and its deviations; results recorded in
  `experiments/2026-10-m0-results.md` (condensed from the raw JSON and checked against it, including E7 and the
  experiment agent's corrections: the E4 role-2 rerun, the E2 malformed-path rerun, the E7 `autoRecovered` false
  positive).
- Decisions now DECIDED with M0 evidence: D1 (B-eligible = source reads only; the per-operation table in §4.3), D2
  (headless shell + `core.noCanvas` as the default agent profile), D3 (P1 PASS), D4 (ASSISTANT agents on dedicated
  users; activeGM implication stated), D15 (E8-driven `describe_schema`: blank export + outline, constraints only with
  `path`). New PENDING-USER: D27 (drop M11, recommended) and D28 (screenshot default as pixel area).
- §2.6: E9 confirms the compact (≤ 1,574 B) and projection budgets; notes that titan full actor exports exceed the 8 KB
  default cap; `sheet_layout` depth to be measured in M15b; screenshot default rephrased (‡, D28).
- Milestones: all BLOCKED-BY-M0 markers removed (M4, M8, M9, M11, M15b); M1 adds an identify acknowledgement; M4
  `describe_schema` design per E8 and compact view from the E9 prototype; M8 role and password warnings; M9 rewritten
  around the default profile, identify-ack wait, `/join`-redirect re-login recovery (E7), measured resource and
  recovery budgets and a restart e2e; M10 anonymous user-listing note; M11 reduced to a read-only form pending D27;
  M15b `sheet_layout` depth measurement.
- §7: risks for server-accepted invalid data, the server `TypeError` noise, anonymous user listing, the agent as
  active GM, login-not-reconnect recovery and the launcher defect; the obsolete "E2 may show" risk removed.

**Revision 6 (2026-10-11):** the user accepted D27 (drop M11, the raw-socket executor; logged in `TODO.md`) and D28
(screenshot default as a pixel area of at most 480,000 px, aspect kept). No PENDING-USER decisions remain.

**Revision 7 (2026-11-21):** the user dropped M17 (multi-step undo). D29 now records the drop; the `allowUndo` gate row,
the `undo_last` tool mentions and the M17 section were removed from PLAN.md; the item is logged in `TODO.md`. The code
already had no undo gate (`shared/gates.js`, `tests/unit/gates.test.js`).

**Revision 8 (2026-11-21):** the user chose document backups in place of undo (D33, new milestone M21 ahead of M18,
design `specs/2026-11-21-wiretap-backups-design.md`), approved the `trash` npm dependency and changed the file rule to
recycle-bin removal only (D34). The user delegated the remaining design calls; they are marked "designer's call" in
the design.

## As-built notes (moved from PLAN.md)

Per-milestone implementation notes: argument shapes, measured results, review fixes. The current state of the code is in the `wiretap-*` skills; this section is the record.

### As-built notes: M14 registry protocol (was PLAN section 4.5)

`apiVersion` is the integer `SCRIPT_API_VERSION` (1) and a payload with another value, or a plain array, is refused
  whole (the endpoint's list is cleared and the ack is `OP_FAILED`). A `ScriptDefinition` (`shared/scripts.js`, one
  validator for both sides) is `{name, version, description, inputSchema, result: {budgetBytes}, requires, mutates,
  gate?, moduleId?}`. `result.shape` of §2.4 is not on the wire (the result shaping runs in the client handler).
  `source` (shipped|plugin|agent) is not a field: the registering route implies it and the validator takes it as an
  argument; only `shipped` is accepted today and a valid plugin or agent definition is refused with "not supported by
  this version of Wiretap". `requires` and `mutates` are required and never defaulted; `requires: 'none'` (sidecar
  scripts) is valid in the shared shape but refused when a client registers it. `version` is a semver-like string of
  at most 32 characters (`SCRIPT_VERSION_MAX_CHARS`); `gate` is a name in `GATES` other than `allowedPluginModules`;
  `moduleId` is plugin-only. Each event replaces the endpoint's whole list (an empty `scripts` clears it); the ack is
  `{ok, accepted, refused}` (`NOT_GM` for an unregistered socket). The sidecar validates every entry with the shared
  validator and the sidecar-only conversion: names of at most 32 characters (`CORE_TOOL_NAME_MAX_CHARS`; plugin and
  agent names would be 64) and at most 30 tools in all (`ALWAYS_LISTED_TOOLS_MAX` less the built-in `read_handle`);
  the JSON Schema is a documented subset (depth 4, 64 nodes, 32 properties, string enums of at most 32 values) and
  `$ref`, combinators, `pattern`, `format`, `default`, `const` and `Object.prototype`-named properties are refused.
  Every script is listed as an MCP tool with `readOnlyHint = !mutates`; `destructiveHint` is not set. A call runs
  the `callTool` op with `{name, arguments}`; the executing endpoint is resolved by name at call time and its own
  declaration of the tool supplies the gate and the result budget (`TOOL_GONE` when it no longer registers the name or
  declares a different argument schema, `requires` or `mutates`; `GATE_DENIED` when its declared gate differs from the
  listed one). `requires: 'dom'` scripts route to a `dom: true` endpoint of the `agent` kind only (D25), or of the
  kind the session fixed with `?endpoint=`; with none, the call fails with `NO_ENDPOINT` naming the missing kind. An
  MCP session picks its endpoint kind with `?endpoint=human|agent` on the initialize URL. No script tool is a
  sidecar handler: the sidecar's only built-in tool is `read_handle`, and the client registers every other tool as a
  script (`src/bridge/scripts/`). The client sends the registry after every acknowledged identify and whenever a script
  registers. Its `callTool` handler finds the script by name, judges the declared gate from its own settings
  (`GATE_DENIED`), validates the arguments with `shared/schemaValidate.js` (`ARGS_INVALID`), and runs the handler under
  an 8 s limit (`SCRIPT_TIMEOUT`); a result that cannot be serialized or exceeds 900,000 bytes is refused
  (`RESULT_INVALID`, `RESULT_TOO_LARGE`).

### As-built notes: M4

**As built, phase A (2026-10-13; `list_document_types` and `get_document`; `search_documents` and `describe_schema`
follow):**

- `src/bridge/scripts/canonical.js` holds the canonical export (`exportDocument`: §4.4 options, `uuid` added, `Set` to
  array) and `resolveDocument` (uuid, world id, `pack`, `parentUuid`). The exclusions apply there: a `Setting` whose key
  starts with `wiretap.` (any case) or has no text key is `DOC_EXCLUDED`; `password` and `passwordSalt` are removed from
  a `User` export, source and derived, so a path to one is in `missing`. `ctx.core.readDocument` is the one entry the
  scripts use; `search_documents` must read through it.
- `get_document` arguments: `uuid`, or `documentName` and `id` with `parentUuid` or `pack`; `mode` (`compact` default,
  `full`), `fields`, `paths` (both up to 20), `derived`, `ifModifiedSince`, `maxBytes` (128 to 16,000, declared so the
  enforcer receives it). `paths`, `fields` and `mode: "full"` are mutually exclusive; `derived` needs `paths` or
  `fields` and reads `toObject(false)`. The result budget is 16,000 B; the sidecar enforcer makes handles.
- `ctx.shape.compact` gained `keyPaths` (exact dotted paths below `system`, in order) and a `modified` header from
  `_stats.modifiedTime`; both count inside the 2,000-byte bound. The key-field lists are paths, not key names: a titan
  Actor holds 44 `baseValue` leaves (MEASURED on the blank export), so a key-name pattern fills the 24 leaves with skill
  rows. The lists exist for the `titan` system only (`docs/experiments/2026-10-m4-keyfields.md`, `docs/TODO.md`).
- `list_document_types` returns `{ system, world, embedded, packOnly?, subtypes, omitted? }` within the new
  `DOCUMENT_TYPES_MAX_BYTES` (3,000) budget. Definitions are in `src/bridge/scripts/definitions.js` (relative imports
  only, so the `tsx`-run context measurement can load them): `get_document` 682 B, `list_document_types` 243 B listed.
- Measured on titan: compact views 60 to 1,191 B, `list_document_types` 1,522 B (`tests/e2e/readTools.spec.js`).

**As built, phase B (2026-10-13; `search_documents` and `describe_schema`):**

- `search.js`: candidates from the world collection, `parent.getEmbeddedCollection` or `pack.getIndex({ fields })` (only
  the filter and field paths; no document loaded; `Setting` and `User` refused with a pack). Live documents pass
  `canonical.unreadable()` and filters and fields read `exportDocument`; a filter or field on a User password path is
  `PATH_EXCLUDED`. Filters are `path=value` strings (<= 5, equality on the scalar as text) because the schema subset has no
  mixed-type value. Order: name cut to 40 B, then uuid; the cursor encodes that key, so it is a position and not an
  offset. Rows are cut from the end to fit `SEARCH_PAGE_MAX_BYTES`. `maxBytes` is not declared (the page budget is the
  tool's cap). See the review fixes below for the work bounds.
- `schemaWalk.js` and `schemaDescribe.js`: the walker reads class names along the prototype chain (free-form: ObjectField,
  AnyField, JSONField, TypedObjectField, TypedSchemaField; referenced by document name: collections, embedded documents,
  foreign keys; TypeDataField resolved by subtype), bounded by depth 3, 150 nodes and a cycle guard. Without `path` the
  result is the blank export (built in memory, canonical export) plus one-level outlines; with `path` the blank subtree
  plus the constraints of the field. `DESCRIBE_SCHEMA_MAX_BYTES` (8,000) is held by cutting the example, then the
  outlines, and by re-walking a path at a smaller depth.
- Measured on titan (`tests/e2e/searchSchema.spec.js`): 105 `describe_schema` calls (every class, its default subtype and
  every subtype), the largest 5,784 B; blank examples exist for every class except `ActorDelta` and `TableResult`. Listed
  definitions: `search_documents` 687 B, `describe_schema` 382 B (measured with `definitionBytes` after the review fixes
  below); the six tools list 3,223 B in all (the earlier 3,268 B minus the 45 B `search_documents` shrank; derived, not
  re-measured as a total; limits: 800 B each, 16,000 B, 30 tools).

**As built, review fixes (2026-10-13):**

- Secrets: see §4.4 (credential denylist, key-name redaction, limitations). The redaction sits in the one export
  function, so it covers every read path; unit tests use `MOCK_` values and e2e writes real `Setting` documents
  (`tests/e2e/readTools.spec.js`).
- `search_documents` work bounds (`shared/budgets.js`: `SEARCH_SCAN_MAX` 2,000, `SEARCH_EXPORT_MAX` 300,
  `SEARCH_BATCH_SIZE` 25): every readable document gets its ordering key from its live name (cheap), the candidates after
  the cursor are examined in that order, `name`, `type` and `folder` filters, the `type` argument and `query` read the live
  document, and a document is exported only for a filter on another path or for a page row with `fields` (once per
  document). The result is `{ rows, total, cut?, scanned?, nextCursor? }`: `total` counts the matches among the
  candidates examined from the cursor on, `cut` and `scanned` appear when a cap stopped the call, and `nextCursor` then
  resumes after the last candidate examined. The loop yields with a `MessageChannel` message (timers are clamped to 4 ms
  once nested) every 25 candidates and throws `SEARCH_ABORTED` when `ctx.signal` aborted, which the 8 s timeout sets.
  Unit tests count `toCompendium` calls over 4,500 and 1,000 synthetic actors.
- More than 5 filters are `ARGS_INVALID` in the engine as well as the schema. Field paths are limited to
  `SEARCH_FIELD_PATH_MAX_BYTES` (64) because rows echo them as keys, and a lone row whose values still overflow the
  page degrades to `[uuid, name, type]`. `maxBytes` is no longer declared by `search_documents`; the SDK strips it.
- Compendium searches ask `getIndex` for at most `SEARCH_INDEX_FIELDS_MAX` (5) distinct paths of at most
  `SEARCH_INDEX_SEGMENTS_MAX` (3) segments, never a whole `system`, `items`, `effects`, `flags`, `pages`, `results`,
  `prototypeToken` or `ownership` subtree. Side effect (READ `compendium-collection.mjs:334-367`): `getIndex` merges the
  requested fields into the pack's one index and records them as indexed for the session, so they stay for every later
  consumer; the bounds keep that growth small.
- `describe_schema`: a step below a list takes an integer index or `*` (else `PATH_NOT_FOUND`; a list without an element
  field is also `PATH_NOT_FOUND`); a path result cuts the example first and keeps the schema depth; a blank example
  that cannot be built is logged once through `ctx.log` (the registry's log sink; bounded and sanitized) and the
  result keeps `example: null`.
- `search_documents` cost and abort: the ordering keys of the whole class are built and sorted on every call, which is
  O(N log N) and uncapped (it yields every 25 documents); the scan after it is capped. The scan continues past `limit`
  matches until a cap or the end because `total` counts what it examined. A compendium `getIndex` is not abortable. The
  cursor is the base64url of the key text (name cut to 40 B, one NUL, uuid), at most 512 characters. A two-segment index
  path may still pull a whole `system.<x>` object into the shared index (whether it is an object is not known from the
  path). A row that lost its `fields` to fit the page sets `fieldsDropped: true` on the result.
- Error codes of the read tools: `ARGS_INVALID`, `DOC_NOT_FOUND`, `DOC_EXCLUDED`, `DOC_UNREADABLE`, `PATH_NOT_FOUND`,
  `PATH_EXCLUDED`, `PATH_EMBEDDED`, `PATH_FREE_FORM`, `PATH_UNSAFE_SEGMENT`, `PATH_INVALID`, `PATH_LIMIT`,
  `CURSOR_INVALID`, `SEARCH_ABORTED`.
- e2e coverage of acceptance (`tests/e2e/everyType.spec.js`): in the titan world every class of
  `CONST.ALL_DOCUMENT_TYPES` and every subtype is created as a recorded `Wiretap E2E ` document except what the spec
  lists: `Adventure` (compendium only) and `FogExploration` (no name field to carry the prefix) are never created, and
  `Folder.ActiveEffect` and `Folder.Adventure` are not attempted because creating one leaves a folder the world cannot
  delete (MEASURED: the client errors in `Folders#_onModifyContents`, and the server's `Folder#_preDelete` throws for a
  type without a world collection). 98 documents in 32 of 34 classes were created (embedded documents under recorded
  parents), each read in the compact view (largest 1,148 B, limit 2,000), and `list_document_types` equals
  `ALL_DOCUMENT_TYPES`. The registry (`tests/e2e/registryCore.js`) now holds `ChatMessage` (identified by `flavor`),
  `Combat`, `Setting` (key prefix `wiretap-e2e.`), `User` (never the signed-in user or a game master) and deletes in the
  order ChatMessage, Combat, Setting, User, Scene, Playlist, RollTable, JournalEntry, Macro, Cards, Actor, Item,
  Folder; embedded documents are never recorded because they go with their parent. The core credential setting
  itself is not created by e2e (a sweep could not tell a test copy from a real one); the denylist is covered by unit
  tests and the secret-key rule by real `Setting` documents.

### As-built notes: M5

**As built, phase A (2026-10-13; `create_documents`, `update_documents`, `delete_documents`):**

- Phase B (`replace_document`, `batch`, idempotency keys, `actAs`, handle inputs) is described below.
- Argument shapes (the argument-schema subset has no free-form object, so structured input is JSON text):
  `create_documents({ documentName, data: string[1..50], parentUuid?, pack?, keepId?, dryRun?, paths? })` with one JSON
  object text per document, at most 200,000 bytes of data in all (`WRITE_DATA_MAX_BYTES`);
  `update_documents({ updates: { uuid, path, value?, op? }[1..200], dryRun?, paths? })` with `value` as JSON text and
  `op` of `set` (default), `replace` or `delete`; `delete_documents({ uuids: string[1..50], dryRun? })`. Definitions
  measure 640 B, 709 B and 381 B (`tests/measure/measureContext.mjs`; 8 tools, 4,490 B in all).
- One choke point, `src/bridge/scripts/writeGuard.js` `guardWrite`, runs before validation and before every write
  API: the `User` password rule and the `wiretap.*` Setting deny (a by-id update resolves the key from the existing
  document; a Setting with no readable key is refused) hold whatever the gates say; then the category gates are read
  from THIS client's settings at call time: `allowUserWrites`, `allowSettingWrites`, `allowModuleConfigWrites`
  (`core.moduleConfiguration`), `allowFileUpload` (a base64 data URI anywhere in the values; a superset of the file
  paths the gate names, because the value scan cannot tell a file field from other text), `allowOwnershipWrites` (an
  `ownership` key in values or paths) and `allowCompendiumWrites` (a `pack`, or a parent inside a pack). No gate is
  declared on the three definitions because no one gate covers a whole tool.
- Validation: Foundry validates the cleaned data without writing; failures return as one `VALIDATION_FAILED` error
  (new code) with at most 10 failures and the true `failureCount` in 512 B, nothing written. `dryRun` returns the
  same ack shape marked `dryRun: true` and calls no create, update or delete API. New codes: `VALIDATION_FAILED`,
  `DELETE_REFUSED` (a compendium pack, the signed-in user, the last game master), `WRITE_NOT_APPLIED` (a hook or the
  system cancelled part of the call).
- Acks: `[{uuid, name, type}]` (a batch of 50 measures 3,541 B), `[{uuid, changed[]}]` (`changed` is empty when Foundry
  applied nothing), and a delete dry run `{dryRun, rows, total, cut?}` within the hard cap. `ScriptError` carries
  `details = { failures, failureCount }`, which `src/bridge/foundryBridge.js` acks (at most 10 failures).
- `create_actor` is removed from code, tests, README and skills.
- Review fixes (2026-10-13): a Setting is judged by its `key` text alone (a `namespace` is never read; Foundry's
  `Setting` schema has no such field and prunes it, MEASURED in the live world by `tests/e2e/writeTools.spec.js`);
  data and path keys are split on `.` and an `ownership` segment (also behind a `-=` or `==` operator prefix) needs
  `allowOwnershipWrites`, because Foundry expands dotted keys (MEASURED: `{ 'ownership.default': 3 }` stored
  `ownership.default` 3); `findUnsafeValue` refuses any dotted segment that is an `UNSAFE_SEGMENTS` entry or an
  `Object.prototype` name; an update resolves each uuid to a document (a compendium pack uuid or a non-document is
  `ARGS_INVALID`) and refuses a document written twice, counted by canonical uuid, embedded documents included; a
  later update that fails after earlier ones applied is `WRITE_NOT_APPLIED` naming the applied uuids; created names
  are cleaned and bounded; a row with read-back stays within 256 B (`cut: true` otherwise).
- MEASURED on Foundry 14.364 (`debug/dumps/probe-validation.json` when kept): `DataModelValidationError.getAllFailures()`
  returns `{}` for a real failure and `getFailure()` with no key returns the root tree, so `failuresOf` walks the tree.

**As built, phase B and its review fixes (2026-10-13; `replace_document`, `batch`, `actAs`, `idempotencyKey`, handle inputs):**

- Argument shapes: `replace_document({ uuid, data, dryRun?, actAs?, paths? })` (`data` is one JSON object text);
  `batch({ creates?: { documentName, data, parentUuid? }[], updates?: { uuid, path, value?, op? }[], deletes?: string[],
  dryRun?, actAs? })`; `actAs?` on `create_documents`, `update_documents` and `delete_documents`; `idempotencyKey?` (1 to
  64 characters) on `create_documents`. The batch schema is flat (one document per create entry, no `pack`, no `keepId`,
  flat patches) because the raw definition must stay within 800 B and depth 4.
- Strict arguments (shared-contract change): a definition with `additionalProperties: false` now REJECTS an undeclared
  argument on both validators (`shared/schemaValidate.js`: "has a property that is not an argument"; the sidecar's zod
  schema is `.strict()` through `argumentSchema`), where it used to drop it silently. A misspelled `dryrun` therefore
  fails instead of running a real write. zod ignores an own `__proto__` key instead of refusing it, so the parity test
  asserts client rejection and absence from the sidecar's parsed data. The client's listed form
  (`shared/schemaValidate.js` `listedNode`) now emits `additionalProperties: false` for a strict object, so the client
  and the sidecar measure the same bytes (`tests/unit/schemaStrict.test.js` compares every shipped definition).
- Batch entries (`strictNested`): MEASURED, an undeclared key inside an entry never reaches a handler: the sidecar's zod
  parse strips it (a `parent` typo for `parentUuid` arrived as a world-level create) and the client validator copies
  declared properties only. Listing the entries strict costs definition bytes (listed 880 B with strict entries, 915 B
  with `required`, about 70 B more with an `op` enum and `maxLength` bounds, against 800 B), so a definition may set
  `strictNested: true` instead (`shared/scripts.js`; not listed, part of `schemaSignature`): every object below the root
  then refuses an undeclared key on both validators, and the sidecar keeps the listed schema free of the nested
  `additionalProperties` by overriding that key in the zod JSON output (`toolRegistry.ts`). Only `batch` sets it. This is
  a new definition field and a deviation from "the handler validates entries": surfaced to the coordinator for
  confirmation. `replace_document` lists at 562 B, `batch` at 795 B.
- `replace_document` (`writeReplace.js`) mirrors `ClientDocument#importFromJSON` in Foundry 14.364
  (`client/documents/abstract/client-document.mjs`, `importFromJSON` and `fromImport`): `fromImport` (strict, with
  `dropInvalidEmbedded`), `toObject`, the steps of `WorldCollection#fromCompendium`, the `metadata.preserveOnImport`
  fields dropped (`_id`, `sort`, `ownership`, `folder`), then `update(data, { diff: false, recursive: false })` WITH hooks
  (the core import passes `noHook: true`; MEASURED by the e2e: a `preUpdateActor` listener saw the new name once).
  Consequence (MEASURED live): every top-level field the data omits resets to its default; omitting `items` or `effects`
  empties the collection and omitting `flags` wipes every module's flags. A full read with one change in it round-trips;
  a sparse object does not (use `update_documents` for a sparse change). `_stats.coreVersion` is always set to
  `game.version`, because another version makes `fromImport` ask the server to migrate the data. Only a
  `DataModelValidationError` becomes `VALIDATION_FAILED`; any other error passes through. Primary classes only
  (embedded uuid: `ARGS_INVALID`); `User` is refused (`ARGS_INVALID`, use `update_documents`) because a replace resets
  the password and role. `guardWrite` judges the given data and again the computed replacement. The incoming
  `flags.wiretap` scope is stripped and the live one carried over, so a full read round-trips and idempotency records
  survive; every other module's flags are replaced like any other field.
- `_id` and `flags` rules (`shared/docPath.js`, `writeGuard.js`, `writeFields.js`): `_id` is refused as a path segment
  at document and embedded level (`PATH_UNSAFE_SEGMENT`), and update operations are built as `{ ...changes, _id }` so the
  planned id always wins. A `flags` value that is not an object and an op `replace` or `delete` on a `flags` object
  (the document's or an embedded one's) or on its `wiretap` scope are refused (`GATE_DENIED`), because each would erase
  the idempotency records. The operator spellings are covered by "Operator spellings" below. MEASURED live on 14.364
  (`tests/e2e/writeTools.spec.js`): `{'==flags': {}}` erases all flags of an Actor and of an embedded Item (other
  modules' flags too), a bare `{'-=flags': null}` changes nothing, and `flags.-=wiretapE2e` removes one scope.
- `batch` (`writeBatch.js`, `writeBatchSettle.js`) is planned by the same planners as the single tools, so each
  sub-operation passes `guardWrite`, validation and the `actAs` check before anything is sent; the order is creates,
  updates, deletes; an operation cannot refer to a document an earlier one creates. READ in the Foundry 14.364 tree
  (`server-backend.mjs`, where the batch handler is the private method `#r`; the 14.369 main tree names it `#a`, so the
  behaviour is cited, not the minified name): the client preprocesses each operation and drops cancelled entries and
  no-op updates (an operation with nothing left stays unsent); the server validates all requests first and writes nothing
  if one fails, but it still answers with dry-run echoes of the requests that passed, which the client handles as real (a
  ghost create, a phantom delete); it then applies the requests one by one and stops at the first failure with no
  rollback: NOT atomic. The client backend shows errors only as notifications and resolves with the answered requests
  only. `batch` therefore matches results to operations by document id (not position), reports an unchanged or
  hook-cancelled update as `changed: []`, asks the server (`database.get`, `_id` equality per id; MEASURED: `$in` finds
  nothing) which documents exist after a failure, removes ghost creates from the client collection, restores
  phantom-deleted documents (a result is matched to an operation only when its parent is the operation's parent and, for
  a create, none of its ids is touched by another operation: a failed create used to take the echo of an update or of a
  create under another parent; Foundry deletes `operation.parent` while it sends the request, so the settle entry keeps
  the parent itself), and throws `WRITE_NOT_APPLIED` ("N of M operations applied, X unchanged, Y partly cancelled
  by a hook, Z cancelled by a hook, W failed, V not written; the batch is not atomic", at most 256 B, with the applied
  uuids). Limit: operations on compendium packs cannot be re-checked after a failure.
- `actAs` (`writeActAs.js`) is best-effort and advisory (decision D7; section 2.9 does not define it): the write always
  runs as the executing GM client and its gates stay the upper bound. After `guardWrite`, Foundry is asked `canUserModify`
  with `create`, `update` or `delete` for the named user, with dotted keys expanded first, and a refusal is
  `ACT_AS_DENIED` (at most 256 B) with nothing written. It can only add refusals. An unknown user is `ARGS_INVALID`.
- Idempotency (`writeIdempotency.js`), `create_documents` only: the key (`/^[A-Za-z0-9._:-]{1,64}$/`) is stored on every
  created document as `flags.wiretap.idem = { k, i, n, h, u, d }` (key, index, count, hash of the request, the writing
  user, the carrying document id); documents are created with client-chosen ids. A record counts only when `u` is the
  user of this client and `d` is the id of its document, so a copy of a document or a record another user planted is
  ignored (a guard against mistakes, not an authorization boundary). Complete records with the same hash replay the first
  call's rows (the replay honours `dryRun`, `actAs` and read-back); a different hash is `IDEMPOTENCY_CONFLICT` ("used by
  a different request"), and an incomplete set (a hook cancelled a document, or one was deleted since) is
  `IDEMPOTENCY_CONFLICT` saying "created k of n documents ... use a new idempotencyKey": the missing documents are never
  created behind the caller's back, the message names the remedy. The lookup reads at most `IDEMPOTENCY_SCAN_MAX` (20,000) documents of the collection and
  throws `IDEMPOTENCY_UNAVAILABLE` beyond it; calls with one class, parent and key run one after another
  (`withKeyLock`); two GM clients at once are not coordinated. Retention is 24 h by `_stats.createdTime`. The hash is
  cyrb53, non-cryptographic.
- Handle inputs (owner-approved option 1): a definition names up to four string or string-array arguments in
  `handleArgs` (`create_documents.data`, `replace_document.data`; not part of the listed definition, so it costs no
  budget). The sidecar (`server/handleInput.ts`, called by `makeRegistryToolHandler` in `server/mcp.ts`) replaces a text
  that equals `handle:<22-character id>` with the stored text BEFORE `bridge:invoke`, so resolution happens before the
  client's gate checks and the client still runs `guardWrite` on the resolved content. The handle must belong to the
  calling session (a foreign, unknown or expired handle is `HANDLE_NOT_FOUND`); the stored text must be the JSON text of
  ONE document (a `get_document` full read; anything else is `HANDLE_NOT_DOCUMENT`); each text is bounded by 100,000
  bytes and all texts together by `WRITE_DATA_MAX_BYTES` (200,000), checked by `HandleStore.read` before any text is
  returned (`HANDLE_TOO_LARGE`). Messages never carry stored text. Client scripts are unchanged.
- Delete and replace gates (owner decision): world-scope restricted settings `allowDelete` and `allowReplace`, default
  closed (`shared/gates.js`, `lang/en.json`, registered from the registry like every gate). `guardWrite` takes an
  `operation` (`delete` or `replace`) and a `dryRun` flag and reads the gate on the executing client at call time:
  `delete_documents`, the deletes of a `batch` (through `prepareDeletes`) and `replace_document`. A dry run needs no gate
  (chosen so an agent can preview what a deletion or replacement would do, and so it sees the closed gate only on the real
  call). No definition declares `gate`, because that check also stops previews and no one gate covers `batch`. A batch
  that deletes nothing needs neither gate. `tests/unit/riskGates.test.js` runs every risky script (and fails when a
  mutating script named delete, replace and so on, or `batch`, has no closed-gate denial case).
- Gate scope (third review, redone in the fifth): the gates cover every way to remove or replace embedded documents,
  not only the delete and replace tools. See "Operator spellings" below for the mechanism that now decides it. The
  paths `items` and `items.<id>` with any op stay `PATH_INVALID`; field-level `op: 'delete'` or `'replace'` of a plain
  field is an ordinary update, ungated. `replace_document` also needs `allowDelete` when the replacement drops embedded
  documents of any kind and depth (`droppedEmbedded`), and its ack, dry run included, carries `dropped`. `keepId` with an
  `_id` that exists is refused (MEASURED: the server overwrites the stored document, world and embedded, and the client
  keeps its old copy). An embedded update group is never `partial`: a dropped entry has no paths in the ack, as
  `changed: []` does for a single update.
- Operator spellings (fifth review round). Four review rounds had each found a new bypass of one class (flags
  operators, collection operators, wrapper objects, operators on nested collections, `==key` on a Setting, delta
  collections) because operator handling was text matching in about eight places. The cause: Foundry reaches one
  operator three ways (a `==` / `-=` key prefix per segment, an operator object, a serialized `__$OPERATOR$__` object),
  and each place knew one or two. Fix, one mechanism: `shared/writeKeys.js` is the only reader of the spellings
  (`isOperatorKey` is Foundry's `isDeletionKey`; `splitKey`, `keyNames`, `canonicalKey`, `hasOperatorSegment`,
  `isOperatorWrapper`); an operator exists only through the explicit `op` of an update patch; any other spelling in a
  path, patch value, create data or replace data is `PATH_OPERATOR`; gates come from the TARGET FIELD TYPE
  (`writeFields.js`: `reachesEmbedded` via `schema.getField`, `containsEmbedded`, `analyzeChanges` over the changes
  after `cleanChanges`, which runs the backend's `cleanData`), so `items.<id>.effects`, `tokens.<id>.delta` and
  `tokens.<id>.delta.items` are covered; `replace_document` counts drops by walking the schema (`walkEmbedded`), single
  embedded documents and the token delta included; a Setting is judged by the key the cleaned change leaves. Removed:
  `collectionOperations`, `rewritesFlags`, `namesReserveFlagScope`'s operator handling, `hasKeyOperator`, the local
  operator regex of `docPath.js`, `droppedBy`, the `paths` and `rewrites` fields of the guard intent and the
  `hierarchy`-based carry of the Wiretap record. MEASURED on 14.364 (e2e `records how Foundry treats every spelling of
  an operator`; table in `docs/POST_WORK_FINDINGS.md`). Tests: red first (`debug/dumps/red-m5f-*.txt`), a generated
  grid (`operatorGrid.test.js`, 2,873 cells, built from the mock schemas), `writeKeys`, `writeBackstop` and `writeFields`
  tests; mutation run `debug/dumps/mutation-m5f.txt` applied 61 mutations: 51 killed at once, 10 survived (nine exposed
  untested branches: the depth bounds, an untyped document, arrays, a cleaning failure, the single embedded document and
  plain schema fields in `walkEmbedded`, the cleaned flag scope in the guard, a Setting renamed by `op: 'replace'`; one,
  an operator inside the value of another, was first judged equivalent for plain schemas and is observable through a
  field class the walker cannot enumerate); tests were added and all 10 were re-run (`mutation-m5f-rerun.txt`): killed.
- Round 6 review fixes (M5 phase B):
  - Dotted wrapper identifier: `hasOperatorSegment` (`shared/writeKeys.js`) also returns true for a segment equal to
    `OPERATOR_IDENTIFIER`, so `flags.__$OPERATOR$__` and the like are `PATH_OPERATOR` in every consumer. MEASURED on
    14.364 (e2e operator-spelling test): a dotted wrapper erases `flags`, empties `items` and an item's `effects`; the
    plain `set` forms (`effects.<id>: null`, `effects: { <id>: null }`, an unlinked token delta merge with `items`) change
    nothing, so no further gate was added. The grid gained a `dottedWrapper` representation for the patch and data tools.
  - Cleaned changes are scanned for ownership, password and data URI keys outside operator values and for the flag scope
    through them (`scanWriteValues` option `operators: 'refuse' | 'descend' | 'skip'` replaced `allowOperators`).
  - One schema traversal (`childrenOf` in `writeFields.js`) serves `containsEmbedded` and `walkEmbedded`, covering
    `ArrayField`, `TypedObjectField` and `TypedSchemaField`; past `DEPTH_MAX` the walk throws `ARGS_INVALID` instead of
    returning (`walkSchema` removed).
  - `FLAGS_KEY` and `FLAG_SCOPE` are exported once from `shared/writeKeys.js`, `isPlainObject` once from
    `writeFields.js` (renamed from `isObjectValue`; the local copies in `writeGuard.js` and `writeReplace.js` were
    removed); the `docPath.js` `WRITE_OPS` comment names the operator objects.
  - `create_documents` with an `idempotencyKey` on a class with no `flags` field (Setting) is `ARGS_INVALID`.
  - Skills: new `wiretap-write-guard` skill (guard, operators, `writeFields.js`, `writeKeys.js`, `docPath.js`, grid);
    `wiretap-writes` absorbed the phase A write scripts; `wiretap-scripts` is 244 lines. `docs/TODO.md`, the README and
    the skills no longer say deletion has no Wiretap gate (`allowDelete` exists).
  - Tests: reds in `debug/dumps/red-m6-*.txt`; mutation run `debug/dumps/mutation-m6.txt` applied 20 mutations: 17
    killed, 3 survived (the cleaned flag scope read through operators at guard level, a typed schema as a child, a typed
    projection that ignored the type); tests were added and the three re-run (`mutation-m6-survivors.txt`): killed.
- New codes: `ACT_AS_DENIED`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_UNAVAILABLE`, `HANDLE_NOT_DOCUMENT`; the sidecar also
  answers `HANDLE_NOT_FOUND` and `HANDLE_TOO_LARGE` for handle inputs. `WRITE_NOT_APPLIED` is also used by
  `replace_document` and `batch`; `GATE_DENIED` covers the `flags.wiretap` scope.
- Intermittent integration failures: `reservePort` (`tests/portPool.js`) replaced nine copies of a probe that took a
  port from the OS dynamic range; see `docs/POST_WORK_FINDINGS.md`.
- Test order: the second review round wrote red tests first too (`debug/dumps/red-m5d-*.txt`; mutation run
  `debug/dumps/mutation-m5d.txt`); the first review round wrote red tests first (`debug/dumps/red-m5c-*.txt`); the original phase B `actAs` and
  idempotency code was written before its tests, and its red evidence is the mutation run
  (`debug/dumps/mutation-m5b.txt`). The review-fix mutation run (`debug/dumps/mutation-m5c.txt`) applied 39 mutations: 37
  killed, 2 survived as equivalent mutants. `applyUpdate` building the embedded update with `_id` first cannot be observed
  through the public API, because `groupWrites` refuses an `_id` path before it is reached. The batch result match
  ignoring ids gives the same outcome, because the server confirmation after a failure reclassifies a wrongly matched
  echo.

### As-built notes: M6

**As built (2026-11-20; `open_sheet`, `close_sheet`, `roll`, `draw_table`, `execute_macro`, the Macro code gate):**

- Run with the parallel workflow (ten tasks in lanes: sheets, dice, macros), controller in the main session. `undo_last`
  was moved to M17 by the owner and is not built.
- Definition sizes (MEASURED, `npx tsx tests/measure/measureContext.mjs`): `open_sheet` 370 B, `close_sheet` 363 B,
  `roll` 368 B, `draw_table` 358 B, `execute_macro` 488 B; 15 tools, 8,149 B in all (max 30 tools, 16,000 B). Fixture
  results: `open_sheet` with a 100-byte app id 122 B (budget 128), `close_sheet` 25 B (128), `roll` cut to its budget
  500 B (512), `draw_table` of several long results 993 B (1000), `TABLE_EMPTY` 78 B (512), `USER_OFFLINE` 214 B (512),
  `execute_macro` small value 27 B, a 12 KB value as a handle 135 B. Hard failures 0, warnings 0.
- New result budgets: `SHEET_RESULT_MAX_BYTES` 128, `ROLL_RESULT_MAX_BYTES` 512, `DRAW_RESULT_MAX_BYTES` 1000.
  `execute_macro` takes `RESULT_HARD_CAP_MAX_BYTES`; the enforcer turns a value over 8,000 B into a handle.
- e2e on the live world (MEASURED, headless, zero census after each run): `sheetTools.spec.js` 4 passed (two runs),
  `diceTools.spec.js` 6 passed (two runs), `macroTools.spec.js` 6 passed (runs 3 and 4; runs 1 and 2 each failed one
  test on a spec error: a scene created with no active scene in the world became active, fixed with `active: false`
  and a restored view; a token-only macro sees the token's synthetic actor, whose name is the token's). No product
  defect was found by the e2e runs.
- Owner decisions of 2026-11-20:
  - The sheet tools are normal `api` tools, not DOM tools, with an optional `userId`: with it the sheet opens on that
    connected user's client (who needs OBSERVER), without it on the client running the call; never broadcast. They
    stay read-only (no consent prompt: opening a sheet changes no data).
  - `close_sheet` takes `userId` too and uses a second user query, `wiretap.closeSheet`, with the same sender-is-GM
    check as `wiretap.openSheet`.
  - `draw_table` has `toChat`, default false, like `roll`.
  - `execute_macro` takes `uuid`, `actorUuid?`, `tokenUuid?` and `timeoutMs?` (1 s to 5 minutes, default 8 s).
    `timeoutMs` is one shared argument any tool can opt into by declaring it; the sidecar waits `timeoutMs` + 2 s for a
    tool that declares it (10 s otherwise). A value too large for the wire is reported as success with `value: null`,
    `tooLarge: true` and its size in bytes; the user-facing skill says this alone does not show the macro worked.
  - `allowMacroExecution` also gates writing code that later runs: a Macro `command`, a Macro `type` changed to
    `script`, an Adventure's stored `macros`, and a region behavior of type `executeScript` (in a scene, a region or an
    Adventure). Only the type rules are change-only: re-stating the `script` type of a script Macro, or the
    `executeScript` type of a behavior already of that type, is not refused. Any write that carries a Macro's
    `command` or an `executeScript` behavior's `system.source` needs the gate even when the value is unchanged: the
    guard reads the raw values and the cleaned changes, and Foundry's cleaning keeps unchanged values. Author/user
    fields, `_stats.createdTime` and folder/sort stay ungated (`docs/TODO.md`).
  - The user-facing skill limit is 70 lines (was 60).
  - Approved: per-family definition files (`sheetDefinitions.js`, `diceDefinitions.js`, `macroDefinitions.js`) so no
    two lanes write one file; six new error codes (`SHEET_UNAVAILABLE`, `SHEET_DENIED`, `USER_OFFLINE`,
    `SHEET_QUERY_FAILED`, `TABLE_EMPTY`, `MACRO_FAILED`); the `wiretap-gameplay` developer skill.
  - The plan writer's calls, approved with the plan: a token not on the viewed scene is refused; a chat macro speaks as
    the named actor; an e2e defect in risky code stops its lane; the names `actorUuid` and `tokenUuid`.
- Review: Tasks 2 (sheets), 4 (`execute_macro`) and 5 (the Macro write gate) took a buddy check with
  `wiretap-spec-reviewer` and `wiretap-code-reviewer` in place of their normal review. Its fixes: the sheet query's own
  5 s timer (an unanswered query is `SHEET_QUERY_FAILED`, not a misleading 8 s timeout); remote sheet ids bounded by
  their JSON size; `timeoutMs` and the per-call reply wait; `tooLarge` success; macro refusal and failure wording ("is
  a document of type", "did not compile; nothing ran", "threw; it may have partly run"); the region script gate and
  the change-only type rules; the guard walk skipping non-object embedded entries; stale comments; open-gate tests
  that check the write happened; one skill line each for a null chat value, a sheet opening on every tab the user has
  open and the agent's client stopping before `timeoutMs`; the exact timeout text (`limit / 1000`, not rounded).
- Task 6 had to edit three test files outside its file list, because each hard-codes the shipped tool list:
  `tests/unit/contextBudget.test.js`, `tests/unit/writeScripts.test.js`, `tests/integration/readTools.test.js`.
- Final whole-branch review (`sdd-final-reviewer`): approved, Minor findings only. Fixed: documentation that overstated
  the change-only rule, the sidecar skill's missing budgets, the chat-null and macro-result wording. The owner kept any
  write carrying code gated and picked four minors, all fixed and re-checked: a `roll` result over 512 B when trailing
  terms roll no dice (`0d6`); `draw_table` text now decodes character references; one-pass sheet id cut; test polish
  (macro budget fixtures fail with the gate closed, a macro error over 512 B in e2e, the skill description names the
  gameplay tools). After them (MEASURED): macro and sheet e2e 10 passed, zero census; `npm run check:release` clean.

### As-built notes: M21

**As built (2026-11-21; `backup_documents`, `list_backups`, `restore_backup`, `delete_backup`, the
`allowBackupAnyFolder` gate, the Backup folder setting, protocol 5 with the piece transport and the settings carrier,
recycle-bin removal):**

- Dependency: `trash` `^10.1.1` (installed 10.1.1; its `engines` field asks for Node 20 or later), a runtime
  dependency imported only by `server/backups.ts`. Node on this machine: v26.11.1 (MEASURED, `node -v`).
- Definition sizes (MEASURED, `npx tsx tests/measure/measureContext.mjs`): `backup_documents` 800 B, `list_backups`
  378 B, `restore_backup` 730 B, `delete_backup` 369 B, `read_handle` 766 B; 19 tools, 10,426 B in all (max 30 tools,
  16,000 B).
- Transport (MEASURED, `tests/integration/backupTools.test.js`): 2,048,000 bytes in four 512,000-byte pieces took
  12.8 ms and 18.2 ms in two runs. Inferred: about 0.4 to 0.6 s per 64,000,000 bytes (the backup bound) for the
  transport alone, extrapolated linearly from those two samples.
- e2e on the live world (MEASURED, headless): `backupTools.spec.js` 7 passed in three runs (37.2 s, 36.0 s, 32.2 s);
  `gates.spec.js` 4 passed. The largest live pack, `titan-vttrpg-compendium.effects` (199 index entries), measured as
  a dry run 256 documents, 419,426 bytes, in 58 to 63 ms. Inferred: about 9 s of export per 64,000,000 bytes,
  extrapolated linearly from that rate.
- Unit suite after M21 (MEASURED, `npm test`): 123 files, 2779 passed, 2 skipped.
- Designer decisions made during the run (each the designer's call under the user's delegation, not the user's own
  choice):
  - The 800-byte definition budget wins over "every argument has a short describe"; seven arguments carry no describe
    (six names, `timeoutMs` in two tools).
  - A document whose export hits the walk bounds (50,000 nodes, 24 levels, or JSON text nested 4 deep in strings) is
    not backed up: it is counted as unreadable (`DOC_UNREADABLE`), never written cut. Also recorded in the design.
  - Re-creating a deleted document on restore keeps `create_documents` gate parity: it needs `allowOwnershipWrites`.
  - The sidecar accepts only the exact restore result shape the client sends; a backup over 10,000 documents fails
    with `BACKUP_TOO_LARGE`; restore and delete run the same folder link check as backup and list.
  - The `wiretap.backupFolder` world setting is kept in the e2e gate record, so a killed e2e run is recovered.
  - The backups unit test that writes 1,001 files has a 30 s limit (`POST_WORK_FINDINGS.md` has the entry).

### As-built notes: M18

**As built (2026-11-21; `create_pack`, `delete_pack`, the `allowPackDeletion` gate, the definition flag
`requiresUserInteraction` and the sidecar's `_meta` entry, the pack-aware e2e running list):**

- Definition sizes (MEASURED, `npx tsx tests/measure/measureContext.mjs`): `create_pack` 500 B, `delete_pack` 404 B;
  21 tools, 11,330 B in all (max 30 tools, 16,000 B). The fixtures `create_pack` dry run with a 64-character name and a
  cut label and `delete_pack` dry run with the largest count and a long label each measure 256 B of 256 B.
- e2e on the live world (MEASURED, headless, 14.364): `tests/e2e/packTools.spec.js` 6 passed: the listing (only
  `delete_pack` carries the meta entry), a `create_pack` dry run and a denied real run with the gate closed, a real
  create with refusals that raise no GM-screen error, a `delete_pack` dry run with the document count, and the denied,
  refused and real delete.
- `compendiumConfiguration` (MEASURED in that run): a deleted pack's key stays in the core world setting as
  `{"folder":null,"locked":false}`; Foundry does not prune it, and the product's `delete_pack` leaves it too
  (`POST_WORK_FINDINGS.md` has the entry).
- The e2e running list cleans its own pack keys (`1361027`, `tests/e2e/registryCore.js`): the teardown removes the
  `compendiumConfiguration` key of each recorded e2e pack it deletes or finds already gone, the sweep the key of each
  pack it deletes, and neither touches any other key; the census reports a stale `world.wiretap-e2e-*` key whose pack
  is gone. Two stale keys left by this milestone's own earlier e2e runs were removed once from the live world (42 to
  40 keys, every other key unchanged). The malformed `create_pack` dry runs and the system-pack and missing-pack
  `delete_pack` dry runs are sent with their gate closed.
- Unit suite after M18 (MEASURED, `npm test` at `e15d83b`): 129 files, 2876 passed, 2 skipped; at `1361027`: 129
  files, 2880 passed, 2 skipped, and `tests/e2e/packTools.spec.js` 6 passed.
- `skills/wiretap/SKILL.md` is 74 lines; its cap in `tests/unit/shippedSkill.test.js` is 75 (the owner ruled such
  limits are the agent's to settle).
- `create_pack` refuses a name equal to an existing pack id's name ignoring case and names that pack id, because the
  server stores a pack in `packs/<name>` and Windows folder names ignore case (`CLOSED_BUGS.md` has the entry).
- `tests/integration/userInteractionMeta.test.js` covers a hostile client that registers its own `_meta` and
  `annotations` (the listing holds only the sidecar's one meta key and `readOnlyHint` from `mutates`) and a flag off,
  on, off sequence with a `tools/list_changed` each time.
- Designer decisions made during the run (each the designer's call under the user's delegation, not the user's own
  choice):
  - Gate before checks, on a real run only: a real run checks its gate first and a closed gate reveals nothing about
    packs; a dry run skips the gate. Rejected: checks first, which would let an agent learn `PACK_LOCKED` before
    `GATE_DENIED`.
  - `delete_pack` refuses a locked pack with `PACK_LOCKED` instead of unlocking and deleting; `PLAN.md` M18 was edited
    to say so. Owner attention: this changes the M18 decision text.
  - The not-found code is `PACK_NOT_FOUND` (the design's word), while `restore_backup` uses `PACK_GONE` for a pack
    that no longer exists; the two codes name the same condition on two tools. Owner attention.
  - Bounds on untrusted input in the schema: `label` 1 to 128 characters, `name` 1 to 64, `id` 1 to 128; `type` is
    unbounded in the schema and checked against the ten Foundry pack types in the handler (an enum would cost about
    150 B of the 800 B definition). A pack name becomes a folder name, so an unbounded name could make the Foundry
    server fail with a GM-screen error.
  - A label that slugs to nothing, with no `name`, is `ARGS_INVALID` ("give a name"), because Foundry would pick
    `<type>-<randomID>`, which a dry run could not report.
  - A derived name over 64 characters is `ARGS_INVALID`, the same bound as an explicit `name`.
  - The handler uses `label.slugify({ strict: true })` (Foundry's own slug, the server's default) and holds its own
    copies of Foundry's name pattern and reserved-name pattern, cited to `common/packages/base-package.mjs`, because
    no public validator is exposed to modules.
  - The ack label is cut with `truncateUtf8` until the whole row is at most 256 B; `id`, `type` and `documents` are
    never cut.
  - The carrier is a boolean (`requiresUserInteraction`), not a free `_meta` object, so no client can attach other MCP
    metadata; the sidecar builds the one `_meta` entry itself. The forced name list is
    `USER_INTERACTION_TOOLS = ['delete_pack']` in `shared/scripts.js`.
  - No `isGM` check in the handlers: the bridge runs scripts only on GM clients, so a non-GM call cannot arrive.
  - The e2e running list records a pack as `{ documentName: 'Compendium', id: 'world.<name>', uuid:
    'Compendium.world.<name>' }`; `Compendium` is the last type in the deletion order (documents inside a pack go with
    it).
  - A new skill `wiretap-packs` holds the pack scripts; the carrier is described in `wiretap-mcp-sessions`, the gate in
    `wiretap-write-guard` and `wiretap-sidecar`.

## Decision provenance (moved from PLAN.md section 3)

| # | Source |
|---|---|
| D1 | DECIDED: User 2026-10-10; MEASURED (coord.) M0 E2 (`docs/experiments/2026-10-m0-results.md`) |
| D2 | DECIDED: User; MEASURED (coord.) M0 E3: shell/noCanvas median ready 1.8 s, 438.7 MB working set, 18.2 % of one core idle; full build 2.9 s, 547.3 MB, 42.1 %; shell with a drawn canvas 608 % idle |
| D3 | DECIDED (premise confirmed: P1 PASS): User; READ `foundry/dist/database/documents/user.mjs`; MEASURED (coord.) M0 P1: no password, hash or salt client-visible for any role on any path |
| D4 | DECIDED (per M0 evidence): MEASURED (coord.) M0 E1, E4; READ `users.mjs:70-96`, `common/documents/user.mjs:124` |
| D5 | DECIDED: User 2026-10-11 |
| D6 | DECIDED: User |
| D7 | DECIDED: User |
| D8 | DECIDED (gate list in §4.6; the three proposed additions are DECIDED, see §4.6): User |
| D9 | DECIDED: User |
| D10 | DECIDED: User; MEASURED (coord.) (claude 2.1.296): `.` rewritten to `_`; `__`, `-`, 110-char names work |
| D11 | DECIDED: User 2026-10-11; MEASURED (coord.) (claude 2.1.296): stateless lists tools once; stateful list_changed honoured; sampling `-32601` |
| D12 | DECIDED: User 2026-10-11 |
| D12a | DECIDED (user accepted the recommendation, 2026-10-11): §9 C1 |
| D13 | DECIDED: User; READ `client-document.mjs:1065` |
| D14 | DECIDED (incl. `keepId`): User 2026-10-11; READ `client-document.mjs:928-944,1113-1134` |
| D15 | DECIDED: User; READ: no JSON-Schema export in `common/data/fields.mjs`; MEASURED (coord.) M0 E8 |
| D16 | DECIDED: User 2026-10-11; READ `.claude/claude.md:25` |
| D17 | DECIDED: User 2026-10-10 |
| D18 | DECIDED: User 2026-10-11; MEASURED (coord.) §2.1 R1–R6 |
| D19 | DEFERRED (logged in `docs/TODO.md`): User 2026-10-11 |
| D20 | DECIDED (adoption); the value changes of revision 3 DECIDED (accepted 2026-10-11): User 2026-10-11; MEASURED (coord.) §2.1 |
| D21 | DECIDED: option (b) (accepted 2026-10-11): §2.5; READ Claude Code permission and MCP docs |
| D22 | DECIDED (coordinator's judgement, delegated by the user): User 2026-10-11 |
| D23 | DECIDED: User 2026-10-11 |
| D24 | DECIDED (in principle): User 2026-10-11 ("I think this can work") |
| D25 | DECIDED: User 2026-10-11 |
| D26 | DECIDED (accepted 2026-10-11; recommendation): User request 2026-10-11; READ `helpers.mjs:821-868`, `global.d.mts:6-7` |
| D27 | DECIDED: drop (user accepted, 2026-10-11): MEASURED (coord.) M0 E2, E3 |
| D28 | DECIDED (user accepted, 2026-10-11): MEASURED (coord.) M0 E9: titan actor sheet 850×926 |

## Path resolver notes (moved from PLAN.md section 2.8)

Implemented in `shared/docPath.js`.

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

## Plan baseline text (moved from PLAN.md section 1)

Wiretap at the plan baseline (HEAD `048df55`, before M1; the line citations below describe that snapshot, and M1
replaced `invokeOnGM` and the first-socket routing with the endpoint registry and router): one MCP tool,
`create_actor`. The request path was MCP HTTP (`127.0.0.1:31417/mcp`, stateless; a new
`McpServer` is built per request, READ `server/mcp.ts:95-100`) → `bridge.invokeOnGM` (first identified GM socket, READ
`server/foundryBridge.ts:57-76`) → Socket.IO `bridge:invoke` → `OP_HANDLERS` on a GM browser client (READ
`src/bridge/foundryBridge.js:25-27`; as built the table is `opHandlers` and holds only `callTool`, which runs a
registered script). Socket.IO is bound to `127.0.0.1` (READ `server/server.ts:30`). Identify trusts
the client's `isGM` claim (READ `server/foundryBridge.ts:40-44`).

## Resolved contradictions (moved from PLAN.md section 9)

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

## Debug and handoff notes

None existed in the plan at the time of the split. Open defects are in [`OPEN_BUGS.md`](OPEN_BUGS.md); anomalies found
during work belong in [`POST_WORK_FINDINGS.md`](POST_WORK_FINDINGS.md).
