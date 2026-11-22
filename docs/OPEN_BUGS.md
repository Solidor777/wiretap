# Open bugs

- [Flaky test] A default-worker `npm test` fails in `tests/unit/contextBudget.test.js` now and then and passes on a
  rerun; the file passes alone (29/29). Seen at least three times in M15a: with other projects' Playwright load, and
  once with no named load (failure message not captured). Assumed to be timeouts under load; the cause has not been
  measured. Found in M15a.

- [Stale read] `get_document` with `ifModifiedSince` returns `{unchanged:true}` for a parent document whose embedded
  document changed. Foundry 14.364 leaves the parent's `_stats.modifiedTime` unchanged when an embedded Item is
  updated (MEASURED on the live titan world: actor `before` = `after` = 1795310889255, item 1795310889307), and
  `getDocument.js` compares only the parent's stamp. The compact view's `modified` field has the same blind spot.
  Embedded create and delete are not measured yet. Regression test: `tests/e2e/readTools.spec.js`, "ifModifiedSince on
  a parent sees an embedded update and an embedded create" (fails today). Fix in M15a.
