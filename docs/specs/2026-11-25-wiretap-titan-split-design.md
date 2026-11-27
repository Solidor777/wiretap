# Wiretap Titan split design

Date: 2026-11-25. Status: approved by the owner.

## Intent

Wiretap is system agnostic (owner ruling, 2026-11-25): built and shipped code references no game system. The only
Titan-specific content in shipped code is the per-subtype key-field lists of the compact document view
(`src/bridge/scripts/keyFields.json`, 32 Titan subtypes). They leave Wiretap and are kept, unused, in the add-on module
`wiretap-titan-vttrpg` for later.

## Goals

- No shipped Wiretap file names or holds data for the Titan system.
- The add-on keeps the lists, byte for byte, for later use.
- The compact view of `get_document` uses only the generic key-name rule of `ctx.shape` for every system.

## Non-goals

- No hook or API for an add-on to supply key fields. The owner does not need key fields now.
- Test machinery keeps using the Titan install (the `test-titan` world, titan-like unit fixtures), as the owner allowed.
- Historical records (`docs/experiments/`, past plans and specs, `docs/PROGRESS.md` entries) stay as written.

## Approaches

- **Chosen: move the data file, drop the lookup.** Recycle `keyFields.json` and `keyFields.js`; `getDocument.js`
  calls `ctx.shape.compact` without `keyPaths`; the add-on stores the JSON at `data/keyFields.json`.
- Rejected: build an add-on key-field hook now. The owner said key fields are not needed now.
- Rejected: keep the JSON in Wiretap unread. Titan content would still ship.

## Design

### Wiretap

- Recycle `src/bridge/scripts/keyFields.json` and `src/bridge/scripts/keyFields.js` with `trash`.
- `src/bridge/scripts/getDocument.js`: remove the `keyPathsFor` import and lookup; the compact branch calls
  `ctx.shape.compact(data, { version, partial })`.
- `ctx.shape.compact` keeps its `keyPaths` option (owner-approved call): it is system agnostic and a later add-on may
  use it. Its own unit tests stay.
- `README.md`: the compact-view description says the leaves come from the default key-name pattern, with no Titan
  mention.
- Living docs: `docs/PLAN.md` text that describes per-type key-field lists is edited to the current decision (the
  generic rule only); `docs/TODO.md`'s "Right after M7" entry is deleted when the work is done; `docs/PROGRESS.md`
  records the work; every `wiretap:wiretap-*` skill that describes the lists or `keyFields.js` is updated.

### Tests

- `tests/unit/getDocument.test.js`:
  - The 2 KB test stops iterating `KEY_FIELDS`. It builds a hard-coded synthetic document whose `system` leaves all
    match the default key-name pattern, more than 24 of them, each value at 200 bytes, plus 120 long-named items, and
    asserts the compact budget (`COMPACT_VIEW_MAX_BYTES`) and at most 24 leaves.
  - The test that sets `game.system.id = 'titan'` uses a synthetic system id; its assertions stay valid under the
    default pattern or are adjusted to it.
  - The `KEY_FIELDS` import is removed.
- `tests/e2e/readTools.spec.js`: remove the `KEY_FIELDS` import and the branch that compares compact `fields` with a
  list. The error, size and uuid checks stay.
- `tests/e2e/keyFields.measure.spec.js` stays (test tooling that reads any system). Its comment no longer names a
  Wiretap data file: it generates candidate lists in the committed format for an add-on.

### Add-on `wiretap-titan-vttrpg`

- Save the JSON unchanged at `data/keyFields.json` (repo root, not imported, not in `dist/`).
- `docs/PLAN.md` "Work not yet built": the lists are stored at `data/keyFields.json`; how an add-on supplies them to
  Wiretap is designed with the owner when key fields are needed.
- Commit in the add-on's own repository.

## Constraints

- No permanent deletion: `trash` with forward-slash paths, then verify.
- `npm run build`, unit tests, lint and `npm run check:release` pass; the e2e spec `readTools.spec.js` passes on
  `test-titan` (shared resource: no other e2e run active).
- `rg -i titan src server shared lang module.json` returns nothing after the change.

## Left to the builder

- The exact synthetic leaf names in the 2 KB test, as long as they match the default key-name pattern.
- Wording of the doc and skill edits.

## Execution method

Native (`superpowers:executing-plans`): about three small sequential tasks, no parallel work.
