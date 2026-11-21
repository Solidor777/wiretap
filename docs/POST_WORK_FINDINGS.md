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

- Title: `getAllFailures()` is empty for a real failure on Foundry 14.364. Summary: `DataModelValidationError.getAllFailures()`
  returned `{}` for a blank name, a bad image path, a bad sort and an unknown type, while `getFailure()` with no key
  returned the nested root tree (`message`, `fields`, `elements`, `joint`). MEASURED in the live test world through the
  create path (30 documents with an empty name gave 60 failures at `name` and `prototypeToken.name`). The write path
  (`failuresOf` in `src/bridge/scripts/writes.js`) asks `getAllFailures()` first and walks the tree when it is empty.
  Status: Needs review on a Foundry update; the unit mock (`tests/unit/mockWriteWorld.js`) models both behaviours.

- Title: `changed: []` in an `update_documents` ack. Summary: `changed` lists the paths Foundry applied; when a patch
  equals the stored value Foundry applies nothing and the list is empty, which is not an error. A dry run lists the
  planned paths. Status: Documented in the tool description and the skill.

- Title: Code-bearing documents. Summary: a write tool could store code that runs later (a script `Macro`, a script
  region behavior) with no gate. Status: Resolved by owner decision (2026-11-20): `guardWrite` needs
  `allowMacroExecution`, the gate of `execute_macro`, for a Macro `command`, a Macro `type` changed to `script`, an
  Adventure's stored `macros` and an `executeScript` region behavior at any nesting (change-only type rules). Other
  code-bearing data, such as HTML in a `JournalEntry` page, stays ungated; no decision covers it.

- Title: JSON-text arguments. Summary: the argument-schema subset (depth 4, 64 nodes, no free-form object) cannot
  describe a data object, so `data` entries and patch `value`s are JSON text, parsed in the handler with a byte bound.
  Status: Needs review; the alternative is logged in `docs/TODO.md`.

- Title: `modifyBatch` is not atomic, hides failures and echoes dry runs. Summary: the `foundry.documents.modifyBatch` doc
  comment describes an atomic batch. READ in the Foundry 14.364 tree (`server-backend.mjs`, batch handler `#r`; the 14.369
  tree names it `#a`): the client drops cancelled entries and no-op updates; the server validates every operation first and
  writes nothing on a validation error but still answers with dry-run echoes of the requests that passed, which the client
  handles as real (a ghost create, a phantom delete); it then applies them one by one and stops at the first failure
  without a rollback. The client backend shows errors as notifications and resolves with the answered requests only.
  MEASURED live: the ghost create and the phantom delete appear after a failed validation pass; `batch` removes the ghost
  and restores the document (`writeBatchSettle.js`). Status: Handled and documented; compendium packs are not re-checked.

- Title: The server matches `_id` queries by equality only. Summary: MEASURED on 14.364, `database.get` with
  `{ _id: { $in: [...] } }` returns nothing; one `_id` equality query per id works, and a parent query returns all
  children. Status: Handled in `writeBatchSettle.js`; relevant to any future bulk read by id.

- Title: Replace resets omitted fields. Summary: MEASURED on 14.364, `replace_document` (import, then update with
  `diff: false, recursive: false`) resets every omitted top-level field to its default: omitted `items` and `effects`
  empty the collections and omitted `flags` wipes all modules' flags. Status: Documented in the tool text, the skills and
  the README; the module's own `flags.wiretap` scope is carried over.

- Title: Replace needs `ownership` left out. Summary: `replace_document` judges the raw data with `guardWrite`, which
  treats any `ownership` key (also inside embedded items) as an ownership write, while Foundry's import drops it anyway.
  A full `toObject()` therefore needs `allowOwnershipWrites` unless the caller removes `ownership` first. MEASURED by
  the e2e. Status: Documented in the skill; needs review if the guard should ignore preserved fields.

- Title: Foundry removes `operation.parent` while it sends a batch operation. Summary: READ in the 14.364 tree
  (`client-backend.mjs`, `#buildRequest`): the request builder sets `operation.parentUuid` and deletes `operation.parent`,
  so code that reads the parent of an operation after `modifyBatch` sees none. `batch` keeps the parent on its own
  settle entry. Status: Handled; the unit mock now removes the key as Foundry does.

- Title: Operator keys in updates. Summary: MEASURED on 14.364 by the e2e: an update with `{'==flags': {}}` erases all flags
  of an Actor and of an embedded Item (other modules' flags included), `{'-=flags': null}` changes nothing, and
  `flags.-=<scope>` removes one scope. The v14 source marks both operator keys as deprecated legacy syntax
  (`_migrateDeletionKey` in `common/utils/helpers.mjs`). Status: Superseded by "Three spellings of one operator" below:
  the tools refuse every operator spelling in a key, path or value and accept an operator only through `op`.

- Title: `keepId` overwrites an existing document. Summary: MEASURED on 14.364 by the e2e probe: creating with `keepId`
  and the `_id` of an existing document, world or embedded, does not fail; the server stores the new data under that id
  (the old document is gone) while the client keeps its old embedded copy. Status: `create_documents` refuses a `keepId`
  that is taken (`ARGS_INVALID`); a pack is checked through its index.

- Title: Operator keys remove embedded documents. Summary: MEASURED on 14.364: `{'==items': []}` removes every item of an
  Actor, and `items.<id>.==effects` removes the effects of an item; `-=items` is a no-op. Status: Superseded by "Three
  spellings of one operator" below; the gates now follow the field type.

- Title: Three spellings of one operator. Summary: Foundry reaches the same operator three ways: a key prefix (`==name`,
  `-=name`, `isDeletionKey` in `common/utils/helpers.mjs`, applied per segment after a dotted key is expanded), an
  operator object (`ForcedReplacement`, `ForcedDeletion`) and a serialized `{"__$OPERATOR$__": ...}` object that
  `SchemaField.reconstructOperator` rebuilds (an unknown identifier is dropped). MEASURED on 14.364 (e2e
  `records how Foundry treats every spelling of an operator`): all three erase flags and remove embedded documents the same
  way (`items`, an item's `effects`, a Scene's `tokens` by `==tokens`); a plain array or `null` has no effect; a bare
  `-=items` and a `ForcedDeletion` on `items` do nothing; `-=items.<id>` errors; an unknown wrapper is dropped. On the
  create side `==flags` and a `flags` wrapper replace the flags, and `-=flags` is refused by Foundry. Status: Handled
  by one reader (`shared/writeKeys.js`), explicit `op` as the only way to an operator, gates derived from the schema
  field (`writeFields.js`) and a backstop over the cleaned changes (see the `wiretap-writes` skill). Owner-visible
  consequences: a path or value with an operator prefix or a wrapper is refused (`PATH_OPERATOR`) in every tool; an op
  `replace` or `delete` on an embedded data model (an `EmbeddedDataField`, for example a system model) is gated too,
  although it removes no documents, because the field type is the rule; `replace_document` counts only embedded
  DOCUMENTS as dropped.

- Title: A wrapper in create data can corrupt the world. Summary: MEASURED on 14.364 while probing: `Actor.create` with
  `name` set to a `__$OPERATOR$__` wrapper stored the wrapper object itself as the name, and the next world load threw
  in `Actors.initializeTree` (`localeCompare is not a function`), so `game.ready` never became true and every login
  timed out until that actor was deleted through a server-side repair. Status: create data with a wrapper or an operator
  key is refused before any write; never probe malformed create values on the shared test world.

- Title: Cleaning fills defaults inside an operator value. Summary: an op `replace` of a whole document field is cleaned
  with the defaults of that field's schema (a replaced token `delta` gains `ownership`), so scanning the cleaned changes
  inside an operator value for ownership, password or data URI keys would demand gates the caller never asked for.
  Status: the guard reads the cleaned changes twice (`scanWriteValues` option `operators`): the reserved flag scope
  THROUGH operator values (`'descend'`, where it can hide), and ownership, password and data URI keys OUTSIDE them
  (`'skip'`, so a path such as `ownership.default` or a data URI that survives cleaning is judged on what the database
  receives). The raw values and the patch paths are still judged as written.

- Title: The operator identifier as a dotted path segment. Summary: Foundry expands a dotted key into nested objects
  before it rebuilds operators, so `flags.__$OPERATOR$__` with a sibling `flags.value` becomes the wrapper
  `flags: { __$OPERATOR$__, value }`; no front layer refused the dotted spelling. MEASURED on 14.364 (e2e `records how
  Foundry treats every spelling of an operator`): the dotted wrapper on `flags` erased the flags; on `items` it left 0
  items; on an item's `effects` it removed the effects. The plain forms are harmless (MEASURED): `item.update({
  ['effects.<id>']: null })`, `item.update({ effects: { <id>: null } })`, and an unlinked token `delta` merge containing
  `items` (`{ delta: { items: [] } }` and `{ 'delta.items': [] }`) changed nothing. Status: `hasOperatorSegment` treats a
  segment equal to `OPERATOR_IDENTIFIER` as an operator spelling in every consumer, so it is `PATH_OPERATOR` in paths,
  nested value keys, create data keys and batch operations; the operator grid has a `dottedWrapper` representation for
  every patch and data tool. The plain `set` forms needed no extra gate.

- Title: Integration tests drew ports from the OS ephemeral range. Summary: nine test files reserved a port by listening
  on port 0 and releasing it, so the port came from the range outbound client sockets use (Windows 49152-65535,
  `netsh int ipv4 show dynamicport tcp`). Under four concurrent vitest runs (24 cores each) a bind failed with
  `EADDRINUSE` four times in three rounds (ports 53761, 54396, 54394, 58044). Status: MEASURED, and fixed by
  `tests/portPool.js` (ports 32000 to 48999, one slice per vitest worker, bound-checked); the same load then produced no
  `EADDRINUSE` in its first round, and `tests/unit/portPool.test.js` fails if a port leaves the pool or repeats. NOT
  established: that the three single failures seen in plain `npm test` runs were this race (their assertion text was not
  kept). The load runs also showed 1000 ms waits for the identify or the invocation and 5000 ms test timeouts
  expiring under that overload; those are CPU starvation, not a defect of one test.


- Title: A scene created while no scene is active becomes active. Summary: `Scene.create({ name })` in a world with no
  active scene makes the new scene active and viewed (`client/documents/scene.mjs` `_preCreateOperation`, READ at
  lines 1038-1042), which pulls every connected user to it. MEASURED in the M6 macro e2e on 14.364: the first run left a
  recorded scene active until teardown. Status: `tests/e2e/macroTools.spec.js` creates its scene with `active: false`
  and restores the prior view; any e2e that creates a Scene must do the same.
