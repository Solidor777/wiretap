# Post-work findings

Living record of issues found during post-work review that deserve attention (gotchas, anomalies). Not a to-do list:
deferred work goes in [`TODO.md`](TODO.md) and defects in [`OPEN_BUGS.md`](OPEN_BUGS.md).

- Title: Folder types without a world collection. Summary: `Folder.create({ type: 'ActiveEffect' })` and `type:
  'Adventure'` succeed on the server but the folder cannot be deleted afterwards (client: `Folders#_onModifyContents`
  reads `game.collections.get(type)`; server: `Folder#_preDelete` reads a collection the world does not have).
  MEASURED in the test world on 2026-10-13: two such folders were retyped to `Item` with `folder.update` and then deleted.
  `tests/e2e/everyType.spec.js` does not create them. Status: Needs review when `create_documents` is built.

- Title: Compact view tuple count under 2 KB. Summary: with synthetic `MOCK_` data (`tests/unit/scriptShape.test.js`) a
  compact view of an actor with 120 embedded items lists all 40 tuples only when item names are short (`i<n>`, 16-character
  ids, beside the fixture's three key leaves). With 18-character names it lists 35 and sets `cut: true`, because the
  2,000-byte budget (`COMPACT_VIEW_MAX_BYTES`) binds before the 40-tuple cap. The cap is therefore a ceiling, not a
  guarantee; the budget is the data-independent bound. Status: Needs review when the per-subtype key-field lists are
  fixed (docs/PLAN.md M4).
