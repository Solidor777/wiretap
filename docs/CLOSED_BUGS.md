# Closed bugs

## E2E build wrote into the repo root and accumulated stale hashed chunks

- **Was:** `tests/e2e/global-setup.js` runs `npm run build:e2e` (`vite build --mode e2e`); `vite.config.mjs` set
  `build.outDir` to the repo root with `emptyOutDir: false`, and the e2e build code-splits the gated probe import into
  `[name]-[hash].js` chunks. Measured on 2026-10-11 and again on 2026-10-13 before the fix: the root held
  `TerminalConnection.svelte-BqIjz3bZ.js`, `TerminalConnection.svelte-mN39lUcZ.js`, `registerProbe-B0zWb1xU.js`,
  `registerProbe-gFiVeMjW.js` (each with a `.js.map`) from different builds, next to the shipping `index.js`,
  `index.js.map` and `style.css`. Every build with new content added files and nothing removed the old ones.
- **Fix:** (1) `build.outDir` is `dist/` for the production and the e2e build (`scripts/lib/buildOutput.mjs`, used by
  `vite.config.mjs`), `emptyOutDir` stays false so Vite deletes nothing; (2) `module.json` `esmodules` and `styles`
  are `dist/index.js` and `dist/style.css` (Foundry loads them relative to the module root); `lang/` and the other
  static paths stay where they were; (3) the e2e build emits hash-free names (`[name].js`, `[name][extname]`) so each
  build overwrites the previous one; the production build keeps the bundler's default naming and has no dynamic import,
  so it emits only `index.js`, `index.js.map` and `style.css`; (4) `scripts/check-module-build.mjs`
  (`npm run check:build`, run by the e2e global setup after the build) fails when a file `module.json` names does not
  exist; `tests/unit/buildOutput.test.js` asserts the output directory, the hash-free e2e names, the production
  naming, the manifest paths and the check itself.
- **Measured after the fix (2026-10-13):** `npm run build` wrote `dist/index.js`, `dist/index.js.map`, `dist/style.css`
  only. Two consecutive `npm run build:e2e` runs left the same seven files in `dist/` (`index.js`, `style.css`,
  `TerminalConnection.svelte.js`, `registerProbe.js` and their maps) with no hashed name, and the root listing did not
  change. `npm run test:e2e` (headless, Foundry started by the harness) passed 14 of 14 loading the module from `dist/`.
- **Recycled with `trash` afterwards (2026-10-13), no longer in the root:** `index.js`, `index.js.map`,
  `style.css`, `TerminalConnection.svelte-BqIjz3bZ.js(.map)`, `TerminalConnection.svelte-mN39lUcZ.js(.map)`,
  `registerProbe-B0zWb1xU.js(.map)` and `registerProbe-gFiVeMjW.js(.map)` in the repo root. They were no longer loaded (the manifest points at `dist/`); their `.gitignore` and eslint ignore lines were removed once they were gone.
- **Release check:** `npm run check:release` fails while `dist/` holds anything but `index.js`, `index.js.map` and
  `style.css`; packaging runs `npm run build` and then `npm run check:release`, after the e2e leftovers are recycled.
- **Owner decision:** `.claude/CLAUDE.md` says test and e2e code builds to `test/build/` and stale built files are
  deleted after every build. The e2e bundle now shares `dist/` with the shipping build because Foundry loads the module
  from the paths in `module.json`, so `test/build/` cannot be the e2e output directory without a second manifest, and
  hash-free names replace "delete stale files" (nothing here deletes). The rule text needs rewording by the owner. A
  production build after an e2e build leaves the e2e-only `registerProbe.js` chunk in `dist/`; the production
  `index.js` does not import it (dead-code eliminated).

## `npm run foundry:start` did not stop Foundry when the invoking process was stopped

- **Was:** the supervisor (`scripts/e2e-foundry-server.mjs`) watched the nearest non-shell ancestor (`pickWatchPid`).
  Under `npm run foundry:start` that is npm's own `node.exe`, which waits for the supervisor and survives a killed
  invoker, so the watch never fired.
- **Measured (2026-10-11):** the chain is supervisor <- `cmd.exe /d /s /c node ...` <- npm `node.exe npm-cli.js` <- outer
  `cmd.exe` (or harness shell) <- invoker. After killing only the outer `cmd`, npm node, the supervisor and Foundry were
  all still alive and :30000 still listened.
- **Fix:** `package.json` `foundry:start` passes `--standalone`. In that mode the launcher watches
  `pickStandaloneWatchPid(ancestors, viaNpm)` (`scripts/lib/superviseServer.mjs`): skip leading shells, skip the npm
  wrapper when `npm_execpath` is set, take the next ancestor (shells included); without npm the nearest ancestor;
  `process.ppid` when the chain is exhausted. Playwright's `webServer` command is unchanged and still uses
  `pickWatchPid`.
- **Measured after the fix:** `tests/unit/SuperviseServer.test.js` `pickStandaloneWatchPid` tests (5) failed before the
  implementation (4 failed, 8 passed in the file; the `pickWatchPid` regression test passed already) and pass after
  (12 of 12); changing the wrapper skip (`wrapperIndex + 1` to `wrapperIndex`) fails 3 of them.
- **Measured (2026-10-11):** launched `cmd /c npm run foundry:start`, waited for :30000, then killed only the outer
  `cmd`. All five processes in the chain (outer cmd, npm node, shim cmd, supervisor, Foundry) exited within 5 s and
  :30000 stopped listening. Before the fix the same test left npm node, supervisor and Foundry running.

## Terminal socket handlers did not validate payloads

- **Was:** `server/terminal.ts` read `payload.data`, `payload.cols` and `payload.rows` from untrusted `TERMINAL_INPUT`,
  `TERMINAL_RESIZE` and `TERMINAL_LAUNCH` events without validation. Reading a property of an `undefined` payload throws
  inside a Socket.IO listener (inferred, not run against a live process, to terminate the sidecar), and a non-numeric
  size reached node-pty and the stored `size`.
- **Fix:** a payload that is not an object, input whose `data` is not a string, and a `cols` or `rows` that is not an
  integer within 1..`MAX_TERMINAL_DIMENSION` (1000) are ignored with one fixed `console.warn` line; a launch with an
  invalid size spawns nothing; an absent launch `cols`/`rows` keeps the stored size (default 80x24). Input `data` has no
  length cap: Socket.IO's `maxHttpBufferSize` (not overridden in `server/`; its default is inferred to be 1 MB) already
  bounds one event.
- **Measured:** `tests/unit/terminalPayloads.test.js` failed 48 of 50 tests before the fix (the 2 valid-input tests
  passed) and passes 50 of 50 after; removing the upper-bound check fails 4 of them (sizes 1001 and 1e9 for resize and
  launch).

## Sidecar Socket.IO server was not bound to loopback

- **Was:** `server/server.ts` passed no host to `new Server(port, { cors })`, so Node bound all interfaces; the
  unauthenticated terminal launch and bridge `isGM` identify events were reachable from the network.
- **Measured before the fix:** `server.io.httpServer.address()` returned `{ address: '::', family: 'IPv6' }`, and a TCP
  connection to this machine's non-loopback IPv4 address on the Socket.IO port was accepted
  (`tests/integration/serverModes.test.js`, both assertions failed).
- **Fix:** `createWiretapServer` creates an `http.Server`, calls `listen(port, '127.0.0.1')` and attaches Socket.IO to
  it; the bind address is not configurable.
- **Measured after the fix:** `address()` returns `{ address: '127.0.0.1', family: 'IPv4' }`; a loopback connection and
  a socket.io client connect; a connection to the non-loopback IPv4 address is refused (the test skips on a machine
  without one); `dispose()` stops the HTTP server and releases the port.

## `create_pack` accepted a name that differs from a world pack's only in case

- **Was:** `src/bridge/scripts/createPack.js` checked a collision with `game.packs.has('world.<name>')`, the same
  case-sensitive test the Foundry server makes. The server stores a world pack in the folder `packs/<name>`, and
  folder names ignore case on Windows, so `create_pack` with `name: "Monsters"` beside an existing `world.monsters`
  passed the check and would point the new pack at the existing pack's folder. Found and fixed before the live e2e run.
- **Fix:** the handler compares the new id with every key of `game.packs` in lowercase and refuses a match with
  `ARGS_INVALID` naming the existing pack id, on a real run and a dry run (`b41ab2e`).
- **Verified:** `tests/unit/createPack.test.js` "refuses a name that equals a world pack name when case is ignored, on
  a real run and on a dry run" asserts `ARGS_INVALID` with "already exists" for `name: "Foo"` beside `world.foo`, and
  that `createCompendium` is not called.

## `mcpConfigFile.test.js` failed when a process id was reused

- **Was:** `tests/unit/mcpConfigFile.test.js` `freshRoot(name)` named roots `test/tmp/mcpConfigFile/<pid>-<counter>`. One
  full `npm test` run (2026-10-11) failed 7 tests on the "scratch root must not exist yet" assertion while the file
  passed alone and in the next two full runs; `test/tmp/mcpConfigFile/` held 121 leftover directories that the
  no-deletion rule forbids removing, so a reused pid plus counter collided with an older run's directory.
- **Fix:** roots are now `<timestamp>-<pid>-<counter>`; the timestamp is taken once when the test module loads.
- **Measured after the fix:** three consecutive runs of the file passed (8 passed, 1 skipped on Windows), and the new
  directories have the `<13-digit timestamp>-<pid>-<counter>` form. The collision itself depends on pid reuse and was
  not reproduced on demand, so the fix is verified by construction, not by reproducing the failure.

## An Adventure with an empty `macros` set needed `allowMacroExecution`

- **Was:** `guardWrite` asked for `allowMacroExecution` on any Adventure create whose data held a `macros` key, even
  an empty one: `writesField` of `src/bridge/scripts/writeGuard.js` tested only that the key exists, so `macros: []`
  counted as writing macro code. Foundry defaults the set to `[]` (`common/data/fields.mjs` 2289-2297, 2329-2333;
  READ), so an Adventure's `toObject()` always holds the key (INFERRED, not measured live) and every `fromUuids` copy
  of an Adventure, and any `data` create that included `macros: []`, was refused while the gate was closed. Found in
  M15a.
- **Fix:** `writesAdventureMacros` in `writeGuard.js` counts a `macros` key only when its value, an update operator
  unwrapped, is not an empty array; a dotted key into the set and a deletion still count. An Adventure whose `macros`
  hold a macro, by create, update `set` or update `replace`, is still refused while the gate is closed.
- **Verified:** `tests/unit/macroCommandGate.test.js` "create of an Adventure whose macros list is empty needs no
  macro gate", "update of an Adventure's macros to an empty list with op set / replace needs no macro gate" and
  "update of an Adventure's macros with op replace and a macro is denied while the gate is closed";
  `tests/unit/writeCopyCreate.test.js` "copies an Adventure whose macros set is empty with every gate but the
  compendium gate closed". Before the fix every case but the denial failed with `Gate allowMacroExecution is closed`.

## `create_documents` rows came back out of input order

- **Was:** a `parentUuid` copy of `fromUuids: [A, B]` acked rows `[B, A]` in one of two live runs of
  `tests/e2e/copyTools.spec.js` (MEASURED; the other run gave `[A, B]`). `runCreate` of `src/bridge/scripts/writes.js`
  mapped the documents in the order Foundry answered, while its JSDoc promised data order. READ in the 14.364 tree:
  the client keeps the server's order (`client/data/client-backend.mjs` 53-65 and 158-169); the server's
  `_createDocuments` (`dist/database/backend/server-backend.mjs`, minified, offsets 4537-6250) builds each document
  inside `Promise.all(data.map(async ...))` and pushes it only after `await createNewId()`, a database lookup
  (`sublevel-database.mjs`, offset 203: `randomID(16)` until `!await this.has(id)`), so documents whose ids the server
  generates come back in the order those lookups finish. With `keepId` and an `_id` there is no await before the push.
  World, embedded and pack creates take that path (`common/abstract/document.mjs` 606-610 and 863-869 send all three
  to `DatabaseBackend#create`), for `data` and `fromUuids` alike; idempotent creates and the backup restore, which send
  ids under `keepId`, were not affected (INFERRED from the same code).
- **Fix:** `runCreate` sends every document with an id under `keepId: true`: the kept `_id` when the call has `keepId`,
  else a fresh `foundry.utils.randomID()` in place of any `_id` the data holds (the server ignores that `_id` without
  `keepId`, so the caller-facing meaning of `keepId` is unchanged). It then matches the created documents to the data
  by id, so row i is data i whatever order Foundry answers in. `refuseTakenIds` and the ack shape are unchanged.
- **Verified:** `tests/unit/writeCreate.test.js` "createDocuments: rows follow the order of the data" (world,
  embedded, pack and keepId creates with `world.createOrder.reverse`, which makes the mocked server answer in reverse,
  and a data `_id` replaced without keepId). Before the fix all five failed (the order cases with
  `[ 'MOCK_2', 'MOCK_1', 'MOCK_0' ]`); after it they pass. Not re-measured on the live world here.

## The copy header described a create's ownership wrongly

- **Was:** the header of `src/bridge/scripts/writeCopy.js` said a create whose data holds no `ownership` gets only the
  schema initial `{ default: NONE }`, and that a copy differs there from Foundry's world import, which grants the
  importing user OWNER; `references/copies.md` of the `wiretap-writes` skill did not say what that ownership is. On the
  live titan world (14.364) a world Item the GM created from data with no `ownership`, and a world copy made by
  `fromUuids` from a pack document, both store `{ default: 0, <GM user id>: 3 }` (MEASURED by
  `tests/e2e/copyTools.spec.js`, its log lines). READ: the Foundry server's `_preCreate`
  (`dist/database/backend/server-document.mjs`, minified, offset 16411) sets `ownership.<creating user id>` to OWNER
  when the document has an `ownership` value that does not name the user. The copy carries no `ownership` key, so it
  gets what a plain create gets and no gate was affected; only the text was wrong.
- **Fix:** the `writeCopy.js` header states the server's OWNER grant with that citation and that a copy, like a plain
  create, ends up with the ownership Foundry's world import grants; `references/copies.md` states the stored value,
  measured and read. No code changed. Embedded copies' stored ownership is not measured (Inferred: the server runs the
  same `_preCreate` for them).

## batch created rows did not follow the entries

- **Was:** `batch` sent its creates without ids (`keepId` false) and listed the `created` rows in the order Foundry
  answered each create operation (`acknowledge` in `src/bridge/scripts/writeBatch.js` mapped
  `states[index].documents`). READ in the 14.364 tree (`dist/database/backend/server-backend.mjs`, minified): the
  batch handler runs each operation through `modifyDocument`, which reaches `_createDocuments`, and that answers
  documents whose ids the server generates in the order its `createNewId` lookups finish. On top of that,
  `groupCreates` (`src/bridge/scripts/batch.js`) merges the entries into one create per class and parent in first-use
  order, so `[Actor A, Item B, Actor C]` came back `A, C, B`. Found in M15a; not measured live.
- **Fix:** `buildOperations` sends every created document with an id from `createId` (`writeArgs.js`) under
  `keepId: true`, as `runCreate` does, and `acknowledge` matches each group's answer by id, so each group's rows follow
  its data. `groupCreates` also returns `rowOrder`, the place of each entry's row among the group-by-group rows, and
  `batchHandler` puts the `created` rows back in entry order, dry run included. The grouping, the operations sent
  (beyond the ids and `keepId`) and the row shape are unchanged; updated rows stay one per uuid in first-patch order
  and deleted rows in the order given.
- **Verified:** `tests/unit/writeBatch.test.js` "batch: created rows follow the order of the entries", with
  `world.createOrder.reverse` (the mocked `modifyBatch` now answers creates in reverse too): one group of three creates
  and the mixed `[Actor A, Item B, Actor C]` through `batchHandler` (dry run and real). Before the fix both failed
  (`[ 'MOCK_2', 'MOCK_1', 'MOCK_0' ]` and `[ 'MOCK_A', 'MOCK_C', 'MOCK_B' ]`); after it they pass. Not re-measured on
  the live world here.


## contextBudget.test.js timed out inside a default-worker npm test

- **Was:** a default-worker `npm test` failed now and then in `tests/unit/contextBudget.test.js` with "Test timed out
  in 5000ms" and passed on a rerun; the file passed alone. Captured in `debug/dumps/m15a-npmtest-1.txt` for "accepts a
  skills directory whose tool mentions all exist and none when the directory is absent"; reproduced once more, in a
  full run that also timed out "keeps the listed production tools and their fixtures inside every budget". Found in
  M15a.
- **Cause (MEASURED with vitest JSON durations and per-phase timing written to `debug/dumps/`):** every report of
  `collectReport` ran every fixture of every tool, and the `list_backups` fixture
  (`tests/unit/contextBudgetHarness.js`) made 50 real backups (an MCP call, two Socket.IO pieces and a file write
  each) and then read 50 headers. One report took 0.24 to 0.42 s alone and 0.9 to 4.5 s in a full run; the 50-backup
  fixture was 72 to 74% of the fixture time of the file's reports, alone and in full runs. In a full run, steps that touch the disk slowed far more than plain tool calls: a
  backup's median went from 2.5 to 24 ms and the 50-header list call from 35 ms to 2.7 s, while a plain tool call's
  median went from 1.5 to 2.0 ms. The skills test runs two reports, and the file's first tests run while the other
  workers are busiest, so they reached 3.2 to 4.8 s. Excluded: harness start, including the port reservation (31 to
  602 ms per start), the skills directory read (0.2 to 91 ms), timers and the tool-list debounce (none on the report
  path; `nextToolListChange` is not used by the failing test), and the plain tool calls through the fake GM (1.5 to
  2.0 ms median). Unverified: why disk steps slow so much (real-time antivirus scanning is on for this machine; its
  exclusions were not readable).
- **Fix:** the `list_backups` fixture makes 17 backups, one more than the 16 rows that fit in
  `BACKUP_LIST_MAX_BYTES`, and fails unless the listing is cut. The result is the same 1,971 bytes it was with 50.
  `collectReport` takes `runFixtures` (true, false, or the names of the tools whose fixtures run). The test file's
  `reportWith` and `reportOn` run none unless asked: the production-budget test runs all, and the four registry tests
  and "fails a fixture result over its budget" run only their own tools. The production-budget test, the one test that
  runs every fixture (40 tool calls, 20 backup files written and 18 headers read), has a 10 s limit, with the
  measured 1.7 to 4.2 s full-run time in a comment.
- **Verified:** a new test, "checks that every tool has a fixture without running any when fixtures are not run",
  failed before `runFixtures` existed and passes now. After the fix the file takes 2.3 s alone and 10.0 to 11.6 s in a
  full run (it took 21 to 23 s before). The skills test takes 0.6 s or less in a full run. Three default-worker
  `npm test` runs passed: 2956 passed and 2 skipped in each (`debug/dumps/flaky-ctx-npmtest-{1,2,3}.txt`).

## searchDocuments.test.js scan-cap test timed out inside a default-worker npm test

- **Was:** a default-worker `npm test` failed in `tests/unit/searchDocuments.test.js` ("search_documents work bounds >
  stops after the scan cap, reports cut and scanned, and a cursor resumes to cover every document") with "Test timed
  out in 5000ms" in 2 of 5 full runs (`debug/dumps/m15a-npmtest-2..6.txt`). Found in M15a.
- **Cause (MEASURED with vitest JSON durations and temporary timing written to `debug/dumps/`):** needless work in
  the test. It built 4,500 actors and drained them 80 rows a call: 57 calls, each of which orders the whole
  collection with a yield every 25 documents, 13,790 yields in all. The test took 306 to 1,168 ms alone and 2,165 to
  5,198 ms in six full runs, the same on `main` (743, 306, 341 ms alone; 5,198 failed, 4,380 and 3,701 ms in full runs)
  as on this branch (1,168, 336, 310 ms; 2,165, 3,624 and 4,116 ms), so the M15a content version is not the cost:
  `search.js` and `searchDocuments.js` are unchanged since `main` and call neither `shape.compact` nor
  `contentVersion`. In full runs the same drain took 2.0 to 3.0 s, against 0.25 s alone.
- **Fix:** the test holds `SEARCH_SCAN_MAX` + `SEARCH_MAX_LIMIT` actors (2,100: one page more than the scan cap, the
  least that makes the first call stop at the cap) and drains them at `SEARCH_MAX_LIMIT` rows a call: 21 calls and
  2,684 yields. Its assertions are unchanged. The drain takes 0.05 s alone and 0.49 to 0.51 s in full runs; the test
  takes 86 ms alone. In the same work, two backup tests measured near their limits got a limit with the measured
  reason in a comment: "stops reading headers after 1000" (`tests/unit/backups.test.js`, 11 to 31 s in full runs, one
  on `main` failed at 31 s against its 30 s limit; now 60 s) and "refuses more than 10000 documents and more than 64000000
  bytes" (`tests/unit/exportBackup.test.js`, up to 5.1 s in a full run; now 15 s). Their fixtures are the least
  that reach each cap.
- **Verified:** three default-worker `npm test` runs passed: 2956 passed and 2 skipped in each
  (`debug/dumps/flaky-search-npmtest-{1,2,3}.txt`).

## A keyed keepId retry of create_documents was refused as an overwrite

- **Was:** a `create_documents` retry with `keepId: true`, an explicit `_id` (in `data`, or the kept source id of a
  `fromUuids` copy) and the same `idempotencyKey` was refused with `ARGS_INVALID` "keepId: <Class> '<id>' already
  exists and would be overwritten" instead of replaying the first call's rows, as the tool description and the skill
  say repeats do. MEASURED with `npx vitest run tests/unit/writeKeepId.test.js tests/unit/writeCopyCreate.test.js -t
  "replays a keyed keepId"`: both second calls threw that `ARGS_INVALID` from `refuseTakenIds` (world Actor
  `MOCKFREEID000003`; embedded Item `MOCKITEM00000002` copied under another actor). Found in M15a.
- **Cause:** `prepareCreate` (`src/bridge/scripts/writes.js`) ran `refuseTakenIds` before `applyIdempotency` looked
  the key up, so the documents the first call created made the retry look like an overwrite.
- **Fix:** `refuseTakenIds` runs after the key lookup. A keyed retry whose key and request hash match stored records
  returns the replay first; a call with no matching record (no key, or a key with no record yet) still meets
  `refuseTakenIds` before any write. `refuseUnsafeData`, target resolution and the first `guardWrite` still run before
  the lookup. The record, the hash and the ack are unchanged.
- **Verified:** the two tests "replays a keyed keepId retry whose ids the first call took, and writes once"
  (`tests/unit/writeKeepId.test.js`) and "replays a keyed keepId copy retry whose kept source id the first call took
  under the parent" (`tests/unit/writeCopyCreate.test.js`) failed before the fix and pass now; "refuses on a dry run
  too, and under an idempotency key" (a taken id with a key and no record) still passes. `npm test`: 133 files, 2958
  passed and 2 skipped.
