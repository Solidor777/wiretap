# Open bugs

- [Stale read] `get_document` with `ifModifiedSince` returns `{unchanged:true}` for a parent document whose embedded
  document changed. Foundry 14.364 leaves the parent's `_stats.modifiedTime` unchanged when an embedded Item is
  updated (MEASURED on the live titan world: actor `before` = `after` = 1795310889255, item 1795310889307), and
  `getDocument.js` compares only the parent's stamp. The compact view's `modified` field has the same blind spot.
  Embedded create and delete are not measured yet. Regression test: `tests/e2e/readTools.spec.js`, "ifModifiedSince on
  a parent sees an embedded update and an embedded create" (fails today). Fix in M15a.
- [Ack order] `batch` lists its `created` rows in the order Foundry answers each create operation
  (`acknowledge` in `src/bridge/scripts/writeBatch.js` maps `states[index].documents`), and a batch create is sent
  without ids (`keepId` of the plan). Inferred from READ code: `modifyBatch` reaches the same server `_createDocuments`
  (`dist/database/backend/server-backend.mjs`: the batch handler runs each operation through the per-operation
  handler `modifyDocument` uses; the link between them was not traced line by line), which answers
  documents whose ids it generates in the order its `createNewId` lookups finish. Inferred, not measured live: a batch
  create of two or more documents can list its rows out of entry order, as `create_documents` did before
  `runCreate` sent ids.
