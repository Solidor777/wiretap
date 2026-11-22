# `create_documents` copies (`fromUuids`, `writeCopy.js`)

Current-state reference for the copy half of `create_documents`. The argument rule and the handler order are in
`SKILL.md`; this file holds how a copy is built and what refuses it.

## `copyDataFromUuids({ documentName, fromUuids, keepId = false })`

- Returns one plain data object per uuid, in `fromUuids` order (a uuid given twice gives two separate objects). Every
  source is resolved and checked before any copy is built; the module writes nothing.
- Each copy is the source's `toCompendium(null, { clearSort, clearFolder, clearOwnership, clearSource, clearState,
  keepId })`, then:
  - every `ownership` key deleted: of the document and its `hierarchy`, and for an Adventure of each content-set entry
    and its hierarchy, by the `_clearFieldsRecursively` of the entry class `contentFields` names (the content sets are
    SetFields outside the Adventure's hierarchy);
  - `_id` deleted unless `keepId`; `sort` and `folder` deleted again whatever a subclass honoured;
  - `_stats.compendiumSource` set to the source uuid for a source inside a pack, whatever the target;
  - every `flags.wiretap` removed (`stripWiretapFlags` of `writeReplace.js`), so a source's idempotency record never
    passes on, with or without an `idempotencyKey` on the copy call.
- So a source that carries `ownership`, `folder` or `sort` copies with every gate closed, and the copy gets the
  ownership a create with no `ownership` gets: the schema initial (`{ default: 0 }` for most classes) plus the
  creating user as OWNER, which the server's `_preCreate` adds whenever the document has an `ownership` value that
  does not name that user (`dist/database/backend/server-document.mjs`, minified, offset 16411; READ). MEASURED on the
  live world (14.364, `tests/e2e/copyTools.spec.js` log lines): a world copy of a pack Item and a plain GM create with
  no `ownership` both store `{ default: 0, <GM id>: 3 }`, the same as Foundry's world import grants. Embedded copies'
  stored ownership is not measured (Inferred: the server runs the same `_preCreate` for them).
- Built from the raw document, not the redacted read export: secret-named keys copy unchanged, as Foundry's own import
  copies them; every read of the copy is redacted.

## Refusals (all before any create call)

| Case | Code |
|---|---|
| `fromUuids` not an array of 1 to 50 strings | `ARGS_INVALID` "Give 1 to 50 fromUuids." (the schema's `minItems` / `maxItems` refuse first through the tool) |
| `documentName` is `User` | `ARGS_INVALID` "fromUuids does not copy a User; create it from data." |
| A source not found | `DOC_NOT_FOUND` |
| A source of another class | `ARGS_INVALID` naming `fromUuids.<index>` and both class names |
| A source `unreadable` refuses (credential or `wiretap.*` Setting) | that code, `DOC_EXCLUDED` |

`writeCopyCreate.test.js` proves each refusal through `create_documents` leaves the mock world's write calls empty.

## Gates on copies

- A copy meets the gates the same data would: a pack target needs `allowCompendiumWrites` (the same `GATE_DENIED`
  text as for `data`), and so on.
- An Adventure: Foundry's `toObject()` always holds a `macros` key (`common/documents/adventure.mjs:47`, a SetField;
  `ArrayField` is required with initial `[]`, `common/data/fields.mjs:2289-2297`, `:2329-2333`). `guardWrite` asks for
  `allowMacroExecution` only when the `macros` set holds a macro (`writesAdventureMacros`, `writeGuard.js`; see
  `wiretap-write-guard`), so an Adventure copy with an empty `macros` set needs only the gates its target needs
  (`allowCompendiumWrites` for a pack), and one whose set holds a macro is `GATE_DENIED` while the gate is closed.

## Bounds

A copy has no per-call byte bound. `WRITE_DATA_MAX_BYTES` (200,000 B) is checked only on `data` text, by
`checkDataBytes` in `parseDataObjects` (`writeArgs.js`), because it bounds what an agent sends; a copy sends only
uuids (each at most 256 characters), and the cap of 50 `fromUuids` is its bound.

## Idempotency

With `idempotencyKey`, the handler passes `requestData: { fromUuids }`, so the hash is
`[documentName, parentUuid ?? null, keepId, { fromUuids }]`: a retry after the source was edited replays the first
result, and the same key with other `fromUuids` is `IDEMPOTENCY_CONFLICT`.

A keyed retry rebuilds the copies (`copyDataFromUuids`) and judges them before the replay lookup, the same order as the
`data` path: `prepareCreate` runs `refuseUnsafeData`, resolves the target, runs `guardWrite` on the copied data and,
with `keepId`, `refuseTakenIds`, and only then calls `applyIdempotency`. So a retry replays only while every source
still resolves and is readable and its copy passes that guard; otherwise it returns that refusal and writes nothing.
Foundry validation and the second `guardWrite` on the cleaned data run after the lookup, so a replay does not run them
(a replay still runs `checkActAs` against the earlier documents).

## Tests

- `tests/unit/writeCopy.test.js`: `copyDataFromUuids` alone (order, `keepId`, the cleared fields for world, pack and
  embedded sources, Adventure content ownership, `compendiumSource`, `flags.wiretap`, no source mutation, every
  refusal).
- `tests/unit/writeCopyCreate.test.js`: `fromUuids` through `create_documents` with the mock world: world, embedded and
  pack copies, the exactly-one-of rule, every refusal writing nothing, a closed gate refused as for `data`, a placed
  source with every gate closed, `dryRun`, idempotency replay after an edit and conflict, `flags.wiretap` with and
  without a key, `keepId` and a taken `_id`, read-back, both Adventure macro cases, the definition bounds.
- `tests/integration/copyTools.test.js`: the real shipped scripts behind a fake GM through the sidecar and the SDK
  client: a 100 KB copy whose body never reaches the agent, the two-call actor build, a missing source.
