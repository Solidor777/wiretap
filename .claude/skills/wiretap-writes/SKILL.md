---
name: wiretap-writes
description: Wiretap create_documents, update_documents, delete_documents, replace_document, batch, advisory actAs, create_documents idempotencyKey, handle inputs, strict arguments and the _id / flags.wiretap guard rules (phase B of the core write tools); the Foundry semantics they mirror, their codes and tests. Use when reading or editing the write scripts, replace, batch, actAs, idempotency or handle-input code or their tests. The base write guard and operators are in wiretap-write-guard.
paths:
  - "src/bridge/scripts/writeReplace.js"
  - "src/bridge/scripts/writeBatch.js"
  - "src/bridge/scripts/writeBatchSettle.js"
  - "src/bridge/scripts/writeActAs.js"
  - "src/bridge/scripts/writeIdempotency.js"
  - "src/bridge/scripts/replaceDocument.js"
  - "src/bridge/scripts/batch.js"
  - "src/bridge/scripts/writes.js"
  - "src/bridge/scripts/createDocuments.js"
  - "src/bridge/scripts/updateDocuments.js"
  - "src/bridge/scripts/deleteDocuments.js"
  - "src/bridge/scripts/writeArgs.js"
  - "src/bridge/scripts/writeAck.js"
  - "tests/unit/write*.test.js"
  - "tests/unit/mockWriteWorld.js"
  - "tests/e2e/writeTools.spec.js"
  - "tests/e2e/writeHelpers.js"
  - "server/handleInput.ts"
  - "tests/unit/writeReplace*.test.js"
  - "tests/unit/writeBatch*.test.js"
  - "tests/unit/writeActAs.test.js"
  - "tests/unit/writeIdempotency*.test.js"
  - "tests/unit/writePhaseB.test.js"
  - "tests/unit/handleInput.test.js"
  - "tests/unit/writeKeepId.test.js"
  - "tests/unit/batchHandler.test.js"
  - "tests/integration/writeToolsB.test.js"
---

# Wiretap phase B write tools

Covers the phase A scripts (`create_documents`, `update_documents`, `delete_documents`) and the phase B tools; the guard is in `wiretap-write-guard`. Fourteen shipped
scripts in all; `replace_document` lists at 562 B and `batch` at 795 B (800 B raw-definition limit, MEASURED by
`tests/measure/measureContext.mjs`). Foundry version read and measured: 14.364 (`game.version`).

## Files

| File | Role |
|---|---|
| `src/bridge/scripts/writes.js` | `createDocuments`, `updateDocuments`, `deleteDocuments` and the planners `prepareCreate`, `prepareUpdates`, `prepareDeletes` that `batch` and `replace_document` reuse; the guard calls, validation (`failuresOf`), `refuseTakenIds`, `refuseUnsafeData` |
| `src/bridge/scripts/createDocuments.js`, `updateDocuments.js`, `deleteDocuments.js` | Handlers of the phase A scripts (`updateDocuments.js` groups patch entries by uuid) |
| `src/bridge/scripts/writeArgs.js`, `writeAck.js` | Argument helpers (`parseDataObjects`, `parseJson`, `checkDataBytes`) and ack shaping |
| `src/bridge/scripts/writeReplace.js`, `replaceDocument.js` | `replace_document` and its handler; `droppedEmbedded`, the carry of `flags.wiretap` |
| `src/bridge/scripts/writeBatch.js`, `writeBatchSettle.js`, `batch.js` | `batch`: planning, `modifyBatch`, settle and repair |
| `src/bridge/scripts/writeActAs.js`, `writeIdempotency.js` | `actAs` check and the `create_documents` idempotency record |
| `server/handleInput.ts` | Handle inputs, resolved by the sidecar before `bridge:invoke` |
| Guard files | `writeGuard.js`, `writeFields.js`, `shared/writeKeys.js`: see `wiretap-write-guard` |

## Phase A write scripts

`create_documents`, `update_documents` and `delete_documents` (and the phase B tools, listed in `wiretap-writes`): `mutates: true`, `requires: 'api'`, no declared gate (one
gate cannot cover them; the handlers enforce per category, see below), `result.budgetBytes` = `ACK_BATCH_MAX_BYTES`
(4000). Listed 640 B, 709 B and 381 B (MEASURED by `tests/measure/measureContext.mjs`). Every argument is a flat
schema: the subset has no free-form object, so a data object or a patch value travels as JSON text (`parseDataObjects`,
`parseJson` in `writeArgs.js`; the text is bounded by `SCHEMA_BOUND_MAX` per item and `WRITE_DATA_MAX_BYTES` (200,000)
per call; a parse failure is `ARGS_INVALID` naming the index).

- `create_documents({ documentName, data[1..50], parentUuid?, pack?, keepId?, dryRun?, paths? })`: `data` is one JSON
  object text per document. `parentUuid` creates embedded documents (`createEmbeddedDocuments`); `pack` creates in a
  compendium (`documentClass.createDocuments(.., { pack })`); neither creates in the world. Result: one
  `{ uuid, name, type }` per document (a dry run has `uuid: null` and `dryRun: true`), shaped by `writeAck.js`
  `ackDocuments`. `paths` adds a read-back of those paths per created document (`attachReadback`;
  `checkReadbackPaths` bounds them).
- `update_documents({ updates[1..200], dryRun?, paths? })`: each entry is one patch `{ uuid, path, value?, op? }`;
  entries with one `uuid` form that document's update. `value` is JSON text; `op` is `set` (default), `replace`
  (Foundry's `ForcedReplacement`) or `delete` (`ForcedDeletion`; takes no `value`); `op` is the only way to an operator
  (a `==` / `-=` prefix or a `__$OPERATOR$__` object is `PATH_OPERATOR`; see `wiretap-writes`).
  Paths below an embedded collection (`items.<id>.system.x`) are grouped into one `updateEmbeddedDocuments` call per
  collection (`groupWrites` of `shared/docPath.js`); a wildcard, an unsafe segment or conflicting paths are `PATH_*`
  errors. Result per document: `{ uuid, changed[] }`; `changed` lists the paths Foundry applied (empty when Foundry
  changed nothing; a dry run lists the planned paths and adds `dryRun: true`).
- `delete_documents({ uuids[1..50], dryRun? })`: deletes through `deleteDocuments` / `deleteEmbeddedDocuments`. A dry
  run returns `{ dryRun: true, rows: [uuid, name, type][], total, cut? }` with the embedded cascade, at most
  `DELETE_PREVIEW_ROWS_MAX` (500) rows and the default result cap; nothing is deleted. A compendium pack itself, the
  signed-in user and the last game master are `DELETE_REFUSED`. Deleting needs the `allowDelete` gate (`wiretap-write-guard`);
  the description says it is irreversible and the README gives the Claude Code `ask` rule.

Write path (`writes.js`): arguments checked and targets resolved, `guardWrite` (`wiretap-write-guard`), Foundry validation without writing, `dryRun` stops, then the Foundry document API runs. Validation uses `cleanData` and `validate({ changes, strict })` and collects failures with
`failuresOf`: `getAllFailures()` first, and the failure tree of `getFailure()` when it is empty (on Foundry 14.364
`getAllFailures()` returns `{}` for a real failure). `ScriptError.details = { failures, failureCount }` is acked by the
bridge (at most 10 failures, path and message bounded) and `formatBridgeError` prints them in 512 B.
- Phase B (`replace_document`, `batch`, `actAs` on all write tools, `idempotencyKey` on `create_documents`, the
  `flags.wiretap` scope and `_id` paths refused by `guardWrite` / `groupWrites`, handle inputs) is in `wiretap-writes`;
  its codes are `ACT_AS_DENIED`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_UNAVAILABLE` and `HANDLE_NOT_DOCUMENT`. A definition
  may carry `handleArgs` (validated by `validateScriptDefinition`, not listed).
- Codes: `ARGS_INVALID`, `DOC_NOT_FOUND`, `GATE_DENIED`, `VALIDATION_FAILED` (one error for the whole call, nothing
  written), `DELETE_REFUSED`, `WRITE_NOT_APPLIED` (Foundry accepted the call but a hook or the system cancelled it), and
  the `PATH_*` codes of the read scripts.
- Details: a Setting is judged by its `key` text alone (`settingKeyOf`; a `namespace` is never read, Foundry prunes it);
  data keys and path segments are split on `.` by `keyNames` of `shared/writeKeys.js` (Foundry expands dotted keys) before
  the `ownership` test; `findUnsafeValue` refuses any dotted segment (an operator prefix read away) that is an
  `UNSAFE_SEGMENTS` entry or an `Object.prototype` name, and reports an operator key or wrapper as `'operator'`. `resolveWritable` refuses a compendium pack uuid and a non-document (update and
  delete); an update refuses a document written twice, counted by canonical uuid with embedded documents included.
  Created names are cleaned (`cleanForLog`, 128 B). A row with read-back stays within `ACK_MAX_BYTES` (`cut: true`).
- A write across several documents is not atomic once Foundry starts it: an update that fails after earlier ones
  applied is `WRITE_NOT_APPLIED` and names how many and which uuids were applied.

## Strict arguments

Definitions carry `additionalProperties: false` at the root; both validators REJECT an undeclared argument (client
`shared/schemaValidate.js`, sidecar zod `.strict()` via `argumentSchema` in `server/toolRegistry.ts`); the client's
`listedNode` emits that keyword so both sides measure the same bytes. A handler never sees an undeclared key inside an
entry (the sidecar's zod parse and the client's validated copy both drop it), so `batch` sets the definition flag
`strictNested: true`: every object below the root refuses an undeclared key on both validators, and the listed schema
omits the nested `additionalProperties` (strict entries would list at 880 B, plus `required` 915 B, plus an `op` enum
and `maxLength` about 70 B more, over 800 B). The flag is validated in `shared/scripts.js`, part of `schemaSignature`,
and the sidecar's zod objects are `.strict()` with the JSON key overridden to `undefined`. Tests: `batchHandler.test.js`,
`schemaValidate.test.js`, `schemaStrict.test.js`, `writeToolsB.test.js` ("undeclared keys in batch entries").

## replace_document (`writeReplace.js`, handler `replaceDocument.js`)

`replace_document({ uuid, data, dryRun?, actAs?, paths? })`, `data` one JSON object text. Mirrors
`ClientDocument#importFromJSON` (`client-document.mjs`): `Document.fromImport` (strict), `toObject`, the
`WorldCollection#fromCompendium` steps, drop `metadata.preserveOnImport` (`_id`, `sort`, `ownership`, `folder`), then
`update(data, { diff: false, recursive: false })` WITH hooks (the core import passes `noHook: true`).

- Every omitted top-level field resets to its default (MEASURED): omitted `items` / `effects` empty the collections,
  omitted `flags` wipes other modules' flags. Intended input is a full `get_document` read with a change.
- `_stats.coreVersion` is always `game.version`. Only `DataModelValidationError` becomes `VALIDATION_FAILED`.
- Primary classes only (`ARGS_INVALID`); `User` is refused (`ARGS_INVALID`, use `update_documents`).
- Flow: strip incoming `flags.wiretap`, `guardWrite` the given data, build the replacement, `guardWrite` the
  replacement, carry the live `flags.wiretap` over, `checkActAs`. A raw `ownership` key (also inside embedded items)
  needs `allowOwnershipWrites` or must be removed first.
- An update that resolves with nothing is `WRITE_NOT_APPLIED`. Ack `{ uuid, changed[] }`; `dryRun` stops before the update.

## batch (`writeBatch.js`, `writeBatchSettle.js`, handler `batch.js`)

`batch({ creates?, updates?, deletes?, dryRun?, actAs? })`: flat entries. Sub-operations are planned by
`prepareCreate`, `prepareUpdates`, `prepareDeletes` (one `checkDataBytes` total over creates and updates), so each
passes `guardWrite`, validation and `actAs` before anything is sent. Order: creates, updates, deletes; no reference to a
document an earlier operation creates; `checkConflicts` refuses update/delete on one document. `buildOperations`
builds updates as `{ ...changes, _id }`.

Sent with `foundry.documents.modifyBatch`. Behaviour READ in the 14.364 tree (`server-backend.mjs`, batch handler `#r`;
the 14.369 tree names it `#a`: cite behaviour, not the name): the client drops cancelled entries and no-op updates
(an operation with nothing left is not sent); the server validates all first and writes nothing on a validation error
but still returns dry-run echoes of the passing requests (the client treats them as real: ghost creates, phantom
deletes); it then applies one by one and stops at the first failure, NO rollback. Errors surface only as notifications.

`settle` matches results to operations by document id, the parent of the result (`SettleEntry.parent`, kept because
Foundry deletes `operation.parent` while sending) and, for a create, ids no other sent operation touches (states
applied, unchanged, partial, cancelled, failed, echo);
`confirmAfterFailure` asks the server (`database.get` with `_id` equality per id; `$in` returns nothing, MEASURED),
removes ghost creates and restores phantom deletes; `incomplete` throws `WRITE_NOT_APPLIED` ("N of M operations
applied, X unchanged, Y partly cancelled by a hook, Z cancelled by a hook, W failed, V not written; the batch is not
atomic", <= 256 B). Unchanged or cancelled updates ack `changed: []`; in an embedded update group with several entries, an entry Foundry dropped (unchanged or hook-cancelled) simply has no paths in the ack and the batch raises no error, an update is never `partial` (tested in `writeBatchStrict.test.js`). Compendium pack operations cannot be re-checked.

## actAs (`writeActAs.js`)

Best-effort advisory (D7). After `guardWrite`, `Document#canUserModify(user, action, expandObject(data))` for the named
user on every target; a refusal is `ACT_AS_DENIED` (<= 256 B), nothing written. The write runs as the GM client, so
`actAs` only adds refusals. Unknown user: `ARGS_INVALID`.

## Idempotency (`writeIdempotency.js`), create_documents only

`idempotencyKey` (`/^[A-Za-z0-9._:-]{1,64}$/`) stored per created document as `flags.wiretap.idem = { k, i, n, h, u, d }`
(key, index, count, `requestHash` cyrb53, writing user id, carrying document id). Documents are created with
client-chosen ids (`keepId`). A record counts only when `u` is this client's user and `d` is its document id. Complete
records with the same hash replay (honouring `dryRun`, `actAs`, read-back); another hash is `IDEMPOTENCY_CONFLICT`
("different request"), an incomplete set (hook-cancelled or deleted document) is `IDEMPOTENCY_CONFLICT` naming "k of n
documents" and the remedy (a new key); the missing documents are never created behind the caller's back. The lookup reads at most `IDEMPOTENCY_SCAN_MAX` (20,000) documents, beyond that
`IDEMPOTENCY_UNAVAILABLE`. `withKeyLock` serializes calls per class, parent and key. Retention 24 h by
`_stats.createdTime`. A class with no `flags` field (Setting) cannot carry the record: `prepareCreate` refuses an
`idempotencyKey` there with `ARGS_INVALID`, as it does for a pack.

## Delete and replace gates, operators, guard rules

In `wiretap-write-guard`.

## Handle inputs (`server/handleInput.ts`, `server/handles.ts`, `server/mcp.ts`)

A definition's optional `handleArgs` (1 to 4 names of declared string or string-array arguments; validated in
`shared/scripts.js`; part of the registry signature, not of the listed schema) marks `create_documents.data` and
`replace_document.data`. `makeRegistryToolHandler` calls `resolveHandleArgs` BEFORE `bridge:invoke`: a text equal to
`handle:<22-char id>` becomes the stored text, so the client's gate checks run after resolution and `guardWrite` still
judges the resolved content. `HandleStore.read(ownerKey, handle, maxBytes)` returns the whole entry or
`HANDLE_NOT_FOUND` (unknown, expired or another session's) / `HANDLE_TOO_LARGE`. Stored shape: the JSON text of ONE
document; otherwise `HANDLE_NOT_DOCUMENT`. Bounds: 100,000 B per text, `WRITE_DATA_MAX_BYTES` (200,000) in total.
Messages never carry stored text. Client scripts are unchanged.

## Codes

New: `ACT_AS_DENIED`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_UNAVAILABLE`, `HANDLE_NOT_DOCUMENT` (client / sidecar),
`HANDLE_NOT_FOUND`, `HANDLE_TOO_LARGE` (sidecar). Reused: `WRITE_NOT_APPLIED`, `GATE_DENIED`, `PATH_UNSAFE_SEGMENT`,
`VALIDATION_FAILED`, `ARGS_INVALID`.

## Not built

Idempotency for `batch` and `replace_document`; embedded replace; `pack` and `keepId` in batch creates; schema-level
strict batch entries (800 B limit).

## Tests

Unit over `mockWriteWorld.js` (its `MockValidationError` reproduces the 14.364 behaviour of an empty
`getAllFailures()`) and `mockFoundryData.js` (see `wiretap-write-guard`; models Foundry's operation preprocessing, `world.batch.failure = { index, phase }`,
`world.cancel.{updateIds,deleteIds,createNames}`, `_id`-equality `database.get`, a server copy, `fromImport`,
`canUserModify`): `writeCreate`, `writeUpdate`, `writeDelete`, `writeScripts`, `writeReplace*`, `writeBatch*`,
`writeActAs`, `writeIdempotency*`, `writePhaseB`, `handleInput`, plus handle cases in `handles.test.js`. Integration `writeToolsB.test.js` (sidecar with a fake client,
including handle inputs). e2e `tests/e2e/writeTools.spec.js` (live world, throwaway `Wiretap E2E ` documents):
replace with a `preUpdateActor` hook and omitted-field reset, batches with unchanged / hook-cancelled middle operations,
ghost / phantom repair, embedded and parentUuid batches, idempotent and concurrent creates, handle create / replace,
`_id` and flags refusals, `actAs` denial with a throwaway player, the gates of a throwaway scene's token delta, and one
test that records how Foundry treats every operator spelling (the representation table in
`docs/POST_WORK_FINDINGS.md`).
