---
name: wiretap-write-guard
description: Wiretap write guard - guardWrite and its gates (allowDelete, allowReplace, user, setting, ownership, file upload, macro and region script code, compendium), the one reader of Foundry update operators (shared/writeKeys.js), the schema-based embedded-field analysis and cleaned-changes backstop (writeFields.js), the write path grammar (shared/docPath.js groupWrites) and the generated operator grid. Use when reading or editing the guard, operators, gates or their tests.
paths:
  - "src/bridge/scripts/writeGuard.js"
  - "src/bridge/scripts/writeFields.js"
  - "shared/writeKeys.js"
  - "shared/docPath.js"
  - "shared/gates.js"
  - "tests/unit/writeGuard.test.js"
  - "tests/unit/writeKeys.test.js"
  - "tests/unit/writeBackstop.test.js"
  - "tests/unit/writeFields.test.js"
  - "tests/unit/writeHardening.test.js"
  - "tests/unit/riskGates.test.js"
  - "tests/unit/macroCommandGate.test.js"
  - "tests/unit/operatorGrid*.js"
  - "tests/unit/mockFoundryData.js"
---

# Wiretap write guard

## Files

| File | Role |
|---|---|
| `src/bridge/scripts/writeGuard.js` | `guardWrite(intent)` and `scanWriteValues(values, { operators })`: the one choke point for the operator rule, the `flags.wiretap` rule, the password rule, the `wiretap.*` Setting deny and the category gates |
| `src/bridge/scripts/writeFields.js` | `reachesEmbedded`, `containsEmbedded` (schema), `cleanChanges`, `analyzeChanges` (operators in cleaned changes), `walkEmbedded` (schema and data), `isOperatorObject`, `isPlainObject`; one `childrenOf` traversal serves the schema walk and the data walk |
| `shared/writeKeys.js` | The only reader of operator spellings (`isOperatorKey`, `splitKey`, `keyNames`, `canonicalKey`, `hasOperatorSegment`, `isOperatorWrapper`) and the constants `FLAGS_KEY`, `FLAG_SCOPE`, `OPERATOR_IDENTIFIER` |
| `shared/docPath.js` | `parsePath`, `groupWrites` (write paths, the `PATH_*` codes including `PATH_OPERATOR`), `findUnsafeValue` |

## Order of the guard

Called through the planners of `writes.js` (also by `replace_document` and `batch`) after arguments and targets are
resolved and before validation or any write. The guard throws `GATE_DENIED` for the first of, in code order (always,
whatever the gates): an operator spelling in written data (`scan.operator`), the `flags.wiretap` scope, a
password-named field or path of a `User`, a `Setting` whose key (from the data, or from the existing document for a
by-id update, normalized by `normalizeSettingKey`) is in the `wiretap.` namespace or cannot be read; then a closed gate
on THIS client: `allowDelete` (`delete`) and `allowReplace` (`replace`) when the intent carries `operations` (or the
cleaned `targets` hold operators on embedded fields) and is not a `dryRun` (see `wiretap-writes`), `allowUserWrites`
(User), `allowSettingWrites` (Setting), `allowModuleConfigWrites` (`core.moduleConfiguration`), `allowFileUpload` (a
base64 data URI anywhere in the values), `allowOwnershipWrites` (an `ownership` key in values or paths),
`allowMacroExecution` (macro or region script code, below; a `dryRun` needs it too), `allowCompendiumWrites` (a
`pack` or a document inside one).

## Macro and region script code (`allowMacroExecution`)

A write that stores code which later runs needs `allowMacroExecution`, the gate of `execute_macro`
(`wiretap-gameplay`), on every write tool (create, update, replace, batch).

- `writesMacroCode(intent)` over the raw `values` and each target's cleaned `changes`; a key counts by its first
  segment (`keyNames(key)[0]`, so a dotted key counts as the field Foundry expands it into):
  - `Macro`: any key writing `command` (any value, any op); or a cleaned change of `type` whose value (operator
    unwrapped by `DataFieldOperator.get`) is `script` on a target whose stored `_source.type` is not `script`. The type
    rule is change-only: re-saving a script Macro's type is allowed. A create's `type: 'script'` with no `command`
    stores the default empty command and is not gated.
  - `Adventure`: any key writing `macros` (importing the adventure creates those Macros).
- `writesRegionScript(intent)`: each create or replace value (with `CONFIG[documentName].documentClass`, no stored
  source) or each target's cleaned changes (with `target.document.constructor` and `_source`) is copied by
  `writtenData` (a `ForcedReplacement` becomes its value, a `ForcedDeletion` becomes null) and walked by
  `walkEmbedded` of `writeFields.js`, which pairs each written embedded document with its stored source by `_id` at any
  nesting: a RegionBehavior itself, a Region's `behaviors`, a Scene's `regions`, an Adventure's stored `scenes`. The
  walk skips an embedded collection element that is not an object (Foundry's validation refuses it after the guard).
  `storesBehaviorScript(data, stored)` is true when the behavior's type after the write is `executeScript` and either
  the stored type is not (created so, or changed to it) or the write puts `system.source`. Change-only like Macros:
  this is Foundry's `MACRO_SCRIPT` rule (`common/documents/region-behavior.mjs`, `region.mjs`) except that Foundry also
  refuses re-stating the type of an existing `executeScript` behavior and Wiretap does not.

## Delete and replace gates (`writeGuard.js`)

`allowDelete` and `allowReplace` are world-scope restricted settings, default closed (`shared/gates.js`,
`lang/en.json`). `guardWrite` takes `operations` (`'delete'`, `'replace'`), `targets` and `dryRun`: the gates are read on
the executing client at call time and a `dryRun` preview needs none. What needs which gate:

- `delete_documents` and the deletes of a batch: `allowDelete` (`prepareDeletes(uuids, actAsUser, dryRun)`).
- `replace_document`: `allowReplace`; also `allowDelete` when the replacement drops embedded DOCUMENTS of any kind and
  depth: collections, a single embedded document, a token `delta` (`droppedEmbedded` in `writeReplace.js` over
  `walkEmbedded` of `writeFields.js`, which pairs live and replacement data through the schema; an embedded data model
  that is not a document is not counted). The ack of a replace that drops carries `dropped: n`, on a dry run too.
- `update_documents` and `batch.updates`: an operator reaches Foundry only through `op` (below). The gate comes from
  the TARGET FIELD TYPE, never from key text: `reachesEmbedded(documentClass, source, names)` resolves the path with
  `schema.getField` one prefix at a time, follows an element id into the schema of a collection's documents and a single
  embedded document into its own schema, and answers true when the path is, holds or addresses an element of an
  `EmbeddedCollectionField` (also `EmbeddedCollectionDeltaField`) or an `EmbeddedDataField` (also `EmbeddedDocumentField`,
  the token `delta`). A path below a system data model whose document type is unknown fails closed. Then `op: 'replace'`
  needs `allowReplace` and `allowDelete`, and `op: 'delete'` needs `allowDelete`; `set` needs none.
- A path on a top-level collection or element (`items`, `items.<id>`) is `PATH_INVALID`. Nested ones are reachable and
  gated: `items.<id>.effects`, `tokens.<id>.delta`, `tokens.<id>.delta.items`, `system.<embedded model>`.
- `create_documents` and `batch` creates never need these gates, but `keepId` is refused when the `_id` exists
  (`refuseTakenIds`, `ARGS_INVALID`): MEASURED on 14.364, the server overwrites the stored document, world and embedded,
  while the client keeps its old copy.

No definition declares `gate` (that check would stop previews and cannot cover `batch`). The grid
(`operatorGrid.test.js` with `operatorGridCases.js`) generates its cases from the field schemas of the mock world (each
embedded field of every depth x set / replace / delete x explicit `op` / key prefix / wrapper x gates closed, each one
open, all open x `update_documents`, `batch` updates, `replace_document`, `create_documents`, `batch` creates), with a
fresh mock world per cell; `riskGates.test.js` runs each risky script closed, dry and open and fails when a mutating
script with a risky verb in its name, or `batch`, has no entry.

## Operators (`shared/writeKeys.js`, `writeFields.js`, `writeGuard.js`)

Foundry spells one operator three ways, all with the same effect (MEASURED on 14.364, see the e2e `records how Foundry
treats every spelling of an operator`): a key prefix `==name` / `-=name` per segment (`isDeletionKey`), an operator
object (`ForcedReplacement`, `ForcedDeletion`) and a serialized `{"__$OPERATOR$__": ...}` object (an unknown identifier
is dropped). Wiretap reads all three through ONE module, `writeKeys.js` (`isOperatorKey`, `splitKey`, `keyNames`,
`canonicalKey`, `hasOperatorSegment`, `isOperatorWrapper`), and lets an operator exist only through the explicit `op`
field of an update patch (`changeValue` in `writes.js` builds the real operator objects).

- A path segment with an operator prefix, and a key, wrapper or operator object anywhere in a patch value, create data or
  replace data, is refused with `PATH_OPERATOR` (`groupWrites`, `refuseUnsafeData`), before any gate and whatever the
  gates and `dryRun`. Prefixed names are read canonically everywhere: `==__proto__` is `__proto__`.
- Backstop: `cleanChanges` runs `documentClass.cleanData(changes, { partial, migrate, sanitize }, { creation: false,
  model, source })` as the database backend does, `guardUpdate` hands the cleaned changes to `guardWrite` as `targets`,
  and `analyzeChanges` walks them for operator objects: an operator at a path that reaches embedded documents adds the
  gates above, an operator at `flags` or in `flags.wiretap` (and a `flags` value that is not an object) is refused. A
  create judges its cleaned data again, where any operator object is refused (`GATE_DENIED`). Cleaning fills defaults
  inside an operator value, so `guardWrite` reads the cleaned changes twice with `scanWriteValues(values, { operators })`:
  `'descend'` for the flag scope (it can hide in an operator value) and `'skip'` for ownership, password and data URI
  keys; `'refuse'` (raw values) flags any operator. The raw values and each patch as the dotted-key object it writes
  are judged too.
- `hasOperatorSegment` is true for a prefixed segment AND for a segment equal to `__$OPERATOR$__`: Foundry expands a
  dotted key before it rebuilds operators, so `flags.__$OPERATOR$__` with `flags.value` is the wrapper (MEASURED: it
  erases flags and embedded collections), hence `PATH_OPERATOR` in paths, value keys, create data and batch.
- One traversal, `childrenOf(field, type)` in `writeFields.js`, serves `containsEmbedded` (schema only, depth fails
  closed to true) and `walkEmbedded` (schema and data; throws `ARGS_INVALID` past `DEPTH_MAX`); it covers schema fields,
  the system data model, `TypedSchemaField`, `ArrayField` and `TypedObjectField`.
- A Setting is judged by the key it LEAVES: the existing key and the key of the cleaned change with an operator unwrapped.

## Guard rules (`writeGuard.js`, `shared/docPath.js`)

- `_id` is never a path segment, at document level or as `names[2]` of an embedded path (`PATH_UNSAFE_SEGMENT`, from
  `groupWrites`).
- The `flags.wiretap` scope is `GATE_DENIED` in data values, dotted paths, a `flags` value that is not a plain object,
  and an op `replace` / `delete` on `flags` or on the scope (`analyzeChanges`). MEASURED on 14.364 that `==flags` erases
  all flags (also embedded), a bare `-=flags` and `flags: null` do nothing. Only this module writes the record, after
  the guard.

## Tests

Unit over `mockFoundryData.js` (faithful `DataFieldOperator` classes, the cleaning of operator keys and wrappers,
`foundry.data.fields` classes and a field schema per mock class, including a Scene that embeds Token with an ActorDelta
and a Setting with no flags, ownership or type) and `mockWriteWorld.js`: `writeGuard`, `riskGates`, `writeHardening`,
`writeKeys`, `writeFields` (one traversal for `containsEmbedded` and `walkEmbedded`, the `idempotencyKey` refusal on a
class with no flags), `writeBackstop` (guard-level and `analyzeChanges` cases, the create backstop, the cleaned-changes
scan outside operator values), `macroCommandGate` (Macro command, type, Adventure macros and region script behaviors
at every nesting, through create, update, replace and batch, gate closed, dry run and open; the writes that store no
code), and `operatorGrid` over `operatorGridCases.js`: every write tool against every operator
representation, including the dotted wrapper segment, on a fresh world per cell. e2e `tests/e2e/writeTools.spec.js`
records how Foundry treats every operator spelling (the representation table in `docs/POST_WORK_FINDINGS.md`).
