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
| M14 Script runtime and the discovery layer | Done | 2026-10-13 | not yet committed | [`PLAN.md`](PLAN.md) section 4.5 as-built note; client runtime in `src/bridge/scripts/`; user-facing skill `skills/wiretap/SKILL.md` |

Current suite (MEASURED 2026-10-13, `npm test`): 63 test files passed, 1678 tests passed, 1 skipped (1679).

Next milestone in the order of PLAN.md section 5: M4.

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

## Debug and handoff notes

None existed in the plan at the time of the split. Open defects are in [`OPEN_BUGS.md`](OPEN_BUGS.md); anomalies found
during work belong in [`POST_WORK_FINDINGS.md`](POST_WORK_FINDINGS.md).
