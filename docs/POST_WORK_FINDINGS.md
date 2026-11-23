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

- Title: The backup list cap test ran close to the default 5 s test limit. Summary: `tests/unit/backups.test.js`
  "stops reading headers after 1000" writes 1001 files and reads 1000 headers on real disk. Measured: the whole file
  takes 2.66 s in an idle `npm test`; with three `npx vitest run` at once it timed out at 5000 ms in two of three
  runs, the same load that failed the older process-spawning tests listed above (terminal, serverModes,
  SuperviseServer). Two builders hit one unnamed single failure each during the parallel M21 run. Status: MEASURED;
  the test now carries a 30 s limit (per-test limits are exempt from the 1000 ms wait rule), since the cap cannot be
  reached without the files.

- Title: The `BridgeIdentify` typedef does not list `settings`. Summary: `shared/protocol.js` documents the identify
  payload with its optional `gateState` but not the `settings` object (`BridgeSettings`) that the client sends
  (`src/bridge/foundryBridge.js`, `settings: readBridgeSettings()`) and the sidecar sanitizes (`server/endpoints.ts`
  `validateIdentify`, `sanitizeBridgeSettings(fields.settings)`). Status: READ; a documentation gap in a shared file,
  not a behaviour defect.

- Title: A scene created while no scene is active becomes active. Summary: `Scene.create({ name })` in a world with no
  active scene makes the new scene active and viewed (`client/documents/scene.mjs` `_preCreateOperation`, READ at
  lines 1038-1042), which pulls every connected user to it. MEASURED in the M6 macro e2e on 14.364: the first run left a
  recorded scene active until teardown. Status: `tests/e2e/macroTools.spec.js` creates its scene with `active: false`
  and restores the prior view; any e2e that creates a Scene must do the same.

- Title: Backup restore throughput and two restore targets are not covered live. Summary: only the piece transport
  (`tests/integration/backupTools.test.js`) and an export dry run of the largest live pack (`backupTools.spec.js`) were
  timed; how long a restore of 10,000 documents (the backup bound) takes, each document a replace or create through
  the write path, is not measured. No live e2e restores into a compendium pack or re-creates Folders: the unit tests
  over mocked `game` (`tests/unit/restoreBackup.test.js`) re-create a Folder and refuse a gone or locked pack, but
  have no case that restores a document into an unlocked pack. Status: NOT MEASURED.

- Title: A deleted pack leaves its key in `compendiumConfiguration`. Summary: after `delete_pack` removes a world pack
  on the live world (14.364), the core world setting `compendiumConfiguration` still holds an entry for the deleted
  pack id, `{"folder":null,"locked":false}`. Inferred, not measured: a pack created later with the same name reads
  that entry, and with it any folder, lock or ownership a GM had set on the old pack (whether the entry also carries
  `ownership` is not checked; the `create_pack` ack would not show it). Status: MEASURED in the M18 pack e2e run (`tests/e2e/packTools.spec.js`). The product's `delete_pack`
  still leaves the key (Foundry's own delete does the same; `deleteCompendium` does not touch the setting), while the
  e2e running list cleans its own: its teardown and sweep remove the key of each e2e pack they delete, and the census
  reports a stale `world.wiretap-e2e-*` key (`tests/e2e/registryCore.js`).

- Title: The `delete_pack` prompt is not verified in Claude Code itself. Summary: the sidecar lists `delete_pack` with
  `_meta["anthropic/requiresUserInteraction"]: true` whatever the GM client's definition says;
  `tests/integration/userInteractionMeta.test.js` proves the MCP SDK client receives it and
  `tests/e2e/packTools.spec.js` sees it in the live listing. What the docs state (READ,
  https://code.claude.com/docs/en/mcp, "Require approval for a specific tool"): Claude Code shows such a tool's
  permission prompt on every call, even in the `acceptEdits`, `auto` and `bypassPermissions` modes, and an allow rule
  that matches it does not skip the prompt. The page names no first version; a web-search summary attributed
  "v2.1.199 or later" to a GitHub issue quoting the docs, and the third-party guide it pointed to
  (https://wikidocs.net/458156) refused an automated fetch, so no minimum version is known here. The same summary said
  `dontAsk` denies such a call instead of prompting (not checked). What stays unverified here: that
  this project's own Claude Code shows the prompt on a `delete_pack` call, and whether Claude Desktop honours the
  entry at all (an open issue reports that it may drop per-tool `_meta`). Another MCP client or a local process is not
  prompted; the `allowPackDeletion` gate is the Wiretap-side control either way. Status: UNVERIFIED.

- Title: The `create_pack` collision check scans every pack id. Summary: the check that ignores case compares
  `world.<name>` with every key of `game.packs`, not only world packs, so a package whose id is `world` in another
  letter case (for example a module `World`) could make a free name read as taken. Status: INFERRED from
  `src/bridge/scripts/createPack.js`; needs an oddly named package to occur, not measured.

- Title: Dispatch does not compare `requiresUserInteraction` between endpoints. Summary: the registry tool's prompt
  flag is part of its `signature`, but dispatch compares only `schemaSignature` between the listed tool and the chosen
  endpoint's declaration (`server/endpoints.ts`), and the flag is not in it. For `delete_pack` the flag is forced by
  name (`USER_INTERACTION_TOOLS`), so it cannot differ; it would matter only for a future prompted tool that is not on
  that list. Status: READ (`server/toolRegistry.ts`, `server/endpoints.ts`); unreachable today.

- Title: An embedded change leaves the parent's modified time alone. Summary: on Foundry 14.364 an embedded Item
  update, an embedded ActiveEffect create and that ActiveEffect's delete all leave the parent document's
  `_stats.modifiedTime` where it was, so no timestamp on the parent tells whether its embedded documents changed, and a
  delete leaves no timestamp anywhere. Anything that detects change by `_stats.modifiedTime` misses them; `get_document`
  uses a content hash (`version`) instead. Status: MEASURED on the live world by `tests/e2e/readTools.spec.js` (its log
  line `{"update":false,"create":false,"delete":false}`, two runs).

- Title: Foundry's two import methods prepare a copy differently. Summary: `ClientDocument#toCompendium`
  (`client/documents/abstract/client-document.mjs:1113-1134`) deletes `_id` (unless `keepId`) and the top-level `sort`,
  keeps `folder` unless `clearFolder`, clears the three `_stats` source keys with `clearSource` (so Foundry's own pack
  import leaves no `_stats.compendiumSource`), and with `clearOwnership` leaves an `ownership` of `{ default }` on the
  document and on every embedded document. `WorldCollection#fromCompendium`
  (`client/documents/abstract/world-collection.mjs:109-137`) exists only on world collections, keeps `folder` by
  default, sets `_stats.compendiumSource` only for a source inside a pack, deletes embedded `ownership` and always ends
  with a top-level `ownership` granting the importing user OWNER. Neither walk enters an Adventure's content sets, which
  sit outside its `hierarchy`. A leftover `ownership` key would need `allowOwnershipWrites`, which is why `writeCopy.js`
  uses one builder (`toCompendium`, then every `ownership` deleted) for every target. The stored document still gets the
  creating user as OWNER from the server's `_preCreate` (`dist/database/backend/server-document.mjs`). Status: READ in
  the v14 tree; the stored ownership MEASURED by `tests/e2e/copyTools.spec.js`.
