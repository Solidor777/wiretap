# Open bugs

- [Stale read] `get_document` with `ifModifiedSince` returns `{unchanged:true}` for a parent document whose embedded
  document changed. Foundry 14.364 leaves the parent's `_stats.modifiedTime` unchanged when an embedded Item is
  updated (MEASURED on the live titan world: actor `before` = `after` = 1795310889255, item 1795310889307), and
  `getDocument.js` compares only the parent's stamp. The compact view's `modified` field has the same blind spot.
  Embedded create and delete are not measured yet. Regression test: `tests/e2e/readTools.spec.js`, "ifModifiedSince on
  a parent sees an embedded update and an embedded create" (fails today). Fix in M15a.
- [Wrong comment] The header of `src/bridge/scripts/writeCopy.js` says a create whose data holds no `ownership` gets
  the schema initial `{ default: NONE }` and that this is where a copy differs from Foundry's world import, which grants
  the importing user OWNER. On the live titan world (14.364) a world Item created by the GM from data with no
  `ownership`, and a world copy made by `fromUuids` from a pack document, both store
  `{ default: 0, <GM user id>: 3 }` (MEASURED by `tests/e2e/copyTools.spec.js`, its log lines). READ: the Foundry
  server's `_preCreate` (`dist/database/backend/server-document.mjs`) adds `ownership.<creating user id> = OWNER` when
  the document has an `ownership` field and the user is not in it. The copy's ownership does equal that of a plain
  create with no `ownership`, so the gate behaviour holds; the comment, `references/copies.md` and the brief's "class
  defaults" assertion for `ownership` are wrong. Embedded copies' stored ownership is not measured yet.
- [Ack order] `batch` lists its `created` rows in the order Foundry answers each create operation
  (`acknowledge` in `src/bridge/scripts/writeBatch.js` maps `states[index].documents`), and a batch create is sent
  without ids (`keepId` of the plan). Inferred from READ code: `modifyBatch` reaches the same server `_createDocuments`
  (`dist/database/backend/server-backend.mjs`: the batch handler runs each operation through the per-operation
  handler `modifyDocument` uses; the link between them was not traced line by line), which answers
  documents whose ids it generates in the order its `createNewId` lookups finish. Inferred, not measured live: a batch
  create of two or more documents can list its rows out of entry order, as `create_documents` did before
  `runCreate` sent ids.
