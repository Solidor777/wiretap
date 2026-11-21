# Wiretap M18 "Compendium pack tools" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `parallel-subagent-development` to implement this plan. Steps use
> checkbox (`- [ ]`) syntax for tracking. Every task brief is the task's text plus the whole "Global Constraints"
> section, copied verbatim: the implementer does not read this file.

**Goal:** ship the two tools `create_pack` and `delete_pack` for world compendium packs (each with `dryRun`), the
`allowPackDeletion` gate, and the tool-level prompt carrier: a script definition may set `requiresUserInteraction: true`,
the sidecar maps it to the MCP tool's `_meta["anthropic/requiresUserInteraction"]: true`, and the sidecar sets it for any
tool named `delete_pack` whatever the client sent, so Claude Code asks the human before every deletion.

**Architecture:** both tools are scripts in the GM client's shipped registry (`src/bridge/scripts/`), like the other
write tools. Each handler checks its gate itself, after the `dryRun` branch, so a preview works with the gate closed. The
handlers refuse what Foundry would refuse (type, name, collision, non-world pack, locked pack) before calling
Foundry, so Foundry never shows a GM-screen error for input Wiretap could have refused. Creation calls
`foundry.documents.collections.CompendiumCollection.createCompendium`; deletion calls `pack.deleteCompendium()`; the
Foundry server removes the pack files, Wiretap code touches none. The carrier is one optional boolean in the shared
definition validator, one field on the sidecar's `RegistryTool`, and one `_meta` entry in the sidecar's `registerTool`
call.

**Tech Stack:** TypeScript on `tsx` (sidecar), JavaScript ES modules (shared, client), Foundry VTT v14 client API, MCP SDK
1.29.0 (Streamable HTTP), zod, vitest + happy-dom, Playwright (headless).

**Spec:** `docs/specs/2026-11-21-wiretap-pack-tools-design.md` (approved 2026-11-21; the owner delegated the design),
with `docs/PLAN.md` §5 "M18 — Compendium pack tools", D30, D34, §2.5 (safeguard 2), §4.6 (gates) and §4.8 (test-data
cleanup).

## Model/Effort directives

- Plan writer: dispatched `sdd-plan-writer-opus`.
- Execution method: parallel
- Loop owner: mainline session
- Implementer per task (project rule, `.claude/CLAUDE.md`): `foundry-module-dev` for Tasks 3, 4, 5 and 6 (client `.js`
  under `src/`); `wiretap-coder` for Tasks 1, 2, 7, 8, 9 and 10 (`server/`, `shared/`, tests, docs). The
  `dispatching-sdd-agents` tiers choose only the model and effort these agents run at.
- Per-task review: none; review groups instead (see `## Lanes`). `wiretap-spec-reviewer`, then `wiretap-code-reviewer`
  per group; at most three fix rounds per group. Task 2 takes a buddy check (see "Buddy-check directives").

## Global Constraints

Every task's requirements include each line below.

- **Scope.** The user asked for compendium tools ("Execute the milestone with paralell subagent development. Do the
  same with compendium tools") and delegated the design. This milestone builds exactly what
  `docs/specs/2026-11-21-wiretap-pack-tools-design.md` states, with the calls in "Designer decisions" below. No pack
  folders, ownership, lock or rename arguments, no unlocking, no system or module packs, no pack content copy or import.
  Nothing outside the task's own files is changed; a defect found elsewhere is reported, not fixed.
- **Builders carry this line word for word:** "No unrequested features, shims or defensive code. A guard against input
  the product cannot send is not requested." Socket and MCP input is untrusted (any local process can connect and
  identify, and any MCP client can send any arguments), so its bounds are requested.
- **Agents.** Implementers: `foundry-module-dev` for client `.js`/`.svelte`; `wiretap-coder` for `server/`, `shared/`,
  tests, build config, docs. Reviewers: `wiretap-spec-reviewer` then `wiretap-code-reviewer`.
- **Skills first.** Before reading or editing a subsystem's files, read its skill file under `.claude/skills/`:
  `wiretap-codebase-core` always; `wiretap-scripts` for `src/bridge/scripts/**`, `skills/**` and
  `tests/e2e/registryCore.js`; `wiretap-mcp-sessions` for `shared/scripts.js`, `server/toolRegistry.ts`, the session
  parts of `server/mcp.ts` and `tests/integration/mcpSessions*`; `wiretap-mcp-bridge` for `server/mcp.ts` tools;
  `wiretap-write-guard` for `shared/gates.js` and the guard; `wiretap-writes` for the write scripts the pack handlers
  imitate; `wiretap-build-test` for `tests/**`. For Foundry API behaviour invoke the `foundry-vtt:foundry-vtt` skill.
- **TDD, no stubs.** Write the failing test, see it fail, write the code, see it pass. No placeholder bodies.
- **Formatting.** 3-space indentation as the existing files use; 120-character lines; multi-line `{}` on every
  conditional; objects with more than one property and arrays with more than one entry are multi-line; every variable
  typed with a one-line comment (JSDoc `@type` in `.js`, a type annotation plus a `//` line in `.ts`); every function a
  JSDoc block with typed params (`{Type} [optional] - text`) and a typed return (async included); classes and objects
  typed with `@typedef` / interfaces. No `:global` CSS selectors.
- **Comments.** Present tense, what or why only. No task IDs, plan or spec references, review notes or history. Cite the
  Foundry source file for any Foundry behaviour a comment relies on. A `TODO:` describes the work only and is logged in
  `docs/TODO.md`.
- **No backwards compatibility.** No aliases, shims, deprecation paths or migrations. No dynamic imports in shipping
  builds. No test code in shipping builds.
- **Pack files are Foundry's (D34).** Wiretap code, product and test, calls no permanent-delete API
  (`tests/unit/noPermanentDelete.test.js` enforces it). The Foundry server removes a deleted pack's files. The only code
  that calls `deleteCompendium` is `src/bridge/scripts/deletePack.js` and the e2e registry teardown in
  `tests/e2e/registryCore.js`.
- **Never probe malformed create data on the shared live world** (a wrapper in `name` once stopped the world booting).
  Unit tests mock `game`. e2e creates only well-formed `Wiretap E2E ` packs; a refusal case (bad name, collision, bad
  type, system pack) uses `dryRun: true`, which refuses in the handler and never reaches Foundry even when the handler
  has a defect.
- **e2e.** Headless Playwright only (`playwright.config.mjs`). Every wait inside a loaded page is at most 1000 ms
  (`expect.poll`, `waitForFunction`, `toPass`, `timeout:`); world boot, login, reload, the build, the `actionTimeout`
  safety net and per-test limits are exempt. Only one task runs e2e at a time: `npx playwright test` uses the live
  Foundry on `:30000` (shared with another project's e2e) and ports 31416, 31418 and 31419, and overwrites `dist/`; run
  `npm run build` after it. Every e2e pack label starts with `Wiretap E2E ` and is recorded with `recordDocument` of
  `tests/e2e/registry.js` right after creation; `settleRegistry` / `teardownRecorded` remove it.
- **Context budgets (D17), enforced by `tests/unit/contextBudget.test.js`:** each pack tool result at most 256 B
  (`ACK_MAX_BYTES`); every definition at most 800 B; description at most 160 characters (warn) and 240 (hard); all
  definitions together at most 16,000 B; at most 30 listed tools. A budget is raised only by the owner. Bytes are raw
  UTF-8 bytes; 1 KB = 1000 B in this project. The `_meta` flag is not part of the definition size
  (`definitionBytes` counts name, description and schema).
- **Errors.** A client script fails by throwing `new ScriptError(code, message)` of
  `src/bridge/scripts/registry.js` (code `/^[A-Z][A-Z0-9_]{0,63}$/`, message at most 256 B). No message echoes unbounded
  caller text: bound it with `cleanForLog` of `shared/logText.js` and `truncateUtf8` of `shared/utf8.js`.
- **Commands.** `npm test`, `npm run typecheck`, `npm run eslint`, `npm run build`, `npx playwright test <spec>`. A task
  is verified when all three of `npm test`, `npm run typecheck` and `npm run eslint` pass; report their output.
- **Commits.** Commit each task as one logical unit once local CI passes. Do not push (the controller pushes at the
  milestone end). End commit messages with the attribution lines the controller gives.
- **Foundry source.** Behaviour cited below was read in the Foundry v14 tree at `C:\FoundryVTT\V14\dev\foundry\`
  (build 14.364, the version the live world runs); paths below are relative to it.
- **Repeat errors.** The second occurrence of the same failure ends the task: report the count and a diagnosis instead
  of patching the symptom again.

### Foundry facts the tasks rely on (read in the v14 source)

- `client/documents/collections/compendium-collection.mjs:758-767`: `static async createCompendium(metadata, options)`
  returns the new `CompendiumCollection`; for a non-GM it returns a notification instead of throwing (the bridge runs on
  GM clients only). The class is reachable as `foundry.documents.collections.CompendiumCollection` (the bare global is
  a compatibility alias, `client/client.mjs:599`). A server refusal rejects and also shows a red notification on the GM
  screen (`client/helpers/socket-interface.mjs:15-36`).
- The server (`dist/packages/world.mjs`, one minified line) creates `world.<name>`: `name` defaults to
  `label.slugify({strict:true})`, an empty slug falls back to `<type>-<randomID>`, a collision is checked only against
  `world.<name>`, and the pack data is validated.
- `common/packages/base-package.mjs:368-378,583-590`: `name` must match `/^[A-Za-z0-9-_]+$/` and must not match
  `/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i`; `label` is a non-blank string; `type` is one of
  `CONST.COMPENDIUM_DOCUMENT_TYPES` (`common/constants.mjs:413-424`).
- `String.prototype.slugify` is a Foundry primitive (`common/primitives/string.mjs:73`): trims, lowercases, collapses
  whitespace and `-` runs to `-`, and with `strict` removes characters outside `[a-zA-Z0-9-]`.
- `compendium-collection.mjs:806-815`: `async deleteCompendium()` throws (and shows a notification) when the pack's raw
  `config.locked` is true; it sends the bare pack name to the server, which rebuilds `world.<name>`, so only a world
  pack can be deleted; the server removes the pack folder itself (`dist/database/backend/server-compendium.mjs`).
- `compendium-collection.mjs:225-227`: the `locked` getter is `config.locked ?? (packageType !== "world")`, so for a
  world pack it is true only when the GM locked it. `pack.metadata.packageType` is `"world"`, `"system"` or `"module"`;
  `pack.collection` is the id (`world.<name>`); `pack.documentName` is the document type; `pack.title` is the label;
  `pack.index.size` counts documents without loading them.

## Review Focus

Inputs the spec implies but does not spell out, most likely to bite first; each has a test in the owning task.

1. A label that slugs to nothing (`日本語`, `!!!`) with no `name`: Foundry would pick a random name, so the dry run could
   not report the id. Expected: `ARGS_INVALID` asking for a `name`. Test: Task 4.
2. A reserved or colliding name (`con`, `NUL`, an existing `world.<name>`; a system pack of the same bare name is not a
   collision). Expected: `ARGS_INVALID`, and Foundry is never called. Test: Task 4.
3. `delete_pack` on a system pack, a module pack, a bare name without `world.`, an unknown id and a locked world pack.
   Expected: `ARGS_INVALID`, `PACK_NOT_FOUND`, `PACK_NOT_FOUND`, `PACK_NOT_FOUND`, `PACK_LOCKED`; `deleteCompendium` is
   never called and the lock is never changed. Test: Task 5.
4. A client that registers `delete_pack` without the flag, or a plugin or agent definition that names it. Expected: the
   sidecar still lists it with the `_meta` entry; plugin and agent definitions are refused. Tests: Task 2, Task 7.
5. A 128-character label of 4-byte characters. Expected: every ack and preview is at most 256 B, the label cut on a
   character boundary. Test: Task 3 (helper) and Tasks 4 and 5 (through the handlers).

## Measured baseline

Measured with `npx tsx tests/measure/measureContext.mjs` on commit `10ffd14`: 19 listed tools, 10,426 B of definitions
(maximum 16,000 B, 30 tools); the 14 scripts take 7,383 B of the 12,000 B the registry leaves them (16,000 less 800 per
sidecar built-in), so two new definitions of at most 800 B each fit. The largest existing definition is `batch` at 795 B.

## File structure

| File | Task | Responsibility |
|---|---|---|
| `shared/gates.js`, `lang/en.json` | 1 | The `allowPackDeletion` gate and its setting texts |
| `shared/scripts.js` | 2 | `requiresUserInteraction` on `ScriptDefinition`, its validation, `USER_INTERACTION_META_KEY`, `USER_INTERACTION_TOOLS` |
| `server/toolRegistry.ts` | 2 | `RegistryTool.requiresUserInteraction`, the by-name forcing, the change signature |
| `server/mcp.ts` | 2 | `_meta` on the registered MCP tool |
| `src/bridge/scripts/packDefinitions.js` | 3 | `createPackDefinition`, `deletePackDefinition` |
| `src/bridge/scripts/packCommon.js` | 3 | `requireOpenGate`, `fitPackAck` shared by both handlers |
| `src/bridge/scripts/createPack.js` | 4 | `createPackHandler` |
| `src/bridge/scripts/deletePack.js` | 5 | `deletePackHandler` |
| `src/bridge/scripts/index.js`, `skills/wiretap/SKILL.md`, shipped-list tests, budget fixtures | 6 | Registration, the agent guidance, the budget measurement |
| `tests/integration/userInteractionMeta.test.js` | 2 | The carrier through the real sidecar |
| `tests/integration/packTools.test.js` | 7 | The pack tools through the sidecar with a fake GM client |
| `tests/e2e/registryCore.js`, `tests/unit/e2eRegistry.test.js` | 8 | The e2e running list records, sweeps, counts and tears down world packs |
| `tests/e2e/packTools.spec.js` | 9 | Live world: create, preview, refuse, delete |
| `docs/**`, `README.md`, `.claude/**`, `graphify-out/` | 10 | Tracking files, skills, the new `wiretap-packs` skill, graph |

One file layout call: the two handlers get one file each and share `packCommon.js` (the write guard's own
`requireOpen` is private to `writeGuard.js`, a security file, so it is not exported for reuse).

## Lanes

| Task | Writes | Shared resources | Waits on | Review group | Review timing | Risky |
|---|---|---|---|---|---|---|
| T1 Gate | `shared/gates.js`, `lang/en.json`, `tests/unit/gates.test.js` | none | none | G3 Pack scripts | on landing | no |
| T2 Prompt carrier | `shared/scripts.js`, `server/toolRegistry.ts`, `server/mcp.ts`, `tests/unit/scripts.test.js`, `tests/unit/toolRegistry.test.js`, `tests/unit/scriptRegistry.test.js`, `tests/integration/userInteractionMeta.test.js` | none | none | B2 buddy check (alone) | on landing | yes |
| T3 Definitions and helpers | `src/bridge/scripts/packDefinitions.js`, `src/bridge/scripts/packCommon.js`, `tests/unit/packDefinitions.test.js`, `tests/unit/packCommon.test.js` | none | T2 | G3 Pack scripts | on landing | no |
| T4 create_pack | `src/bridge/scripts/createPack.js`, `tests/unit/createPack.test.js` | none | T1, T3 | G3 Pack scripts | on landing | yes |
| T5 delete_pack | `src/bridge/scripts/deletePack.js`, `tests/unit/deletePack.test.js` | none | T1, T3 | G3 Pack scripts | on landing | yes |
| T6 Registration, budgets, user skill | `src/bridge/scripts/index.js`, `skills/wiretap/SKILL.md`, `tests/unit/scriptFixtures.js`, `tests/unit/contextBudgetHarness.js`, `tests/unit/contextBudget.test.js`, `tests/unit/writeScripts.test.js`, `tests/unit/riskGates.test.js`, `tests/integration/readTools.test.js` | none | T4, T5 | G3 Pack scripts | on landing | no |
| T7 Integration tests | `tests/integration/packTools.test.js`, `docs/OPEN_BUGS.md` | none | T6 | G7 Sidecar integration | on landing | no |
| T8 e2e registry learns packs | `tests/e2e/registryCore.js`, `tests/unit/e2eRegistry.test.js` | none | none | G8 e2e | on landing | yes |
| T9 e2e on the live world | `tests/e2e/packTools.spec.js`, `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md` | Foundry `:30000`, ports 31416 / 31418 / 31419, `dist/` | T7, T8 | G8 e2e | on landing | yes |
| T10 Docs, skills, graph | `docs/PROGRESS.md`, `docs/PLAN.md` (M18 only), `docs/TODO.md`, `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md`, `docs/POST_WORK_FINDINGS.md`, `docs/README.md`, `README.md`, `lang/en.json`, `skills/wiretap/SKILL.md`, `.claude/skills/**`, `.claude/CLAUDE.md`, `graphify-out/` | none | T9 | G10 Docs | on landing | no |

Waves: T1, T2 and T8 at once (no shared file); then T3; then T4 and T5 at once; then T6; then T7; then T9; then T10.
`docs/OPEN_BUGS.md` is written by T7, then T9, then T10, never at once. `lang/en.json` is written by T1 and later by T10
(check only unless a text is wrong). `skills/wiretap/SKILL.md` is written by T6 and later by T10 (check only).

| Stop | Where | Kind |
|---|---|---|
| The MCP SDK client's `listTools` result does not carry the `_meta` the sidecar passed to `registerTool` (the prompt carrier design then fails and needs the owner) | T2 step 4 | stops everything |
| A TITAN e2e run is active, or the Wiretap census is not zero after the e2e spec | T9 | stops everything |
| The e2e teardown or sweep would delete a pack that is not a world pack whose label starts with `Wiretap E2E ` | T8, T9 | stops everything |
| A new definition is over 800 B, the definitions total is over 16,000 B, the tool count is over 30, or a result fixture is over its budget | T6 step 5 | stops this lane |
| The user-facing skill cannot hold the pack section within 70 lines without dropping a fact | T6 step 6 | stops this lane |
| On the live world `createCompendium` or `deleteCompendium` behaves unlike the Foundry facts above (the call is missing, the pack is not removed from `game.packs`, or the server refuses a well-formed request) | T9 | stops this lane |
| The e2e spec exposes a defect in the buddy-checked Task 2 files (a change there is a high-risk signal) | T9 | stops this lane |
| An unflagged task shows a high-risk signal (security boundary, process spawn, protocol or public API change) | any task | stops this lane |
| A buddy check ends with a finding the two seats did not settle | T2 | stops this lane |
| The same failure occurs a second time | any task | stops this lane |
| A group's third fix round leaves review findings open | any task | stops this lane |

## Buddy-check directives

- T2 gets a buddy check (`buddy-checking`) with `wiretap-spec-reviewer` and `wiretap-code-reviewer` as the two seats.
  It replaces its group review. T2 is a protocol and public API change at the security boundary: the `_meta` carrier,
  and the sidecar's forcing of it for `delete_pack` whatever a client sends. The seats check that no client path (a
  missing flag, a plugin or agent definition, a changed version, a re-registration) lists `delete_pack` without the
  entry, and that a client cannot inject any other `_meta` key.
- Every other task takes the group review of its review group (G3, G7, G8, G10). T4, T5, T8 and T9 are marked risky
  (a gate, an irreversible deletion, an e2e teardown that deletes packs); the controller states that as the trigger
  when it chooses the reviewer tier for G3 and G8.

## Owner decisions

From the design's "Intent" (the owner's decisions of 2026-10-13/14) and the owner's words of 2026-11-21, one line each.

- Compendium tools are built as milestone M18: `create_pack` and `delete_pack` for any unlocked world pack.
- `delete_pack` always asks the human (the prompt is Claude Code's, so the README states that another MCP client or a
  local process is not prompted and the gate stays Wiretap's own control).
- Deletion has its own gate `allowPackDeletion`; every risky operation sits behind a GM gate that is off by default.
- "Execute the milestone with paralell subagent development. Do the same with compendium tools" (2026-11-21).

## Designer decisions

Calls the design leaves to the builder (or marks "designer's call"), made under the owner's delegation; each goes into
`docs/PROGRESS.md` as-built notes in Task 10. Calls marked **owner** change or fill a decision text and need the owner's
attention in the final report.

- **Gate before checks, on a real run only.** A real run checks its gate first and a closed gate reveals nothing about
  packs; a dry run skips the gate. Alternative rejected: checks first, so an agent could learn `PACK_LOCKED` before
  `GATE_DENIED`.
- **`delete_pack` locked pack: `PACK_LOCKED`, not unlock-then-delete.** The design says so; `docs/PLAN.md` M18 still
  says "after unlocking", so Task 10 edits that decision text in place. **owner**
- **Not-found code is `PACK_NOT_FOUND` (the design's word).** `restore_backup` already uses `PACK_GONE` for a pack that
  no longer exists; the two codes name the same condition on two tools and are kept as the design states them. **owner**
- **Bounds on untrusted input (schema):** `label` 1 to 128 characters, `name` 1 to 64 characters, `id` 1 to 128
  characters, `type` unbounded in the schema but checked against the ten Foundry types in the handler (a 10-value enum
  costs about 150 B of the 800 B definition). The design gives no bounds; a pack name becomes a folder name, so an
  unbounded name could make Foundry's server fail with a GM-screen error, which is the design's anti-goal.
- **Empty slug.** A label that slugs to nothing, with no `name`, is `ARGS_INVALID` ("give a name"); Foundry would pick
  `<type>-<randomID>`, which the dry run could not report.
- **A derived name over 64 characters** is `ARGS_INVALID` too (the same bound as an explicit `name`).
- **The handler reads `label.slugify({ strict: true })`** (Foundry's own slug, the server's default) and holds its own
  copies of Foundry's name pattern and reserved-name pattern, cited to `base-package.mjs`, because no public validator
  is exposed to modules.
- **The ack label** is cut with `truncateUtf8` until the whole row is at most 256 B; `id`, `type` and `documents` are
  never cut.
- **The carrier is a boolean, not a free `_meta` object**, so no client can attach other MCP metadata; the sidecar
  builds the one `_meta` entry itself. The forced name list is `USER_INTERACTION_TOOLS = ['delete_pack']` in
  `shared/scripts.js`.
- **No `isGM` check** in the handlers: the bridge runs scripts only on GM clients, so a non-GM call cannot arrive.
- **e2e records a pack as** `{ documentName: 'Compendium', id: 'world.<name>', uuid: 'Compendium.world.<name>' }`;
  `Compendium` is the last type in the deletion order (documents inside a pack vanish with it).
- **A new skill `wiretap-packs`** holds the pack scripts; the carrier goes into `wiretap-mcp-sessions`, the gate into
  `wiretap-write-guard` and `wiretap-sidecar`.

---

### Task 1: The `allowPackDeletion` gate

The owner decided deletion has its own gate, off by default. This task adds the gate, so Task 5's handler can name it.

**Files:**
- Modify: `shared/gates.js` (`GATES` after `allowReplace`; the `GateState` typedef), `lang/en.json`
- Test: `tests/unit/gates.test.js`

**Interfaces:**
- Produces: `GATES.allowPackDeletion = entry('boolean', false, 'Deleting a world compendium pack and every document in
  it for good (delete_pack).')`; `GateState.allowPackDeletion: boolean`; the setting text
  `WIRETAP.Settings.Gates.AllowPackDeletion` = `{ "Name": "Risk gate: delete compendium packs", "Hint": "Lets agents
  delete an unlocked world compendium pack and every document in it for good, with delete_pack. Previews (dry runs)
  work without this gate." }`. Everything else (the setting registration of `src/settings/gates.js`, `readGateState`,
  `sanitizeGateState`, the e2e gate record) derives from `GATES` and needs no change.

- [ ] **Step 1: Write the failing tests** in `tests/unit/gates.test.js`:

```js
// BOOLEAN_GATES gains 'allowPackDeletion'; the test is renamed 'holds exactly the twelve boolean gates and the plugin module list'
// the closedGateState literal gains allowPackDeletion: false
it('defines allowPackDeletion as a boolean gate that is closed by default', () => {
   expect(GATES.allowPackDeletion).toMatchObject({ type: 'boolean', default: false });
   expect(gateDenial(closedGateState(), 'allowPackDeletion')?.message).toContain('allowPackDeletion');
   expect(isGateOpen({ ...closedGateState(), allowPackDeletion: true }, 'allowPackDeletion')).toBe(true);
});
```

- [ ] **Step 2: Run.** `npx vitest run tests/unit/gates.test.js tests/unit/gateSettings.test.js`. Expected: FAIL (the
  gate is missing; `gateSettings` fails once the gate exists without its text, so Step 3 adds both).
- [ ] **Step 3: Implement** the gate entry, the typedef property and the `lang/en.json` block.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass (`gateSettings.test.js`
  finds the new gate's texts).
- [ ] **Step 5: Commit** `feat(shared): allowPackDeletion gate`.

---

### Task 2: The prompt carrier: `requiresUserInteraction` to MCP `_meta`

The owner decided `delete_pack` always asks the human, at every Claude Code permission level, and that no plugin, setting
or client may list it without the prompt. This task builds the carrier: a script definition's boolean, the sidecar's
mapping to `_meta["anthropic/requiresUserInteraction"]: true`, and the sidecar's forcing of it for the name `delete_pack`.
It is a protocol and public API change at the security boundary.

**Files:**
- Modify: `shared/scripts.js` (typedef, validator, two exports), `server/toolRegistry.ts` (`RegistryTool`, `sanitizeTool`),
  `server/mcp.ts` (the `registerTool` call of `syncRegistryTools`, near `annotations: { readOnlyHint: ... }`)
- Test: `tests/unit/scripts.test.js`, `tests/unit/toolRegistry.test.js`, `tests/unit/scriptRegistry.test.js`
- Create: `tests/integration/userInteractionMeta.test.js`

**Interfaces:**
- Produces, `shared/scripts.js`: `@property {true} [requiresUserInteraction]` on `ScriptDefinition`;
  `export const USER_INTERACTION_META_KEY = 'anthropic/requiresUserInteraction'`;
  `export const USER_INTERACTION_TOOLS = Object.freeze(['delete_pack'])`. `validateScriptDefinition` reads the field
  with `ownValue`, accepts `undefined` or `true`, refuses anything else with the reason
  `requiresUserInteraction may only be true`, and copies `requiresUserInteraction: true` into the normalized definition
  only when it was `true`. The field is not part of `definitionBytes`.
- Produces, `server/toolRegistry.ts`: `RegistryTool.requiresUserInteraction: boolean` (true when the validated
  definition carries the flag or its `name` is in `USER_INTERACTION_TOOLS`); the value is the last element of
  `signature` (so a change re-registers the tool) and is not part of `schemaSignature` (it is not a routing property).
- Produces, `server/mcp.ts`: the `registerTool` config gains `_meta: { [USER_INTERACTION_META_KEY]: true }` exactly when
  `tool.requiresUserInteraction` is true, and no `_meta` key otherwise.
- Consumes: `script(name, overrides)` of `tests/unit/scriptFixtures.js`; `createHarness`, `connectGm`, `register`,
  `connectClient`, `toolNames`, `invokes` of `tests/integration/mcpHarness.js`; the `run([...])` and `entry(...)`
  helpers of `tests/unit/toolRegistry.test.js`.

- [ ] **Step 1: Write the failing tests.**

```js
// tests/unit/scripts.test.js
it('keeps requiresUserInteraction: true in the normalized definition and omits it otherwise', ...);
//   validateScriptDefinition(script('x', { requiresUserInteraction: true }), 'shipped').definition.requiresUserInteraction === true
//   without the field: Object.hasOwn(definition, 'requiresUserInteraction') === false
it.each([false, 'true', 1, null, {}])('refuses requiresUserInteraction %j', ...);
//   outcome.ok === false and outcome.reason === 'requiresUserInteraction may only be true'
it('does not count the flag in the definition size', ...);
//   a definition of 799 bytes with the flag is still accepted; definitionBytes(...) is the same with and without it
it('exports the meta key and the forced tool names', () => {
   expect(USER_INTERACTION_META_KEY).toBe('anthropic/requiresUserInteraction');
   expect(USER_INTERACTION_TOOLS).toEqual(['delete_pack']);
   expect(Object.isFrozen(USER_INTERACTION_TOOLS)).toBe(true);
});
it.each(['plugin', 'agent'])('refuses a %s definition named delete_pack whatever flag it carries', ...);
//   validateScriptDefinition(script('delete_pack', { requiresUserInteraction: true }), source).ok === false

// tests/unit/toolRegistry.test.js
it('marks a tool whose definition declares requiresUserInteraction', ...);   // tools[0].requiresUserInteraction === true
it('marks delete_pack although its definition omits the flag', ...);          // entry({ name: 'delete_pack' }) -> true
it('leaves every other tool unmarked', ...);                                   // plain entry -> false
it('changes signature but not schemaSignature when the flag differs', ...);

// tests/unit/scriptRegistry.test.js
it('keeps requiresUserInteraction in definitions() of a registered script', ...);

// tests/integration/userInteractionMeta.test.js (createHarness; connectGm; gm.register([...]); connectClient)
it('lists a flagged tool with the meta entry and an unflagged tool without a _meta', async () => {
   // gm.register([script('delete_pack', { mutates: true, requiresUserInteraction: true }), script('plain_tool')])
   expect(listed('delete_pack')._meta).toEqual({ 'anthropic/requiresUserInteraction': true });
   expect(listed('plain_tool')._meta).toBeUndefined();
});
it('lists delete_pack with the meta entry when the client registers it without the flag', ...);
//   gm.register([script('delete_pack', { mutates: true })]) -> _meta toEqual the same object
it('lists the meta entry on a tool of another name that the client flags, and no other _meta key', ...);
//   script('mark_x', { requiresUserInteraction: true }) -> Object.keys(_meta) toEqual(['anthropic/requiresUserInteraction'])
it('forwards a call of the flagged tool to the client unchanged', ...);
//   callTool({ name: 'delete_pack', arguments: {...} }) -> gm.invokes[0].params toEqual({ name: 'delete_pack', arguments: {...} })
```

- [ ] **Step 2: Run.** `npx vitest run tests/unit/scripts.test.js tests/unit/toolRegistry.test.js
  tests/unit/scriptRegistry.test.js tests/integration/userInteractionMeta.test.js`. Expected: FAIL (the exports, the
  field and the `_meta` are missing).
- [ ] **Step 3: Implement** the validator field, the two exports, the `RegistryTool` field and its by-name forcing in
  `sanitizeTool`, the signature element, and the `_meta` entry in `server/mcp.ts` (typed as `Record<string, unknown>`
  as the MCP SDK's `registerTool` config declares).
- [ ] **Step 4: Verify the SDK carries it.** The integration test's first case is the proof: the SDK client's
  `listTools()` must return the `_meta` object on the flagged tool. If it does not, stop (stops everything).
- [ ] **Step 5: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 6: Commit** `feat(server): tool-level user-interaction meta carried from the script definition`.

---

### Task 3: Pack definitions and the shared handler helpers

The owner asked for the two tools with `dryRun` and a gate each. This task writes their two definitions and the two
helpers both handlers use. A definition's budget is 800 B and its description at most 160 characters; neither declares a
`gate` field, because a definition-level gate would block the dry run (the handler judges the gate after its `dryRun`
branch).

**Files:**
- Create: `src/bridge/scripts/packDefinitions.js` (relative imports only, so the `tsx` measurement can load it),
  `src/bridge/scripts/packCommon.js`, `tests/unit/packDefinitions.test.js`, `tests/unit/packCommon.test.js`

**Interfaces:**
- Consumes: Task 2's validator accepting `requiresUserInteraction`; `getBudget('ACK_MAX_BYTES')` of
  `shared/budgets.js`; `requireGate` of `~/bridge/gates.js`; `ScriptError` of `~/bridge/scripts/registry.js`;
  `GATE_DENIED` of `$shared/protocol.js`; `truncateUtf8` of `$shared/utf8.js`.
- Produces, `packDefinitions.js`: `export const createPackDefinition` and `export const deletePackDefinition`
  (`ScriptDefinition`s), both `version: '1.0.0'`, `requires: 'api'`, `mutates: true`,
  `result: { budgetBytes: getBudget('ACK_MAX_BYTES').value }`, no `gate`, no `handleArgs`.
  - `create_pack` input schema: root object, `additionalProperties: false`, `required: ['label', 'type']`,
    properties `label` (string, `minLength` 1, `maxLength` 128), `type` (string), `name` (string, `minLength` 1,
    `maxLength` 64), `dryRun` (boolean). The description holds `allowCompendiumWrites`.
  - `delete_pack` input schema: root object, `additionalProperties: false`, `required: ['id']`, properties `id` (string,
    `minLength` 1, `maxLength` 128), `dryRun` (boolean). `requiresUserInteraction: true`. The description says deletion
    is irreversible and holds `allowPackDeletion`.
- Produces, `packCommon.js`:
  - `requireOpenGate(name: string): void` — throws `new ScriptError(GATE_DENIED, denial.message)` when
    `requireGate(name)` returns a denial; returns otherwise.
  - `fitPackAck(row: Record<string, unknown>): Record<string, unknown>` — returns a copy of `row` whose JSON is at most
    `getBudget('ACK_MAX_BYTES').value` bytes: when it is longer, the string field `label` is cut with `truncateUtf8`
    (largest prefix that fits, ending in the ellipsis marker); every other field is copied unchanged.

- [ ] **Step 1: Write the failing tests.**

```js
// tests/unit/packDefinitions.test.js
it('declares the pinned names, versions, flags and budgets', () => {
   expect(createPackDefinition).toMatchObject({ name: 'create_pack', version: '1.0.0', requires: 'api', mutates: true });
   expect(deletePackDefinition).toMatchObject({ name: 'delete_pack', version: '1.0.0', requires: 'api', mutates: true });
   for (const definition of [createPackDefinition, deletePackDefinition]) {
      expect(definition.result.budgetBytes).toBe(256);
      expect(Object.hasOwn(definition, 'gate')).toBe(false);
   }
});
it('carries requiresUserInteraction on delete_pack only', () => {
   expect(deletePackDefinition.requiresUserInteraction).toBe(true);
   expect(Object.hasOwn(createPackDefinition, 'requiresUserInteraction')).toBe(false);
});
it('passes the shared validator with no warning and keeps the flag', ...);
//   validateScriptDefinition(def, 'shipped'): ok true, warnings [], delete_pack definition.requiresUserInteraction true
it('lists each definition within 800 bytes and 160 characters of description', ...);
//   definitionBytes(name, description, compileSchema(inputSchema).listed) <= 800; description.length <= 160
it('names the gate and, for delete_pack, the irreversibility in the description', () => {
   expect(createPackDefinition.description).toContain('allowCompendiumWrites');
   expect(deletePackDefinition.description).toContain('allowPackDeletion');
   expect(deletePackDefinition.description).toMatch(/irreversible/i);
});
it('bounds the untrusted arguments in the schema', ...);
//   compileSchema(create.inputSchema).validate: a 129-character label, an empty label, a 65-character name, an
//   undeclared key and a missing type are each refused; a 128-character label and a 64-character name are accepted
//   compileSchema(delete.inputSchema).validate: an empty id, a 129-character id, a missing id and an undeclared key are
//   refused

// tests/unit/packCommon.test.js (game.settings.get stubbed as in tests/unit/executeMacro.test.js)
it('requireOpenGate throws GATE_DENIED naming the gate while it is closed and returns once it is open', ...);
it('fitPackAck returns a row that already fits equal to the input', ...);
it('fitPackAck cuts a 128-character label of 4-byte characters so the row is at most 256 bytes', () => {
   const row = fitPackAck({ dryRun: true, id: `world.${'a'.repeat(64)}`, label: '😀'.repeat(128), type: 'JournalEntry', documents: 99999 });
   expect(new TextEncoder().encode(JSON.stringify(row)).length).toBeLessThanOrEqual(256);
   expect(row.label.endsWith('…')).toBe(true);           // the ellipsis marker of truncateUtf8
   expect('😀'.repeat(128).startsWith(row.label.slice(0, -1))).toBe(true);   // a prefix cut on a character boundary
});
it('fitPackAck keeps every field but the label', ...);
```

- [ ] **Step 2: Run.** `npx vitest run tests/unit/packDefinitions.test.js tests/unit/packCommon.test.js`. Expected: FAIL
  (modules missing).
- [ ] **Step 3: Implement** both files by the Interfaces block. Descriptions say what each tool does in at most 160
  characters; both state their gate by name.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(bridge): pack tool definitions and shared handler helpers`.

---

### Task 4: `create_pack`

The owner asked for pack creation behind `allowCompendiumWrites`, with a dry run. This task writes the handler. It
refuses what Foundry would refuse before calling Foundry, so Foundry never shows a GM-screen error for it.

**Files:**
- Create: `src/bridge/scripts/createPack.js`, `tests/unit/createPack.test.js`

**Interfaces:**
- Consumes: `requireOpenGate`, `fitPackAck` (Task 3); `ScriptError`; `cleanForLog` of `$shared/logText.js`.
- Produces: `export async function createPackHandler(args: { label: string, type: string, name?: string, dryRun?: boolean },
  ctx: object): Promise<{ id: string, label: string, type: string } | { dryRun: true, id: string, label: string, type:
  string }>`. Throws `ScriptError` with `GATE_DENIED` or `ARGS_INVALID`. The order is pinned because the results depend
  on it:
  1. a real run (`args.dryRun !== true`) calls `requireOpenGate('allowCompendiumWrites')`;
  2. `label.trim()` empty is `ARGS_INVALID` containing `label must not be blank`;
  3. `type` not in `CONST.COMPENDIUM_DOCUMENT_TYPES` is `ARGS_INVALID` containing `type must be one of` and the list;
  4. `name = args.name ?? label.slugify({ strict: true })`; an empty derived name is `ARGS_INVALID` containing `label has
     no letters or digits to name the pack; give a name`; a name (given or derived) longer than 64 characters is
     `ARGS_INVALID` containing `name is over 64 characters`; a name not matching `/^[A-Za-z0-9-_]+$/` is `ARGS_INVALID`
     containing `name may hold only letters, digits, - and _`; a name matching
     `/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i` is `ARGS_INVALID` containing `name is a reserved name`
     (patterns cited to `common/packages/base-package.mjs:583-590`);
  5. `game.packs.has(\`world.${name}\`)` is `ARGS_INVALID` containing `already exists`;
  6. a dry run returns `fitPackAck({ dryRun: true, id: \`world.${name}\`, label, type })` and calls nothing;
  7. otherwise `pack = await foundry.documents.collections.CompendiumCollection.createCompendium({ label, type, name })`
     and the result is `fitPackAck({ id: pack.collection, label: pack.metadata.label, type: pack.documentName })`.
  Every message is at most 256 B; caller text in a message goes through `cleanForLog(text, 64)`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/createPack.test.js` with a mocked `game` (`settings.get` reading a
  `gates` object, `packs` a `Map`), `CONST.COMPENDIUM_DOCUMENT_TYPES` (the ten Foundry names), a
  `foundry.documents.collections.CompendiumCollection.createCompendium` mock that returns a pack object
  `{ collection: 'world.<name>', metadata: { label }, documentName: type }`, and a stand-in `String.prototype.slugify`
  installed in `beforeEach` and removed in `afterEach` (trims, lowercases, collapses whitespace and `-` runs to `-`,
  removes characters outside `[a-zA-Z0-9-]`):

```js
it('creates the pack with the label, type and derived name, and returns { id, label, type }', async () => {
   gates.allowCompendiumWrites = true;
   const result = await createPackHandler({ label: 'MOCK Pack One', type: 'Actor' }, {});
   expect(createCompendium).toHaveBeenCalledTimes(1);
   expect(createCompendium).toHaveBeenCalledWith({ label: 'MOCK Pack One', type: 'Actor', name: 'mock-pack-one' });
   expect(result).toEqual({ id: 'world.mock-pack-one', label: 'MOCK Pack One', type: 'Actor' });
});
it('passes an explicit name through', ...);                    // name 'my_pack-2' -> createCompendium name 'my_pack-2'
it('is denied naming allowCompendiumWrites while the gate is closed, and calls Foundry zero times', ...);
//   code GATE_DENIED, message contains 'allowCompendiumWrites'; game.packs.has not called (gate is first)
it('a dry run with the gate closed returns { dryRun: true, id, label, type } and calls Foundry zero times', ...);
it.each(['', '   '])('refuses the blank label %j', ...);        // ARGS_INVALID 'label must not be blank'
it.each(['actor', 'Wall', '', 'Actor '])('refuses the type %j naming the allowed list', ...);
it.each(['my pack', 'a.b', '../x', 'é', 'a/b'])('refuses the name %j', ...);
it.each(['con', 'PRN', 'aux', 'nul', 'com1', 'LPT9'])('refuses the reserved name %s', ...);
it.each(['日本語', '!!!'])('refuses the label %s with no name, because its slug is empty', ...);
it('refuses a derived or given name over 64 characters and accepts exactly 64', ...);
it('refuses a collision with world.<name>, on a real run and on a dry run', ...);
it('does not treat a system pack of the same bare name as a collision', ...);   // game.packs has 'mysystem.mock-pack-one'
it('every refusal calls createCompendium zero times', ...);
it('keeps the ack within 256 bytes for a 128-character label of 4-byte characters, real and dry', ...);
it('keeps every refusal message within 256 bytes and bounds the echoed caller text', ...);   // a 5,000-character type
```

- [ ] **Step 2: Run.** `npx vitest run tests/unit/createPack.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `createPackHandler` by the pinned order. Imports use the `~/` and `$shared/` aliases.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(bridge): create_pack script`.

---

### Task 5: `delete_pack`

The owner asked for pack deletion for any unlocked world pack, behind its own gate, with a dry run that lists the pack
and its document count. This task writes the handler. Deletion is irreversible; Foundry's server removes the files.

**Files:**
- Create: `src/bridge/scripts/deletePack.js`, `tests/unit/deletePack.test.js`

**Interfaces:**
- Consumes: `requireOpenGate`, `fitPackAck` (Task 3); `ScriptError`; `cleanForLog`.
- Produces: `export async function deletePackHandler(args: { id: string, dryRun?: boolean }, ctx: object): Promise<{
  dryRun: true, id: string, label: string, type: string, documents: number } | { id: string, deleted: true }>`. Throws
  `ScriptError`. The order is pinned:
  1. a real run calls `requireOpenGate('allowPackDeletion')` (before any pack lookup);
  2. `pack = game.packs.get(args.id)`; undefined is `PACK_NOT_FOUND` with the message `No pack with that id.` plus the
     id cleaned and cut to 64 B;
  3. `pack.metadata.packageType !== 'world'` is `ARGS_INVALID` with `Only world packs can be deleted.`;
  4. `pack.locked` (the getter; true only when the GM locked a world pack, `compendium-collection.mjs:225-227`) is
     `PACK_LOCKED` with `The pack is locked; unlock it in Foundry first.`;
  5. a dry run returns `fitPackAck({ dryRun: true, id: pack.collection, label: pack.title, type: pack.documentName,
     documents: pack.index.size })`;
  6. otherwise `await pack.deleteCompendium()` and returns `{ id: args.id, deleted: true }`.
  The handler never calls `pack.configure`, `setFolder` or any pack method but `deleteCompendium`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/deletePack.test.js` with a mocked `game` (`settings.get` reading a
  `gates` object; `packs` a `Map` of mock packs `{ collection, title, documentName, locked, metadata: { packageType },
  index: { size }, deleteCompendium: vi.fn(async () => {}), configure: vi.fn() }`):

```js
it('deletes an unlocked world pack through deleteCompendium and returns { id, deleted: true }', async () => {
   gates.allowPackDeletion = true;
   expect(await deletePackHandler({ id: 'world.mock-pack' }, {})).toEqual({ id: 'world.mock-pack', deleted: true });
   expect(pack.deleteCompendium).toHaveBeenCalledTimes(1);
});
it('is denied naming allowPackDeletion while the gate is closed, before looking up the pack', async () => {
   // GATE_DENIED; game.packs.get not called; deleteCompendium not called
});
it('a dry run with the gate closed returns the pack, its type and its document count, and deletes nothing', async () => {
   expect(await deletePackHandler({ id: 'world.mock-pack', dryRun: true }, {})).toEqual({
      dryRun: true, id: 'world.mock-pack', label: 'MOCK Pack', type: 'Actor', documents: 3,
   });
});
it.each([['missing', 'world.nope'], ['a bare name', 'mock-pack']])('is PACK_NOT_FOUND for %s', ...);
it.each(['system', 'module'])('refuses a %s pack as ARGS_INVALID "Only world packs can be deleted."', ...);
it('refuses a locked world pack as PACK_LOCKED and neither deletes it nor changes its lock', ...);   // configure not called
it('a dry run still refuses a missing, a non-world and a locked pack', ...);
it('checks a system pack before its lock', ...);          // a locked system pack is ARGS_INVALID, not PACK_LOCKED
it('keeps the preview within 256 bytes for a 128-character id and a long label of 4-byte characters', ...);
it('keeps every refusal message within 256 bytes and bounds the echoed id', ...);
it('calls no pack method but deleteCompendium', ...);     // configure and any other spy not called
```

- [ ] **Step 2: Run.** `npx vitest run tests/unit/deletePack.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `deletePackHandler` by the pinned order.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass (including
  `noPermanentDelete.test.js`).
- [ ] **Step 5: Commit** `feat(bridge): delete_pack script`.

---

### Task 6: Registration, budgets and the agent guidance

The owner asked for the tools to be usable by agents. This task registers both scripts, brings every test that
enumerates the shipped scripts up to date in the same commit, measures the context budget, and teaches the agent the
tools in the user-facing skill.

**Files:**
- Modify: `src/bridge/scripts/index.js` (`SHIPPED_SCRIPTS`: `create_pack`, then `delete_pack`, after `execute_macro`),
  `skills/wiretap/SKILL.md`
- Modify tests: `tests/unit/scriptFixtures.js` (`shippedScripts()` appends both definitions in that order),
  `tests/unit/writeScripts.test.js` (the shipped-order list), `tests/unit/contextBudget.test.js` (the listed-tools
  list), `tests/integration/readTools.test.js` (the two `toolNames` and `readOnlyHint: false` lists),
  `tests/unit/contextBudgetHarness.js` (`FIXTURES`), `tests/unit/riskGates.test.js`

**Interfaces:**
- Consumes: Tasks 3, 4, 5.
- Produces: the registered scripts `create_pack` and `delete_pack`; `FIXTURES.create_pack` and `FIXTURES.delete_pack`
  (canned worst-case acks the fake GM returns: a `create_pack` dry-run row with a 64-character name and a label cut to
  fit, budget `ACK_MAX_BYTES`; a `delete_pack` dry-run row with the largest count and a long label, budget
  `ACK_MAX_BYTES`; a `delete_pack` `PACK_LOCKED` error, budget `ERROR_MAX_BYTES`).

- [ ] **Step 1: Update the failing tests first.** Add `create_pack` and `delete_pack` to the lists above (the sorted
  `toolNames` lists, the shipped-order list, the `readOnlyHint: false` list). In `tests/unit/riskGates.test.js`, add a
  mock world pack to `beforeEach` (`globalThis.game.packs = { get: (id) => (id === 'world.mock-pack' ? pack : undefined)
  }` with an unlocked world pack whose `deleteCompendium` is a `vi.fn(async () => {})`) and one entry to `RISKY`:

```js
delete_pack: {
   gate: 'allowPackDeletion',
   run: (dryRun) => deletePackHandler({ id: 'world.mock-pack', dryRun }, {}),
},
```

  The existing generic tests then prove: denied naming the gate while closed; a dry run with the gate closed returns
  without error; runs once the gate is open. The "every risky script is gated" test finds `delete_pack` in `RISKY`.
- [ ] **Step 2: Run.** `npx vitest run tests/unit/riskGates.test.js tests/unit/writeScripts.test.js
  tests/unit/contextBudget.test.js tests/unit/shippedSkill.test.js tests/integration/readTools.test.js`. Expected: FAIL
  (the tools are not registered; the skill does not name them).
- [ ] **Step 3: Implement** the registration and the fixtures.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass except the skill test
  until Step 6.
- [ ] **Step 5: Measure.** `npx tsx tests/measure/measureContext.mjs > debug/dumps/m18-context.txt 2>&1`, then read the
  table. Expected: 21 tools; `create_pack` and `delete_pack` each at most 800 B; the total at most 16,000 B (measured
  baseline 10,426 B); every fixture within its budget; `Hard failures: 0`. Report each new definition's bytes, the total
  and the tool count. Over a limit: stop and report (a budget is raised only by the owner).
- [ ] **Step 6: Write the skill text** in `skills/wiretap/SKILL.md`. The file is exactly 70 lines today and
  `tests/unit/shippedSkill.test.js` caps it at 70, so reflow the wrapped paragraphs to 120 columns and merge the error
  lines to make room, without dropping a fact. The new section carries these facts: `mcp__wiretap__create_pack`
  (`label`, `type` a document type such as `Actor`, optional `name`) makes an empty world pack and needs
  `allowCompendiumWrites`; `mcp__wiretap__delete_pack` (`id` is `world.<name>`) removes an unlocked world pack and every
  document in it for good, needs `allowPackDeletion`, and Claude Code asks the human on every call; `dryRun` on both
  works with every gate closed and `delete_pack`'s lists the document count; a locked pack is `PACK_LOCKED` and the GM
  unlocks it in Foundry; `PACK_NOT_FOUND`; a system or module pack is refused; offer `backup_documents` with `pack`
  before `delete_pack` (the existing Backups sentence "any `replace_document` or delete" gains `delete_pack`). Add
  "creating or deleting a compendium pack" to the frontmatter description. If the section cannot fit in 70 lines
  without dropping a fact, stop (stops this lane).
- [ ] **Step 7: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass, including
  `shippedSkill.test.js` (the skill names `create_pack` and `delete_pack`, at most 70 lines).
- [ ] **Step 8: Commit** `feat(bridge): register the pack tools; budgets, fixtures and skill guidance`.

---

### Task 7: Integration tests over a real socket

The owner asked for prompt-on-every-deletion and the tools' budgets; `docs/PLAN.md` M18 names the test "the annotation is
present and cannot be removed by a plugin or setting". Task 2 proves the carrier with synthetic scripts; this task
proves it with the shipped definitions, through the real sidecar, Socket.IO and the MCP SDK client with a fake GM client.

**Files:**
- Create: `tests/integration/packTools.test.js`
- Modify: `docs/OPEN_BUGS.md` only to log a defect the tests expose

**Interfaces:**
- Consumes: `createHarness` (`start`, `connectGm({ answer })`, `gm.register`, `gm.invokes`, `connectClient`,
  `toolNames`, `cleanup`) of `tests/integration/mcpHarness.js`; `shippedScripts()` of `tests/unit/scriptFixtures.js`
  (Task 6); the pattern of `tests/integration/diceTools.test.js`.

- [ ] **Step 1: Write the tests.**

```js
it('lists create_pack and delete_pack as mutating tools, and only delete_pack with the user-interaction meta', async () => {
   // annotations readOnlyHint false on both; delete_pack._meta toEqual({ 'anthropic/requiresUserInteraction': true });
   // create_pack._meta undefined
});
it('lists delete_pack with the meta entry when its client registers it without the flag', ...);
//   re-register shippedScripts() with delete_pack's flag deleted and its version set to '1.0.1' (a changed signature
//   makes the session re-list it); after the list_changed, delete_pack._meta still toEqual the same object
it('forwards create_pack arguments to the GM client as a callTool op and returns its ack within 256 bytes', ...);
//   gm.invokes[0].op === OP_CALL_TOOL; params toEqual({ name: 'create_pack', arguments: { label, type, name, dryRun: true } })
it('forwards delete_pack the same way and passes dryRun through', ...);   // answer { id, deleted: true }; byte length <= 256
it('refuses an undeclared argument, a missing id and an over-long field before anything is sent', ...);
//   delete_pack { id, force: true }, delete_pack {}, create_pack { label: '', type: 'Actor' }, a 65-character name,
//   a 129-character label: each isError true; gm.invokes stays empty
it('a GM client error code reaches the agent as <code>: <message>', ...);   // answer PACK_LOCKED -> text starts 'PACK_LOCKED:'
```

- [ ] **Step 2: Run.** `npx vitest run tests/integration/packTools.test.js`. Expected: all pass. A failure that is a
  product defect: log it in `docs/OPEN_BUGS.md` and stop the lane.
- [ ] **Step 3: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 4: Commit** `test(integration): pack tools over the sidecar, the prompt meta on delete_pack`.

---

### Task 8: The e2e running list records, sweeps and tears down world packs

The design says the e2e registry records a pack by its collection id, sweeps and counts world packs whose label starts
with the e2e prefix, and tears one down (unlocking it first when locked). Today the registry only knows 16-character
document ids and resolves with `fromUuid`, so a pack is invisible to it. This is test infrastructure that deletes packs,
so its identity test is strict.

**Files:**
- Modify: `tests/e2e/registryCore.js`, `tests/unit/e2eRegistry.test.js`

**Interfaces:**
- Produces, `registryCore.js`: `'Compendium'` appended to `ALLOWED_DOCUMENT_NAMES` (last, after `Folder`). An entry of
  documentName `Compendium` has `id` matching `/^world\.[A-Za-z0-9_-]{1,64}$/` and `uuid` `Compendium.<id>`; every
  other type keeps the 16-character id rule, and the pack id pattern is refused for every other type.
  - Inspect and delete (browser functions, which take everything as arguments): resolve a `Compendium` entry with
    `game.packs.get(entry.id)`. Safe only when `pack.metadata.packageType === 'world'` and `pack.title` starts with the
    prefix; otherwise it is a violation naming the id. The delete is `if (pack.locked) { await pack.configure({ locked:
    false }); } await pack.deleteCompendium();` after the identity test is repeated for that pack.
  - Sweep: every `game.packs` pack whose title starts with the prefix is deleted when it is a world pack, and is a
    violation otherwise; a sweep with any violation deletes nothing (as today).
  - Census: one line `Compendium <title>` per world pack whose title starts with the prefix.
- Consumes: the existing helpers of `tests/unit/e2eRegistry.test.js` (`page`, `entryOf`, `writeRaw`, `pendingOf`); the
  mock `game` there gains `packs`, an iterable `Map`-like of mock packs `{ collection, title, metadata: { packageType },
  locked, configure: vi.fn(), deleteCompendium: vi.fn() }`.

- [ ] **Step 1: Write the failing tests** (the existing loop test at the top of the file builds 16-character ids for
  `ALLOWED_DOCUMENT_NAMES`; it keeps every non-pack type and gets a pack-aware entry for `Compendium`):

```js
it('accepts a well-formed pack entry and refuses a pack id on another type', () => {
   expect(entryProblem({ documentName: 'Compendium', id: 'world.wiretap-e2e-1', uuid: 'Compendium.world.wiretap-e2e-1', createdBy: 'unit' })).toBeNull();
   // refused: id 'system.pack', 'world.', 'world.a b', 'world.' + 'a'.repeat(65), a 16-character document id, a uuid
   // that is not 'Compendium.<id>'; and documentName 'Actor' with id 'world.x'
});
it('tears a recorded pack down through deleteCompendium, unlocking it first only when it is locked', ...);
//   locked pack: configure called once with { locked: false } before deleteCompendium; unlocked pack: configure not called
it('refuses to delete a recorded pack that is a system pack or whose title lacks the e2e prefix, and deletes nothing', ...);
it('skips a recorded pack that no longer exists', ...);
it('deletes recorded packs after the documents', ...);
it('sweeps unrecorded world packs titled with the prefix and spares system packs, module packs and unprefixed world packs', ...);
it('a sweep with a violation deletes no pack', ...);    // a prefixed non-world pack is a violation
it('counts a prefixed world pack as a leftover line "Compendium <title>"', ...);
it('settleRegistry tears down, sweeps and counts packs together with documents', ...);
```

- [ ] **Step 2: Run.** `npx vitest run tests/unit/e2eRegistry.test.js`. Expected: FAIL (the type is not allowed).
- [ ] **Step 3: Implement.** The browser functions run inside `page.evaluate`, so each takes its inputs as arguments and
  closes over nothing, as the existing ones do.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 5: Commit** `test(e2e): the running list records, sweeps and tears down world packs`.

---

### Task 9: e2e on the live world

The owner asked for the tools; `docs/PLAN.md` M18 names the e2e flow ("a throwaway world pack created and deleted through
the tools, recorded on the §4.8 list"). This task proves it on the live world.

**Files:**
- Create: `tests/e2e/packTools.spec.js`
- Modify: `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md` as defects are found

**Interfaces:**
- Consumes: the shipped tools (Task 6); `login(page, user)` of `tests/e2e/fixtures.js`; `startGateSidecar`,
  `stopSidecar` of `tests/e2e/sidecar.js`; `E2E_MCP_PORT` of `tests/e2e/ports.js`; `recordGateSettings`,
  `restoreGateSettings`, `readSidecarGateState` of `tests/e2e/gates.js`; `E2E_PREFIX`, `recordDocument`,
  `settleRegistry`, `assertSettled`, `teardownRecorded` of `tests/e2e/registry.js` (pack-aware after Task 8). Follow the
  setup of `tests/e2e/macroTools.spec.js` (sidecar per spec file, MCP SDK client per test, `callText` and `callJson`
  helpers, an `openGate` helper that sets a gate in the page and polls the page and the sidecar snapshot with
  `timeout: 1000`, `recordGateSettings` in `beforeEach` and `restoreGateSettings` in `afterEach`, the settle with
  `assertSettled` in `afterAll`).
- Every pack is created through `create_pack` with the label `${E2E_PREFIX}Pack <ts>` and type `JournalEntry` (no system
  data needed), and recorded at once with `recordDocument(page, { documentName: 'Compendium', id, uuid:
  \`Compendium.${id}\`, createdBy })`. A page-side spy on `ui.notifications.error` counts GM-screen errors; it is
  installed in the test and removed in `finally`.

- [ ] **Step 1: Write the spec** with these tests:

```js
test('lists create_pack and delete_pack, and only delete_pack carries the user-interaction meta', ...);
//   tools/list: delete_pack._meta toEqual({ 'anthropic/requiresUserInteraction': true }); create_pack._meta undefined
test('a create_pack dry run with the gate closed returns the id and creates no pack', ...);
//   result { dryRun: true, id: 'world.wiretap-e2e-pack-<ts>', label, type: 'JournalEntry' }; game.packs.has(id) false
test('create_pack is denied while allowCompendiumWrites is closed and creates nothing', ...);   // GATE_DENIED naming it
test('create_pack creates the world pack, and refusals before Foundry raise no GM-screen error', ...);
//   openGate allowCompendiumWrites; create -> { id, label, type } <= 256 B and game.packs.get(id).metadata.packageType
//   'world'; dryRun refusals (same name again, name 'con', type 'Wall', name 'a b') each ARGS_INVALID; the
//   ui.notifications.error spy has zero calls
test('a delete_pack dry run lists the pack and its document count and deletes nothing', ...);
//   a created JournalEntry inside the pack (page: JournalEntry.implementation.create(..., { pack })); dry run
//   -> { dryRun: true, id, label, type: 'JournalEntry', documents: 1 } with allowPackDeletion closed; the pack remains
test('delete_pack is denied while allowPackDeletion is closed, refuses what it must, then deletes', ...);
//   closed: GATE_DENIED naming allowPackDeletion, pack remains; open: a dryRun on a system pack id (any pack of
//   game.packs with packageType 'system') -> ARGS_INVALID; a dryRun on 'world.no-such-pack' -> PACK_NOT_FOUND;
//   lock the pack in the page (pack.configure({ locked: true })) -> a real call is PACK_LOCKED and the pack remains
//   and the spy has zero calls; unlock it; the real call -> { id, deleted: true } <= 256 B; game.packs.has(id) false
```

  Every test that creates a pack leaves teardown to the recorded list; none deletes through anything but the tool or the
  registry. A system pack is only ever named in a `dryRun`.
- [ ] **Step 2: Run.** Confirm no TITAN e2e run is active, then `npx playwright test tests/e2e/packTools.spec.js`.
  Expected: 6 passed, the global teardown reports a zero Wiretap census, every gate restored. Then `npm run build`.
- [ ] **Step 3: Report a defect** the spec exposes: log it in `docs/OPEN_BUGS.md` and stop the lane. A fix in a Task 2
  file is a high-risk change, so the controller takes it to the owner; the spec itself is fixed only where the spec, not
  the code, is wrong. A defect in Task 4's, Task 5's or Task 8's files is fixed with a unit test in that task's test
  file and moved to `docs/CLOSED_BUGS.md`.
- [ ] **Step 4: Measure.** After a pack was created and deleted, read in the page whether
  `game.settings.get('core', 'compendiumConfiguration')` still holds a key for the deleted pack (it may after a lock and
  unlock). Report the finding (Task 10 records it in `docs/POST_WORK_FINDINGS.md`).
- [ ] **Step 5: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`, the Step 2 command. Expected: all pass.
- [ ] **Step 6: Commit** `test(e2e): create and delete a world pack through the tools on the live world`.

---

### Task 10: Tracking files, skills and the knowledge graph

`.claude/CLAUDE.md` makes the documentation step part of every plan ("a plan is not complete until this is done"). This
task brings every tracking file and skill to the state the code is in now.

**Files:**
- Modify: `docs/PROGRESS.md`: the M18 row in "Milestone completion" (status Done, date, commit hashes) and an "As-built
  notes: M18" section with the measured definition sizes, total and tool count (Task 6), the e2e results and the
  `compendiumConfiguration` finding (Task 9), and every line of "Designer decisions" above. The "Next milestone" line
  names the next milestone of `docs/PLAN.md` §5 order.
- Modify: `docs/PLAN.md` M18 only (it stays forward-looking): "deletion through `CompendiumCollection#deleteCompendium`
  after unlocking" becomes "deletion through `deleteCompendium` of an unlocked pack; a locked pack is refused with
  `PACK_LOCKED` and the GM unlocks it (Wiretap never changes a lock)"; "which needs a tool-level `_meta` field in the
  script definition and its registry mapping" becomes "carried by the script definition's `requiresUserInteraction`
  flag, which the sidecar maps to `_meta` and forces for the name `delete_pack`".
- Modify: `docs/TODO.md` (delete any item M18 completed; add none unless a deferral was made), `docs/OPEN_BUGS.md`,
  `docs/CLOSED_BUGS.md`, `docs/POST_WORK_FINDINGS.md` (the `compendiumConfiguration` finding; any mid-run anomaly),
  `docs/README.md` (add the M18 spec and plan if it lists specs and plans).
- Modify: `README.md`: the two tools and their arguments; the gates table row for `allowPackDeletion` and the gate list
  sentence; that a deletion is irreversible, the Foundry server removes the files, a locked pack is refused and the GM
  unlocks it; that the prompt is enforced by Claude Code (the sidecar lists `delete_pack` with
  `_meta["anthropic/requiresUserInteraction"]: true` whatever a client registers), so another MCP client or a local
  process is not prompted and the gate stays Wiretap's own control (the residual risk); and the tool names in the
  user-facing skill list.
- Check: `lang/en.json` holds the Task 1 texts; `skills/wiretap/SKILL.md` matches the shipped tools (Task 6).
- Modify skills to the current code (read from the code, not a changelog): `.claude/skills/wiretap-codebase-core/SKILL.md`
  (the subsystem map gains the pack tools; the list of sidecar built-ins is unchanged), `wiretap-scripts` (the file
  table, `SHIPPED_SCRIPTS` list, the definition field `requiresUserInteraction`, the e2e registry's `Compendium` type),
  `wiretap-mcp-sessions` (`RegistryTool.requiresUserInteraction`, the forcing by name, `_meta` on the registered tool,
  the signature), `wiretap-mcp-bridge` (the listed tools and the `_meta` entry), `wiretap-write-guard` and
  `wiretap-sidecar` (the gate list gains `allowPackDeletion`), `wiretap-client` (the gate hint line),
  `wiretap-build-test` (the new test files and the pack-aware e2e registry). `wiretap-sidecar`, `wiretap-build-test`
  and `wiretap-writes` are near 20,000 characters: put new detail in their `references/` files and keep a pointer.
- Create: `.claude/skills/wiretap-packs/SKILL.md` with `paths:` `src/bridge/scripts/packDefinitions.js`,
  `src/bridge/scripts/packCommon.js`, `src/bridge/scripts/createPack.js`, `src/bridge/scripts/deletePack.js`,
  `tests/unit/packDefinitions.test.js`, `tests/unit/packCommon.test.js`, `tests/unit/createPack.test.js`,
  `tests/unit/deletePack.test.js`, `tests/integration/packTools.test.js`, `tests/e2e/packTools.spec.js` (what each
  handler checks, in order; the gate-after-dry-run rule; the codes; the ack bounds; the Foundry calls; the tests). Add
  its row to the skill table of `.claude/CLAUDE.md` and to the core skill's subsystem map.

- [ ] **Step 1: Write** the updates above. Skills describe the current code only, read from the code.
- [ ] **Step 2: Measure** every `SKILL.md` touched or created with `wc -c`: each stays below 20,000 characters. Over:
  move detail into the skill's `references/` and leave a pointer.
- [ ] **Step 3: Run** `graphify update .`. Expected: completes without error.
- [ ] **Step 4: Verify.** `npm test` (the skill-mention checks of `contextBudget.test.js` and `shippedSkill.test.js` read
  `skills/**`). Expected: pass.
- [ ] **Step 5: Commit** `docs: close M18; progress, README and skills`.
