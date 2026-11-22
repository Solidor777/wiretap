# Wiretap M15a "Copy by uuid and content versions" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` with
> `dispatching-sdd-agents` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Every task brief is
> the task's text plus the whole "Global Constraints" section, copied verbatim: the implementer does not read this file.

**Goal:** ship the three pieces of M15a: `fromUuids` on `create_documents` (copy documents by uuid without the source
body entering the agent's context), a content `version` and an `ifChanged` argument on `get_document` that replace the
modified-time check (`modified`, `ifModifiedSince`) and fix the stale embedded read, and the user-facing recipes that
replace `copy_document` and `build_actor`. No tool name is added; the listed tool count stays 21.

**Architecture:** the version is a cyrb53 hash of a key-sorted serialization of the canonical export that
`ctx.core.readDocument` returns, computed by the `get_document` handler and handed to `ctx.shape.compact`. A copy is
built by a helper that the `create_documents` handler calls before `prepareCreate`: it resolves each uuid, refuses what a
read would refuse, exports the raw source with `toCompendium`, clears the world-specific fields and strips
`flags.wiretap`; the copies then go through `prepareCreate` / `runCreate` unchanged, so every gate, `guardWrite`,
validation, `dryRun`, `actAs`, `keepId`, `pack`, `parentUuid`, `idempotencyKey` and `paths` read-back behaves as for
`data`.

**Tech Stack:** JavaScript ES modules (Foundry v14 client scripts under `src/bridge/scripts/`), vitest + happy-dom,
Playwright (headless) on the live titan world, MCP SDK 1.29.0 client.

**Spec:** `docs/plans/2026-11-21-wiretap-m15a-design.md` (approved by the owner 2026-11-21), with `docs/PLAN.md` M15a,
§2.6 (context budgets), §2.9 (script catalogue), §4.4 (canonical representation) and §4.8 (e2e teardown).

## Model/Effort directives

Execution method: one at a time (superpowers:subagent-driven-development with dispatching-sdd-agents)

- Implementer per task (project rule, `.claude/CLAUDE.md`): `foundry-module-dev` for Tasks 1, 3 and 4 (client `.js`
  under `src/`, with their unit tests); `wiretap-coder` for Tasks 2, 5, 6 and 7 (e2e, integration tests, test helpers,
  docs). The `dispatching-sdd-agents` tiers choose only the model and effort these agents run at.
- Per-task review: `wiretap-spec-reviewer`, then `wiretap-code-reviewer`; at most three fix rounds per task; a third
  round that still leaves findings open goes to the drift check of `dispatching-sdd-agents` ("Stuck Dispatch Loops").
- Escalation of a BLOCKED implementer: the ladder of `dispatching-sdd-agents` (Sonnet high, then Opus high).
- Final review: one whole-branch review by `sdd-final-reviewer`; its dispatch carries the project rules that apply.
- Task order is the numbering; Tasks 1 and 2 are the version, Tasks 3 to 6 are the copy, Task 7 is documentation.

## Buddy-check directives

- Plan buddy check: declined 2026-11-21 (owner chose task checks only)
- Flagged tasks: 3, 4 — buddy check (reviewers `wiretap-spec-reviewer` and `wiretap-code-reviewer`) replaces the task
  review; pre-authorized by the owner 2026-11-21
- Unflagged tasks showing risk signals: ask

## Global Constraints

Every task's requirements include each line below.

- **Scope.** The owner asked for M15a and approved `docs/plans/2026-11-21-wiretap-m15a-design.md`. Build exactly that.
  Non-goals: no new tool name; no `diff_since` (either mode); no "to handle" option on `get_document`; no `overrides` on
  copies; no `build_actor`, `copy_document`, `export_to_handle`, `import_from_handle` or `add_embedded` tool; `batch` does
  not get `fromUuids` (its definition lists at 795 B of 800 B). Nothing outside the task's own files is changed; a defect
  found elsewhere is reported, not fixed.
- **Builders carry this line word for word:** "No unrequested features, shims or defensive code. A guard against input
  the product cannot send is not requested." Socket and MCP input is untrusted (any MCP client can send any arguments),
  so its bounds are requested.
- **Anti-goals.** A copy that bypasses any check a `create_documents` call with the same data would meet (gates,
  `guardWrite`, validation, `actAs`, `dryRun`, `refuseTakenIds`). A version that says "unchanged" when a readable value
  changed: a spurious "changed" costs one re-read and is acceptable, a false "unchanged" is the bug being fixed.
- **No backwards compatibility.** `ifModifiedSince` and the compact view's `modified` are removed outright: no alias,
  shim, deprecation path or migration. No dynamic imports in shipping builds. No test code in shipping builds.
- **Agents.** Implementers: `foundry-module-dev` for client `.js`/`.svelte`; `wiretap-coder` for `server/`, `shared/`,
  tests, build config, docs. Reviewers: `wiretap-spec-reviewer` then `wiretap-code-reviewer`.
- **Skills first.** Before reading or editing a subsystem's files, read its skill file under `.claude/skills/`:
  `wiretap-codebase-core` always; `wiretap-scripts` for `src/bridge/scripts/**` and `skills/**`; `wiretap-writes` for
  the write scripts; `wiretap-write-guard` for `guardWrite`; `wiretap-mcp-bridge` for MCP tools and the sidecar;
  `wiretap-build-test` for `tests/**`. For Foundry API behaviour invoke the `foundry-vtt:foundry-vtt` skill.
- **TDD, no stubs.** Write the failing test, see it fail, write the code, see it pass. No placeholder bodies.
- **Formatting.** 3-space indentation as the existing files use; 120-character lines; multi-line `{}` on every
  conditional; objects with more than one property and arrays with more than one entry are multi-line; every variable
  typed with a one-line comment (JSDoc `@type` in `.js`); every function a JSDoc block with typed params
  (`{Type} [optional] - text`) and a typed return (async included); objects typed with `@typedef`. No `:global` CSS.
- **Comments.** Present tense, what or why only. No task, step or plan references, no history ("previously", "replaced"),
  no review notes. Cite the Foundry source file for any Foundry behaviour a comment relies on. Persistent diagnostics go
  through the project logger, never `console.log`. A `TODO:` describes the work only and is logged in `docs/TODO.md`.
- **Context budgets (PLAN §2.6), enforced by `tests/unit/contextBudget.test.js`:** a definition at most 800 B listed
  (`create_documents` lists 640 B today, MEASURED by `npx tsx tests/measure/measureContext.mjs`); description at most 240
  characters (hard) and 160 (target; this plan requires 160); an ack at most 256 B per document; compact view at most
  2,000 B (`COMPACT_VIEW_MAX_BYTES`); all definitions at most 16,000 B; at most 30 listed tools. A budget is raised only
  by the owner. Bytes are raw UTF-8 bytes; 1 KB = 1000 B.
- **Errors.** A client script fails by throwing `new ScriptError(code, message)` of `src/bridge/scripts/registry.js`
  (code `/^[A-Z][A-Z0-9_]{0,63}$/`, message at most 256 B). No message echoes unbounded caller text: bound it with
  `cleanForLog` of `$shared/logText.js`.
- **e2e.** Headless Playwright only (`npx playwright test <spec>`, never the Playwright MCP `browser_*` tools). It starts
  its own Foundry on port 30000 and uses ports 31416, 31418 and 31419: confirm all four are free and that no other
  project's e2e run is active first. It overwrites `dist/`: run `npm run build` after. Every wait inside a loaded page is
  at most 1000 ms (`expect.poll`, `waitForFunction`, `toPass`, `timeout:`); world boot, login, reload, the build, the
  `actionTimeout` safety net and per-test limits are exempt. Every e2e document name carries the `Wiretap E2E ` prefix
  and is recorded with `recordDocument` of `tests/e2e/registry.js` right after creation. Never create a document with
  malformed data in `name` or any sorted field on the shared world (a wrapper in `name` once stopped the world booting);
  refusal cases use well-formed values and `dryRun` where the refusal is in the handler.
- **No permanent deletes** anywhere (`tests/unit/noPermanentDelete.test.js` enforces it); use `trash` when a file must
  go. Debug output goes under `debug/dumps/`, never the repo root.
- **Commands.** `npm test`, `npm run typecheck`, `npm run eslint`, `npm run build`, `npx playwright test <spec>`. A task
  is verified when all three of `npm test`, `npm run typecheck` and `npm run eslint` pass; report their output.
- **Commits.** Commit each task as one logical unit once local CI passes; stage only the task's own files. Do not push
  (the controller pushes at the milestone end). Every commit message ends with these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01GuTjnShR7efXDHVud7PXnn`.
- **Skills stay current.** A task that changes the paths of a `wiretap-*` skill updates that skill to the current state
  (no changelog) in the same work unit; each `SKILL.md` stays under 20,000 characters (measure with `wc -c`; over it,
  move detail to the skill's `references/` and leave a pointer).
- **Foundry source.** Behaviour cited below was read in the Foundry v14 tree at `C:\FoundryVTT\V14\dev\foundry\`
  (paths below are relative to it).
- **Repeat errors.** The second occurrence of the same failure ends the task: report the count and a diagnosis instead
  of patching the symptom again.

### Foundry facts the tasks rely on (read in the v14 source)

- `client/documents/abstract/client-document.mjs:1113-1134`: `toCompendium(pack, {clearSort=true, clearFolder=false,
  clearFlags=false, clearSource=true, clearOwnership=true, clearState=true, keepId=false})` starts from `toObject()`,
  deletes `_id` unless `keepId`, `sort` when `clearSort`, `folder` when `clearFolder`, `flags` when `clearFlags`,
  `active` when `clearState`, clears `_stats.compendiumSource`, `duplicateSource` and `exportSource` when `clearSource`
  and, when `clearOwnership`, clears `author` and replaces every `ownership` with `{ default }` (the key stays).
- `client/documents/abstract/world-collection.mjs:109-137`: `fromCompendium(document, {clearFolder=false,
  clearState=true, clearSort=true, clearOwnership=true, keepId=false})` KEEPS `folder` by default, sets
  `_stats.compendiumSource` to the source uuid only when given a Document that has a `pack` (:115), and always ends with
  an `ownership` key (`{ default: NONE, [game.user.id]: OWNER }`). It exists only on the world collections.
- `client/documents/collections/compendium-collection.mjs:470-474`: a world document imported into a pack goes through
  `document.toCompendium(this, options)`, not `fromCompendium`.
- `common/abstract/document.mjs` and `client-document.mjs` `_preCreate` decide what ownership a created document gets
  when the data holds none: Task 3 step 1 reads them.

## Review Focus

Inputs the design implies but does not spell out, most likely to bite first; each has a test in the owning task.

1. An embedded delete (no timestamp left behind) must change the parent's `version`; a reordered but equal export must
   not; an edit of a secret-named value must not (the agent cannot see it). Tests: Task 1 (unit), Task 2 (live world).
2. A copy of a source that carries `ownership`, `folder` or `sort` must succeed with every gate closed and carry none of
   them: Foundry's own `fromCompendium` re-adds an `ownership` key, which `guardWrite` would refuse without
   `allowOwnershipWrites`. Test: Task 3, Task 4.
3. A source that carries a `flags.wiretap` idempotency record must not pass it on, also when the copy call itself has an
   `idempotencyKey`. Tests: Task 3 (unit), Task 6 (live world).
4. A uuid that is a `User`, a credential or `wiretap.*` Setting, missing, or of another class must write nothing and name
   the refusal (`ARGS_INVALID`, `DOC_EXCLUDED`, `DOC_NOT_FOUND`). Test: Task 3.
5. A retry with the same `idempotencyKey` and `fromUuids` after the source was edited replays the first result instead of
   `IDEMPOTENCY_CONFLICT`; `data` and `fromUuids` together, or neither, is `ARGS_INVALID`. Test: Task 4.

## File structure

| File | Task | Responsibility |
|---|---|---|
| `src/bridge/scripts/contentHash.js` (new) | 1 | `hashText`, `stableStringify`, `contentVersion`: the one cyrb53 implementation |
| `src/bridge/scripts/writeIdempotency.js` | 1 | `requestHash` delegates to `hashText` |
| `src/bridge/scripts/shape.js`, `getDocument.js`, `definitions.js` | 1 | `version` in the compact, `paths` and `fields` results; `ifChanged`; `ifModifiedSince` and `modified` removed |
| `src/bridge/scripts/writeCopy.js` (new) | 3 | `copyDataFromUuids`: sources to create data |
| `src/bridge/scripts/createDocuments.js`, `writes.js`, `definitions.js` | 4 | `fromUuids` argument, exactly-one-of check, hash input for the idempotency record |
| `tests/unit/contentHash.test.js` (new), `scriptShape.test.js`, `getDocument.test.js`, `contextBudgetHarness.js`, `tests/integration/readTools.test.js` | 1 | Version tests and the moved `ifModifiedSince` / `modified` tests |
| `tests/unit/mockWriteWorld.js`, `tests/unit/writeCopy.test.js` (new) | 3 | `toCompendium` options in the mock; builder tests |
| `tests/unit/writeCopyCreate.test.js` (new) | 4 | `create_documents` with `fromUuids`: gates, dry run, idempotency, definition bounds |
| `tests/integration/mcpHarness.js`, `tests/integration/copyTools.test.js` (new) | 5 | Real handlers behind the sidecar; the 100 KB source; the two-call recipe |
| `tests/e2e/readTools.spec.js` | 2 | `ifChanged` on the live world, embedded update, create and delete |
| `tests/e2e/copyTools.spec.js` (new) | 6 | `fromUuids` on the live world |
| `skills/wiretap/SKILL.md`, `README.md` | 1, 5 | User-facing text |
| `docs/**`, `.claude/**`, `graphify-out/` | 4, 7 | Tracking files, skills, graph |

Layout calls: the hash and the stable serialization live in one new file next to their two callers (both client-only);
the copy builder is its own file because `writes.js` is already the largest write file.

---

### Task 1: Content version on `get_document`, `ifChanged`, and `modified` / `ifModifiedSince` removed

The owner asked for an exact change-only read: it reports a change whenever anything the agent can read changed,
embedded documents included. Measured: Foundry 14.364 leaves a parent's `_stats.modifiedTime` unchanged when an embedded
document is updated, so the timestamp check says "unchanged" falsely. This task replaces the timestamp with a content
version. The e2e test for it is Task 2; do not edit `tests/e2e/readTools.spec.js` here (it has an uncommitted
change that Task 2 owns, and it must not enter this commit).

**Files:**
- Create: `src/bridge/scripts/contentHash.js`, `tests/unit/contentHash.test.js`
- Modify: `src/bridge/scripts/writeIdempotency.js` (`requestHash`), `src/bridge/scripts/shape.js` (`compact`,
  `CompactOptions`, `headerDrop`; the `modified` read near line 342-348 and the header drop list near line 416),
  `src/bridge/scripts/getDocument.js`, `src/bridge/scripts/definitions.js` (`getDocumentDefinition`),
  `skills/wiretap/SKILL.md` (the get_document bullet, lines 8-13), `README.md` (lines near 138 and 143),
  `.claude/skills/wiretap-scripts/SKILL.md` and `.claude/skills/wiretap-scripts/references/core-read-scripts.md`
  (every `modified` / `ifModifiedSince` mention; add `contentHash.js` to the Files table)
- Modify tests: `tests/unit/scriptShape.test.js` (the `shape.compact: modified time` block near 549-583),
  `tests/unit/getDocument.test.js` (compact-view test near 220-243, the `ifModifiedSince` block near 347-419),
  `tests/unit/contextBudgetHarness.js` (`mockCompactView` near 236; the unchanged-ack fixture near 670),
  `tests/integration/readTools.test.js` (near 137 and 147). `tests/unit/mockDocuments.js` needs no change: its
  `_stats.modifiedTime` stays, since the export still holds `_stats`.

**Interfaces:**
- Produces, `contentHash.js`:
  - `export function hashText(text: string): string` — cyrb53 (moved verbatim from `requestHash`: the same 14 lowercase
    hex digits, the same algorithm comment and its public-domain attribution).
  - `export function stableStringify(value: unknown): string` — `JSON.stringify` of the value with the keys of every
    plain object sorted (code-unit order); arrays keep their order. Approach: a `JSON.stringify` replacer that returns
    `Object.fromEntries` of the sorted entries for a plain object (own-property creation, so a `__proto__` key survives).
  - `export function contentVersion(value: unknown): string` — `hashText(stableStringify(value))`.
- Produces, `shape.js`: `ctx.shape.compact(doc, { keyPattern?, keyPaths?, embedded?, version?: string })`. The header
  holds `version` (cut with `truncateUtf8` to 32 bytes) when `version` is a non-empty string, between `type` and
  `fields`, and never holds `modified`. The first header field dropped when the view is over budget is `version`.
- Produces, `getDocument.js`: the `get_document` result. Compact view: `version` as above. `paths`: `{ values, missing,
  version }`. `fields`: `{ fields, missing, version }`. `mode: 'full'`: the export unchanged, with no `version` key.
  `ifChanged` (string) equal to the current version: `ctx.shape.ack({ unchanged: true })`, whatever the mode.
- Produces, `definitions.js`: `getDocumentDefinition.inputSchema.properties.ifChanged = { type: 'string', maxLength: 32 }`
  in place of `ifModifiedSince`; the listed definition stays at most 800 B.
- Consumes: `ctx.core.readDocument(reference, { derived })` returning `{ data, documentName }`; `ctx.shape.ack`.

Decisions this task makes: the version is 14 hex digits (the `hashText` form); `ifChanged` is bounded to 32 characters;
the version is computed only when the call returns it or compares it (not for `mode: 'full'` without `ifChanged`);
the hash helper lives in `src/bridge/scripts/contentHash.js`.

- [ ] **Step 1: Write the failing tests.**

```js
// tests/unit/contentHash.test.js
it('hashText returns 14 lowercase hex digits and is deterministic', ...);
//   expect(hashText('MOCK_a')).toMatch(/^[0-9a-f]{14}$/); equal for equal text; different for 'MOCK_a' vs 'MOCK_b'
it('requestHash is hashText of the JSON text', () => {
   expect(requestHash(['Actor', null, false, [{ name: 'MOCK_a' }]])).toBe(hashText(JSON.stringify(['Actor', null, false, [{ name: 'MOCK_a' }]])));
});
it('stableStringify sorts keys at every level and keeps array order', () => {
   expect(stableStringify({ b: { d: 1, c: 2 }, a: [3, 1] })).toBe('{"a":[3,1],"b":{"c":2,"d":1}}');
});
it('contentVersion is equal for a reordered export and differs for a changed value or a reordered array', ...);
it('contentVersion keeps an own __proto__ key in the text', ...);   // JSON.parse('{"__proto__":{"x":1},"a":1}')

// tests/unit/scriptShape.test.js (replaces 'shape.compact: modified time')
it('shows the version option in the header, between type and fields', ...);
//   Object.keys(view) starts ['uuid','name','type','version','fields', ...]; view.version === 'a1b2c3d4e5f607'
it('leaves version out when the option is missing, empty or not a string, and never shows modified', ...);
//   even with _stats: { modifiedTime: 1_760_000_000_000 } in the document
it('keeps the 2 KB bound with a version present and the data at its worst', ...);   // items 120, nameLength 18

// tests/unit/getDocument.test.js (the 'get_document ifModifiedSince' block becomes 'get_document version and ifChanged')
it('shows a 14-hex version in the compact view and no modified', ...);
it('gives the same version on two reads, and for a source whose keys are in another order', ...);
it('changes the version when an embedded item is updated, created or deleted', ...);   // three mock variants of the source
it('changes the version when only _stats changes', ...);                                // modifiedTime 1000 vs 2000
it('keeps the version when only a secret-named value changes', ...);   // flags: { MOCK_mod: { apiKey: 'MOCK_A' } } vs 'MOCK_B'
it('puts the same version in the compact view, the paths result and the fields result', ...);
it('hashes the prepared export when derived is true', ...);
//   mockDocument with prepared: { system: {...changed} }: paths + derived:true -> version differs from the compact version;
//   two derived reads give equal versions; a change only to prepared data changes the derived version
it('answers unchanged for a derived read only against a derived version', ...);
//   ifChanged = derived version + derived:true -> { unchanged: true }; the same text without derived -> the normal result
it('returns no version in mode full', () => { expect(Object.hasOwn(result, 'version')).toBe(false); });
it('answers { unchanged: true } when ifChanged equals the version, for compact, paths, fields and full', ...);
it('returns the normal result when ifChanged differs', ...);
it('never answers unchanged for an unreadable document', ...);   // wiretap.* Setting + any ifChanged -> DOC_EXCLUDED
it('refuses ifModifiedSince as an undeclared argument', ...);    // get({ uuid, ifModifiedSince: 1 }) rejects ARGS_INVALID
it('declares ifChanged with maxLength 32 and no ifModifiedSince, within 800 B listed', ...);
```

  Also: `tests/unit/contextBudgetHarness.js` `mockCompactView` holds `version: 'a1b2c3d4e5f607'` in place of `modified`; its
  unchanged-ack fixture passes `ifChanged: 'a1b2c3d4e5f607'`; the ten-path fixture result gains `version`.
  `tests/integration/readTools.test.js`: both `ifModifiedSince: 12` become `ifChanged: 'abc'`, and a new case
  `it('refuses ifModifiedSince before the client is called', ...)` asserts `isError` true and `gm.invokes` empty.
- [ ] **Step 2: Run.** `npx vitest run tests/unit/contentHash.test.js tests/unit/scriptShape.test.js
  tests/unit/getDocument.test.js tests/unit/contextBudget.test.js tests/integration/readTools.test.js
  tests/unit/writeIdempotency.test.js`. Expected: FAIL (the module, the option and the argument are missing).
- [ ] **Step 3: Implement** `contentHash.js` by the Interfaces block, and point `requestHash` in `writeIdempotency.js` at
  `hashText` (same output; the cyrb53 comment moves with the code, `requestHash` keeps a one-line doc).
- [ ] **Step 4: Implement** `shape.js` (option, header, drop order, `CompactOptions` typedef, the function's JSDoc: it no
  longer mentions the modified time) and `getDocument.js`. Handler order: `checkCombination` → `readDocument` with
  `{ derived: args.derived === true }` → the version, computed only when `args.ifChanged !== undefined` or
  `args.mode !== 'full'`, from `data`, the export the read returns (the prepared export when `derived` is true; no second
  read) → `ifChanged` equal → `ack({ unchanged: true })` → `paths` / `fields` /
  full / compact, each as in Interfaces. Update the file header comment (it lists `ifModifiedSince`).
- [ ] **Step 5: Implement** the `definitions.js` change and update `skills/wiretap/SKILL.md`, `README.md` and the two
  `wiretap-scripts` files: the compact view shows `version` (a short content hash of everything the agent can read,
  embedded documents included; an edit of a secret-named value does not change it), `paths` and `fields` results carry it,
  `ifChanged` returns `{unchanged: true}` when it equals the current version; a `derived: true` read hashes the prepared
  values, so its version is compared by a derived read. Keep
  `skills/wiretap/SKILL.md` at most 75 lines (`tests/unit/shippedSkill.test.js`).
- [ ] **Step 6: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 7: Measure.** `npx tsx tests/measure/measureContext.mjs > debug/dumps/m15a-version.txt 2>&1`; read the table.
  Expected: 21 tools, `get_document` at most 800 B, every fixture within its budget, `Hard failures: 0`. Report the
  `get_document` size and the compact fixture size.
- [ ] **Step 8: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 9: Commit** (stage only this task's files; not `tests/e2e/readTools.spec.js`)
  `feat(read): content version and ifChanged replace the modified-time check`.

---

### Task 2: e2e for `ifChanged` on the live world

The uncommitted test "ifModifiedSince on a parent sees an embedded update and an embedded create" in
`tests/e2e/readTools.spec.js` fails on the live world today (MEASURED: the actor's `_stats.modifiedTime` stays
1795310889255 after an embedded item update; the item's moves to 1795310889307). This task moves it, and the
`ifModifiedSince` assertions of the first read test, to `ifChanged`, adds the embedded delete, and proves the fix.

**Files:**
- Modify: `tests/e2e/readTools.spec.js` (the first read test near lines 136-267 and the regression test from line 269),
  `.claude/skills/wiretap-scripts/SKILL.md` (its e2e paragraph names `ifModifiedSince`)

**Interfaces:**
- Consumes: Task 1's `get_document` (`version`, `ifChanged`); the helpers already in the spec (`callText`, `readJson`,
  `createRecordedActor`, `recordDocument`).

- [ ] **Step 1: Rewrite the tests.**

```js
// test 1, renamed 'reads a created actor: compact, paths, derived, ifChanged, full and handle'
//   was: expect(typeof view.modified).toBe('number')           now: expect(view.version).toMatch(/^[0-9a-f]{14}$/)
//   was: ifModifiedSince: view.modified -> { unchanged: true }  now: ifChanged: view.version -> { unchanged: true }, <= 256 B
//   after the rename update: readJson({ uuid, ifChanged: view.version }).version is a string that is not view.version
//   paths result: slices.version === view.version; derived paths result: derived.version !== stored.version (the effect
//   makes the prepared value differ), and ifChanged: derived.version with derived:true -> { unchanged: true }
//   full export (inline, maxBytes 16000): Object.hasOwn(exported, 'version') is false

// test 2, renamed 'ifChanged on a parent sees an embedded update, an embedded create and an embedded delete'
//   one embedded item exists; each step: read { uuid } -> version v; read { uuid, ifChanged: v } -> { unchanged: true } (control);
//   mutate in the page; read { uuid, ifChanged: v } -> not { unchanged: true } and result.version !== v
//   steps: update the item name; create an ActiveEffect; delete the ActiveEffect
```

  Remove the page-side `setTimeout` pauses (a content version needs none). In the page, also record for each of the three
  mutations whether the parent's `_stats.modifiedTime` moved, as `{ update, create, delete }` booleans, and attach it to
  the assertion messages; it is evidence, not an assertion.
- [ ] **Step 2: Run.** Confirm ports 30000 and 31416-31419 are free and no other e2e run is active, then
  `npx playwright test tests/e2e/readTools.spec.js`. Expected: every test in the file passes; the global teardown reports
  a zero Wiretap census; all gates restored. Then `npm run build`. Report which of the three mutations moved the parent's
  `_stats.modifiedTime` (the bug record says only the embedded update is measured).
- [ ] **Step 3: Update** the e2e paragraph of `.claude/skills/wiretap-scripts/SKILL.md`: `ifChanged` and `version` in place
  of `ifModifiedSince`, and the embedded update, create and delete case.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 5: Commit** `test(e2e): ifChanged sees an embedded update, create and delete`. Leave `docs/OPEN_BUGS.md`
  alone: Task 7 moves the bug.

---

### Task 3: The copy builder `copyDataFromUuids`

The owner asked to copy documents by uuid in one call without the source body entering the agent's context. This task
builds the step that turns source uuids into create data; Task 4 wires it into `create_documents`. Foundry does this two
ways (a pack import uses `toCompendium`, a world import uses `fromCompendium`, an embedded create neither), so this
task reads the cited source first and builds one helper whose result is correct for all three targets.

**Files:**
- Create: `src/bridge/scripts/writeCopy.js`, `tests/unit/writeCopy.test.js`
- Modify: `tests/unit/mockWriteWorld.js` (the mock `toCompendium` near line 565)

**Interfaces:**
- Consumes: `resolveDocument({ uuid })` and `unreadable(document)` of `~/bridge/scripts/canonical.js` (`unreadable`
  returns `{ code, message } | null`); `stripWiretapFlags(root)` of `~/bridge/scripts/writeReplace.js`; `ScriptError`;
  `cleanForLog` of `$shared/logText.js`; `getBudget('WRITE_DOCUMENTS_MAX')` of `$shared/budgets.js`.
- Produces: `export async function copyDataFromUuids({ documentName, fromUuids, keepId = false }): Promise<Record<string,
  unknown>[]>` in `src/bridge/scripts/writeCopy.js` — one plain data object per uuid, in `fromUuids` order, ready for
  `prepareCreate`. Order of the checks (nothing is written by this function):
  1. `fromUuids` is an array of 1 to `WRITE_DOCUMENTS_MAX` strings, else `ARGS_INVALID` `Give 1 to 50 fromUuids.`;
  2. `documentName === 'User'` is `ARGS_INVALID` containing `fromUuids does not copy a User`;
  3. for each uuid in order: `resolveDocument({ uuid })` (a missing source is its `DOC_NOT_FOUND`, which names the uuid);
     a source whose `documentName` differs is `ARGS_INVALID` naming the index and both classes (bounded with
     `cleanForLog`); `unreadable(source)` non-null is a `ScriptError` with that code and message;
  4. the data: `source.toCompendium(null, { keepId, clearSort: true, clearFolder: true, clearOwnership: true,
     clearSource: true, clearState: true })`, then `ownership` deleted (Foundry leaves `{ default }`; any `ownership` key
     needs `allowOwnershipWrites`), `_id` / `sort` / `folder` deleted again when present (so the result does not depend on
     which options a subclass honours), `_stats.compendiumSource` set to `source.uuid` when `source.pack` is truthy, then
     `stripWiretapFlags(data)`.
  Every target kind gets the same clearing: an embedded document has no `folder` field, so deleting it is a no-op there.

Decision this task makes: one helper for world, pack and embedded targets instead of calling `fromCompendium` (it exists
only on world collections, keeps `folder` and re-adds an `ownership` key; Foundry facts above).

- [ ] **Step 1: Read the Foundry source** the Interfaces rely on: `client/documents/abstract/client-document.mjs:1113-1134`,
  `world-collection.mjs:109-137`, `compendium-collection.mjs:462-474`, the `_preCreate` of `client-document.mjs` (~:431)
  and `common/abstract/document.mjs` (what ownership a create with no `ownership` key gets), and the `toCompendium`
  overrides of `scene.mjs:1554`, `playlist.mjs:480`, `roll-table.mjs:510`, `active-effect.mjs:481`. Confirm per target
  kind (world, pack, embedded) that the clearing in Interfaces step 4 matches what Foundry does for `_id`, `folder`, `sort`
  and `ownership`, and what each override changes. Write the findings, including any difference from this plan, as present-
  tense facts with source citations in the file header comment of `writeCopy.js`. A difference that changes the
  Interfaces is reported to the controller before the code is written.
- [ ] **Step 2: Extend the mock.** In `tests/unit/mockWriteWorld.js` make `toCompendium(pack, options = {})` follow the
  option defaults of `client-document.mjs:1113` for `keepId`, `clearSort`, `clearFolder`, `clearOwnership` (leave
  `ownership: { default }` when the source has one) and `clearSource` (drop the three `_stats` keys). The existing callers
  pass `keepId: true, clearSort: false, clearOwnership: false, clearSource: false`, which must keep returning the whole
  source; run `npm test` to confirm.
- [ ] **Step 3: Write the failing tests** in `tests/unit/writeCopy.test.js` over `installWriteWorld(vi.fn)`; sources are
  added with `world.add(documentName, data, context)` (a pack source is also put in `world.byUuid` under its
  `Compendium.<pack>.<Class>.<id>` uuid and added with `{ pack: '<pack id>' }`; embedded sources with `world.addChild`):

```js
it('returns one data object per uuid in fromUuids order', ...);
it('clears _id unless keepId, and keeps it with keepId', ...);
it.each(['world', 'pack', 'embedded'])('clears folder, sort and ownership, and keeps the rest, for a %s source', ...);
//   source carries folder: 'MOCKFOLDER000001', sort: 5, ownership: { default: 2, MOCKUSER: 3 }, system: { hp: 3 }
//   result has none of the three keys (also no ownership.default) and system: { hp: 3 }
it('sets _stats.compendiumSource to the source uuid for a pack source only', ...);
it('removes flags.wiretap from the copy and from embedded documents, and keeps other flags', ...);
it('does not mutate the source', ...);
it('refuses a missing source with DOC_NOT_FOUND naming the uuid, and calls no create', ...);
it('refuses a source of another class with ARGS_INVALID naming the index', ...);
it('refuses a User copy with ARGS_INVALID before resolving anything', ...);   // fromUuid not called
it('refuses a credential Setting and a wiretap.* Setting with DOC_EXCLUDED', ...);
it.each([[], 'MOCK', Array.from({ length: 51 }, (_, i) => `Actor.MOCK${i}`)])('refuses fromUuids %j', ...);
it('bounds a long uuid in the not-found message to 256 bytes', ...);
```
- [ ] **Step 4: Run.** `npx vitest run tests/unit/writeCopy.test.js`. Expected: FAIL (module missing).
- [ ] **Step 5: Implement** `copyDataFromUuids` by the Interfaces block.
- [ ] **Step 6: Run** the Step 4 command. Expected: PASS.
- [ ] **Step 7: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 8: Commit** `feat(write): build create data from source uuids`.

---

### Task 4: `fromUuids` on `create_documents`

The owner asked for copies through `create_documents`. This task adds the argument and the exactly-one-of rule, hashes
the request as given for `idempotencyKey`, and keeps the definition within its budget.

**Files:**
- Modify: `src/bridge/scripts/createDocuments.js`, `src/bridge/scripts/writes.js` (`createDocuments`, `createChecked`,
  `prepareCreate`: the `request` of `applyIdempotency` near line 478), `src/bridge/scripts/definitions.js`
  (`createDocumentsDefinition`), `.claude/skills/wiretap-writes/SKILL.md` and `.claude/skills/wiretap-scripts/SKILL.md`
  (current state: `fromUuids`, `writeCopy.js`, `contentHash.js`), `.claude/CLAUDE.md` (the `wiretap-writes` row of the
  skill table: add `writeCopy` to the `write{...}.js` glob), `.claude/skills/wiretap-codebase-core/SKILL.md` (the same
  glob in the subsystem map)
- Create: `tests/unit/writeCopyCreate.test.js`

**Interfaces:**
- Consumes: `copyDataFromUuids` (Task 3); `parseDataObjects(args.data)` of `writeArgs.js`.
- Produces: `create_documents` arguments gain `fromUuids: string[]` (`minItems` 1, `maxItems`
  `getBudget('WRITE_DOCUMENTS_MAX').value`, items `{ type: 'string', maxLength: 256 }`); `required` becomes
  `['documentName']`; `handleArgs` stays `['data']`. The description names `fromUuids`, `data`, `parentUuid` or `pack`
  and `idempotencyKey` within 160 characters (candidate, 159 characters: `Create Foundry documents from data (JSON text
  each) or fromUuids (copies). parentUuid or pack for embedded or pack. idempotencyKey: a repeat returns the first.`;
  the implementer counts again and may reword within 160).
- Produces, `writes.js`: `createDocuments(params)`, `createChecked(params)` and `prepareCreate(params)` accept an optional
  `requestData?: unknown`; when given it replaces `data` in the value `applyIdempotency` hashes (`[documentName,
  parentUuid ?? null, keepId, requestData ?? data]`). The handler passes `{ fromUuids: args.fromUuids }`.
- Handler order in `createDocumentsHandler`: exactly one of `args.data` and `args.fromUuids` (else `ARGS_INVALID` containing
  `Give data or fromUuids, not both and not neither`) → `data` is `parseDataObjects(args.data)` or
  `await copyDataFromUuids({ documentName: args.documentName, fromUuids: args.fromUuids, keepId: args.keepId === true })`
  → `checkReadbackPaths` → `ctx.core.createDocuments({ ..., data, requestData })` as today. The ack is unchanged.

- [ ] **Step 1: Write the failing tests** in `tests/unit/writeCopyCreate.test.js` (mock world and gate setup as
  `tests/unit/writeCreate.test.js`; the handler is called as `tests/unit/writeScripts.test.js` calls it):

```js
it('creates world copies from fromUuids and acks { uuid, name, type } per document in order', ...);
it('creates embedded copies under parentUuid and copies into a pack', ...);   // pack needs allowCompendiumWrites open
it.each([[undefined, undefined], [['{"name":"MOCK_a"}'], ['Item.MOCKSOURCE0001']]])('refuses data %j with fromUuids %j', ...);
//   ARGS_INVALID; no create call
it('refuses a closed gate exactly as it does for data', ...);   // pack target, allowCompendiumWrites closed -> GATE_DENIED
it('copies a source with ownership, folder and sort with every gate closed', ...);   // no GATE_DENIED, none of the three sent
it('a dryRun copy returns rows with dryRun: true and a null uuid and creates nothing', ...);
it('writes nothing when one of several sources is missing', ...);
it('replays the first result for the same idempotencyKey and fromUuids after the source was edited', ...);
//   second call: same rows (uuids), createDocuments called once in total; no IDEMPOTENCY_CONFLICT
it('treats the same key with other fromUuids as IDEMPOTENCY_CONFLICT', ...);
it('does not pass a source flags.wiretap record on, with or without an idempotencyKey on the copy call', ...);
it('applies keepId to the copies and refuses a taken _id', ...);
it('adds read-back for paths', ...);
it('declares fromUuids and keeps the definition within its bounds', () => {
   // fromUuids: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', maxLength: 256 } };
   // required ['documentName']; handleArgs ['data'];
   // description.length <= 160 and contains 'fromUuids' and 'idempotencyKey';
   // definitionBytes(name, description, compileSchema(inputSchema).listed) <= 800
});
```
- [ ] **Step 2: Run.** `npx vitest run tests/unit/writeCopyCreate.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the `writes.js` plumbing, the handler, and the definition.
- [ ] **Step 4: Run** the Step 2 command and `npx vitest run tests/unit/contextBudget.test.js
  tests/unit/schemaValidate.test.js tests/unit/schemaStrict.test.js tests/unit/writeIdempotency.test.js
  tests/unit/writeScripts.test.js`. Expected: PASS.
- [ ] **Step 5: Measure.** `npx tsx tests/measure/measureContext.mjs > debug/dumps/m15a-copy.txt 2>&1`. Expected: 21 tools,
  `create_documents` at most 800 B (640 B today; estimate +60 to 80 B), the total at most 16,000 B, `Hard failures: 0`.
  Report the new `create_documents` size, the total and the tool count. Over a limit: shorten the description or the
  bounds without dropping `minItems` / `maxItems`, and report.
- [ ] **Step 6: Update the skills** named under Files to the current code (the `wiretap-writes` paths list gains
  `src/bridge/scripts/writeCopy.js` and its tests in its frontmatter and its Files table; describe `fromUuids`, the
  exactly-one-of rule, the clearing, the hash input and the codes). Measure each touched `SKILL.md` with `wc -c`.
- [ ] **Step 7: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 8: Commit** `feat(write): create_documents copies documents by uuid with fromUuids`.

---

### Task 5: Integration tests, the user-facing recipes and the README

The owner asked for the two-call recipes that replace `copy_document` and `build_actor`, and the design requires an
integration proof that the source body never reaches the agent and that the actor recipe is two `tools/call` requests.
A fake GM client that returns canned acks cannot prove either, so the harness lets the fake client run the real script
handlers against the mock world.

**Files:**
- Modify: `tests/integration/mcpHarness.js` (`connectGm`: the `BRIDGE_INVOKE` listener awaits `answer`, whose JSDoc type
  becomes `(request: object) => object | Promise<object>`), `skills/wiretap/SKILL.md`, `README.md` (the create_documents
  text; find it by searching `create_documents`)
- Create: `tests/integration/copyTools.test.js` (`// @vitest-environment node`)

**Interfaces:**
- Consumes: `createHarness` (`start`, `connectGm({ answer })`, `gm.register`, `gm.invokes`, `connectClient` returning
  `{ client, transport }`, `cleanup`); `shippedScripts()` of `tests/unit/scriptFixtures.js`; `installWriteWorld` of
  `tests/unit/mockWriteWorld.js`; `registerShippedScripts(registry)` of `~/bridge/scripts/index.js`,
  `createScriptRegistry()` of `~/bridge/scripts/registry.js` and `createCallTool({ registry })` of
  `~/bridge/scripts/callTool.js`; `OP_CALL_TOOL` of `shared/protocol.js`. The fake client's `answer` calls the real
  `callTool(request.params)` and acks `{ ok: true, result }` or `{ ok: false, error: { code: error.code ?? 'OP_FAILED',
  message: error.message } }`.
- Message capture: after `connectClient()`, wrap `transport.onmessage` (every message the SDK client receives) and
  `transport.send` (every message it sends) with recorders that keep the JSON text, then call the original.

- [ ] **Step 1: Write the failing tests** in `tests/integration/copyTools.test.js`:

```js
it('copies a 100 KB source without the body reaching the agent', async () => {
   // world: an Item source whose system.notes is 'MOCK_'.repeat(20000) (100 KB); one Actor target
   // call create_documents { documentName: 'Item', parentUuid: <actor uuid>, fromUuids: [<source uuid>] } through the SDK client
   // expect the result rows [{ uuid, name, type }]; JSON of every received message < 5,000 bytes and never contains 'MOCK_MOCK_'
   // expect gm.invokes[0].params.arguments toEqual { documentName, parentUuid, fromUuids } (no data)
   // expect the created embedded item in the mock world to hold the 100 KB notes (the copy happened, the body stayed in the client)
});
it('builds an actor with its own items inline and compendium items by uuid in two tools/call requests', async () => {
   // call 1: create_documents { documentName: 'Actor', data: [one JSON text with inline items and effects] }
   // call 2: create_documents { documentName: 'Item', parentUuid: <uuid from call 1>, fromUuids: [pack item uuid] }
   // expect the sent messages with method 'tools/call' to number exactly 2, and gm.invokes with op OP_CALL_TOOL exactly 2
});
it('returns a missing-source error as <code>: <message> and sends no document', ...);   // DOC_NOT_FOUND text names the uuid
```
- [ ] **Step 2: Run.** `npx vitest run tests/integration/copyTools.test.js`. Expected: FAIL until the harness awaits
  `answer`; after the harness change and Task 4, all pass. A failure that is a product defect: log it in
  `docs/OPEN_BUGS.md` and stop the task.
- [ ] **Step 3: Change** the harness listener to `async` with `ack(await answer(request))`. Run
  `npx vitest run tests/integration` to confirm the existing integration tests still pass.
- [ ] **Step 4: Write the recipes** in `skills/wiretap/SKILL.md` (file at most 75 lines; reflow wrapped paragraphs to 120
  columns and merge lines without dropping a fact; if it cannot fit, stop and report). Facts to carry: **Copy**
  `mcp__wiretap__create_documents` with `documentName` and `fromUuids` (up to 50 world, embedded or compendium documents of
  that class) in place of `data`, plus `pack` or `parentUuid` as for `data`: one call, the source body never enters your
  context; the copy has a new `_id` (unless `keepId`) and no `folder`, `sort`, `ownership` or `flags.wiretap`; a `User`
  cannot be copied; rename or adjust with `update_documents` afterwards. **Build an actor**: `create_documents` for the
  Actor with its own items and effects inline in `data`, then `create_documents` with `documentName: "Item"`,
  `parentUuid` the new actor and `fromUuids` the compendium items: two calls. **Change-only re-read**: keep the `version`
  of a `get_document` result and pass it as `ifChanged`. Add "copying documents by uuid" to the frontmatter description.
- [ ] **Step 5: Update `README.md`** (the `create_documents` text: `fromUuids`, exactly one of `data` and `fromUuids`,
  what a copy clears, that source secrets are copied as Foundry's import copies them and every read of the copy stays
  redacted, `User` refused; `idempotencyKey` hashes `fromUuids` as given).
- [ ] **Step 6: Verify.** `npm test` (includes `shippedSkill.test.js` and the context-budget tests), `npm run typecheck`,
  `npm run eslint`. Expected: all pass.
- [ ] **Step 7: Commit** `test(integration): copy by uuid and the two-call actor recipe; skill and README`.

---

### Task 6: e2e for `fromUuids` on the live world

The design requires a live proof: world items copied onto a recorded actor, and a world document copied into a recorded
throwaway world pack. This task also exercises the two Foundry behaviours that unit mocks cannot (what Foundry does with
the cleared data, and `_stats.compendiumSource`).

**Files:**
- Create: `tests/e2e/copyTools.spec.js`
- Modify: `.claude/skills/wiretap-build-test/SKILL.md` (the e2e spec list and the harness change of Task 5)

**Interfaces:**
- Consumes: the tools of Tasks 1 to 4; `login` of `tests/e2e/fixtures.js`; `startGateSidecar`, `stopSidecar` of
  `tests/e2e/sidecar.js`; `E2E_MCP_PORT` of `tests/e2e/ports.js`; `recordGateSettings`, `restoreGateSettings` of
  `tests/e2e/gates.js`; `E2E_PREFIX`, `recordDocument`, `settleRegistry`, `assertSettled`, `teardownRecorded` of
  `tests/e2e/registry.js` (a world pack is recorded as `{ documentName: 'Compendium', id: 'world.<name>', uuid:
  'Compendium.world.<name>' }`); `createArguments`, `firstSubtype`, `idOf` of `tests/e2e/writeHelpers.js`. Follow the setup
  of `tests/e2e/packTools.spec.js` (sidecar per spec file, SDK client per test, `callText`, an `openGate` helper that
  sets a gate in the page and polls page and sidecar snapshot with `timeout: 1000`, `recordGateSettings` in `beforeEach`,
  `restoreGateSettings` in `afterEach`, `settleRegistry` + `assertSettled` after each test).

- [ ] **Step 1: Write the spec.**

```js
test('copies world items onto a recorded actor with fromUuids', ...);
//   create a recorded Actor and two recorded world Items (names with E2E_PREFIX; the first created with an
//   idempotencyKey so it carries flags.wiretap.idem); create_documents { documentName: 'Item', parentUuid, fromUuids: [a, b] }
//   -> two rows in order, uuids start with `${actorUuid}.Item.`, names equal the sources', ack <= 4000 B;
//   in the page: actor.items.size 2, each copy's _id differs from its source's, no copy has flags.wiretap,
//   the sources still exist unchanged
//   refusals (well-formed uuids only): data + fromUuids -> ARGS_INVALID; documentName 'Actor' with an Item uuid ->
//   ARGS_INVALID; a dryRun copy returns dryRun rows and the actor still has 2 items
test('copies a world document into a recorded throwaway world pack and back into the world', ...);
//   openGate allowCompendiumWrites; create_pack { label: `${E2E_PREFIX}Copy ${ts}`, type: 'Item' }, record it at once;
//   a recorded world Item; create_documents { documentName: 'Item', pack: id, fromUuids: [item.uuid] } -> one row;
//   in the page the pack index holds one entry named like the source;
//   then create_documents { documentName: 'Item', fromUuids: [<pack document uuid>] } -> a recorded world Item whose
//   _stats.compendiumSource equals the pack document's uuid, with folder, sort and ownership at the class defaults
```

  Every created world document is recorded right after creation; the pack and its contents are removed by the registry.
- [ ] **Step 2: Run.** Preconditions as in Global Constraints (ports free, no other e2e run), then
  `npx playwright test tests/e2e/copyTools.spec.js`. Expected: 2 passed, a zero Wiretap census, every gate restored. Then
  `npm run build`. A result that differs from Task 3's header-comment facts is a defect: log it in `docs/OPEN_BUGS.md` and
  stop the task.
- [ ] **Step 3: Update** `wiretap-build-test` (the new spec, the new integration test, the async `answer` of
  `mcpHarness.js`).
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`, the Step 2 command. Expected: all pass.
- [ ] **Step 5: Commit** `test(e2e): copy documents by uuid on the live world`.

---

### Task 7: Tracking files, skills and the knowledge graph

`.claude/CLAUDE.md` makes the documentation step part of every plan: it is not complete until it is done. This task
brings every tracking file and skill to the state the code is in now. `docs/PLAN.md` stays forward-looking: no as-built
notes, measured results, counts or dates.

**Files:**
- Modify: `docs/PLAN.md`: (a) the M15a section (near line 662) rewritten to this scope: goal, `In` (`fromUuids` on
  `create_documents`, content `version` and `ifChanged` on `get_document`, the documented recipes), tests, acceptance
  (two `tools/call` requests for the actor recipe, the 100 KB source), budgets; drop `add_embedded`, `diff_since`,
  `export_to_handle`, `import_from_handle`, `build_actor`, `copy_document` and the consent-at-start line; (b) §2.9: delete
  the rows of those six scripts, update the `get_document` row, add a `create_documents` row with `fromUuids`; (c) the
  change-only row near line 80 and the composite-scripts row near line 76 reworded to the version and the recipes; (d) §4.4
  (near lines 394, 398-400 and 419): `modified` and `ifModifiedSince` become `version` and `ifChanged`, and the
  `export_to_handle` / `import_from_handle` mentions become `fromUuids`; (e) a decision row `D35` after D34 recording
  "M15a fills gaps only: `fromUuids` on `create_documents`, a content `version` with `ifChanged`, no composite tools, no
  `diff_since`" (status DECIDED).
- Modify: `docs/TODO.md`: one deferral, `diff_since` mode 2 (paths changed since a snapshot): about 8k tokens saved per
  edit cycle against a full re-read, about 0.7k against a compact re-read, one more call, and
  `foundry.utils.diffObject` returns differing arrays whole, so it needs a keyed diff in the §2.8 path grammar; mode 1
  (documents changed since a time) cannot report deletions and its clock basis is unverified.
- Modify: `docs/OPEN_BUGS.md` (delete the stale-read entry), `docs/CLOSED_BUGS.md` (add it in the file's Was / Fix /
  Measured form: the cause (Foundry leaves the parent's `_stats.modifiedTime` unchanged on an embedded update), the fix
  (content version), what Task 2 measured for embedded create and delete, the test that proves it);
  `docs/POST_WORK_FINDINGS.md` (the Foundry facts Task 2 measured about the parent's stamp, and the `fromCompendium` /
  `toCompendium` differences from `writeCopy.js`'s header comment, as gotchas, not tasks).
- Modify: `docs/PROGRESS.md`: the M15a row (Done, date, commits from `git log`) in "Milestone completion", the
  "Next milestone" line (next in PLAN §5 order after M15a), the suite counts (MEASURED, `npm test`), and an "As-built notes:
  M15a" section with the measured sizes (`create_documents`, `get_document`, total, 21 tools), the e2e results of Tasks 2
  and 6, and the decision list below. `docs/README.md`: add the design and this plan if it lists them.
- Modify: `.claude/skills/wiretap-writes/SKILL.md`, `wiretap-scripts/SKILL.md` and `references/core-read-scripts.md`,
  `wiretap-build-test/SKILL.md` (check each against the code, fix what Tasks 1 to 6 left stale: counts such as "Fourteen
  shipped scripts", the test lists, the compact view's fields), `wiretap-mcp-bridge` (check only).
- Check: `skills/wiretap/SKILL.md` matches the shipped tools; `README.md` lines near 138 and 143 and the create_documents
  text are current.

Decisions to record in `docs/PROGRESS.md` (one line each, with the rejected alternative where it matters):
- One builder helper for all target kinds instead of `fromCompendium` (it keeps `folder`, re-adds `ownership`, exists on
  world collections only).
- `ownership` is removed from copies entirely, so a copy needs no `allowOwnershipWrites`.
- The version is 14 hex digits; `ifChanged` is bounded to 32 characters; the helper lives in `contentHash.js`.
- The version hashes the export the read returns: the prepared export for `derived: true` (owner's decision; rejected:
  hashing stored data only, which says "unchanged" after a derived value changes through another document).
- `idempotencyKey` hashes `{ fromUuids }`; a retry after the source was deleted is `DOC_NOT_FOUND`, not a replay.
- `fromUuids` items are bounded to 256 characters and the array to 1 to 50.
- The fake GM client of the integration harness may answer asynchronously so a test can run the real handlers.
- Task 1 and Task 2 are separate commits (the e2e needs a live Foundry and a second agent type).

- [ ] **Step 1: Write** the updates above, reading each fact from the code or the task reports, not from memory.
- [ ] **Step 2: Measure** every `SKILL.md` touched with `wc -c`: each stays below 20,000 characters.
- [ ] **Step 3: Run** `graphify update .`. Expected: completes without error.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`, `npm run build`, `npm run check:release` (move
  e2e leftovers in `dist/` to the recycle bin with `trash` first if it names any). Expected: all pass.
- [ ] **Step 5: Commit** `docs: close M15a; progress, README and skills`.

---

## Decision log

Calls the design left open, and plan-level calls; the owner can change any of them.

- Version text is 14 lowercase hex digits (`hashText`, the form `requestHash` already returns); `ifChanged` is bounded to
  32 characters. The design allowed hex or base36 in the 16-character range.
- The shared hash helper is `src/bridge/scripts/contentHash.js` (`hashText`, `stableStringify`, `contentVersion`); both
  callers are client scripts. `requestHash` keeps its name and output.
- The version is skipped for `mode: 'full'` without `ifChanged` (it is neither returned nor compared there).
- For `derived: true` the version hashes the prepared export the read already made (owner's decision 2026-11-21).
- Copies use one builder for world, pack and embedded targets: `toCompendium(null, ...)` with every clear option, then
  `ownership`, `_id` (unless `keepId`), `sort` and `folder` deleted, `_stats.compendiumSource` set for a pack source,
  `flags.wiretap` stripped. `fromCompendium` is not called (Foundry facts above).
- `fromUuids` is bounded to 1 to 50 items of at most 256 characters; the uuid-to-data step runs before `prepareCreate`,
  so a missing source is reported before a closed gate would be.
- `prepareCreate` gains an optional `requestData` that replaces `data` in the idempotency hash; `batch` does not pass it.
- Task 1 and the e2e of Task 2 are two commits, not one, because the e2e needs the live world and a different agent type;
  `tests/e2e/readTools.spec.js` stays uncommitted until Task 2.
- Task 5 lets the fake GM client answer asynchronously (a one-line harness change) so the integration test runs the real
  handlers; with canned acks the 100 KB assertion would test nothing.
- Task 6 adds one assertion beyond the design's two e2e cases: the pack document copied back into the world, to prove
  `_stats.compendiumSource` on the live world.
- No `## Lanes` section: the plan runs one at a time.

## Self-review

- Spec coverage: `fromUuids` (T3, T4), exactly-one-of, class mismatch, missing source, `User` refusal, `unreadable` refusal,
  `flags.wiretap` strip, per-target clearing, `prepareCreate` reuse, idempotency hash, ack unchanged, description and 800 B
  budget (T3, T4); version, stable serialization, redaction, `_stats` input, derived, placement, `ifChanged`, embedded
  changes, 2 KB compact view (T1, T2); recipes and tool-name test (T5); unit, integration, e2e and budget acceptance (T1 to
  T6); documentation, bug move, TODO deferral, D35 (T7). Non-goals appear only in Global Constraints.
- Names: `copyDataFromUuids`, `requestData`, `contentVersion`, `hashText`, `stableStringify`, `ifChanged`, `version` are
  spelled the same in every task that uses them.
- Placeholders: none; every task names its files, signatures, pinned values and the command with its expected result.
