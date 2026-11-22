# Open bugs

- [Stale read] `get_document` with `ifModifiedSince` returns `{unchanged:true}` for a parent document whose embedded
  document changed. Foundry 14.364 leaves the parent's `_stats.modifiedTime` unchanged when an embedded Item is
  updated (MEASURED on the live titan world: actor `before` = `after` = 1795310889255, item 1795310889307), and
  `getDocument.js` compares only the parent's stamp. The compact view's `modified` field has the same blind spot.
  Embedded create and delete are not measured yet. Regression test: `tests/e2e/readTools.spec.js`, "ifModifiedSince on
  a parent sees an embedded update and an embedded create" (fails today). Fix in M15a.
