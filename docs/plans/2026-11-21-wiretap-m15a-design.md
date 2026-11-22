# M15a design: copy by uuid and content versions

Status: approved by the owner 2026-11-21. Execution method: one at a time (subagent-driven-development).

## Intent

M15a was planned as seven script-library tools (`add_embedded`, `diff_since`, `export_to_handle`, `read_handle`,
`import_from_handle`, `build_actor`, `copy_document`) whose purpose is to cut the calls and the context bytes an agent
spends on common jobs. Since that plan was written, most of the catalogue has landed in other forms:

- `read_handle` exists (`server/mcp.ts`).
- `import_from_handle` is covered: `create_documents.data` and `replace_document.data` accept `handle:<id>`
  (`server/handleInput.ts`), and `create_documents` has `keepId`.
- `add_embedded` from data is covered: `create_documents` takes `parentUuid`.

This milestone fills the gaps that remain, adds no tool name, and fixes one measured bug in the change-only read.

## Goals

1. Copy documents by uuid (a compendium item onto an actor, a world document into a pack, a pack document into the
   world) in one call, without the source body entering the agent's context.
2. Make the change-only read of `get_document` exact: it reports a change whenever anything the agent can read
   changed, embedded documents included.
3. Document the two-call recipes that replace `copy_document` and `build_actor` in the user-facing skill.

## Non-goals

- No new tool names. The always-listed count stays at 21 (PLAN §2.6 ceiling 30).
- No `diff_since` (either mode). Mode 1 (documents changed since a time) cannot report deletions and its clock basis is
  unverified. Mode 2 (paths changed since a snapshot) is deferred to `docs/TODO.md` with the design analysis's numbers:
  ≈8k tokens saved per edit cycle against a full re-read, ≈0.7k against a compact re-read, +1 call, and
  `foundry.utils.diffObject` returns differing arrays whole, so it would need a keyed diff in the §2.8 grammar.
- No "to handle" option on `get_document`; its only remaining use was the mode 2 snapshot.
- No `overrides` on copies (rename and similar changes are a follow-up `update_documents` call).
- No `build_actor`, `copy_document`, `export_to_handle`, `import_from_handle`, `add_embedded` tools.

## Anti-goals

- A copy that bypasses any check a `create_documents` call with the same data would meet (gates, `guardWrite`,
  validation, `actAs`, `dryRun`, `refuseTakenIds`).
- A version that says "unchanged" when a readable value changed. A spurious "changed" only costs one re-read and is
  acceptable; a false "unchanged" is the bug being fixed.

## Constraints

- PLAN.md §2.6 budgets: a definition ≤ 800 B listed (`create_documents` lists at 640 B today, MEASURED by
  `tests/measure/measureContext.mjs`); description ≤ 240 chars hard, 160 target; ack ≤ 256 B per document; compact view
  ≤ 2 KB.
- No backwards compatibility (project `CLAUDE.md`): `ifModifiedSince` and the compact view's `modified` are removed,
  not aliased.
- Code style, typing and comment rules of the project `CLAUDE.md`; the `wiretap-*` skills are updated in the same work
  unit.

## Approaches considered

1. **The catalogue as written** (seven tools, five thin wrappers): rejected by the owner. More names in every session,
   a partial-failure ack design for each composite, one call saved each.
2. **Fill only the gaps** (chosen by the owner): `fromUuids` on `create_documents`, an exact change check on
   `get_document`, `diff_since` decided by a design analysis (outcome: not built), composites replaced by documented
   recipes.

For the change check:

- **A. Newest timestamp across the document and its embedded documents:** small change, but an embedded delete leaves
  no timestamp, so it can still say "unchanged" after a delete; it also depends on the unverified clock basis.
- **B. Content fingerprint (chosen by the owner):** a hash of what the agent can read. Catches every change, deletes
  included, and has no clock dependence. Cost: one stringify and hash per read.

## Design

### 1. `fromUuids` on `create_documents`

- New argument `fromUuids: string[]`, 1 to `WRITE_DOCUMENTS_MAX` (50) entries. Exactly one of `data` and `fromUuids` is
  given (`ARGS_INVALID` otherwise); `required` becomes `['documentName']`.
- The GM client resolves each uuid with `fromUuid` (world, embedded or compendium source). A missing source is
  `DOC_NOT_FOUND` naming the uuid; a source whose `documentName` differs from the argument is `ARGS_INVALID`. Nothing is
  written in either case.
- Each source becomes create data the way Foundry's own compendium import builds it: the source's `toCompendium` export,
  then the target collection's `fromCompendium` preparation (READ `client-document.mjs` `importFromJSON` /
  `WorldCollection#fromCompendium`, the same steps `replace_document` mirrors). That clears `_id` (unless `keepId`),
  `folder`, `sort` and `ownership` as Foundry's import does and sets `_stats.compendiumSource` where Foundry sets it.
  For an embedded target (`parentUuid`) the builder confirms which of these steps apply (an embedded document has no
  world collection).
- `flags.wiretap` is removed from every copy (`stripWiretapFlags` in `writeReplace.js`), so a copied idempotency record
  never travels.
- The copies then go through the existing `prepareCreate` / `runCreate` path unchanged, so every gate, `guardWrite`,
  validation, `dryRun`, `actAs`, `keepId`, `pack`, `parentUuid`, `idempotencyKey` and `paths` read-back behave exactly as
  for `data`.
- Source secrets (owner's decision): a copy is built from the raw document (`toCompendium`), not the redacted read
  export, so secret-named keys are copied unchanged, as Foundry's own import copies them. The agent still never sees
  them: every read of the copy is redacted. A source that a read refuses outright (the `unreadable` cases of
  `canonical.js`, such as credential Settings) is refused with the same code a read gives, and nothing is written.
  `fromUuids` with `documentName: 'User'` is `ARGS_INVALID` (designer's call: a copied account has no use, and a raw
  copy would otherwise carry the password fields a read drops).
- `data` and `fromUuids` texts are not combined. The `handleArgs` entry stays `['data']`.
- The uuid-to-data step is a helper the `create_documents` handler calls before `prepareCreate`, so `prepareCreate`
  keeps taking data. `batch` does not get `fromUuids` (designer's call: its definition lists at 795 B of 800 B).
- `idempotencyKey` hashes the request as given: `fromUuids` in place of `data` (designer's call: a retry after a source
  edit replays the first result instead of failing with `IDEMPOTENCY_CONFLICT`). Order: build the copies and strip
  `flags.wiretap`, then the existing `keepId` / idempotency-id / record steps of `prepareCreate`.
- Expected per target kind, written as separate unit cases: world and pack targets clear `_id` (unless `keepId`),
  `folder`, `sort` and `ownership`; an embedded target clears `_id` (unless `keepId`), `sort` and `ownership`, and has
  no `folder` field to clear. The builder confirms each against the Foundry source and records any difference.
- Ack: unchanged (`{uuid, name, type}` per created document, in `fromUuids` order).
- Description gains a short mention of `fromUuids` within 240 chars; the definition stays ≤ 800 B (INFERRED: +60 to
  80 B), measured by `tests/measure/measureContext.mjs` and enforced by the existing CI budget test.

### 2. Content version on `get_document`

- `version`: a short text, the cyrb53 hash (the function behind `requestHash` in `writeIdempotency.js`, moved to a
  shared helper if both use it) of the canonical export the read returns, after the exclusions of `ctx.core.readDocument`
  (redaction included: the agent cannot see a secret, so a change to one does not change the version, and the hash never
  carries information about a secret). With `derived: true` the version hashes the prepared export the read
  returns (owner's decision after the plan review: a stored-only hash would say "unchanged" after a derived value changes
  through another document).
- Stable serialization: keys sorted at every level before hashing, so a reordered but equal export keeps its version.
- Input: the whole export `ctx.core.readDocument` returns (`_stats` and `uuid` included). An update that changes only
  `_stats` counts as a change (designer's call: the safe direction). The handler computes the version and passes it to
  `ctx.shape.compact`, which puts it where `modified` was; `paths` and `fields` results add it in the handler.
- Where it appears: the compact view (replacing `modified`), and the `paths` and `fields` results (`version` beside
  `values` / `fields`). Not in `mode: "full"`: the full result is the export itself and feeds handles and
  `create_documents`.
- New argument `ifChanged: string` (bounded length) replaces `ifModifiedSince`: equal version → `{unchanged: true}`
  (≤ 256 B), otherwise the normal result.
- Embedded documents are part of the parent's export, so an embedded create, update or delete changes the parent's
  version.
- The compact view stays ≤ 2 KB: `version` replaces `modified` (a 16-char text against a 13-digit number, INFERRED
  ≈ +5 B).

### 3. Skill recipes (`skills/wiretap/`)

- Copy: `create_documents({documentName, fromUuids, pack? | parentUuid? })`, one call.
- Build an actor: `create_documents` for the actor with its own items and effects inline in `data`, then
  `create_documents({documentName: 'Item', parentUuid, fromUuids})` for compendium items: two calls where the
  generic-tools path takes five or more.
- Change-only re-read: keep `version`, pass it as `ifChanged`.
- The test that checks every tool name a shipped skill mentions still passes.

## Tests (acceptance)

- Unit: `fromUuids` happy path (world, pack and embedded targets), exactly-one-of refusal, missing source, class
  mismatch, `flags.wiretap` stripped, ownership / folder / `_id` cleared, gates and `dryRun` reached through
  `prepareCreate`; version stability under key reorder, change on embedded create / update / delete, redacted value
  excluded, `ifChanged` equal and unequal, `version` absent from full mode.
- Integration (fake client): a `fromUuids` copy whose 100 KB synthetic source never appears in any MCP message the SDK
  client receives; the build-an-actor recipe counted at two `tools/call` requests.
- e2e on the live titan world (§4.8 teardown, `Wiretap E2E ` prefix): the existing regression test
  `tests/e2e/readTools.spec.js` "ifModifiedSince on a parent sees an embedded update and an embedded create" is
  rewritten to `ifChanged` and also covers an embedded delete; the existing ifModifiedSince assertions in the first read
  test move to `ifChanged`; a copy test: world items copied onto a recorded actor with `fromUuids`, and a world
  document copied into a recorded throwaway world pack.
- Budgets: `create_documents` definition ≤ 800 B and compact view ≤ 2 KB, by the existing CI budget tests.
- Existing tests that use `ifModifiedSince` or `modified` and move to `ifChanged` / `version`: `scriptShape.test.js`
  (≈549-585), `contextBudgetHarness.js` (≈236, 670), `integration/readTools.test.js` (≈137, 147), `getDocument.test.js`
  and `mockDocuments.js`.

## Documentation

- `docs/PLAN.md`: M15a section rewritten to this scope; §2.9 rows for the dropped tools removed and the
  `create_documents` / `get_document` rows updated; the change-only row near line 80 and §4.4's `modified` text
  updated; a new decision row (next free id after D34) recording "gaps only, no composites, no `diff_since`, content
  version". Forward-looking text only.
- `docs/TODO.md`: `diff_since` mode 2 deferral with the numbers above.
- `docs/OPEN_BUGS.md` → `docs/CLOSED_BUGS.md`: the stale `ifModifiedSince` bug once its test passes.
- `README.md` (lines near 138 and 143), `skills/wiretap/SKILL.md`, and the `wiretap-scripts`, `wiretap-writes` and
  `wiretap-build-test` skills to the current state; `docs/PROGRESS.md` gets the M15a as-built notes.

## Left to the builder

- Exact `fromCompendium` steps for embedded targets and for pack targets, cited from the Foundry source.
- The `ifChanged` maximum length and the version's text form (hex or base36), within the 16-char order of size.
- Where the shared hash helper lives.
