# Wiretap M6 "Sheets and gameplay" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `parallel-subagent-development` to implement this plan. Steps use
> checkbox (`- [ ]`) syntax for tracking. Every task brief is the task's text plus the whole "Global Constraints"
> section, copied verbatim: the implementer does not read this file.

**Goal:** ship the M6 tools `open_sheet`, `close_sheet`, `roll`, `draw_table` and `execute_macro` as shipped scripts,
the `wiretap.openSheet` and `wiretap.closeSheet` user queries that open and close a sheet on a chosen connected user's
client, and the rule that a write setting Macro code (a Macro's `command`, a Macro's `type` changed to script, an
Adventure's stored `macros`) needs the `allowMacroExecution` gate.

**Architecture:** every new tool is a client script (definition + handler under `src/bridge/scripts/`), registered in
`SHIPPED_SCRIPTS` and routed by the existing sidecar router; the sidecar gains no code. The two user queries are
handlers in `CONFIG.queries` registered at `init` on every client (players included), because the receiving client,
not the sender, must judge the request. The Macro rule is one more category gate inside the existing `guardWrite`, so
create, update, replace and batch all inherit it. Each lane writes its own new files; the shared registration files
are edited once, by Task 6.

**Tech Stack:** JavaScript (ES modules), Foundry VTT v14 client API, vitest + happy-dom, Playwright (headless), MCP SDK
client, Socket.IO.

**Spec:** `docs/PLAN.md` §5 "M6 — Sheets and gameplay", with §2.6 (budgets), §2.9 (catalogue rows), §4.6 (risk gates),
§4.8 (test-data cleanup), D12a and D25. The owner's 2026-11-20 decisions are folded into §2.9, §4.6 and §5 M6 (listed
under "Owner decisions" below): no `undo_last` in M6 (it is built once, in M17); the sheet tools are `api` tools with
`userId?`; `draw_table` has `toChat`, default false; `execute_macro(uuid, actorUuid?, tokenUuid?)`; a write of Macro
code needs `allowMacroExecution`; author/user fields, `_stats.createdTime` and folder/sort stay ungated and stay in
`docs/TODO.md`.

## Model/Effort directives

- Plan writer: sdd-plan-writer-opus (dispatched).
- Execution method: parallel
- Loop owner: mainline session
- Implementer per task (project rule, `.claude/CLAUDE.md`): `foundry-module-dev` for Tasks 2, 3, 4, 5 and 6 (client
  `.js` under `src/`); `wiretap-coder` for Tasks 1, 7, 8, 9 and 10 (`shared/`, tests, docs). The
  `dispatching-sdd-agents` tiers choose only the model and effort these agents run at.
- Per-task review: `wiretap-spec-reviewer`, then `wiretap-code-reviewer`; at most three fix rounds per task. Tasks 2,
  4 and 5 take a buddy check instead (see "Buddy-check directives").

## Global Constraints

Every task's requirements include each line below.

- **Scope.** The user asked to resume Wiretap and build milestone M6 exactly as `docs/PLAN.md` §5 M6 states it with
  the owner's 2026-11-20 decisions. `undo_last` is not built (M17 builds it). Author/user fields, `_stats.createdTime` and
  folder/sort stay ungated. Nothing outside the task's own files is changed; a defect found elsewhere is reported, not
  fixed.
- **Builders carry this line word for word:** "No unrequested features, shims or defensive code. A guard against input
  the product cannot send is not requested."
- **Agents.** Implementers: `foundry-module-dev` for client `.js`/`.svelte`; `wiretap-coder` for `server/`,
  `shared/`, tests, build config. Reviewers: `wiretap-spec-reviewer` then `wiretap-code-reviewer`.
- **Skills first.** Before reading or editing a subsystem's files, read its skill file under `.claude/skills/`:
  `wiretap-codebase-core` always; `wiretap-scripts` for `src/bridge/scripts/**` and `skills/**`; `wiretap-write-guard`
  for `writeGuard.js`, `shared/gates.js` and the guard tests; `wiretap-writes` for the write scripts and
  `mockWriteWorld.js`; `wiretap-client` for `src/hooks/**`, `src/bridge/*.js` and `lang/**`; `wiretap-mcp-bridge` for
  routing and gates; `wiretap-build-test` for `tests/**`.
- **TDD, no stubs.** Write the failing test, see it fail, write the code, see it pass. No placeholder bodies.
- **Formatting.** 3-space indentation as the existing files use; 120-character lines; multi-line `{}` on every
  conditional; objects with more than one property and arrays with more than one entry are multi-line; every variable
  typed with a one-line JSDoc comment; every function a JSDoc block with typed params (`{Type} [optional] - text`) and
  a typed return (async included).
- **Comments.** Present tense, what or why only. No task IDs, plan or spec references, review notes or history.
- **No backwards compatibility.** No aliases, shims or deprecation paths. No dynamic imports in shipping builds. No
  test code in shipping builds.
- **No file deletion.** No `fs.rm*`, `fs.unlink*`, `fs.rmdir*` or recursive removal in product or test code. Foundry
  documents created by tests are recorded on the running list `test/state/registry.json` (`recordDocument` of
  `tests/e2e/registry.js`) right after creation and torn down by `settleRegistry` / `teardownRecorded` (the §4.8
  pattern). Every e2e document name starts with `Wiretap E2E ` (a ChatMessage carries the prefix in `flavor`).
- **e2e.** Headless Playwright only (`playwright.config.mjs`). Every wait inside a loaded page is at most 1000 ms
  (`expect.poll`, `waitForFunction`, `toPass`, `timeout:`); world boot, login and reload are exempt. Only one task
  runs e2e at a time: the live Foundry on `:30000` and `dist/` are shared. e2e overwrites `dist/`; run `npm run build`
  after it.
- **Context budgets (D17), enforced by `tests/unit/contextBudget.test.js`:** `open_sheet` / `close_sheet` result
  ≤ 128 B; `roll` ≤ 512 B; `draw_table` ≤ 1 KB (1000 B); `execute_macro` results pass the hard cap (over 8,000 B
  becomes a handle). Every definition ≤ 800 B; description ≤ 160 chars (warn) and ≤ 240 (hard). A budget is raised
  only by the user. Bytes are raw UTF-8 bytes of the returned text.
- **Script errors.** A handler refuses with `new ScriptError(code, message)` from `src/bridge/scripts/registry.js`;
  the code matches `/^[A-Z][A-Z0-9_]{0,63}$/` and is not a reserved sidecar code (`NOT_GM`, `NO_ENDPOINT`,
  `TOOL_GONE`, ...); the message is at most 256 B and never echoes unbounded caller text (`cleanForLog` of
  `shared/logText.js`, `truncateUtf8` of `shared/utf8.js`).
- **Definitions.** Every new argument schema has `additionalProperties: false` at the root (both validators reject an
  undeclared argument; `tests/unit/schemaStrict.test.js` checks shipped definitions); every array declares `maxItems`.
  Definition files import only through relative paths (`../../../shared/budgets.js`), as `definitions.js` does, so the
  `tsx` measurement can load them.
- **Commands.** `npm test`, `npm run typecheck`, `npm run eslint`, `npm run build`, `npx playwright test <spec>`.
  A task is verified when all three of `npm test`, `npm run typecheck` and `npm run eslint` pass; report their output.
- **Commits.** Commit each task as one logical unit once local CI passes. Do not push (the controller pushes at the
  milestone end). End commit messages with the attribution lines the controller gives.
- **Foundry source.** Behaviour cited below was read in the Foundry v14 tree at `C:\FoundryVTT\V14\dev\foundry\`
  (build 14.364, the version the live world runs); paths below are relative to it.
- **Repeat errors.** The second occurrence of the same failure ends the task: report the count and a diagnosis
  instead of patching the symptom again.

## Review Focus

Inputs the spec implies but does not spell out, most likely to bite first; each has a test in the owning task.

1. A player (not a GM) sends `wiretap.openSheet` or `wiretap.closeSheet` to another user's client. Foundry lets
   players query users by default (`common/constants.mjs:1405-1410`, `QUERY_USER` default role PLAYER), so the
   receiving client must refuse it and render or close nothing. Tests: Task 2 (unit), Task 7 (e2e).
2. The target user has LIMITED, not OBSERVER. Foundry's own sheet threshold is LIMITED
   (`client/applications/api/document-sheet.mjs:51`), so Wiretap's OBSERVER check must refuse what Foundry would show.
   Tests: Task 2, Task 7.
3. A macro returns a Document or a cyclic value. A serialization failure would report a macro that already ran as
   failed, and the agent would run it again. Expected: success with the value as a uuid or `unserializable: true`.
   Test: Task 4.
4. A RollTable with every result drawn (no replacement), or none in the formula's range. Foundry only warns and
   returns no results (`client/documents/roll-table.mjs:277-281`, `:292-295`). Expected: a clear `TABLE_EMPTY`
   error, not an empty success. Tests: Task 3, Task 8.
5. `replace_document` of a Macro whose data omits `command`. The replacement still sets the command (an omitted field
   resets to its default), so it needs the gate. Test: Task 5.

---

## File structure

| File | Task | Responsibility |
|---|---|---|
| `shared/budgets.js` | 1 | The three new result budgets |
| `src/bridge/scripts/sheets.js` | 2 | `renderSheet`, `closeSheet` on this client; `remoteUser`, `askUser`: the cross-user query path both handlers share |
| `src/bridge/sheetQuery.js` | 2 | The `wiretap.openSheet` and `wiretap.closeSheet` query handlers (sender and permission checks) and their registration |
| `src/bridge/scripts/sheetDefinitions.js` | 2 | `open_sheet`, `close_sheet` definitions |
| `src/bridge/scripts/openSheet.js`, `closeSheet.js` | 2 | Their handlers |
| `src/hooks/OnceInit.js` | 2 | Registers both queries on every client at `init` |
| `src/bridge/scripts/diceDefinitions.js` | 3 | `roll`, `draw_table` definitions |
| `src/bridge/scripts/roll.js`, `drawTable.js` | 3 | Their handlers and result shaping |
| `src/bridge/scripts/macroDefinitions.js`, `executeMacro.js` | 4 | `execute_macro` definition and handler |
| `src/bridge/scripts/writeGuard.js` | 5 | The Macro code gate inside `guardWrite` |
| `shared/gates.js`, `lang/en.json` | 5 | `allowMacroExecution` unlock text and hint |
| `src/bridge/scripts/index.js`, `tests/unit/scriptFixtures.js`, `tests/unit/contextBudgetHarness.js`, `tests/unit/riskGates.test.js`, `tests/unit/shippedSkill.test.js`, `skills/wiretap/SKILL.md` | 6 | Registration of the five scripts, budget fixtures, risk-gate check, user-facing skill and its line limit |
| `tests/e2e/sheetTools.spec.js`, `diceTools.spec.js`, `macroTools.spec.js` | 7, 8, 9 | Live e2e per lane |
| `docs/**` except `docs/PLAN.md`, `README.md`, `.claude/skills/**`, `.claude/CLAUDE.md` | 10 | Tracking files and skills |

The lanes use their own definition files instead of `definitions.js` so no two lanes write one file (approved by the
owner). `docs/PLAN.md` already states the owner's decisions; no task edits it.

## Lanes

| Task | Writes | Shared resources | Waits on | Review group | Review timing | Risky |
|---|---|---|---|---|---|---|
| T1 Result budgets | `shared/budgets.js`, `tests/unit/budgets.test.js` | none | none | G0 Foundation | on landing | no |
| T2 Sheets: two queries, `open_sheet`, `close_sheet` | `src/bridge/sheetQuery.js`, `src/bridge/scripts/sheets.js`, `src/bridge/scripts/sheetDefinitions.js`, `src/bridge/scripts/openSheet.js`, `src/bridge/scripts/closeSheet.js`, `src/hooks/OnceInit.js`, `tests/unit/sheetQuery.test.js`, `tests/unit/openSheet.test.js`, `tests/unit/closeSheet.test.js`, `tests/unit/OnceInit.test.js`, `tests/integration/sheetTools.test.js` | none | T1 | B2 buddy check (alone) | on landing | yes |
| T3 Dice: `roll`, `draw_table` | `src/bridge/scripts/diceDefinitions.js`, `src/bridge/scripts/roll.js`, `src/bridge/scripts/drawTable.js`, `tests/unit/roll.test.js`, `tests/unit/drawTable.test.js`, `tests/integration/diceTools.test.js` | none | T1 | G2 Dice | phase end | no |
| T4 `execute_macro` | `src/bridge/scripts/macroDefinitions.js`, `src/bridge/scripts/executeMacro.js`, `tests/unit/executeMacro.test.js`, `tests/integration/macroTools.test.js` | none | none | B4 buddy check (alone) | on landing | yes |
| T5 Macro code write gate | `src/bridge/scripts/writeGuard.js`, `shared/gates.js`, `lang/en.json`, `tests/unit/mockWriteWorld.js`, `tests/unit/mockFoundryData.js`, `tests/unit/macroCommandGate.test.js` | none | none | B5 buddy check (alone) | on landing | yes |
| T6 Registration, budget fixtures, user skill | `src/bridge/scripts/index.js`, `tests/unit/scriptFixtures.js`, `tests/unit/contextBudgetHarness.js`, `tests/unit/riskGates.test.js`, `tests/unit/shippedSkill.test.js`, `skills/wiretap/SKILL.md` | none | T2, T3, T4, T5 | G4 Integration | on landing | no |
| T7 Sheets e2e | `tests/e2e/sheetTools.spec.js`, `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md` | Foundry `:30000`, `dist/` | T6 | G1 Sheets e2e | on landing | yes |
| T8 Dice e2e | `tests/e2e/diceTools.spec.js`, `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md`; T3's files only to fix a defect the spec exposes | Foundry `:30000`, `dist/` | T6 | G2 Dice | phase end | no |
| T9 Macro e2e | `tests/e2e/macroTools.spec.js`, `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md` | Foundry `:30000`, `dist/` | T6 | G3 Macro e2e | on landing | yes |
| T10 Docs, skills, graph | `docs/PROGRESS.md`, `docs/TODO.md`, `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md`, `docs/POST_WORK_FINDINGS.md`, `README.md`, `.claude/skills/**`, `.claude/CLAUDE.md`, `graphify-out/` | none | T7, T8, T9 | G5 Docs | on landing | no |

Landing order for the shared registration files: none is shared between parallel lanes. T6 alone edits `index.js`,
`scriptFixtures.js`, `contextBudgetHarness.js`, `riskGates.test.js`, `shippedSkill.test.js` and
`skills/wiretap/SKILL.md`. T7, T8 and T9 run one at a time in any order (they share the live Foundry and `dist/`), so
their writes to the bug files never overlap; T10 runs after all three.

| Stop | Where | Kind |
|---|---|---|
| A TITAN e2e run is active, or the Wiretap census is not zero after an e2e spec | T7, T8, T9 | stops everything |
| An e2e spec exposes a defect in T2's, T4's or T5's files (a change there is a high-risk signal) | T7 step 3, T9 step 3 | stops this lane |
| An unflagged task shows a high-risk signal (security boundary, process spawn, protocol or public API change) | any task | stops this lane |
| A buddy check ends with a finding the two seats did not settle | T2, T4, T5 | stops this lane |
| The same failure occurs a second time | any task | stops this lane |
| A task's third fix round leaves review findings open | any task | stops this lane |

## Buddy-check directives

Decided by the owner on 2026-11-20.

- T2, T4 and T5 get a buddy check (`buddy-checking`) with `wiretap-spec-reviewer` and `wiretap-code-reviewer` as the
  two seats. It replaces their per-task review and their group review.
  - T2: security boundary. Another user's client acts on a command; the query handlers are the only check of who may
    send it (Foundry lets players send queries by default).
  - T4: security boundary. It runs arbitrary code with GM authority behind a gate.
  - T5: security boundary. It changes `guardWrite`, the one choke point for every write and gate.
- T7 and T9 cover the same boundaries live; they are test-only and take the ordinary review. A change either would
  make to T2's, T4's or T5's files is a high-risk signal and follows the next rule.
- An unflagged task that shows high-risk signals during execution stops its lane, and the controller takes it to the
  owner.

## Owner decisions

The owner's answers of 2026-11-20, one line each; the plan and `docs/PLAN.md` carry them.

- Undo: M6 builds no undo tool; `undo_last` is built once, fully, in M17.
- Loop owner: the mainline session runs the parallel loop.
- Macro write: a write that sets a Macro's `command` needs `allowMacroExecution`.
- Other gates: author/user fields, `_stats.createdTime` and folder/sort stay ungated and stay in `docs/TODO.md`.
- `open_sheet`: a normal (`api`) tool, not a DOM tool; with `userId` the sheet opens on that user's client, without it
  on the client running the call; never broadcast.
- `close_sheet`: takes `userId` too and closes on that user's client through a second query, `wiretap.closeSheet`,
  with the same sender-is-GM check; without `userId` it closes on the client running the call.
- `draw_table`: has `toChat`, default false.
- `execute_macro`: takes `uuid` plus the optional Actor and Token the macro acts on (`actorUuid`, `tokenUuid`).
- Macro gaps: a Macro `type` change to script and an Adventure's stored `macros` also need `allowMacroExecution`.
- User-facing skill: its line limit rises from 60 to 70.
- Consent: the per-family definition files, the six error codes, the three budget names and the new
  `wiretap-gameplay` developer skill with its row in `.claude/CLAUDE.md` are approved.
- Buddy check: T2, T4 and T5, with `wiretap-spec-reviewer` and `wiretap-code-reviewer`, replacing their review.

---

### Task 1: Result budgets for the M6 tools

The user asked for M6. This task adds the three result budgets the new tools are held to (§2.6, M6 context-budget
criterion), so each lane's definition can name its budget.

**Files:**
- Modify: `shared/budgets.js` (the `BUDGETS` table, after `WRITE_DATA_MAX_BYTES`)
- Test: `tests/unit/budgets.test.js` (the `EXPECTED` list)

**Interfaces:**
- Produces: `getBudget('SHEET_RESULT_MAX_BYTES').value === 128`, `getBudget('ROLL_RESULT_MAX_BYTES').value === 512`,
  `getBudget('DRAW_RESULT_MAX_BYTES').value === 1000`; unit `bytes`, severity `hard`.

- [ ] **Step 1: Write the failing test.** Append to `EXPECTED` in `tests/unit/budgets.test.js` (multi-line arrays as
  the file has them):

```js
['SHEET_RESULT_MAX_BYTES', 128, 'bytes', 'hard'],
['ROLL_RESULT_MAX_BYTES', 512, 'bytes', 'hard'],
['DRAW_RESULT_MAX_BYTES', 1000, 'bytes', 'hard'],
```

- [ ] **Step 2: Run it.** `npx vitest run tests/unit/budgets.test.js`. Expected: FAIL, `Unknown budget: SHEET_RESULT_MAX_BYTES`
  (or the length check).
- [ ] **Step 3: Implement.** Add three `budget(...)` entries to `BUDGETS`, each with a one-line comment: the result
  of `open_sheet` / `close_sheet`; the result of `roll`; the result of `draw_table` (1 KB).
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(shared): result budgets for sheets, rolls and table draws`.

---

### Task 2: Sheets — the `wiretap.openSheet` and `wiretap.closeSheet` queries, `open_sheet` and `close_sheet`

The user asked for M6. This task delivers its sheet part: `open_sheet(uuid, userId?)` renders a document's sheet on a
chosen connected user's client through the Foundry user query `wiretap.openSheet`, or on the client that runs the
call; `close_sheet(uuid, userId?)` closes it the same way, through a second query, `wiretap.closeSheet`. Both are
normal (`api`) tools and never broadcast. It is a security boundary: a command makes another user's browser act, so
the receiving client checks that the sender is a GM (both queries) and that its own user has OBSERVER on the document
(open only).

Foundry behaviour this relies on (READ):
- `User#query(name, data, {timeout})` refuses an unregistered name and a sender without `QUERY_USER`
  (`client/documents/user.mjs:289-293`) and throws `User [<id>] is not active` for an offline target (`:305-306`);
  it rejects with the handler's error text or resolves its value (`:313-321`).
- The receiving client calls `CONFIG.queries[name](data, {timeout, user})`, where `user` is the sender
  (`client/documents/collections/users.mjs:218-241`, context built at `:230`). The server sets the sender from the
  authenticated socket and forwards to every socket of the target user; the first answer wins; with a `timeout` it
  rejects when no socket answers in time (READ `dist/components/activity.mjs`, the `userQuery` handler).
- Query names of modules must be prefixed (`client/config.mjs:2960-2967`). Players hold `QUERY_USER` by default
  (`common/constants.mjs:1405-1410`).
- `document.sheet` builds the sheet once and returns it, or null when the class has none
  (`client/documents/abstract/client-document.mjs:213-230`). The sheet id is
  `<SheetClassName>-<uuid with dots as dashes>` (`client/applications/api/document-sheet.mjs:134-138`).
- `render({force: true})` returns without rendering, and shows a notification, when `_canRender` throws
  (`client/applications/api/application.mjs:500-528`; the document-sheet check is at
  `document-sheet.mjs:251-255`). `rendered` is true only in the RENDERED state (`application.mjs:367-369`).
  `close()` closes it (`application.mjs:950-952`).

**Files:**
- Create: `src/bridge/scripts/sheets.js`, `src/bridge/sheetQuery.js`, `src/bridge/scripts/sheetDefinitions.js`,
  `src/bridge/scripts/openSheet.js`, `src/bridge/scripts/closeSheet.js`
- Modify: `src/hooks/OnceInit.js` (call `registerSheetQueries()` right after `registerGateSettings()`)
- Test: `tests/unit/sheetQuery.test.js`, `tests/unit/openSheet.test.js`, `tests/unit/closeSheet.test.js`,
  `tests/unit/OnceInit.test.js`, `tests/integration/sheetTools.test.js`

**Interfaces:**
- Consumes: `getBudget('SHEET_RESULT_MAX_BYTES')` (Task 1); `resolveDocument({ uuid })` and `unreadable(document)`
  of `src/bridge/scripts/canonical.js`; `ScriptError` of `registry.js`; `truncateUtf8` of `shared/utf8.js`;
  `cleanForLog`, `describeCause` of `shared/logText.js`.
- Produces:
  - `sheets.js`: `export const APP_ID_MAX_BYTES = 100`; `export const SHEET_QUERY_TIMEOUT_MS = 5000`;
    `export async function renderSheet(document): Promise<SheetOutcome>` with
    `@typedef {{ ok: true, appId: string } | { ok: false, code: string, message: string }} SheetOutcome`;
    `export async function closeSheet(document): Promise<{ ok: true, closed: boolean }>`;
    `export function remoteUser(userId?: string): object | null`;
    `export async function askUser(user, queryName: string, uuid: string, isSuccess: (reply) => boolean):
    Promise<object>`.
  - `sheetQuery.js`: `export const OPEN_SHEET_QUERY = 'wiretap.openSheet'`;
    `export const CLOSE_SHEET_QUERY = 'wiretap.closeSheet'`;
    `export async function handleOpenSheetQuery(data, context): Promise<SheetOutcome>`;
    `export async function handleCloseSheetQuery(data, context): Promise<CloseOutcome>` with
    `@typedef {{ ok: true, closed: boolean } | { ok: false, code: string, message: string }} CloseOutcome`;
    `export function registerSheetQueries(): void`.
  - `sheetDefinitions.js`: `export const openSheetDefinition`, `export const closeSheetDefinition`.
  - `openSheet.js`: `export async function openSheetHandler(args, ctx): Promise<{ ok: true, appId: string }>`.
  - `closeSheet.js`: `export async function closeSheetHandler(args, ctx): Promise<{ ok: true, closed: boolean }>`.

Values the spec and this plan pin:
- `openSheetDefinition`: `name: 'open_sheet'`, `version: '1.0.0'`, description
  `Open a document's sheet: on the client of the connected user named by userId (needs OBSERVER), else on this endpoint.`,
  `inputSchema` `{ type: 'object', properties: { uuid: { type: 'string' }, userId: { type: 'string', maxLength: 16 } },
  required: ['uuid'], additionalProperties: false }`, `result.budgetBytes` = `SHEET_RESULT_MAX_BYTES`,
  `requires: 'api'`, `mutates: false`.
- `closeSheetDefinition`: `name: 'close_sheet'`, `version: '1.0.0'`, description
  `Close a document's sheet if open: on the client of the connected user named by userId, else on this endpoint.`,
  the same `inputSchema` as `open_sheet` (`uuid` required, `userId` with `maxLength: 16`,
  `additionalProperties: false`), same budget, `requires: 'api'`, `mutates: false`.
- Both query handlers never throw (a thrown error would reach the sender as text only, losing the code). Any exception
  not listed → `{ ok: false, code: 'SHEET_UNAVAILABLE', message: describeCause(error, 200) }`. Checks, in this order:
  - `handleOpenSheetQuery`: sender `context.user?.isGM !== true` → `SHEET_DENIED` "Only a GM may open a sheet on
    another user's client."; `typeof data?.uuid !== 'string'` → `ARGS_INVALID`; `resolveDocument({ uuid })` refusal →
    its code and message; `!document.testUserPermission(game.user, 'OBSERVER')` → `SHEET_DENIED` "This user needs
    OBSERVER on the document to see its sheet."; then `renderSheet(document)`.
  - `handleCloseSheetQuery`: sender `context.user?.isGM !== true` → `SHEET_DENIED` "Only a GM may close a sheet on
    another user's client."; `typeof data?.uuid !== 'string'` → `ARGS_INVALID`; `resolveDocument({ uuid })` refusal →
    its code and message; then `closeSheet(document)`.
- `renderSheet`: `document.sheet` null → `SHEET_UNAVAILABLE` "This document has no sheet."; otherwise
  `await sheet.render({ force: true })`; `sheet.rendered !== true` afterwards → `SHEET_UNAVAILABLE` "Foundry did not
  render the sheet."; success → `{ ok: true, appId: truncateUtf8(sheet.id, APP_ID_MAX_BYTES) }`.
- `closeSheet`: `document.sheet?.rendered === true` → `await sheet.close()`, `{ ok: true, closed: true }`; otherwise
  `{ ok: true, closed: false }`.
- `remoteUser(userId)`: no `userId`, or `userId === game.user.id` → `null` (the call runs on this client, no
  self-query). `game.users.get(userId)` undefined → throws `ARGS_INVALID` "No user '<cleanForLog(userId, 32)>'.";
  `user.active !== true` → throws `USER_OFFLINE` "User '<cleanForLog(user.name, 64)>' is not connected; a sheet opens
  or closes only on a connected user's client."; else returns the user.
- `askUser(user, queryName, uuid, isSuccess)`: `await user.query(queryName, { uuid }, { timeout:
  SHEET_QUERY_TIMEOUT_MS })`. A rejection → throws `SHEET_QUERY_FAILED` with `describeCause(error, 200)`. A reply
  `{ ok: false, code, message }` whose code matches `/^[A-Z][A-Z0-9_]{0,63}$/` → throws that code with
  `cleanForLog(message, 200)`; any other reply for which `isSuccess(reply)` is false → throws `SHEET_QUERY_FAILED`
  "The user's client sent an unexpected reply."; else returns the reply.
- `openSheetHandler`: resolve with `resolveDocument({ uuid: args.uuid })`; `unreadable(document)` non-null → throw
  its code and message; `remoteUser(args.userId)` null → `renderSheet(document)` (an `ok: false` outcome is thrown as
  a `ScriptError` with its code and message); otherwise `askUser(user, OPEN_SHEET_QUERY, document.uuid, isOpened)`,
  where `isOpened` holds for `{ ok: true, appId: string }`. Success → `{ ok: true, appId: truncateUtf8(appId,
  APP_ID_MAX_BYTES) }`.
- `closeSheetHandler`: resolve and check `unreadable` as `openSheetHandler` does; `remoteUser(args.userId)` null →
  `closeSheet(document)`; otherwise `askUser(user, CLOSE_SHEET_QUERY, document.uuid, isClosed)`, where `isClosed`
  holds for `{ ok: true, closed: boolean }`. Result → `{ ok: true, closed }`.
- `registerSheetQueries` sets `CONFIG.queries[OPEN_SHEET_QUERY] = handleOpenSheetQuery` and
  `CONFIG.queries[CLOSE_SHEET_QUERY] = handleCloseSheetQuery`. `OnceInit.js` calls it for every user (not only GMs):
  players must be able to receive both queries.

- [ ] **Step 1: Write the failing query-handler tests** in `tests/unit/sheetQuery.test.js` (mock `game.user`,
  `fromUuid` and a document whose `sheet` has `render`, `rendered`, `id`, as `tests/unit/getDocument.test.js` mocks
  documents):

```js
it('refuses a sender who is not a GM and renders nothing', async () => {
   expect(await handleOpenSheetQuery({ uuid: 'Actor.MOCKACTOR0000001' }, { user: { isGM: false } }))
      .toEqual({ ok: false, code: 'SHEET_DENIED', message: expect.stringContaining('GM') });
   expect(sheet.render).not.toHaveBeenCalled();
});
it('refuses when this client\'s user lacks OBSERVER, LIMITED included', async () => {
   document.testUserPermission = vi.fn(() => false);
   expect((await handleOpenSheetQuery({ uuid }, { user: gm })).code).toBe('SHEET_DENIED');
   expect(document.testUserPermission).toHaveBeenCalledWith(game.user, 'OBSERVER');
   expect(sheet.render).not.toHaveBeenCalled();
});
it('renders the sheet for a GM sender when the user has OBSERVER', async () => {
   expect(await handleOpenSheetQuery({ uuid }, { user: gm }))
      .toEqual({ ok: true, appId: 'MockSheet-Actor-MOCKACTOR0000001' });
   expect(sheet.render).toHaveBeenCalledWith({ force: true });
});
it('reports SHEET_UNAVAILABLE when Foundry declines to render', ...);   // render resolves, rendered stays false
it('reports DOC_NOT_FOUND for a uuid that does not resolve', ...);
it('reports ARGS_INVALID for a uuid that is not text', ...);
it('never throws: an exception from the sheet becomes SHEET_UNAVAILABLE', ...);
it('close: refuses a sender who is not a GM and closes nothing', async () => {
   expect(await handleCloseSheetQuery({ uuid }, { user: { isGM: false } }))
      .toEqual({ ok: false, code: 'SHEET_DENIED', message: expect.stringContaining('GM') });
   expect(sheet.close).not.toHaveBeenCalled();
});
it('close: closes a rendered sheet for a GM sender', async () => {
   sheet.rendered = true;
   expect(await handleCloseSheetQuery({ uuid }, { user: gm })).toEqual({ ok: true, closed: true });
   expect(sheet.close).toHaveBeenCalledTimes(1);
});
it('close: reports closed false when the sheet is not open', ...);         // close not called
it('close: reports DOC_NOT_FOUND for a uuid that does not resolve', ...);
it('registers both queries', () => {
   registerSheetQueries();
   expect(CONFIG.queries['wiretap.openSheet']).toBe(handleOpenSheetQuery);
   expect(CONFIG.queries['wiretap.closeSheet']).toBe(handleCloseSheetQuery);
});
```

- [ ] **Step 2: Write the failing handler tests** in `tests/unit/openSheet.test.js` and `tests/unit/closeSheet.test.js`:

```js
it('renders on this client when no userId is given, sending no query', ...);         // { ok: true, appId }
it('renders on this client when userId is this client\'s own user', ...);
it('sends wiretap.openSheet with the canonical uuid and a 5000 ms timeout', async () => {
   await openSheetHandler({ uuid: 'Actor.MOCKACTOR0000001', userId: 'MOCKPLAYER000001' }, ctx);
   expect(player.query).toHaveBeenCalledWith('wiretap.openSheet', { uuid: 'Actor.MOCKACTOR0000001' }, { timeout: 5000 });
});
it('refuses an unknown userId with ARGS_INVALID', ...);
it('refuses an offline user with USER_OFFLINE naming the user and sends nothing', ...);
it('passes the target client\'s refusal code through', ...);   // reply { ok: false, code: 'SHEET_DENIED', ... }
it('reports SHEET_QUERY_FAILED when the query rejects', ...);
it('keeps the result within 128 bytes for a 200-character app id', async () => {
   expect(utf8Bytes(JSON.stringify(await openSheetHandler({ uuid }, ctx)))).toBeLessThanOrEqual(128);
});
it('refuses a wiretap setting with DOC_EXCLUDED', ...);
// closeSheet.test.js
it('closes a rendered sheet on this client when no userId is given, sending no query', ...);  // { ok: true, closed: true }
it('reports closed false when the sheet is not open', ...);   // close not called
it('reports closed false for a document without a sheet', ...);
it('sends wiretap.closeSheet with the canonical uuid and a 5000 ms timeout', async () => {
   player.query = vi.fn(async () => ({ ok: true, closed: true }));
   expect(await closeSheetHandler({ uuid: 'Actor.MOCKACTOR0000001', userId: 'MOCKPLAYER000001' }, ctx))
      .toEqual({ ok: true, closed: true });
   expect(player.query).toHaveBeenCalledWith('wiretap.closeSheet', { uuid: 'Actor.MOCKACTOR0000001' }, { timeout: 5000 });
});
it('refuses an offline user with USER_OFFLINE and sends nothing', ...);
it('passes the target client\'s refusal code through', ...);   // reply { ok: false, code: 'SHEET_DENIED', ... }
it('reports SHEET_QUERY_FAILED for a reply without a boolean closed', ...);   // reply { ok: true }
```

  Add to `tests/unit/OnceInit.test.js`: `it('registers both sheet user queries for every user')`, run with a non-GM
  `game.user`, expecting `CONFIG.queries['wiretap.openSheet']` and `CONFIG.queries['wiretap.closeSheet']` to be
  functions.

- [ ] **Step 3: Write the failing integration test** `tests/integration/sheetTools.test.js` (`// @vitest-environment
  node`, `createHarness()` of `tests/integration/mcpHarness.js`; the fake GM registers `[...shippedScripts(),
  openSheetDefinition, closeSheetDefinition]`, as `tests/integration/writeToolsB.test.js` does):

```js
it('lists open_sheet and close_sheet as read-only and forwards their arguments as a callTool op', ...);
//   annotations.readOnlyHint true; gm.invokes[0].params equals { name: 'open_sheet', arguments: { uuid, userId } };
//   gm.invokes[1].params equals { name: 'close_sheet', arguments: { uuid, userId } }
it('refuses a userId over 16 characters on either tool before anything is sent', ...);   // isError, invokes 0
it('refuses an undeclared argument before anything is sent', ...);
```

- [ ] **Step 4: Run them.** `npx vitest run tests/unit/sheetQuery.test.js tests/unit/openSheet.test.js
  tests/unit/closeSheet.test.js tests/unit/OnceInit.test.js tests/integration/sheetTools.test.js`. Expected: FAIL,
  modules not found.
- [ ] **Step 5: Implement** the five new files and the `OnceInit.js` call with the signatures and values above.
- [ ] **Step 6: Verify.** The command of Step 4, then `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all
  pass.
- [ ] **Step 7: Commit** `feat(client): open_sheet and close_sheet with the wiretap sheet user queries`.

---

### Task 3: Dice — `roll` and `draw_table`

The user asked for M6. This task delivers `roll(formula, toChat=false)` and `draw_table(uuid, toChat=false)`; nothing
is posted to chat unless `toChat` is true (the spec's answer to ChatMessage spam).

Foundry behaviour this relies on (READ):
- `Roll#evaluate({allowInteractive})` (`client/dice/roll.mjs:274`); `false` never prompts for manual dice.
  `Roll.validate(formula)` (`:773-789`). `roll.dice` lists every `DiceTerm` (`:158-165`); `roll.total` (`:193-195`).
  `toMessage()` posts the evaluated roll with the client's message mode (`:926-952`).
- A dice term over 999 results throws "You may not evaluate a DiceTerm with more than 999 requested results"
  (`client/dice/terms/dice.mjs:270-271`).
- `RollTable#draw({displayChat})` returns `{roll, results}`, marks drawn results `drawn: true` when the table has no
  replacement and is not in a pack (`client/documents/roll-table.mjs:98-144`, marking at `:109-114`, chat at
  `:133-140`). With nothing drawable it warns and returns no results (`:277-281`, `:292-295`).
- `TableResult` fields: `type`, `name`, `description` (HTML), `documentUuid`, `range`, `drawn`
  (`common/documents/table-result.mjs:46-63`).

**Files:**
- Create: `src/bridge/scripts/diceDefinitions.js`, `src/bridge/scripts/roll.js`, `src/bridge/scripts/drawTable.js`
- Test: `tests/unit/roll.test.js`, `tests/unit/drawTable.test.js`, `tests/integration/diceTools.test.js`

**Interfaces:**
- Consumes: `getBudget('ROLL_RESULT_MAX_BYTES')`, `getBudget('DRAW_RESULT_MAX_BYTES')` (Task 1);
  `resolveDocument`, `ScriptError`, `truncateUtf8`, `utf8Bytes`, `cleanForLog`, `describeCause`.
- Produces:
  - `diceDefinitions.js`: `export const rollDefinition`, `export const drawTableDefinition`.
  - `roll.js`: `export async function rollHandler(args, ctx): Promise<RollResult>`,
    `@typedef {{ total: number, formula: string, dice: Array<[number, number[]] | [number, number[], number[]]>,
    cut?: true }} RollResult`.
  - `drawTable.js`: `export async function drawTableHandler(args, ctx): Promise<DrawResult>`,
    `@typedef {{ total: number | null, results: Array<{ name: string, text?: string, uuid?: string }>,
    count: number, cut?: true }} DrawResult`.

Values pinned:
- `rollDefinition`: `name: 'roll'`, description
  `Roll a dice formula such as 2d6+3. Returns the total and each die; toChat posts the roll to chat (default false).`,
  `inputSchema` `{ type: 'object', properties: { formula: { type: 'string', maxLength: 256 }, toChat: { type:
  'boolean' } }, required: ['formula'], additionalProperties: false }`, budget `ROLL_RESULT_MAX_BYTES`,
  `requires: 'api'`, `mutates: true` (it can create a ChatMessage).
- `drawTableDefinition`: `name: 'draw_table'`, description
  `Draw from a RollTable by uuid; drawn results are marked as Foundry does. toChat posts the draw to chat (default false).`,
  `inputSchema` `{ type: 'object', properties: { uuid: { type: 'string' }, toChat: { type: 'boolean' } },
  required: ['uuid'], additionalProperties: false }`, budget `DRAW_RESULT_MAX_BYTES`, `requires: 'api'`,
  `mutates: true` (it marks results drawn).
- `rollHandler`: a formula containing `@` → `ARGS_INVALID` "roll has no data source: write numbers instead of
  @references." (a missing reference would silently roll as another value); `Roll.validate(formula)` false →
  `ARGS_INVALID` naming `cleanForLog(formula, 64)`; `evaluate({ allowInteractive: false })` throwing → `ARGS_INVALID`
  with `describeCause(error, 200)`. `toChat === true` → `await roll.toMessage()` after evaluation. Result: `total`,
  `formula` = `truncateUtf8(roll.formula, 128)`, `dice` = one entry per die term in order: `[faces, active results]`,
  plus a third array of the inactive (dropped, rerolled, discarded) results when there are any. Results are listed
  in order until one more would push the serialized result over 512 B; then listing stops and `cut: true` is set.
- `drawTableHandler`: resolve; `documentName !== 'RollTable'` → `ARGS_INVALID`; `await table.draw({ displayChat:
  args.toChat === true })`; no results → `TABLE_EMPTY` "Nothing could be drawn: every result is drawn (reset the
  table) or none is in the formula's range." Rows: `name` = `truncateUtf8(result.name, 64)`; `text` = the plain text
  of `description` (tags removed, whitespace collapsed), `truncateUtf8(…, 200)`, present when non-empty; `uuid` =
  `documentUuid` when present. `total` = `roll?.total ?? null`; `count` = the number of drawn results. Rows are
  dropped from the end until the serialized result is ≤ 1000 B; `cut: true` when any was dropped.

- [ ] **Step 1: Write the failing roll tests** in `tests/unit/roll.test.js` (a mock `Roll` class on
  `globalThis.Roll`/`foundry.dice.Roll` with `validate`, `evaluate`, `dice`, `total`, `formula`, `toMessage`):

```js
it('returns the total, the formula and each die term as [faces, results]', async () => {
   expect(await rollHandler({ formula: '2d6' }, ctx)).toEqual({ total: 9, formula: '2d6', dice: [[6, [4, 5]]] });
});
it('lists inactive results as a third entry', ...);              // 4d6kh3 -> [[6, [6, 5, 4], [1]]]
it('evaluates without interactive prompts', ...);               // evaluate called with { allowInteractive: false }
it('posts to chat only when toChat is true', ...);               // toMessage: 0 calls by default, 1 with toChat
it('refuses a formula with @ references with ARGS_INVALID', ...);
it('refuses an invalid formula with ARGS_INVALID', ...);
it('turns Foundry\'s 999-results refusal into ARGS_INVALID', ...);
it('stays within 512 bytes for 999 results of a d1000 and reports cut', async () => {
   const result = await rollHandler({ formula: '999d1000' }, ctx);
   expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(512);
   expect(result.cut).toBe(true);
});
```

- [ ] **Step 2: Write the failing draw tests** in `tests/unit/drawTable.test.js`:

```js
it('draws with displayChat false by default and returns the rows', ...);  // draw called with { displayChat: false }
it('passes displayChat true when toChat is true', ...);
it('gives a text result its plain text and a document result its uuid', ...); // '<p>A <b>red</b> door</p>' -> 'A red door'
it('reports TABLE_EMPTY when nothing is drawn', ...);
it('refuses a document that is not a RollTable with ARGS_INVALID', ...);
it('stays within 1000 bytes for 20 results with 2000-character descriptions and reports cut', ...);
```

- [ ] **Step 3: Write the failing integration test** `tests/integration/diceTools.test.js` (fake GM registers
  `[...shippedScripts(), rollDefinition, drawTableDefinition]`):

```js
it('lists roll and draw_table as mutating tools and forwards toChat', ...);  // readOnlyHint false
it('refuses a formula over 256 characters before anything is sent', ...);    // gm.invokes.length 0
```

- [ ] **Step 4: Run them.** `npx vitest run tests/unit/roll.test.js tests/unit/drawTable.test.js
  tests/integration/diceTools.test.js`. Expected: FAIL, modules not found.
- [ ] **Step 5: Implement** the three files with the signatures and values above.
- [ ] **Step 6: Verify.** Step 4's command, then `npm test`, `npm run typecheck`, `npm run eslint`. Expected: pass.
- [ ] **Step 7: Commit** `feat(client): roll and draw_table scripts`.

---

### Task 4: `execute_macro` behind `allowMacroExecution`

The user asked for M6. This task delivers `execute_macro(uuid, actorUuid?, tokenUuid?)`: it runs a Macro as the GM
client, optionally naming the Actor and the Token the macro acts on, and returns its value, only while the GM-only
`allowMacroExecution` gate is open (§4.6: a macro is arbitrary code).

Foundry behaviour this relies on (READ):
- `Macro#execute(scope)` (`client/documents/macro.mjs:81-95`) warns and returns nothing when the user cannot execute
  (`:82-85`; `canUserExecute` = LIMITED, `:63-65`). A chat macro uses only `scope.speaker` (`:88`) and returns the
  promise of `ui.chat.processMessage(command, {speaker})` (`:107-116`). A script macro needs a plain-object scope
  (`:90-92`) and receives `speaker`, `actor`, `token` (`:130`): absent ones are filled as `speaker =
  ChatMessage.getSpeaker({actor, token})` (`:133`), `token = canvas.tokens.get(speaker.token)` (`:135`), `actor =
  token?.actor || game.actors.get(speaker.actor)` (`:136`). `scope.actor` is an Actor and `scope.token` a `Token`
  placeable on the canvas, not a TokenDocument (`:73-74`, `:125-126`). The `AsyncFunction` is built outside any `try`
  (`:146`), so a syntax error throws synchronously, and an error inside the macro rejects the returned promise (the
  `try` at `:150-154` catches only synchronous errors).
- `ChatMessage.getSpeaker({actor, token})` accepts a `Token` placeable or a TokenDocument, and an Actor
  (`client/documents/chat-message.mjs:217-234`).
- A TokenDocument's `object` (its placeable) is null unless its scene is the one this client views and the canvas has
  its layer (`client/documents/abstract/canvas-document.mjs:31-35`).

Argument design:
- `uuid` (required): the Macro. `actorUuid` (optional): an Actor, a world Actor or a token's synthetic Actor.
  `tokenUuid` (optional): a Token on the scene this client views.
- All three are resolved and checked before the macro runs, in the order `uuid`, `actorUuid`, `tokenUuid`; the first
  refusal is thrown and the macro does not run.
- With neither `actorUuid` nor `tokenUuid`, `macro.execute()` gets no scope, so Foundry's own defaults apply. With
  either, the scope is `{ speaker, actor, token }`: `actor` the resolved Actor or `undefined`, `token` the Token
  placeable (`tokenDocument.object`) or `undefined`, and `speaker` =
  `foundry.documents.ChatMessage.implementation.getSpeaker({ actor, token })`, which a chat macro uses to speak as
  that actor or token and which equals what Foundry computes for a script macro.

**Files:**
- Create: `src/bridge/scripts/macroDefinitions.js`, `src/bridge/scripts/executeMacro.js`
- Test: `tests/unit/executeMacro.test.js`, `tests/integration/macroTools.test.js`

**Interfaces:**
- Consumes: `getBudget('RESULT_HARD_CAP_MAX_BYTES')`; `resolveDocument`; `ScriptError`; `cleanForLog`,
  `describeCause`; `createScriptRegistry` and `createCallTool` (for the gate test, as `tests/unit/callTool.test.js`
  uses them).
- Produces: `export const executeMacroDefinition`;
  `export async function executeMacroHandler(args, ctx): Promise<MacroResult>`,
  `@typedef {{ type: 'script' | 'chat', value: unknown, unserializable?: true }} MacroResult`.

Values pinned:
- `executeMacroDefinition`: `name: 'execute_macro'`, `version: '1.0.0'`, description (151 characters)
  `Run a Macro by uuid on this GM client and return its value; actorUuid and tokenUuid set its actor and token. Arbitrary code: needs allowMacroExecution.`,
  `inputSchema` `{ type: 'object', properties: { uuid: { type: 'string' }, actorUuid: { type: 'string' }, tokenUuid:
  { type: 'string' } }, required: ['uuid'], additionalProperties: false }`, `result.budgetBytes` =
  `RESULT_HARD_CAP_MAX_BYTES`, `requires: 'api'`, `mutates: true`, `gate: 'allowMacroExecution'` (the `callTool`
  dispatcher checks it on this client before validation and before the handler).
- Resolution and refusals, in order (`<shown>` is `cleanForLog(<the argument>, 64)`):

  | Argument | Unknown uuid | Wrong document class | Other |
  |---|---|---|---|
  | `uuid` | `DOC_NOT_FOUND` "No document '<shown>'." (from `resolveDocument`) | `ARGS_INVALID` "uuid '<shown>' is a <documentName>, not a Macro." | — |
  | `actorUuid` | `DOC_NOT_FOUND` (from `resolveDocument`) | `ARGS_INVALID` "actorUuid '<shown>' is a <documentName>, not an Actor." | — |
  | `tokenUuid` | `DOC_NOT_FOUND` (from `resolveDocument`) | `ARGS_INVALID` "tokenUuid '<shown>' is a <documentName>, not a Token." | `tokenDocument.object` null → `ARGS_INVALID` "tokenUuid '<shown>' is not on the scene this client views; a macro acts on a token placed on the canvas." |

- Execution: `await macro.execute(scope)` (no argument when there is no scope) inside one `try` that also covers a
  synchronous throw; any error → `MACRO_FAILED` with `describeCause(error, 200)`. `value`: a Foundry Document
  (`instanceof foundry.abstract.Document`) becomes its `uuid`; `undefined` becomes `null`; a value that
  `JSON.stringify` cannot serialize (a cycle, a BigInt) becomes `null` with `unserializable: true`; anything else is
  returned as `JSON.parse(JSON.stringify(value))`. A chat macro's created ChatMessage therefore returns its uuid.

- [ ] **Step 1: Write the failing tests** in `tests/unit/executeMacro.test.js` (`outcome(call)` is a local helper
  that returns the thrown error or null, as in `tests/unit/riskGates.test.js`; the mocks: `fromUuid` resolving the
  uuids below, `macro` with `documentName: 'Macro'` and `execute: vi.fn()`, `actor` with `documentName: 'Actor'`,
  `tokenDocument` with `documentName: 'Token'` and `object` a placeable stand-in, and
  `foundry.documents.ChatMessage.implementation.getSpeaker` = `getSpeaker`, a `vi.fn` returning `speaker`):

```js
it('is denied by callTool while allowMacroExecution is closed, and the macro does not run', async () => {
   // registry.register(executeMacroDefinition, executeMacroHandler); gate closed in the mocked settings
   expect((await outcome(() => callTool({ name: 'execute_macro', arguments: { uuid } })))?.code).toBe('GATE_DENIED');
   expect(macro.execute).not.toHaveBeenCalled();
});
it('runs a script macro and returns its value', ...);              // { type: 'script', value: 5 }
it('returns a Document result as its uuid', ...);
it('returns null with unserializable true for a cyclic value', ...);
it('reports MACRO_FAILED with bounded text when the macro rejects', ...);   // message utf8 bytes <= 256
it('reports MACRO_FAILED when the command does not compile', ...);          // execute throws a SyntaxError
it('returns the uuid of the message a chat macro creates', ...);
it('refuses a document that is not a Macro with ARGS_INVALID', ...);
it('calls execute with no scope when neither actorUuid nor tokenUuid is given', async () => {
   await executeMacroHandler({ uuid }, ctx);
   expect(macro.execute).toHaveBeenCalledWith();
});
it('passes the named actor and its speaker', async () => {
   await executeMacroHandler({ uuid, actorUuid: 'Actor.MOCKACTOR0000001' }, ctx);
   expect(getSpeaker).toHaveBeenCalledWith({ actor, token: undefined });
   expect(macro.execute).toHaveBeenCalledWith({ speaker, actor, token: undefined });
});
it('passes the named token as its placeable', async () => {
   await executeMacroHandler({ uuid, tokenUuid: 'Scene.MOCKSCENE0000001.Token.MOCKTOKEN0000001' }, ctx);
   expect(macro.execute).toHaveBeenCalledWith({ speaker, actor: undefined, token: tokenDocument.object });
});
it.each([
   ['actorUuid', 'Item.MOCKITEM00000001', 'not an Actor'],
   ['tokenUuid', 'Actor.MOCKACTOR0000001', 'not a Token'],
])('refuses %s naming a %s with ARGS_INVALID and does not run the macro', async (name, value, text) => {
   const error = await outcome(() => executeMacroHandler({ uuid, [name]: value }, ctx));
   expect(error?.code).toBe('ARGS_INVALID');
   expect(error.message).toContain(text);
   expect(macro.execute).not.toHaveBeenCalled();
});
it.each(['actorUuid', 'tokenUuid'])('refuses an unknown %s with DOC_NOT_FOUND and does not run the macro', ...);
it('refuses a token that is not on the viewed scene with ARGS_INVALID', ...);   // tokenDocument.object null; no run
```

- [ ] **Step 2: Write the failing integration test** `tests/integration/macroTools.test.js` (fake GM registers
  `[...shippedScripts(), executeMacroDefinition]`):

```js
it('refuses execute_macro with GATE_DENIED while the endpoint snapshot has the gate closed, sending nothing', ...);
it('forwards execute_macro once the endpoint pushes allowMacroExecution open', ...);
//   await gm.pushGates({ ...closedGateState(), allowMacroExecution: true }); then gm.invokes.length === 1,
//   and gm.invokes[0].params.arguments equals { uuid, actorUuid, tokenUuid }
it('refuses an undeclared argument before anything is sent', ...);   // { uuid, actor: 'x' }: isError, invokes 0
```

- [ ] **Step 3: Run them.** `npx vitest run tests/unit/executeMacro.test.js tests/integration/macroTools.test.js`.
  Expected: FAIL, modules not found.
- [ ] **Step 4: Implement** both files with the signatures and values above.
- [ ] **Step 5: Verify.** Step 3's command, then `npm test`, `npm run typecheck`, `npm run eslint`. Expected: pass.
- [ ] **Step 6: Commit** `feat(client): execute_macro behind allowMacroExecution`.

---

### Task 5: A write of Macro code needs `allowMacroExecution`

The user asked for M6, which adds: a write that sets a Macro's `command` (create, update, replace or batch) also needs
`allowMacroExecution`, because the command is code that runs when a user executes the macro. The owner also gated two
more ways to write macro code: an update that changes a Macro's `type` to script (stored text becomes code), and an
Adventure write holding stored `macros` (importing the adventure creates those Macros;
`common/documents/adventure.mjs:47`). The rule goes into `guardWrite` (`src/bridge/scripts/writeGuard.js`), which
every write planner calls (`writes.js` `prepareCreate` and its cleaned-data re-check, `prepareUpdates`,
`writeReplace.js` on the given data and on the built replacement, and `batch` through the same planners), so no write
tool needs its own check.

**Files:**
- Modify: `src/bridge/scripts/writeGuard.js` (`guardWrite`, with the other category gates; update the file comment's
  rule 5 and the `@throws` text)
- Modify: `shared/gates.js:74` (`allowMacroExecution` unlock text), `lang/en.json`
  (`WIRETAP.Settings.Gates.AllowMacroExecution.Hint`)
- Modify: `tests/unit/mockWriteWorld.js` and `tests/unit/mockFoundryData.js` (add a `Macro` class with a `name`,
  `type`, `command`, `ownership` and `flags` schema; and an `Adventure` class with a `macros` field)
- Test: `tests/unit/macroCommandGate.test.js`

**Interfaces:**
- Consumes: `guardWrite(intent)` and its `WriteIntent` (`documentName`, `values`, `targets[].changes`, `operations`,
  `dryRun`); `keyNames` of `shared/writeKeys.js`; `requireOpen('allowMacroExecution')` inside `writeGuard.js`.
- Produces: no new export; `guardWrite` throws `GATE_DENIED` naming `allowMacroExecution` when the gate is closed and:
  - `documentName === 'Macro'` and a value object or a target's cleaned changes has a key whose first `keyNames`
    segment is `command`, whatever its value (a create, an update with `op` set, replace or delete, a batch entry, a
    replace, whose built replacement always holds `command`);
  - `documentName === 'Macro'` and a target's cleaned changes has a key whose first `keyNames` segment is `type` and
    whose value is `'script'`, read through an operator object as `scanWriteValues` reads one
    (`foundry.data.operators.DataFieldOperator.get`). A delete of `type` resets it to `chat` (`common/documents/
    macro.mjs:47`) and needs no gate; a replace is already gated by the `command` rule;
  - `documentName === 'Adventure'` and a value object or cleaned changes has a key whose first segment is
    `macros`.
  - It applies to a `dryRun` too, as the other category gates do (only the `allowDelete` / `allowReplace` operation
    gates skip a preview).

Values pinned:
- `shared/gates.js` unlock text: `'Running macros through execute_macro, and writing macro code: a Macro command, a
  Macro type set to script, an Adventure's stored macros (arbitrary code).'`
- `lang/en.json` hint: `"Lets agents run macros and write the code a macro runs (its command, its type set to script,
  or an Adventure's stored macros). A macro is arbitrary code with GM authority and can call game.settings.set, so
  enabling this lets an agent change any gate; only enable it for agents you trust."` It keeps "arbitrary code" and
  `game.settings.set`, which `tests/unit/gateSettings.test.js` requires.

- [ ] **Step 1: Write the failing tests** in `tests/unit/macroCommandGate.test.js`, over `installWriteWorld` of
  `tests/unit/mockWriteWorld.js` and the write operations (`createDocuments`, `updateDocuments`, `replaceDocument`,
  `batchDocuments`, as `tests/unit/riskGates.test.js` imports them, with its local `outcome(call)` helper), gates read
  from the mocked settings:

```js
it.each(['chat', 'script'])('create of a %s Macro with a command is denied while the gate is closed', async (type) => {
   const error = await outcome(() => createDocuments({ documentName: 'Macro', data: [{ name: 'MOCK_M', type, command: 'x' }] }));
   expect(error?.code).toBe('GATE_DENIED');
   expect(error.message).toContain('allowMacroExecution');
   expect(world.calls).toEqual([]);
});
it('create of a Macro with no command needs no gate', ...);
it.each(['set', 'replace', 'delete'])('update of a Macro command with op %s is denied', ...);
it.each(['set', 'replace'])('update of a Macro type to script with op %s is denied', ...);
it('update of a Macro type to chat, or a delete of type, needs no gate', ...);
it('update of a Macro name needs no gate', ...);
it('replace of a Macro is denied even when its data omits command', ...);  // allowReplace open, allowMacroExecution closed
it('batch creates and updates of a Macro command are denied and nothing is sent', ...);  // modifyBatch not called
it('a dry run of a Macro command write is denied while the gate is closed', ...);
it('every write above runs once allowMacroExecution is open', ...);
it('create of an Adventure holding macros is denied while the gate is closed', ...);
it('update of an Adventure\'s macros is denied while the gate is closed', ...);
it('a command key on a document that is not a Macro needs no gate', ...);   // an Actor flag or system field named command
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/macroCommandGate.test.js`. Expected: FAIL (writes succeed
  with the gate closed, or the mock world has no Macro class).
- [ ] **Step 3: Implement** the mock classes, the `guardWrite` rule, the unlock text and the hint.
- [ ] **Step 4: Verify.** Step 2's command, then `npm test` (the operator grid, `writeGuard`, `riskGates` and
  `gateSettings` suites included), `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(client): writing macro code needs allowMacroExecution`.

---

### Task 6: Register the five scripts, add their budget fixtures, update the user-facing skill

The user asked for M6 "all as M14 scripts". This task makes the five scripts shipped: it lists them in
`SHIPPED_SCRIPTS`, gives each a representative-result fixture so the context-budget test enforces the M6 budgets, adds
the risk-gate check for `execute_macro`, and teaches the user-facing skill the new tools. These files land together
because `tests/unit/shippedSkill.test.js` fails while a shipped script is missing from the skill, and
`tests/unit/contextBudget.test.js` fails while a listed tool has no fixture.

**Files:**
- Modify: `src/bridge/scripts/index.js` (imports; append to `SHIPPED_SCRIPTS` in this order: `open_sheet`,
  `close_sheet`, `roll`, `draw_table`, `execute_macro`)
- Modify: `tests/unit/scriptFixtures.js` (`shippedScripts()`: the same five definitions appended in the same order)
- Modify: `tests/unit/contextBudgetHarness.js` (`FIXTURES`: one entry per new tool)
- Modify: `tests/unit/riskGates.test.js` (the "every risky script is gated" check)
- Modify: `skills/wiretap/SKILL.md`; `tests/unit/shippedSkill.test.js:23` (the line limit, 60 → 70, decided by the
  owner)

**Interfaces:**
- Consumes: `openSheetDefinition`, `openSheetHandler`, `closeSheetDefinition`, `closeSheetHandler` (Task 2);
  `rollDefinition`, `rollHandler`, `drawTableDefinition`, `drawTableHandler` (Task 3); `executeMacroDefinition`,
  `executeMacroHandler` (Task 4); budgets of Task 1.
- Produces: `SHIPPED_SCRIPTS` of 14 entries; `shippedScripts()` of 14 definitions.

Fixtures (synthetic `MOCK_` data, through `setGmAck(okAck(...))` as the existing entries do):
- `open_sheet`: "opened on a user's client with a 100-byte app id", budget `SHEET_RESULT_MAX_BYTES`, ack
  `{ ok: true, appId: 'M'.repeat(100) }`; and "user not connected", budget `ERROR_MAX_BYTES`, error
  `{ code: 'USER_OFFLINE', message: <a 200-byte message> }`.
- `close_sheet`: "closed on a user's client", budget `SHEET_RESULT_MAX_BYTES`, ack `{ ok: true, closed: true }`.
- `roll`: "roll cut to its budget", budget `ROLL_RESULT_MAX_BYTES`, an ack shaped like `RollResult` of 480 to 512 B
  with `cut: true`.
- `draw_table`: "draw of several long results", budget `DRAW_RESULT_MAX_BYTES`, an ack shaped like `DrawResult` of
  900 to 1000 B; and "nothing drawable", budget `ERROR_MAX_BYTES`, error `TABLE_EMPTY`.
- `execute_macro`: "small value", budget `RESULT_HARD_CAP_DEFAULT_BYTES`, ack `{ type: 'script', value: 5 }`; and
  "a 12 KB value becomes a handle", budget `ACK_MAX_BYTES`.
- The fake GM of the harness identifies as `kind: 'human'`; the sheet tools are `requires: 'api'`, so they route
  there.

Risk-gate check: `RISKY_VERB` becomes `/delete|replace|remove|destroy|purge|wipe|execute/`; a matching mutating script
passes when it has a `RISKY` entry or declares a `gate` that is a `GATES` name. Add
`it('gates execute_macro behind allowMacroExecution')`, asserting `executeMacroDefinition.gate === 'allowMacroExecution'`.

User-facing skill: add a "**Sheets.**" recipe (`mcp__wiretap__open_sheet` with `uuid`, and `userId` to show it on
that connected user's client, who needs OBSERVER; without `userId` it opens on the client running the call;
`mcp__wiretap__close_sheet` with the same `uuid` and `userId` closes it there; with no human connected a sheet is seen
by no one, so read data instead) and a "**Dice, tables and macros.**" recipe (`mcp__wiretap__roll` with `formula`,
`toChat` default false, no `@` references; `mcp__wiretap__draw_table` with a RollTable `uuid`, drawn results are
marked, `toChat` default false; `mcp__wiretap__execute_macro` with a Macro `uuid`, and `actorUuid` / `tokenUuid` for
the actor and the token (on the viewed scene) it acts on, needs `allowMacroExecution`, its value comes back, and it
may keep running after `SCRIPT_TIMEOUT`). Add to the errors list `SHEET_DENIED`, `USER_OFFLINE`, `SHEET_UNAVAILABLE`,
`SHEET_QUERY_FAILED`, `TABLE_EMPTY`, `MACRO_FAILED`, and to the gate line `allowMacroExecution`: execute_macro and
writing macro code (a Macro command, a type set to script, an Adventure's macros).

- [ ] **Step 1: Write the failing test changes.** The `riskGates.test.js` change above and the line limit of 70 in
  `shippedSkill.test.js`. Then register the scripts in `index.js` and `scriptFixtures.js` only.
- [ ] **Step 2: Run.** `npx vitest run tests/unit/contextBudget.test.js tests/unit/shippedSkill.test.js
  tests/unit/riskGates.test.js tests/unit/schemaStrict.test.js`. Expected: FAIL: missing fixtures for the five tools
  and the skill not naming them.
- [ ] **Step 3: Implement** the fixtures and the skill text; the skill stays at or under 70 lines.
- [ ] **Step 4: Verify.** Step 2's command, then `npm test`, `npm run typecheck`, `npm run eslint`. Then
  `npx tsx tests/measure/measureContext.mjs`. Expected: all pass; the report lists 15 tools (max 30), total
  definitions ≤ 16,000 B, each new definition ≤ 800 B, each new description ≤ 160 characters, and every new fixture
  within its budget.
- [ ] **Step 5: Commit** `feat(client): ship the sheet, dice and macro scripts`.

---

### Task 7: Sheets e2e on the live world

The user asked for M6, whose tests include "e2e with a GM tab and a player context: the sheet opens on the player
client only with permission; an offline user gives a clear error". This task writes that spec. The spec names a
`wtx-player` user, which no longer exists (deleted at M0 close, `docs/PROGRESS.md:34`); the spec creates a throwaway
player instead.

**Files:**
- Create: `tests/e2e/sheetTools.spec.js`

**Interfaces:**
- Consumes: the shipped `open_sheet` / `close_sheet` (Tasks 2, 6); `login(page, user)` of `tests/e2e/fixtures.js`;
  `startGateSidecar`, `stopSidecar` of `tests/e2e/sidecar.js`; `E2E_MCP_PORT` of `tests/e2e/ports.js`;
  `recordGateSettings`, `restoreGateSettings` of `tests/e2e/gates.js`; `E2E_PREFIX`, `recordDocument`,
  `settleRegistry`, `assertSettled`, `teardownRecorded` of `tests/e2e/registry.js`; `firstSubtype`, `idOf` of
  `tests/e2e/writeHelpers.js`. Follow the setup of `tests/e2e/scripts.spec.js` (sidecar per spec file, MCP SDK client
  per test, `callText` helper).

Setup per test: as GM, create in the page an Actor `${E2E_PREFIX}Sheet Actor <timestamp>` and a User
`${E2E_PREFIX}Player <timestamp>` with role 1 (PLAYER), and record both immediately. The player logs in through a
second browser context (`browser.newContext()`), which is closed in `finally` before the teardown deletes the user.

- [ ] **Step 1: Write the spec** with these tests:

```js
test('opens the sheet on the GM tab when no userId is given, and close_sheet closes it', ...);
//   reply { ok: true, appId: expect.any(String) }, bytes <= 128; GM page: fromUuidSync(uuid).sheet.rendered polls true
//   (timeout 1000); close_sheet -> { ok: true, closed: true }, rendered polls false
test('opens the sheet on the player client only once the player has OBSERVER, then closes it there', ...);
//   ownership NONE -> isError, text contains SHEET_DENIED, player page sheet not rendered;
//   ownership LIMITED (1) -> still SHEET_DENIED; OBSERVER (2) -> ok, player page rendered polls true;
//   the GM page sheet is not rendered by this call;
//   close_sheet { uuid, userId: player id } -> { ok: true, closed: true }, bytes <= 128, player page rendered polls
//   false (timeout 1000); a second close_sheet with the same userId -> { ok: true, closed: false }
test('an offline user gives USER_OFFLINE naming the user, for open_sheet and close_sheet', ...);
//   a second recorded player who never logs in; both replies isError with USER_OFFLINE; bytes <= 512
test('the GM client refuses either query a player sends', ...);
//   player page: await game.users.activeGM.query('wiretap.openSheet', { uuid }, { timeout: 1000 }) resolves
//   { ok: false, code: 'SHEET_DENIED', ... } and the GM page sheet stays closed; then open_sheet with no userId
//   renders it on the GM page, the player's 'wiretap.closeSheet' query resolves SHEET_DENIED, and the GM page sheet
//   is still rendered
```

- [ ] **Step 2: Run.** Confirm no TITAN e2e run is active, then `npx playwright test tests/e2e/sheetTools.spec.js`.
  Expected: 4 passed, and the run's global teardown reports a zero Wiretap census. Then `npm run build`.
- [ ] **Step 3: Report a defect** the spec exposes: log it in `docs/OPEN_BUGS.md` and stop the lane. A fix in Task
  2's files is a change to a buddy-checked security boundary, so the controller takes it to the owner; the spec
  itself is fixed only where the spec, not Task 2's code, is wrong.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`, the Step 2 command. Expected: all pass.
- [ ] **Step 5: Commit** `test(e2e): open_sheet and close_sheet across a GM and a player`.

---

### Task 8: Dice e2e on the live world

The user asked for M6, whose tests include "rolls with `toChat: true` are recorded and torn down (§4.8)". This task
writes the dice and table spec.

**Files:**
- Create: `tests/e2e/diceTools.spec.js`

**Interfaces:**
- Consumes: the shipped `roll` / `draw_table` (Tasks 3, 6) and the e2e helpers named in Task 7.

A ChatMessage is identified on the running list by the `Wiretap E2E ` prefix in `flavor`, and `roll` has no flavor
argument. Before a `toChat: true` call the test registers two page hooks and removes them in `finally`:
`preCreateChatMessage` sets `flavor` to `${E2E_PREFIX}roll` on the message's source (`message.updateSource`), and
`createChatMessage` stores the new message id in a page global; the test then records the message.

- [ ] **Step 1: Write the spec** with these tests:

```js
test('roll returns the total and dice and posts nothing by default', ...);
//   2d6: total between 2 and 12, dice [[6, [a, b]]]; game.messages.size unchanged; bytes <= 512
test('roll with toChat true posts one message, recorded and torn down', ...);
//   one new ChatMessage with rolls[0].total equal to the reply's total
test('a 999d1000 roll stays within 512 bytes and reports cut; 1000d6 is ARGS_INVALID', ...);
test('draw_table draws from a recorded table, marks the result drawn and posts nothing by default', ...);
//   RollTable `${E2E_PREFIX}Table <ts>`, formula 1d3, replacement false, three text results with ranges [1,1],[2,2],[3,3];
//   reply.results.length 1, total in 1..3, that result has drawn true in the world; bytes <= 1000
test('draw_table reports TABLE_EMPTY once every result is drawn', ...);   // three draws, then the fourth
test('draw_table with toChat true posts one message, recorded and torn down', ...);
```

- [ ] **Step 2: Run.** Confirm no TITAN e2e run is active, then `npx playwright test tests/e2e/diceTools.spec.js`.
  Expected: 6 passed; zero census. Then `npm run build`.
- [ ] **Step 3: Fix** only defects the spec exposes, in Task 3's files, each with a unit test in Task 3's test
  files; log each in `docs/OPEN_BUGS.md` until fixed and move it to `docs/CLOSED_BUGS.md` after.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`, the Step 2 command. Expected: all pass.
- [ ] **Step 5: Commit** `test(e2e): roll and draw_table on the live world`.

---

### Task 9: Macro e2e on the live world

The user asked for M6's `execute_macro(uuid, actorUuid?, tokenUuid?)` behind `allowMacroExecution` and the gate on
writes of Macro code. This task proves both on the live world.

**Files:**
- Create: `tests/e2e/macroTools.spec.js`

**Interfaces:**
- Consumes: the shipped `execute_macro`, `create_documents`, `update_documents` (Tasks 4, 5, 6) and the e2e helpers of
  Task 7, plus `createArguments`, `patch` of `tests/e2e/writeHelpers.js`. Gates open only through an `openGate`
  helper like the one in `tests/e2e/writeTools.spec.js`; `restoreGateSettings` in `afterEach` closes them.

- [ ] **Step 1: Write the spec** with these tests:

```js
test('creating a Macro with a command is denied while allowMacroExecution is closed', ...);
//   create_documents Macro { name: `${E2E_PREFIX}Macro <ts>`, type: 'script', command: 'return 2 + 3;' }
//   -> isError, text contains GATE_DENIED and allowMacroExecution; no such Macro exists in the world
test('with the gate open, a created macro runs, and an updated command runs the new code', ...);
//   create (record it) -> execute_macro -> { type: 'script', value: 5 };
//   update_documents patch(uuid, 'command', 'return 7;') -> execute_macro -> value 7
test('execute_macro is denied while the gate is closed and the macro does not run', ...);
//   macro created in the page and recorded; its command sets globalThis.wiretapE2eMacroRan = true;
//   after the denied call the page global is undefined
test('a macro that throws reports MACRO_FAILED within 512 bytes', ...);
test('changing a chat Macro to script is denied while the gate is closed', ...);
//   chat macro created in the page with no command key and recorded; update_documents patch(uuid, 'type', 'script')
//   -> isError, text contains GATE_DENIED and allowMacroExecution; the Macro's type is still 'chat'
test('execute_macro passes actorUuid as actor and tokenUuid as the placed token', ...);
//   precondition: game.settings.get('core', 'noCanvas') is false on the GM page; the test fails saying so otherwise.
//   Recorded in the page: Actor `${E2E_PREFIX}Macro Actor <ts>`; Scene `${E2E_PREFIX}Macro Scene <ts>` with one Token
//   `${E2E_PREFIX}Token` of that actor (as tests/e2e/writeTools.spec.js creates one); a script macro whose command is
//   `return [actor?.name ?? null, token?.document?.uuid ?? null];`. Gate open.
//   { uuid, actorUuid } -> value [actor name, null];
//   { uuid, tokenUuid } while the GM page does not view the recorded scene -> isError, ARGS_INVALID, text contains
//   'not on the scene';
//   { uuid, tokenUuid: actor uuid } -> isError, ARGS_INVALID, text contains 'not a Token';
//   the GM page stores game.scenes.viewed?.id, awaits scene.view(), then { uuid, tokenUuid } -> value
//   [actor name, token uuid]; in finally the stored scene is viewed again (Scene#view is local to this client,
//   client/documents/scene.mjs:258)
```

- [ ] **Step 2: Run.** Confirm no TITAN e2e run is active, then `npx playwright test tests/e2e/macroTools.spec.js`.
  Expected: 6 passed; zero census; every gate restored. Then `npm run build`.
- [ ] **Step 3: Report a defect** the spec exposes: log it in `docs/OPEN_BUGS.md` and stop the lane. A fix in Task
  4's or Task 5's files is a change to a buddy-checked security boundary, so the controller takes it to the owner;
  the spec itself is fixed only where the spec, not the code, is wrong.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`, the Step 2 command. Expected: all pass.
- [ ] **Step 5: Commit** `test(e2e): execute_macro and the Macro code gate on the live world`.

---

### Task 10: Tracking files, skills and the knowledge graph

The user asked for M6; `.claude/CLAUDE.md` makes the documentation step part of every plan ("a plan is not complete
until this is done"). This task brings every tracking file and skill to the state the code is in now.

**Files:**
- Modify: `docs/PROGRESS.md` (M6 row in "Milestone completion": status Done, date, commit hashes; an "As-built
  notes: M6" section with the measured definition sizes from `npx tsx tests/measure/measureContext.mjs`, the e2e
  results of Tasks 7–9, and the owner's decisions of 2026-11-20: the sheet tools are `api` tools with `userId?` and
  never broadcast; `close_sheet` uses a second query, `wiretap.closeSheet`, with the same sender-is-GM check;
  `draw_table` has `toChat`, default false; `execute_macro` takes `uuid`, `actorUuid?`, `tokenUuid?`; a Macro `type`
  change to script and an Adventure's stored `macros` also need `allowMacroExecution`; the user-facing skill limit is
  70 lines; the per-family definition files, six error codes and the `wiretap-gameplay` skill were approved; T2, T4
  and T5 took a buddy check)
- Modify: `docs/TODO.md` (the owner chose no new deferral for M6, so add none; delete items M6 completed;
  author/user fields, `_stats.createdTime` and folder/sort items stay)
- Modify: `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md`, `docs/POST_WORK_FINDINGS.md` as the run touched them
- `docs/PLAN.md` is not edited: it already states the M6 decisions, and it stays forward-looking
- Modify: `README.md`: the tool list, the open-sheet semantics (on a chosen connected user's client, who needs
  OBSERVER; without `userId` on the client running the call; `close_sheet` closes it the same way; with no human
  connected only data or measurements), the `toChat` defaults, `execute_macro`'s `actorUuid` and `tokenUuid`, and the
  `allowMacroExecution` row of "Settings and risk gates" (also covers writing macro code: a Macro command, a type set
  to script, an Adventure's stored macros)
- Modify: `.claude/skills/wiretap-scripts/SKILL.md` (files table, `SHIPPED_SCRIPTS` list, the user-facing skill limit
  of 70 lines), `.claude/skills/wiretap-write-guard/SKILL.md` (the Macro code gate in "Order of the guard"),
  `.claude/skills/wiretap-client/SKILL.md` (`OnceInit` registers both sheet queries; `src/bridge/sheetQuery.js`),
  `.claude/skills/wiretap-mcp-bridge/
  SKILL.md` (description's tool list), `.claude/skills/wiretap-build-test/SKILL.md` (the three e2e specs and new unit
  and integration files), `.claude/skills/wiretap-codebase-core/SKILL.md` (subsystem map)
- Create: `.claude/skills/wiretap-gameplay/SKILL.md` (core skill rule 3: the sheet, dice and macro tools are a new
  tool family), with `paths:` for the Task 2–4 files and their tests; add its row to the skill table of
  `.claude/CLAUDE.md` and to the core skill's subsystem map

- [ ] **Step 1: Write** the updates above. Skills describe the current code only, read from the code, not a
  changelog.
- [ ] **Step 2: Measure** every `SKILL.md` touched or created: each stays below 20,000 characters.
- [ ] **Step 3: Run** `graphify update .`. Expected: completes without error.
- [ ] **Step 4: Verify.** `npm test` (the skill-mention checks of `contextBudget.test.js` and `shippedSkill.test.js`
  read `skills/**`). Expected: pass.
- [ ] **Step 5: Commit** `docs: close M6; progress, README and skills`.
