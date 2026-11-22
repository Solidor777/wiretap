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
  ownership a create with no `ownership` gets.
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
  `ArrayField` is required with initial `[]`, `common/data/fields.mjs:2289-2297`, `:2329-2333`). `guardWrite`'s
  Adventure macro check is key presence (`writesField(objects, 'macros')`, `writeGuard.js`), so every Adventure copy
  needs `allowMacroExecution`, even one with an empty `macros` set. An Adventure given as `data` with no `macros` key
  does not.

## Idempotency

With `idempotencyKey`, the handler passes `requestData: { fromUuids }`, so the hash is
`[documentName, parentUuid ?? null, keepId, { fromUuids }]`: a retry after the source was edited replays the first
result, and the same key with other `fromUuids` is `IDEMPOTENCY_CONFLICT`.

## Tests

- `tests/unit/writeCopy.test.js`: `copyDataFromUuids` alone (order, `keepId`, the cleared fields for world, pack and
  embedded sources, Adventure content ownership, `compendiumSource`, `flags.wiretap`, no source mutation, every
  refusal).
- `tests/unit/writeCopyCreate.test.js`: `fromUuids` through `create_documents` with the mock world: world, embedded and
  pack copies, the exactly-one-of rule, every refusal writing nothing, a closed gate refused as for `data`, a placed
  source with every gate closed, `dryRun`, idempotency replay after an edit and conflict, `flags.wiretap` with and
  without a key, `keepId` and a taken `_id`, read-back, both Adventure macro cases, the definition bounds.
