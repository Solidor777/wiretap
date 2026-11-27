# Titan Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wiretap's shipped code holds no Titan content; the Titan key-field lists are saved, unused, in the add-on.

**Architecture:** The compact view of `get_document` stops looking up per-subtype lists and always uses the default
key-name pattern of `ctx.shape.compact`. The JSON moves unchanged to `wiretap-titan-vttrpg/data/keyFields.json`.

**Tech Stack:** JavaScript, vitest, Playwright e2e.

**Spec:** `docs/specs/2026-11-25-wiretap-titan-split-design.md`

## Model/Effort directives

- Plan written mainline in this session (small, fully specified change; no plan-writer dispatch).
- Execution method: native (`superpowers:executing-plans`), chosen by the owner with the design.
- Final review: one `sdd-final-reviewer` pass over the branch, its dispatch carrying the project rules.

## Buddy-check directives

None: no security boundary, process spawn, protocol or public API change.

## Global Constraints

- No permanent deletion: `trash` with forward-slash paths, verify the file is gone afterwards.
- `ctx.shape.compact` keeps its `keyPaths` option and its unit tests.
- Historical records (`docs/experiments/`, past plans and specs, past `docs/PROGRESS.md` entries) are not edited.
- After the change, `rg -i titan src server shared lang module.json` prints nothing.
- Test fixtures stay synthetic (`MOCK_` names); test machinery may keep using `test-titan`.

## Review Focus

- A Titan actor read on the live world under the default pattern: still at most 2,000 B (`readTools.spec.js` and
  `everyType.spec.js` cover it; run both).
- A document with more than 24 pattern-matching leaves at long values: at most 24 leaves and within
  `COMPACT_VIEW_MAX_BYTES` (Task 2's rewritten 2 KB test).
- The add-on's `data/` folder must not reach its release: the add-on's `npm run check:release` passes after a build.

---

### Task 1: Save the lists in the add-on

**Files:**
- Create: `../wiretap-titan-vttrpg/data/keyFields.json` (byte-for-byte copy of `src/bridge/scripts/keyFields.json`)
- Modify: `../wiretap-titan-vttrpg/docs/PLAN.md` ("Work not yet built")

- [ ] **Step 1:** Copy the file. Verify with `cmp src/bridge/scripts/keyFields.json ../wiretap-titan-vttrpg/data/keyFields.json`
  (exit 0).
- [ ] **Step 2:** Edit the PLAN.md bullet to: the lists that left Wiretap are stored at `data/keyFields.json` (keyed by
  system id, then `<documentName>.<type>`); how the add-on supplies them to Wiretap is designed with the owner when key
  fields are needed.
- [ ] **Step 3:** In the add-on: `npm run build`, `npm test`, `npm run check:release` all pass.
- [ ] **Step 4:** Commit in the add-on repo: `git add data/keyFields.json docs/PLAN.md`, message
  `feat: store the Titan key-field lists that left Wiretap`.

### Task 2: Wiretap compact view uses the default pattern only

**Files:**
- Modify: `src/bridge/scripts/getDocument.js:16,113-127`
- Trash: `src/bridge/scripts/keyFields.js`, `src/bridge/scripts/keyFields.json`
- Test: `tests/unit/getDocument.test.js`, `tests/e2e/readTools.spec.js`

**Interfaces:**
- Consumes: `ctx.shape.compact(data, { version, partial })`; `DEFAULT_KEY_PATTERN` in `src/bridge/scripts/shape.js:40`
  (`/^(value|max|min|level|rank|quantity|equipped|formula|damage|armor|cost)$/`).

- [ ] **Step 1: Rewrite the unit tests** in `tests/unit/getDocument.test.js`:
  - Remove the `KEY_FIELDS` import. `worldWithActor`'s default `systemId` becomes `'mock-system'`; the
    `game.system.id = 'titan'` line in "is the default for a world id read…" is removed (the helper sets it).
    `actorSource`'s comment says "synthetic actor".
  - "shows uuid, name, type, the version, the subtype key leaves…" is renamed "…the key leaves of the default pattern…"
    and expects `fields` to equal exactly
    `{ 'system.resource.stamina.value': 6, 'system.resource.resolve.value': 1 }`; the other assertions stay.
  - "uses the default key-name pattern for a system without lists" is renamed "uses the default key-name pattern for
    any system"; body unchanged.
  - "holds 2 KB for every listed subtype…" becomes "holds 2 KB with 30 pattern-matching leaves at 200 bytes and 120
    long-named items": one Actor of type `player`, `system` holding 30 groups `g0`…`g29` each `{ value: 'V'.repeat(200) }`,
    the same 120 items; expects `bytes(view) <= getBudget('COMPACT_VIEW_MAX_BYTES').value`,
    `Object.keys(view.fields).length <= 24` and `view.cut === true`.
- [ ] **Step 2:** `npx vitest run tests/unit/getDocument.test.js` passes. No red step exists: with the synthetic system
  id the old lookup finds no list, so the tests pass before and after Step 3; they pin the behaviour Step 3 keeps.
- [ ] **Step 3:** In `getDocument.js` remove the `keyPathsFor` import and lookup; the compact branch returns
  `ctx.shape.compact(data, { version, partial })`. Trash both `keyFields` files; verify they are gone.
- [ ] **Step 4:** In `tests/e2e/readTools.spec.js` remove the `KEY_FIELDS` import, the `lists` constant and the
  `if (lists[target.key] …)` block; the error, size and uuid assertions stay.
- [ ] **Step 5:** `npm test`, `npm run eslint`, `npm run build`, `npm run check:release` pass;
  `rg -i titan src server shared lang module.json` prints nothing.
- [ ] **Step 6:** With the shared Foundry resources free, `npx playwright test tests/e2e/readTools.spec.js
  tests/e2e/everyType.spec.js` passes; then rebuild, recycle e2e chunks, `npm run check:release` passes.
- [ ] **Step 7:** Commit: `refactor(get_document): the compact view uses the default key-name pattern only`.

### Task 3: Docs, skills and the measurement spec comment

**Files:**
- Modify: `README.md:148`, `docs/PLAN.md` §4.4 (the "per-type key-field list" phrase), `docs/TODO.md:87-92`,
  `docs/PROGRESS.md`, `tests/e2e/keyFields.measure.spec.js:7-10`
- Modify (plugin, outside the repo): `wiretap-scripts/SKILL.md` (description and the `keyFields` row),
  `wiretap-scripts/references/core-read-scripts.md:51-52`, `wiretap-scripts/references/tests.md:8`,
  `wiretap-build-test/references/e2e-tool-specs.md:11`

- [ ] **Step 1:** README: the compact-view leaves come from the default key-name pattern; no Titan mention.
- [ ] **Step 2:** PLAN.md §4.4: "a per-type key-field list" becomes "the `system` leaves whose key matches the default
  key-name pattern". Delete the TODO.md entry. Add a PROGRESS.md entry for the Titan split.
- [ ] **Step 3:** Measurement spec comment: it generates candidate per-subtype lists, in the format of the add-on's
  `data/keyFields.json`, for a system add-on; Wiretap ships no lists.
- [ ] **Step 4:** Skills: remove the `keyFields` row and "key-field lists" from the description; core-read-scripts and
  tests references describe the default-pattern compact view and the rewritten 2 KB test; e2e-tool-specs says the
  measurement output is for an add-on. Keep each SKILL.md under 20,000 characters (measure).
- [ ] **Step 5:** `npm run eslint` passes; `graphify update .`.
- [ ] **Step 6:** Commit: `docs: Wiretap ships no Titan key-field lists`.
