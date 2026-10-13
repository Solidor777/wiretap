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

- Title: `getAllFailures()` is empty for a real failure on Foundry 14.365. Summary: `DataModelValidationError.getAllFailures()`
  returned `{}` for a blank name, a bad image path, a bad sort and an unknown type, while `getFailure()` with no key
  returned the nested root tree (`message`, `fields`, `elements`, `joint`). MEASURED in the live test world through the
  create path (30 documents with an empty name gave 60 failures at `name` and `prototypeToken.name`). The write path
  (`failuresOf` in `src/bridge/scripts/writes.js`) asks `getAllFailures()` first and walks the tree when it is empty.
  Status: Needs review on a Foundry update; the unit mock (`tests/unit/mockWriteWorld.js`) models both behaviours.

- Title: `changed: []` in an `update_documents` ack. Summary: `changed` lists the paths Foundry applied; when a patch
  equals the stored value Foundry applies nothing and the list is empty, which is not an error. A dry run lists the
  planned paths. Status: Documented in the tool description and the skill.

- Title: Code-bearing documents are not gated. Summary: `create_documents` and `update_documents` can create or edit a
  script `Macro` (and other code-bearing data such as HTML in a `JournalEntry` page) with no gate. PLAN section 4.6
  gates only `execute_macro` (`allowMacroExecution`), which is not built; a Macro runs only when a user or a hook
  executes it. `guardWrite` has no rule for the `Macro` class or for `type: 'script'`. Status: Needs owner decision.

- Title: JSON-text arguments. Summary: the argument-schema subset (depth 4, 64 nodes, no free-form object) cannot
  describe a data object, so `data` entries and patch `value`s are JSON text, parsed in the handler with a byte bound.
  Status: Needs review; the alternative is logged in `docs/TODO.md`.
