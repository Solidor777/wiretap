# Wiretap

A Foundry VTT v14 module that adds a tab and a bridge for AI agents inside Foundry. Built with
Svelte 5 (runes), SCSS, and Vite.

## Development

- `npm run dev` — Vite dev server (proxies to Foundry on :30000)
- `npm run build` — production build (emits `dist/index.js` + `dist/style.css`, the files `module.json` loads)
- `npm run check:build` — fails when a file named by `module.json` `esmodules` or `styles` does not exist; the e2e build
  (`vite build --mode e2e`, run by `npm run test:e2e`) writes to the same `dist/` with hash-free file names, so nothing
  accumulates and nothing is deleted
- `npm run check:release` — packaging check: fails while `dist/` holds any file other than `index.js`, `index.js.map` and
  `style.css`. Package with `npm run build` and then `npm run check:release`; the e2e leftovers (`registerProbe.js`,
  `TerminalConnection.svelte.js` and their `.map` files) must be recycled with `trash` before packaging
- `npm test` — unit and integration tests (Vitest), including the context-budget test that holds every MCP tool
  definition and representative result to the budgets in `shared/budgets.js`
- `npx tsx tests/measure/measureContext.mjs` — manual report of the real tool list and fixture result sizes against
  those budgets (not part of CI; needs no Foundry)
- `npm run test:e2e` — end-to-end tests (Playwright)
- `npm run foundry:start` — starts Foundry on the configured world if nothing answers on the port, and stops it when the
  process that ran the command ends

## Running e2e / starting Foundry

`npm run test:e2e` starts Foundry itself through `scripts/e2e-foundry-server.mjs` when nothing answers on
`:30000`, reuses a running server otherwise, and stops a server it started when the run ends. The launched world
(default `test-titan`) must have Wiretap enabled. Defaults derive from the module location (userdata three levels
up, Foundry app in `<userdata>/../foundry`); override with `FOUNDRY_DATA_PATH`, `FOUNDRY_APP_DIR`, `FOUNDRY_PORT`,
`FOUNDRY_WORLD`, `FOUNDRY_SERVER_LOG` (default `debug/dumps/e2e-server.log`). Before it starts or reuses a server, the
launcher writes the e2e fixture plugin module to `<userdata>/Data/modules/wiretap-e2e-plugin` (overwriting, never
deleting); the plugin-tool spec enables it in the world for its run and restores the world's module configuration
after. Foundry reads module folders only when it starts, so a server started before the first install must be
restarted once.

A spec that creates a world document records it in the running list `test/state/registry.json` (gitignored,
overwritten, never deleted) as soon as its id is known, and removes it with a Foundry document call (`document.delete()`)
after the test. Before it deletes anything the teardown checks every recorded entry: an allowed world document type, a
uuid of the form `<Type>.<16-character id>` (never a compendium or embedded uuid), a resolved document of the recorded
type that is not in a pack, not embedded and named with the `Wiretap E2E ` prefix; if any entry fails, nothing is
deleted and the run fails. After the teardown a sweep deletes (through the same checks) every world document named with
the prefix that no running list recorded, and the run fails when it finds one. A census then counts prefixed documents,
every combat and every token whose actor no longer resolves; each test and the global teardown fail on a non-empty
census, and the global setup removes what a crashed run left. The suite refuses to run these steps in any world but
`FOUNDRY_WORLD` (default `test-titan`), and refuses any world whose id does not start with `test-` unless
`WIRETAP_E2E_ALLOW_WORLD=<exact world id>` is set. A recorded teardown tests each document again immediately before it
deletes it, and a sweep that finds a prefixed document it must not delete deletes nothing. Risk: the sweep deletes every
world document whose name starts with `Wiretap E2E ` (a chat message's `flavor`, a setting's key prefix `wiretap-e2e.`),
including one a person made by hand in the test world; keep the prefix out of real documents. A running list that cannot
be read, belongs to another world or holds more than 1,000 entries is never replaced: the run fails instead.

## Running the sidecar

Wiretap's terminal needs a small local Node sidecar (it runs the real PTY; a browser can't). Start it with
a single action:

- **Windows:** double-click `scripts/start-wiretap.cmd` in the module folder.
- **macOS/Linux:** run `./scripts/start-wiretap.sh` from the module folder.

A console window opens and stays up while the sidecar runs — its log shows `listening on http://127.0.0.1:31416`.
**Close that window (or press Ctrl-C) to stop the sidecar.** The Wiretap tab (GM-only) connects automatically
once the sidecar is up; until then it shows a "Sidecar not running" panel.

## MCP modes

The sidecar hosts a Streamable-HTTP MCP endpoint (default `http://127.0.0.1:31417/mcp`, loopback only; override the
port with `WIRETAP_MCP_PORT`) whose tools run against the live world through a GM-identified Foundry client.

- **In-session (default, `full` mode):** when the Wiretap terminal launches `claude` followed only by plain
  arguments (the default command is bare `claude`), the sidecar writes `.wiretap/mcp-<mcpPort>.json` in the module
  directory (the parent of `server/`, resolved from the server's own location; the directory is mode 0o700, the file
  0o600, gitignored) and appends `--mcp-config "<path>"`, so that `claude` sees the Wiretap tools with no setup. Wiring follows an allowlist: every argument must consist solely of
  `A-Z a-z 0-9 . _ : = / @ + , -`. Any other command line is launched unchanged and the skip is logged: a command
  that is not exactly `claude`, one that already passes `--mcp-config`, one with a standalone `--`, and one with any
  other character, which includes **every quoted argument** (for example `claude --append-system-prompt "..."` is
  not wired). The same applies if the config file cannot be written. The config file is rewritten on every wired
  launch (a symbolic link at the file path is refused) and is never deleted by the sidecar; a failed write is logged and
  the command is launched unchanged.
- **Standalone (`mcp-only` mode):** run the sidecar without the terminal relay and attach any MCP client:

  ```
  npm run server:mcp
  claude mcp add --transport http wiretap http://127.0.0.1:31417/mcp
  ```

  `--mcp-only` on the command line or `WIRETAP_MODE=mcp-only` selects this mode (the argument wins; `full` is the
  default and any other `WIRETAP_MODE` value exits with an error). The Socket.IO server and the Foundry bridge stay
  up (the Socket.IO server, like the MCP endpoint, binds `127.0.0.1` only and is not reachable from other machines) so
  the Foundry client can still identify as a GM.

## MCP sessions and registered tools

The MCP endpoint is stateful Streamable HTTP. A client's `initialize` POST opens a session and returns an
`Mcp-Session-Id`; later requests carry it. `GET /mcp` opens the session's event stream, `POST /mcp` carries requests
and `DELETE /mcp` ends the session (in memory only; nothing is deleted on disk). A request without a session id other
than `initialize` gets `400`, an unknown, expired or ended id gets `404` (a client re-initializes after that; measured
with `claude` 2.1.296 in `docs/experiments/2026-10-m3-results.md`), a path other than `/mcp` gets `404` and any other
method `405`.

- **Endpoint choice.** `?endpoint=human` or `?endpoint=agent` on the initialize URL fixes which kind of Foundry GM
  client the session routes to (any other value gets `400`). Without it a call goes to the first healthy `agent`
  endpoint, then the first healthy `human` one.
- **Instructions.** Every session receives a short server `instructions` text that names the tools and explains handles
  and tool-list changes; it does not point to the Wiretap skill (see below). An earlier, longer text (531 characters)
  cost about 221 tokens of context (measured, same results file); the current text is shorter and was not re-measured.
- **Registered scripts.** Every tool except the sidecar's built-ins (`read_handle` and the four backup tools, see
  [Document backups](#document-backups)) is a script a GM client registers. A registered GM client pushes its complete
  script list with the Socket.IO event `bridge:registry`, whose payload is `{ apiVersion: 1, scripts: [...] }` (a plain
  array is refused); each event replaces the endpoint's previous list. A script definition is `{ name, version,
  description, inputSchema, result: { budgetBytes }, requires, mutates, gate?, handleArgs?, strictNested?,
  requiresUserInteraction?, moduleId? }`, documented field by field in `shared/scripts.js`: `version` is a non-empty
  string (semver-like and at most 32 characters for Wiretap's own tools), `requires` is `'api'` (any client endpoint) or
  `'dom'` (a DOM-capable endpoint), `mutates` is required and never defaulted, and `requiresUserInteraction` may only be
  `true`. A tool with that flag, and `delete_pack` whatever its definition says, is listed with `_meta: {
  "anthropic/requiresUserInteraction": true }`, which the sidecar builds itself; a client cannot attach any other
  `_meta` to a tool. The sidecar judges every entry with the validator the client uses. An entry without `moduleId` is
  one of Wiretap's own tools and is refused past any per-tool guideline (a name of 1 to 32 characters without `__`, a
  description of at most 240 characters, a listed definition of at most 800 bytes, the schema guidelines); an entry with
  `moduleId` is a plugin tool, which past a guideline is accepted with a logged warning (see [Plugin
  tools](#plugin-tools-for-module-authors)). An entry that breaks a rule it needs to work (a documented JSON Schema
  subset among them) is refused for both. Each refusal is logged with its reason, and a changed list tells each session
  routed to that endpoint with one debounced `notifications/tools/list_changed` (200 ms quiet, 1,000 ms at most). A call
  to such a tool runs the `callTool` operation on the session's endpoint; each tool is listed with `readOnlyHint` set to
  the inverse of `mutates`. Every shipped tool is one of these scripts: the Foundry client registers it from
  `src/bridge/scripts/` and the sidecar has no handler of its own for it. The client sends its registry after every
  acknowledged identify and whenever a script registers, so a reconnect restores the tool list. The client runs a call
  only after it has found the script by name, judged the script's declared risk gate from its own world settings, and
  validated the arguments against the script's own schema (`shared/schemaValidate.js`, the same JSON Schema subset the
  sidecar converts; every array of Wiretap's own tools declares a `maxItems` of at most 1,000, except the list arguments
  of the read and write tools, which have no item cap); a script that runs longer than 8 s fails with `SCRIPT_TIMEOUT`,
  which says the operation may still have applied. A script may declare the shared optional argument `timeoutMs` in its
  schema (today only `execute_macro` does, 1 to 2,147,481,647 ms: a timer holds at most 2,147,483,647 ms and the sidecar
  waits 2 s longer): a call that sets it runs under that limit instead, and the sidecar waits `timeoutMs` + 2 s for that
  call's reply instead of its usual 10 s. A client runs at most 8 scripts at once; a call beyond that fails at once with
  `SCRIPT_BUSY`. The client sends one registry push per task however many scripts register in it; the sidecar applies at
  most 2 `bridge:registry` pushes per second from one socket: later pushes in the same second are coalesced, and the
  latest is applied when the second ends (an earlier coalesced push is acked `{ ok: true, coalesced: true }`). There is
  no cap on the number of tools or on their total size. The write tools, `roll`, `draw_table`, `execute_macro`,
  `create_pack` and `delete_pack` are listed with `readOnlyHint` false; `open_sheet` and `close_sheet` with true. A tool
  added during a `claude` session was deferred (found through `ToolSearch`) and callable in the same session.
- **Reading documents.** `list_document_types` returns the world's document classes (`world`, `embedded`, `packOnly`)
  and the subtypes of each (at most 3,000 bytes; the longest subtype lists are left out and named in `omitted` when they
  do not fit). `get_document` reads a world, embedded (`parentUuid`) or compendium (`pack`) document by `uuid`, or by
  `documentName` and `id`. The default result is a compact view of at most 2,000 bytes: `uuid`, `name`, `type`,
  `version`, up to 24 `system` leaves and `[id, name, type]` rows of the embedded documents (40 rows at most, with each
  collection's total). `cut: true` marks a view that lost data: a uuid, version, id or leaf value cut short, leaves or
  entries left out, or an object the walk did not enter; a name or type only shortened with `…` is not flagged. The
  leaves come from a reviewed per-subtype list for the `titan` system (`src/bridge/scripts/keyFields.json`) and from a
  default key-name pattern for any other. `fields` returns a nested projection, `paths` returns slices such as
  `system.resource` or `items.*.name` keyed by `_id` with the unresolved paths in `missing`, `derived: true` reads the
  prepared data for those two, and both results carry `version` too. `mode: "full"` returns the whole export
  (`toCompendium` with ids, sort and ownership kept, plus `uuid`) without a `version`. The `version` is a short content
  hash (14 hex digits) of everything the agent can read of the document, embedded documents included, so any readable
  change changes it; an edit of a secret-named value, which is never returned, does not. `ifChanged` set to the current
  version returns `{"unchanged":true}` in every mode. A `derived: true` read hashes the prepared values, so its version
  is compared by another `derived: true` read. `maxBytes` (128 to 16,000) raises the inline limit; a result over the
  limit is a handle. `partial: true` on any read (and on search pages, write read-backs, and as `examplePartial` on
  `describe_schema`) marks an export whose secret redaction stopped at its depth or node bound: part of the document is
  missing, and no other read returns it. A client acks a result up to 900,000 bytes. What is never returned: the
  password fields of a `User` (removed from every export; a path to one is listed in `missing`), a `Setting` in the
  `wiretap.` namespace, the core settings that hold credentials (`core.rtcWorldSettings`, the WebRTC TURN user and
  password) and a `Setting` whose key names a secret (each refused with `DOC_EXCLUDED`), and every key named like a
  secret (`password`, `passphrase`, `secret`, `token`, `apiKey`, `credential`, `privateKey`, in any case) inside a
  `Setting` value or any `flags` object (dropped, so a path into one is listed in `missing`). The match is by name only:
  a secret under another name stays readable and an ordinary name that contains one of those words is dropped. Core
  schema fields and system data are not scanned. Settings of other modules are otherwise readable. Other error codes:
  `DOC_NOT_FOUND`, `DOC_UNREADABLE` (the export failed), `PATH_NOT_FOUND`, `PATH_EXCLUDED`, `PATH_EMBEDDED`,
  `PATH_FREE_FORM`, `PATH_UNSAFE_SEGMENT`, `PATH_INVALID`, `PATH_LIMIT`.
- **Searching and schemas.** `search_documents` needs `documentName` and searches the world, the embedded documents of a
  `parentUuid`, or a compendium `pack` (through its index: only the filter and field paths are read and no document is
  loaded). `type` and `query` (a name substring) narrow it, `filters` (`path=value`; the scalar at a dotted path, as
  text, must equal the value) narrow it further, and `fields` adds scalar values to each row. A page is at most 4,000
  bytes of `[uuid, name, type]` rows (20 by default, any larger `limit`; a lone row whose fields overflow the page is
  shortened to its first three entries) with `total` (and `fieldsDropped: true` when it did) and, when more follow,
  `nextCursor` (at most 512 characters); rows are ordered by name then uuid and the cursor names a position, so
  documents added or removed between pages do not shift it (a cursor that is not one the search issued is
  `CURSOR_INVALID`). The work of one call is bounded: name, subtype and folder are read from the live document and cost
  no export, a call examines at most 2,000 candidates after its cursor and exports at most 300 documents (for a filter
  on another path), yields to the event loop every 25 candidates and stops with `SEARCH_ABORTED` when the call times
  out. A call that stops at a cap reports `cut: true` and `scanned` and returns a `nextCursor` that resumes; `total`
  counts the matches among the candidates examined from the cursor on. A compendium search asks the pack index for at
  most 5 distinct paths of at most 3 segments, never a whole `system`, `items`, `effects` or `flags` subtree; the index
  is shared state, so the fields a search asks for stay in the pack's index for the session (Foundry's `getIndex`), and
  a path with a segment named like a secret is refused with `PATH_EXCLUDED` because an index entry is raw source data.
  The work of a search is not free: ordering keys for the whole class are built and sorted on every call (O(N log N)),
  and a compendium `getIndex` cannot be aborted, so one batch can finish after the call timed out. `Setting` documents
  in the `wiretap.` namespace never appear, and a filter or field on a `User` password path is refused with
  `PATH_EXCLUDED`. `describe_schema` takes `documentName`, an optional `subtype` and an optional `path`. Without a path
  it returns a blank example (the canonical export of a document built in memory) and a one-level outline of the schema;
  with one it returns the example subtree and the field's constraints (choices, min, max, integer, required, nullable,
  blank). Free-form fields are marked and embedded collections are named by document class instead of expanded. A result
  is at most 8,000 bytes; a list it shortens is counted (`exampleKeysMore`, `categoriesMore`, `typesMore`) and an
  outline stopped at its bound says `outlineCut: true`. No read or write tool refuses a call for its size: past a
  best-practice size (50 documents, 200 update entries, 200,000 bytes of data, 100,000 characters in one text or value,
  20 paths or fields, 100 search results, 5 filters, a 64-byte field path, and the lengths of a query, filter, cursor,
  `ifChanged` or uuid) the call runs and the GM's browser writes one line `Wiretap | <tool>: <n> <measure>, over the
  <size> best-practice size`. The protections still refuse: the 1,048,576-byte MCP request body, a path over 512 bytes,
  data nested past 32 levels.
- **Writing documents.** `create_documents`, `update_documents` and `delete_documents` write the live world through
  Foundry's document calls (`createDocuments`, `createEmbeddedDocuments`, `update`, `updateEmbeddedDocuments`,
  `deleteDocuments`, `deleteEmbeddedDocuments`), so system and module pre-write logic and hooks run as for a write made
  in the UI. The argument-schema subset has no free-form object, so structured input travels as JSON text.
  `create_documents` takes `documentName` and exactly one of `data` (one or more JSON object texts) and `fromUuids` (one
  or more uuids of world, embedded or compendium documents of that class to copy; both or neither is `ARGS_INVALID`),
  and optionally `parentUuid` (embedded documents), `pack` (a compendium), `keepId`, `dryRun` and `paths`; it returns
  one `{uuid, name, type}` per document, in the order of `data` or `fromUuids` (4,000 bytes at most, 256 per document).
  A copy is built in the Foundry client from the source document, so the source body never reaches the agent, and it
  meets every gate, write guard, validation, `actAs` and `dryRun` check that a `data` create of the same content would.
  A copy carries no ownership of its source at any depth, and Foundry makes the creating user its OWNER, as for any
  create. It has a new `_id` unless `keepId`, and no `folder`, `sort` or `flags.wiretap`; a copy of a compendium
  document sets `_stats.compendiumSource` to the source uuid. Secret-named values of the source are copied as Foundry's
  own import copies them, and every read of the copy stays redacted. A `User` cannot be copied (`ARGS_INVALID`), a
  missing source is `DOC_NOT_FOUND`, and a source a read refuses gets the read's code (for example `DOC_EXCLUDED`).
  `update_documents` takes `updates`, one patch per entry (`uuid`, `path`, `value` as JSON text, `op` of `set`,
  `replace` or `delete`), `dryRun` and `paths`; entries with one uuid form that document's update, paths such as
  `items.<_id>.system.x` are grouped into one `updateEmbeddedDocuments` call per collection, `replace` and `delete`
  become Foundry's `_replace` and `_del` operators, wildcards and conflicting paths are refused with their `PATH_*`
  code, and it returns `{uuid, changed}` per document (`changed` is empty when Foundry applied nothing).
  `delete_documents` takes `uuids` (one or more) and `dryRun`; a dry run returns `{dryRun, rows: [uuid, name, type][],
  total, cut?}` including embedded cascades within 8,000 bytes, and a compendium pack itself cannot be deleted with it
  (`delete_pack` does that). Deletion is irreversible and needs the `allowDelete` gate (closed by default); put `"ask":
  ["mcp__wiretap__delete_documents"]` in the Claude Code permissions to confirm each call as well. Every call is guarded
  as a whole before the first write: a User write needs `allowUserWrites` (password fields are refused whatever the
  gate, and the signed-in user and the last game master cannot be deleted), a Setting write needs `allowSettingWrites`
  and never a `wiretap.*` key (a by-id write is judged by the key of the existing document), the module configuration
  setting also needs `allowModuleConfigWrites`, a base64 data URI needs `allowFileUpload`, an `ownership` field or path
  needs `allowOwnershipWrites`, macro code needs `allowMacroExecution` (a Macro `command`, a Macro `type` changed to
  `script`, an Adventure's stored `macros`, or a region behavior of type `executeScript` in a region, a scene or an
  Adventure; re-stating the `script` type of a Macro that is already a script, or the `executeScript` type of a behavior
  already of that type, needs no gate, but any write that carries a Macro's `command` or an `executeScript` behavior's
  `system.source` needs it even when the value is unchanged, and a `dryRun` needs it too), a pack or a document inside
  one needs `allowCompendiumWrites`, deleting documents needs `allowDelete` (so does any update or replace that removes
  embedded documents, such as a `replace_document` whose data leaves them out or an update with `op` `replace` or
  `delete` on an embedded field) and replacing a document needs `allowReplace` (a `dryRun` preview needs neither, and a
  replace preview reports `dropped`). `keepId` is refused when the `_id` exists. Foundry validates the input without
  writing (`DataModelValidationError.getAllFailures()`); a failure returns `VALIDATION_FAILED` with at most 10 failures
  and their true count in 512 bytes, and nothing is written. `dryRun` validates and returns the would-be result and
  calls no create, update or delete API. A write is not atomic across documents once Foundry starts it; a hook that
  cancels part of a call reports `WRITE_NOT_APPLIED`.
- **Replacing, batching, `actAs`, idempotency and handle inputs.** An argument a tool does not declare (for example a
  misspelled `dryrun`) is refused with `ARGS_INVALID` instead of being ignored. `replace_document` takes `uuid` and
  `data` (one JSON object text, the shape of a full read) plus `dryRun`, `actAs` and `paths`. It follows Foundry's JSON
  import (`Document.fromImport`, then `update(data, { diff: false, recursive: false })`) but fires the `preUpdate*` and
  `update*` hooks. Every top-level field the data omits is reset to its default (omitted `items` or `effects` are
  emptied, omitted `flags` wipes other modules' flags), so send a full read with your change in it, and use
  `update_documents` for a sparse change. `_id`, `sort`, `ownership` and `folder` are preserved, the module's own
  `flags.wiretap` records are carried over, Users are refused, and only primary document classes are handled. `batch`
  takes `creates` (`{documentName, data, parentUuid?}`), `updates` (flat patches as in `update_documents`), `deletes`,
  `dryRun` and `actAs`, and sends them to `foundry.documents.modifyBatch` in that order. Foundry validates every
  operation first and writes nothing when one fails; it then applies them one by one and stops at the first failure, so
  a batch is NOT atomic and the earlier operations stay applied. Operations Foundry drops (an update that changes
  nothing, or one a hook cancels) report `changed: []`; a shortfall is `WRITE_NOT_APPLIED` with how many operations were
  applied, unchanged, cancelled, failed or not written. The rows follow the entries: created row i is create entry i, an
  updated row per uuid comes in the order of its first patch, and deleted rows come in the order given. Every operation
  passes the same write guard as the single tools, `_id` is never a writable path, and the ack of a 50-document batch is
  at most 4,000 bytes. `create_documents` accepts `idempotencyKey` (1 to 64 of `A-Z a-z 0-9 . _ : -`): the key is stored
  as the module flag `flags.wiretap.idem` on each created document, a repeat of the same request within one day returns
  the first call's rows and creates nothing, and the same key with other data (or after one of its documents was
  deleted) is `IDEMPOTENCY_CONFLICT`. For a copy the request hash covers `fromUuids` as given, not the source content,
  so a retry after a source was edited returns the first call's rows; a keyed retry replays only while every source
  still resolves and passes the checks that run before the replay lookup (resolution, the read refusals and the write
  guard), else it returns that refusal and writes nothing. With `keepId`, the taken-id check runs after the lookup, so a
  keyed retry whose ids its first call took replays. In a collection of more than 20,000 documents the lookup still runs
  and the call writes one warning line. The whole `flags.wiretap` scope, and any write that would erase `flags`, is
  refused (`GATE_DENIED`). `actAs` (a user id) on every write tool is best-effort and advisory: after the gates have
  been judged, Foundry is asked whether that user could make the same change (`Document#canUserModify` with the action
  `create`, `update` or `delete`); if not, the call is refused with `ACT_AS_DENIED` and nothing is written. The write
  still runs as the game master's client, so `actAs` can only add a refusal. A `data` text of `create_documents` or
  `replace_document` may be `handle:<id>` of a stored result (the JSON text of one document, for example a
  `get_document` full read from the same session): the sidecar replaces it with the stored text before the call reaches
  the Foundry client, so the client's gates and write guard judge the resolved content. Each handle is read whole, and
  the texts of one call, inline ones included, hold at most 64,000,000 bytes in all (`HANDLE_TOO_LARGE` past that); an
  unknown, expired or foreign handle is `HANDLE_NOT_FOUND`, and a stored text that is not one document
  `HANDLE_NOT_DOCUMENT`.
- **Sheets, dice and macros.** `open_sheet` takes `uuid` and an optional `userId`. With `userId` it opens the document's
  sheet on that connected user's client, through the Foundry user query `wiretap.openSheet`; the receiving client
  refuses a sender who is not a game master and opens the sheet only when its user has OBSERVER on the document
  (`SHEET_DENIED` otherwise; Foundry itself would show a sheet at LIMITED). Without `userId` the sheet opens on the GM
  client running the call. Nothing is broadcast to other users. `close_sheet` takes the same arguments and closes the
  sheet the same way (query `wiretap.closeSheet`, same game-master check), reporting `closed: false` when none was open.
  An offline user is `USER_OFFLINE`; a user's client that does not answer within 5 s is `SHEET_QUERY_FAILED`. With no
  human connected (only an agent runner), no one sees a sheet: an agent reads the data or measurements instead. Both
  results are at most 128 bytes. `roll` takes a dice `formula` (at most 256 characters, no `@` references) and returns
  the total and each die within 512 bytes (`cut: true` when results are left out). `draw_table` takes a RollTable
  `uuid`, draws with Foundry's own draw (drawn results are marked when the table has no replacement) and returns the
  rows within 1,000 bytes; nothing left to draw is `TABLE_EMPTY`. Both take `toChat`, default false: only `toChat: true`
  posts the roll or the draw to chat. `execute_macro` runs a Macro by `uuid` on the GM client and returns `{ type, value
  }` (a Document as its uuid; an unserializable value as `unserializable: true`; a value too large for the wire as
  `tooLarge: true` with its size in bytes, which shows the macro ran but not that it worked). `actorUuid` and
  `tokenUuid` name the actor and token the macro acts on (a token must be on the scene that client views; a chat macro
  speaks as them), and `timeoutMs` (1 to 2,147,481,647 ms, default 8 s; past 5 minutes the GM's browser writes one
  warning line) sets how long it may run. A macro that does not compile ran nothing; one that throws may have partly
  run; both are `MACRO_FAILED`. It needs the `allowMacroExecution` gate.
- **Compendium packs.** `create_pack` takes `label` (1 to 128 characters, not blank), `type` (one of Foundry's pack
  document types: `ActiveEffect`, `Actor`, `Adventure`, `Cards`, `Item`, `JournalEntry`, `Macro`, `Playlist`,
  `RollTable`, `Scene`), an optional `name` (letters, digits, `-` and `_` of any length, not a reserved device name such
  as `con` or `nul`, as Foundry requires; past 64 characters the GM's browser writes one warning line; by default the
  slug of `label`, as Foundry derives it) and `dryRun`. It creates the world pack `world.<name>` and returns `{ id,
  label, type }`; a dry run returns `{ dryRun: true, id, label, type }` and creates nothing. A name a world pack already
  has, compared without regard to case (pack folders are named after the pack, and Windows folder names ignore case),
  and a label with no letters or digits and no `name` are refused with `ARGS_INVALID`. `delete_pack` takes `id`
  (`world.<name>`) and `dryRun` and deletes the pack with every document in it, returning `{ id, deleted: true }`; a dry
  run returns `{ dryRun: true, id, label, type, documents }` (the count from the pack index) and deletes nothing.
  **Deletion is irreversible**: Foundry's `deleteCompendium` asks the Foundry server, which removes the pack's files
  itself; Wiretap removes no file. Only world packs can be created or deleted (`delete_pack` refuses a system or module
  pack with `ARGS_INVALID`); an unknown id is `PACK_NOT_FOUND`; a locked pack is refused with `PACK_LOCKED`, and the GM
  unlocks it in Foundry (Wiretap never changes a lock). A real `create_pack` needs `allowCompendiumWrites` and a real
  `delete_pack` needs `allowPackDeletion`; each checks its gate first, so a closed gate reveals nothing about the
  world's packs, and a dry run needs no gate. Wiretap makes each of these refusals before Foundry is called, so it shows
  no error on the GM screen. Both results are at most 256 bytes (a long label is cut). **Asking the human before
  `delete_pack`.** Measured here (integration and e2e tests): the sidecar lists `delete_pack` with
  `_meta["anthropic/requiresUserInteraction"]: true` whatever the GM client's definition says. Documented by Claude
  Code, not tested in this project: Claude Code shows the permission prompt of such a tool on every call, even in the
  `acceptEdits`, `auto` and `bypassPermissions` modes, and an allow rule that matches the tool does not skip it ([Claude
  Code MCP docs](https://code.claude.com/docs/en/mcp), "Require approval for a specific tool"). Unverified: the first
  Claude Code version that honours the entry (the official page names none). That prompt is shown by Claude Code, so
  another MCP client or a local process is not prompted; the `allowPackDeletion` gate stays Wiretap's own control (the
  residual risk).
- **Expiry.** A session expires after 30 minutes without a request that carries its id (an open event stream alone does
  not count); the idle sweep runs once per minute. There is no cap on sessions: past 32 open sessions each new one
  writes the sidecar log line `MCP session <id> opened: <n> sessions are open, more than the 32 recommended`. Ending a
  session releases the result handles it owns. One client may open several sessions over its life (measured).
- **Request limits.** A request body over 1,048,576 bytes gets `413`; a request whose headers or body take longer than
  10 s and 15 s gets `408`; a connection that sends no request for 30 s is closed (one with a request in flight, such as
  an open event stream, is not); at most 128 connections are served at once (a connection closed for that limit writes a
  throttled log line). An unknown session id is answered `404` before any body is read. A refused request is answered
  with `Connection: close` once the rest of its body (up to 8 MiB) has been read and discarded, so the client sees the
  status instead of a reset connection.

## Document backups

Four tools run in the sidecar and save Foundry documents to files and put them back. The documents travel between the
GM's browser and the sidecar in pieces of at most 512,000 bytes and never pass through the agent's context. The
user-facing skill tells the agent to make or offer a backup before a bulk update, a replace, a delete or a macro that
changes documents.

- **`backup_documents`** takes exactly one of `uuids` (one or more; an embedded document's uuid backs up its parent
  document), `folderUuid` (a Folder, its subfolders and everything in them), `documentName` (every world document of
  that type and its Folders) or `pack` (a compendium pack and its Folders), plus optional `folder`, `note` (no control
  characters, at most 837 bytes as JSON text, the room the fixed 2,048-byte header line leaves), `dryRun` (measure only;
  nothing is written) and `timeoutMs` (1 to 2,147,481,647 ms, default 120,000). It returns `{ file, folder, documents,
  bytes }` (`folder` is `default`, `setting` or `named`), plus `unreadable` (selected documents that could not be read)
  and `parents` when above 0; a dry run returns `{ dryRun: true, folder, documents, bytes }` with no `file`. A backup
  has no document or byte cap: past 10,000 documents, 64,000,000 bytes, 200 uuids, a 300,000 ms `timeoutMs` or a
  200-byte note the sidecar writes one warning line per measure (`restore_backup` warns the same way); `User` and
  `Setting` documents are refused, because the export drops passwords and redacts setting values. A document that cannot
  be exported whole is counted as unreadable, never written cut.
- **`list_backups`** takes `folder` and `limit` (1 or more, default 10; past 50 a warning line) and returns the newest
  backups as `[file, created, documents, note]` rows with the `total` count (and `invalid` for files that fail the
  checks, `unread` for files the listing's 1,000 header reads did not reach).
- **`restore_backup`** takes `file`, `folder`, `uuids` (restore only these), `dryRun` (plan only) and `timeoutMs`.
- **`delete_backup`** takes `file` and `folder` and moves the file to the recycle bin.

**Where backups go.** With no `folder`, a backup goes to the GM's **Backup folder** setting when it is set (an absolute
path to a folder that exists) and otherwise to the default folder `.wiretap/backups/` in the module folder (created on
first use; gitignored). A `folder` argument must be an absolute path to a folder that exists; naming any folder other
than those two needs the `allowBackupAnyFolder` gate. Symbolic links (and Windows junctions) are refused for the folder
and the file. The sidecar names every file (`<UTC time>-<8 random characters>.wtbackup.jsonl`), creates it exclusively
so no file is ever overwritten, and opens, restores or deletes only a file of that name whose header checks out.
`list_backups` and `delete_backup` work with no GM connected, on the default folder only; a backup and a restore need a
GM's browser. One backup or restore runs at a time (`BACKUP_BUSY`).

**What a backup holds.** A JSON Lines file: a header (world, Foundry and system versions, note, counts), then one line
per document with its stored data, Folders first, parent before child. It is redacted like every read (no `User`
password, no secret-named keys in flags); a restore copies the live value of each left-out secret back, and counts in
`secretLost` the documents where none exists any more.

**Restoring.** A restore is refused for a backup of another world. It is **not atomic**: documents are applied one by
one in file order, and each runs Foundry's hooks and the game system's side effects, which are not reverted; a restore
stopped by its time limit or a disconnect is partly applied. Each document goes through the write gates exactly as the
write tools would: a document that still exists is replaced (`allowReplace`; `allowOwnershipWrites` when its
ownership differs; `allowDelete` when embedded documents were added since, because they are removed), and a deleted one
is created again with its id (`allowOwnershipWrites`, as for `create_documents` with that ownership). A replaced
document gets back its own ownership and that of its first-level embedded documents; deeper embedded documents (for
example the Items in a token's ActorDelta) come back with default ownership. A compendium
target needs `allowCompendiumWrites` and an unlocked pack. A document that fails (a closed gate, a pack or type that no
longer exists, invalid data) is reported in its row and does not stop the others. `dryRun` runs every check with the
gates of a real run and writes nothing. The result counts `replaced`, `created`, `skipped`, `failed` and `secretLost`,
shows up to 20 rows (failures first) and lists `differences` when the Foundry or system version differs from the
backup's.

**Recycle bin only.** Wiretap never deletes a file permanently: `delete_backup`, and a partial file left by a failed
backup, go through the recycle bin (the `trash` package). If the recycle bin refuses, the file stays. `delete_backup`
then fails with `TRASH_FAILED` naming the file. A failed backup keeps its own error code (for example
`BACKUP_INCOMPLETE` or `ENDPOINT_GONE`); when the recycle bin refuses its partial file, the message ends by naming
that file, as the sidecar log does.
Limit, per the `trash` README: a sidecar running as the Windows
SYSTEM account (or another service account) sends files to that account's recycle bin, not the signed-in user's.

**Whole-world backups** are not made by these tools: make one on Foundry's setup screen with the world shut down.

## Wiretap skill for Claude Code

`skills/wiretap/SKILL.md` is a short user-facing skill that tells an agent which Wiretap tools exist
(`mcp__wiretap__list_document_types`, `mcp__wiretap__get_document`, `mcp__wiretap__search_documents`,
`mcp__wiretap__describe_schema`, `mcp__wiretap__create_documents`, `mcp__wiretap__update_documents`,
`mcp__wiretap__delete_documents`, `mcp__wiretap__replace_document`, `mcp__wiretap__batch`,
`mcp__wiretap__open_sheet`, `mcp__wiretap__close_sheet`, `mcp__wiretap__roll`, `mcp__wiretap__draw_table`,
`mcp__wiretap__execute_macro`, `mcp__wiretap__create_pack`, `mcp__wiretap__delete_pack`, `mcp__wiretap__backup_documents`, `mcp__wiretap__list_backups`,
`mcp__wiretap__restore_backup`, `mcp__wiretap__delete_backup`, `mcp__wiretap__read_handle`) and how to use them,
including when to make or offer a backup. It is not installed automatically:
copy the `skills/wiretap` directory into the `.claude/skills/` directory of the project that runs `claude` (a skill for
one project), or into `~/.claude/skills/` (a skill for every project), so that the file is
`.claude/skills/wiretap/SKILL.md`, then start a new `claude` session. A symbolic link to the directory works the same
way where your system allows one (`ln -s <module>/skills/wiretap <target>/wiretap`; on Windows `mklink /D` needs a
console with symbolic-link rights). The skill names only tools that exist; a test (`tests/unit/shippedSkill.test.js`
and the context-budget test) fails when it names one that does not.

## Plugin tools (for module authors)

Another Foundry module can give the agent its own tools. A **plugin tool** is a routine your module registers through
Wiretap's client API; Wiretap lists it to the agent beside its own tools, as `<moduleId>__<name>`, and runs it in the
GM's browser like any Wiretap tool. The GM decides which modules' tools the agent sees: a plugin tool is listed and
callable only while your module id is in the world setting `allowedPluginModules` (comma-separated module ids, empty by
default). A tool of a module that is not listed is left out of the agent's tool list; a call that still reaches it (for
example one sent just after the GM removed the module) is refused with `GATE_DENIED` by the sidecar and again by the
browser that would run it. A change of the setting updates the tool list without a reload.

**A complete minimal example.** Your module needs no import from Wiretap; the API arrives with the hook:

```js
Hooks.once('wiretap.registerTools', (api) => {
   if (api.apiVersion !== 1) {
      console.warn('my-module | unsupported Wiretap plugin API version', api.apiVersion);
      return;
   }
   const outcome = api.registerTool({
      moduleId: 'my-module',
      name: 'count_actors',
      version: '1.0.0',
      description: 'Count the world actors of one type. Pass type (an Actor type); returns { type, count }.',
      inputSchema: {
         type: 'object',
         properties: { type: { type: 'string', maxLength: 64 } },
         required: ['type'],
         additionalProperties: false,
      },
      mutates: false,
      requires: 'api',
      handler: async (args, ctx) => {
         return {
            type: args.type,
            count: game.actors.filter((actor) => actor.type === args.type).length,
         };
      },
   });
   if (!outcome.ok) {
      console.warn('my-module | Wiretap refused count_actors:', outcome.reason);
   }
});
```

`registerTool` returns `{ ok: true, name }` with the registered name (here `my-module__count_actors`) or
`{ ok: false, reason }` with a reason that says what to change. It never throws. In Claude Code the agent sees it as
`mcp__wiretap__<moduleId>__<name>`.

**When to register.** Wiretap fires `wiretap.registerTools` once, from its own `ready` hook, on every client, and that
call is the only way the API reaches your module (`game.modules.get('wiretap').api` does not hold it). Add the listener
while your module's code runs: at the top level of your entry script, as the example does, or in your `init` or `setup`
hook. Foundry runs every module's code and calls `init` and `setup` before `ready`, so such a listener is in place
whether your module loads before or after Wiretap. A listener added inside your own `ready` hook misses the call
whenever Wiretap's `ready` hook runs first: your module then gets no API and no error. On a GM client the hook fires
after Wiretap's own tools are registered. To register later in the session, keep the `api` object the hook passed you
and call `api.registerTool` on it: each accepted tool is sent to the sidecar and every agent session gets a tool-list
change. Registration works on every client, so your module needs no role check, but only GM clients connect to the
sidecar, so only the tools of a GM's browser reach the agent. There is no unregister call: a disabled module's tools
disappear after the next reload.

**Naming.** You pass the short `name`; Wiretap registers `<moduleId>__<name>`. `moduleId` is your module's id from
`module.json`, exactly as Foundry accepts it: one or more of `A-Z`, `a-z`, `0-9`, `_` and `-` (no dots or spaces),
matched exactly, so `MyMod` and `mymod` are different modules. It must name a module that is active in this world.
The short name uses the same characters, without the `<moduleId>__` prefix. The whole name may be at most 50
characters: Claude Code lists each tool as `mcp__wiretap__<name>`, and the Anthropic API accepts tool names of at most
64 characters. A name another tool already has is refused, so the first registration of a name wins.

**The fields.**

| Field | Required | Meaning |
|---|---|---|
| `moduleId` | yes | Your module's id; the module must be active |
| `name` | yes | The short tool name |
| `version` | yes | A non-empty string; one that is not semver-like (`1.0.0`) or is over 32 characters draws a warning |
| `description` | yes | One line of text, no control characters; over 160 characters draws a warning, over 240 another |
| `inputSchema` | yes | A JSON Schema object of the supported subset (below) |
| `handler` | yes | `(args, ctx) => result`, sync or async; `args` are the validated arguments |
| `mutates` | yes | `true` or `false`: whether a call can change the world; listed as `readOnlyHint`, never defaulted |
| `requires` | yes | `'api'` (any GM client) or `'dom'` (only a DOM-capable agent endpoint, see [Bridge routing](#bridge-routing-and-identify-protocol-v5)) |
| `result` | no | `{ budgetBytes }`: the most bytes returned inline; default `{ budgetBytes: 2000 }`, at most 16,000 applied |
| `gate` | no | A risk gate every call also needs, for example `allowDelete`; any gate of [Settings and risk gates](#settings-and-risk-gates) except `allowedPluginModules` |
| `handleArgs` | no | Names of text arguments (or lists of texts) that may be given as `handle:<id>` of a stored result; more than 4 draws a warning |
| `strictNested` | no | Only `true`: nested objects also refuse undeclared keys |
| `requiresUserInteraction` | no | Only `true`: Claude Code asks the human before every call |

The supported `inputSchema` subset is a root `object` whose properties are `string` (`enum`, `minLength`,
`maxLength`), `number` and `integer` (`minimum`, `maximum`), `boolean`, `array` (`items`, `minItems`,
`maxItems`) or nested `object` (`properties`, `required`, `additionalProperties: false`), each with an optional
one-line `description`. Property names match `[A-Za-z_][A-Za-z0-9_]{0,63}`. The sidecar checks every call's arguments
against it before the call is sent, and the browser checks them again before your handler runs.

**What the handler gets.** `ctx` is frozen and holds `core` (Wiretap's document operations: `createDocuments`,
`updateDocuments`, `deleteDocuments`, `replaceDocument`, `batchDocuments`, `documentTypes`, `readDocument`,
`searchDocuments`, `describeSchema`),
`shape` (`compact`, `project`, `paths`, `ack`: result shaping), `signal` (aborts when the call times out; stop
long work on it), `log` (writes one line to Wiretap's log; never throws) and, for `requires: 'dom'` only, `dom`
(`{ document }`). `ctx.core` runs the same code as Wiretap's own tools, so every risk gate and the write guard apply
inside it: a plugin tool cannot write a User, a setting or macro code through `ctx.core` unless the GM opened that
gate. A handler that runs longer than 8 s fails with `SCRIPT_TIMEOUT`; a thrown error reaches the agent as
`OP_FAILED` with its message (at most 256 bytes). A result must serialize to JSON within 900,000 bytes.

**Two gates.** Every call of a plugin tool needs `allowedPluginModules` to list its module. A tool that declares
`gate` needs that gate open too. The sidecar judges both on the endpoint it picked before it sends the call, and the
browser judges both again from its own world settings.

**The three groups of checks.** Wiretap holds its own tools to the size guidelines below and refuses them past one: the
browser refuses such a tool at registration, so it is not listed, and the test suite fails. A plugin tool past a
guideline is accepted, and Wiretap writes one warning line to the browser console (`Wiretap | script registry warning
for "<name>": <text>`) and to the sidecar log (`Wiretap sidecar | registry warning for tool "<name>": <text>`). A rule
the tool needs to work refuses every tool.

1. **Best practice (a plugin tool gets a warning).** `<n>` is the measured value:
   - `description is <n> characters, over the 240-character guideline`, or below that
     `description is <n> characters, over the 160-character target`: the description is paid for in the agent's
     context; shorten it.
   - `result.budgetBytes is <n>, over the 16000-byte result cap; the cap applies`: a larger result becomes a handle
     (below); declare at most 16,000.
   - `listed definition is <n> bytes, over the 800-byte guideline`: name, description and schema as listed; shorten
     the description, drop schema descriptions or split the tool.
   - `version is <n> characters, over the 32-character best practice` and
     `version is not semver-like (MAJOR.MINOR.PATCH, for example 1.0.0)`.
   - `handleArgs lists <n> names, over the 4-name best practice`.
   - Schema guidelines, at most one line each, carrying the largest value measured:
     `schema nests objects and arrays <n> levels deep, over the 4-level guideline` (the root is level 1);
     `schema has <n> nodes, over the 64-node guideline`;
     `an object schema has <n> properties, over the 32-property guideline`;
     `an enum has <n> values, over the 32-value guideline`;
     `an enum value is <n> characters, over the 64-character guideline`;
     `a length or item bound is <n>, over the 100000 guideline`;
     `an array schema declares no maxItems; the guideline is a maxItems of at most 1000`;
     `an array schema allows <n> items, over the 1000-item guideline`;
     `a schema description is <n> characters, over the 240-character guideline`. Flatten, split or bound the schema.
2. **Needed to work (refused, `ok: false`).** The reasons an author can get, and what to change:
   - `moduleId must be your module's id from module.json: one or more of A-Z, a-z, 0-9, _ and - (no dots or spaces)`:
     pass the `id` of your `module.json`.
   - `moduleId "<id>" is not an active module in this world: pass your own module's id and enable the module`.
   - `name already starts with "<moduleId>__"; pass only the short name, Wiretap adds the prefix`, and
     `name is your tool's short name: one or more of A-Z, a-z, 0-9, _ and -; Wiretap adds "<moduleId>__" itself`.
   - `name is <n> characters; Claude Code lists it as mcp__wiretap__<name> and the API accepts at most 64, so
     <moduleId>__<tool> may be at most 50 characters`: shorten the short name.
   - `name "<name>" is already registered: choose another tool name`.
   - `registerTool takes one object: { moduleId, name, version, description, inputSchema, handler, mutates, requires }`.
   - Field rules: `version must be a non-empty string`, `description must be one line of text, not empty`,
     `inputSchema must be an object`, `result must be an object with budgetBytes`,
     `result.budgetBytes must be a positive integer`, `requires must be one of none, api, dom` (and
     `requires none scripts run on the sidecar; a client cannot register them`),
     `mutates must be declared as true or false`, `handler must be a function`,
     `gate must be a registered risk gate other than allowedPluginModules`, `strictNested may only be true`,
     `requiresUserInteraction may only be true`, and the `handleArgs` rules (each name once, a declared text or list
     of texts).
   - `inputSchema: <reason>`: a keyword the converter does not support (`$ref`, `anyOf` and the other combinators,
     `pattern`, `format`, `default`, `const` or an unknown keyword), a bound that is not a non-negative integer, an
     enum that is not a non-empty list of strings, or a property name outside the pattern above. Rewrite that part of
     the schema.
3. **Server protection (the same for every tool).** A schema nested deeper than 32 levels, or one whose walk expands
   past 60,000 nodes (a reused object counts every time it appears), is refused. The browser sends its whole tool list
   in one Socket.IO message the sidecar accepts up to 1,000,000 bytes; when the list would pass 900,000 bytes, plugin
   tools are left out, largest first, each with the console line
   `Wiretap | registry push left out plugin tool "<name>": ...`; Wiretap's own tools are never left out. The sidecar
   applies at most 2 tool-list pushes per second from one browser, the handle store and the MCP request limits apply as
   for every tool.

**Large results become handles.** A result over the tool's `result.budgetBytes` (at most 16,000 bytes) is not sent
inline: the sidecar stores it and the agent gets `{handle, bytes, summary}`, which it reads in pieces with
`mcp__wiretap__read_handle` (see [Large results and handles](#large-results-and-handles)). Return a small result by
default and let an argument ask for more.

**Descriptions that stand alone.** The agent must be able to find and use your tool from its name and description
alone: say what the tool does, what to pass and what it returns, in one line within 160 characters, and give the
arguments names that say what they hold. The example's `create_spell` reads "Create a spell Item from parsed spell
text. Required: name, itemType (the spell Item type), text."

**An optional guide skill.** For workflows that need more than a description, ship a Claude Code skill folder with your
module, for example `skills/<moduleId>/SKILL.md`, that names your tools as `mcp__wiretap__<moduleId>__<tool>` and
gives the steps. Write the descriptions first: the skill only helps the users who install it. A user installs it the
same way as Wiretap's own skill (see [Wiretap skill for Claude Code](#wiretap-skill-for-claude-code)): copy the folder
into `.claude/skills/` of a project or into `~/.claude/skills/`, then start a new `claude` session. Wiretap does not
deliver the guide to the agent.

**Context cost.** Every listed tool costs context in every session. Claude Code defers MCP tools and lists only their
names at first, about 13 tokens per name (`docs/PLAN.md` §2.6); a client that does not defer tools sends every full
definition (up to about 800 bytes each) with every request. Wiretap sets no cap on the number of tools or their total
size: register the tools your users need, and keep each one small.

**Module identity is not proven.** Every module's code runs in the same browser page with full access, so any module
can register tools under any active module's id. `allowedPluginModules` controls what the agent sees; it is not a wall
between modules. A module listed there runs arbitrary code with GM authority, like a macro.

**Example.** `examples/spell-text-plugin/` (not shipped with Wiretap) is a complete module: it registers
`wiretap-example-spells__create_spell` (listed as `mcp__wiretap__wiretap-example-spells__create_spell`), which maps
parsed spell text to Item data through one field table, previews the create with `dryRun` and then creates the Item, and
it ships the guide skill `skills/wiretap-example-spells/SKILL.md`. To try it, copy the folder into Foundry's
`Data/modules/` as `wiretap-example-spells`, enable it in the world and add `wiretap-example-spells` to
`allowedPluginModules`.

## Large results and handles

Every MCP tool result passes through a result enforcer (`server/resultBudget.ts`). A text result of at most 8,000
bytes is returned as is. A larger one is kept in the sidecar's memory and the caller gets `{handle, bytes, summary}`
(at most 256 bytes). Budgets count the raw UTF-8 bytes of the text, not the JSON-escaped bytes of the MCP wire message
(1 KB is 1000 bytes), so a result at the cap can be larger on the wire. `bytes` is the size of the stored text. Only a
result that is a single text item holding JSON is described by its top-level keys, entry counts and `name`/`type`
(keys that collide once shortened to 32 bytes are skipped and counted in `omitted`; keys are listed in JavaScript
property order, integer-like keys first). A result with several items or structured content is stored as the items
joined by newlines and described as `text`.

**Raising the limit.** A tool call may pass `maxBytes` (a positive integer) to change the limit for that call; the limit
applied is at most 16,000 and at most the tool's own budget, and a handle response for a call whose `maxBytes` was
lowered carries `maxBytesLowered` (the limit applied). The MCP SDK strips arguments a tool's input schema does not
declare. `read_handle` declares `maxBytes` (128 to 16,000); any other tool opts in by declaring an optional integer
`maxBytes` in its schema, which adds to that tool's definition size. Without the declaration the 8,000-byte limit
applies.

**Reading a handle.** `read_handle` takes `handle` and optionally `paths` (document paths over the stored JSON, the
grammar of `shared/docPath.js`; any number, with one sidecar warning line past 20), `offset`, `length` and `maxBytes`
(128 to 16,000; the 64 bytes above the window are the footer reserve). Offsets and lengths count UTF-16 units. The first
item is the window text, the second a footer `{offset, length, total}`; the window plus footer stay within `maxBytes`. A
window never ends inside a surrogate pair, an `offset` inside a pair moves back to the pair's first unit (the footer
reports the real offset), and `length: 1` at a pair returns the whole pair. When `maxBytes` is too small for the next
character the call fails with `HANDLE_WINDOW_TOO_SMALL`. A `paths` result is built only as far as one window can reach:
a result longer than the window is cut to it and the footer adds `"truncated": true`. The cut depends on the call's
`maxBytes`, and the cut-off tail is reachable only by narrowing `paths`, not by paging. Each `paths` read parses the
stored text again (nothing is cached); measured on this machine, parse plus 20 wildcard paths took about 17 ms for an 8
MB document of long strings and about 185 ms (parse 26 to 55 ms, resolve 153 to 170 ms) for 7.7 MB of 106,000 small
objects. A read that fails (bad range, bad path, not JSON) does not keep the handle alive.

**Limits.** Handles live only in memory, and nothing is written to disk; a sidecar restart loses them. One stored result
is at most 8,000,000 bytes (a larger one is refused with `HANDLE_TOO_LARGE`) and at most 1,024 handles are held (the
least recently used is evicted beyond that; each store that evicts writes one throttled sidecar log line naming the
bound). Handles are owned by the MCP session that stored them and are released when it ends; eviction is still global,
so one session's large results can evict another's. Inside the 64 MB total each entry is accounted as the larger of its
UTF-8 size and twice its character count, plus 256 bytes of overhead; least recently used entries are evicted first, and
a handle not read for 30 minutes (measured on a monotonic clock) expires. A read of an expired, evicted or unknown
handle gets `HANDLE_NOT_FOUND: Handle not found: it may have expired (1800 s unread) or been evicted (1024 handles and
64000000 bytes are kept).`

**Errors and images.** Error text is capped at 512 bytes. A thrown `BridgeError` passes as `<code>: <message>`; any
other failure, and any result the enforcer cannot read (no `content`, non-string text, unserializable content), becomes
a fixed short error (`Tool failed.` or `Tool returned an invalid result.`) and the real cause is written to the sidecar
log only, with control characters and line breaks replaced by spaces and the text cut to 512 bytes. A result is refused
with `IMAGE_LIMIT` when it carries more than one image, an image whose `mimeType` is not `image/png`, base64 data that
is longer than 1,000,000 characters or has any character outside the standard base64 alphabet (whitespace included), or
a PNG whose longest side exceeds 1280 px. The enforcer returns only what it measured: image items as exactly `type`,
`data` and `mimeType`, text items as exactly `type` and `text`, and the result as `content` plus `structuredContent`
when present. `_meta`, `annotations` and any unknown field, on an item or on the result, are dropped, and the sidecar
log names them (`Wiretap sidecar | <tool> result fields dropped: <names>`). The 480,000 px default image area is applied
when a capture tool takes the picture, not by the enforcer.

## Origin validation

Both listeners refuse a request from a browser page of another origin. The allowed origins are the single constant
`ALLOWED_ORIGINS` in `server/origins.ts` (`http://localhost:30000` and `http://127.0.0.1:30000`, the Foundry page
origins, plus `http://localhost:30001` and `http://127.0.0.1:30001`, the Vite dev-server page origins of `npm run dev`):

- **Socket.IO:** the handshake (`allowRequest`) is refused when it carries an `Origin` header that is not listed
  (cross-site WebSocket hijack). A handshake with no `Origin` header, which is what a local non-browser process sends,
  is accepted: the trust model is that same-machine processes are trusted, and there is still no authentication on
  socket events. Each refused handshake is logged as `Wiretap sidecar | refused origin "<origin>"` (the origin cut to
  64 bytes), at most 10 lines per minute, followed by one `N further origin refusals suppressed` line when the window
  ends (written by the next refusal after the window).
- **MCP (`/mcp`):** a request with a listed-or-absent `Origin` and a `Host` of `127.0.0.1:<mcpPort>` or
  `localhost:<mcpPort>` is served; anything else gets `403` (DNS-rebinding defence). MCP clients send no `Origin`. The `Host` is compared with the port the server actually bound,
  so a server started on an ephemeral port (0) accepts its own Host.

The list is not configurable yet; a Foundry served from another port or host needs the constant edited.

## Bridge routing and identify (protocol v5)

Foundry GM clients register with the sidecar as **endpoints** over Socket.IO. Each endpoint has a `kind`: `human` (a
person's tab) or `agent` (an agent-runner browser).

**Routing.** The default order is the single constant `ROUTE_ORDER` in `server/endpoints.ts` (`['agent', 'human']`): an
invocation goes to the earliest-registered endpoint of the first kind that has one, so a connected agent endpoint is
preferred and a human tab is the fallback. A call may pass `endpoint: 'agent' | 'human'` to the router's
`invoke(op, params, { endpoint })` to restrict the choice to that kind with no fallback. With no eligible endpoint the
call fails with `NO_ENDPOINT`.

**Scripts that need the DOM.** A script registered with `requires: 'dom'` (opening sheets, measuring layout) is routed
to the `agent` kind only, and only to an endpoint that identified with `dom: true`; it never falls back to a human tab.
A session opened with `?endpoint=human` is routed to human tabs instead (a DOM-capable one). With no such endpoint the
call fails with `NO_ENDPOINT` (at most 256 bytes) naming the missing kind, for example `No DOM-capable 'agent' GM
endpoint is connected: enable an agent, or restrict this session to a human tab with ?endpoint=human.` A script with
`requires: 'api'` follows the default order above. The endpoint that runs a call must declare the same `requires`
and `mutates` for the script as the listing did, or the call fails with `TOOL_GONE` without being sent.

**Endpoint health.** Every endpoint is `healthy` or `unresponsive`; routing (the default order and the `endpoint`
override alike) skips unresponsive endpoints, keeping the order above among the rest. When an invocation gets no ack within
its reply wait (10 s, or `timeoutMs` + 2 s, see below) the sidecar emits `bridge:ping` to that endpoint (the client acks `{ ok: true }` at once). A ping acked within 1 s
leaves the endpoint healthy (the operation was slow). A ping that is not acked in 1 s, or cannot be written, marks it
unresponsive and the sidecar pings it every 5 s, one ping in flight per endpoint, until one is acked; only a ping ack
restores it (a new identify from an already-registered socket keeps its health and probe), and a disconnect or a refused
identify removes it and stops its probe. The sidecar waits for that ping (at most 1 s) before answering, so a timed-out
call reports `ENDPOINT_TIMEOUT` after up to 11 s. Health log lines are throttled to 10 per minute. Concurrent timeouts
on one endpoint start one probe. When endpoints of the eligible kind are connected but all are unresponsive the call
fails at once with `ENDPOINT_UNAVAILABLE` (an `endpoint` override never switches kind: it returns `ENDPOINT_UNAVAILABLE`
when that kind has only unresponsive endpoints and `NO_ENDPOINT` when none of that kind is connected). The sidecar never
retries a call: it is sent once, and `ENDPOINT_TIMEOUT` reports that the operation may still have applied so the caller
checks before retrying.

**Identify contract (for runner authors).** Emit `bridge:identify` on every (re)connect, with an ack callback:

```js
socket.emit('bridge:identify', {
   protocolVersion: 5,
   userId,
   userName,
   isGM: true,
   kind: 'human', // or 'agent'
   dom: true,
   gateState, // optional risk-gate snapshot, see below
   settings, // optional bridge settings: { backupFolder }, see below
}, (ack) => { /* { ok: true } or { ok: false, error: { code, message } } */ });
```

The sidecar registers the endpoint and then acks `{ ok: true }`; calls routed after that ack succeed. A refused
identify acks `{ ok: false, error: { code, message } }` and registers nothing: `PROTOCOL_MISMATCH` (any other
`protocolVersion`, including a v1 payload without one, or a malformed field; reload Foundry) or `NOT_GM`. A refused
identify also removes any earlier registration of the same socket. A repeated identify on the same socket updates its
entry; a disconnect removes it. Limits: `userId` is at most 64 bytes and `userName` at most 128 bytes (longer is
`PROTOCOL_MISMATCH`). There is no cap on endpoints: past 64, each new socket that identifies writes one sidecar log
line. Refused-identify log lines are throttled to 10 per minute in total; the ack is never throttled.

**Risk gates.** A gate is a world-scope GM setting that unlocks a class of dangerous operation. The registry is
`shared/gates.js` (`GATES`): the boolean gates `allowMacroExecution`, `allowUserWrites`, `allowSettingWrites`,
`allowFileUpload`, `allowOwnershipWrites`, `allowCompendiumWrites`, `allowModuleConfigWrites`, `allowDelete`,
`allowReplace`, `allowPackDeletion`, `allowBackupAnyFolder` and `allowAgentScripts` (all default `false`) and
`allowedPluginModules` (an array of module ids, default empty). There is no undo gate. The client reports its gate
values as a snapshot object with exactly those keys: in the identify's optional `gateState`, and again by emitting
`bridge:gateState` `{ gateState, settings }` (ack callback optional) whenever a gate or a bridge setting changes; a
payload without `gateState` closes every gate. `settings` carries the world settings the sidecar acts on, today only
`backupFolder` (a string of at most 1,024 bytes with no control characters; anything else is treated as unset, and the
GM's browser logs once that the default folder is used instead), kept per endpoint. The sidecar sanitizes every
snapshot: only the registry names are read, each only as an own property and only with its registry type (booleans;
`allowedPluginModules` is a list of any length of Foundry module ids, one or more of `A-Z`, `a-z`, `0-9`, `_` and `-`,
matched exactly, duplicates removed; the GM's browser logs once each stored entry it ignores); every other key and every
wrong-typed value is dropped and the gate stays closed. An absent or non-object snapshot closes every gate. The snapshot
belongs to the sending endpoint: a repeated identify replaces it, a `bridge:gateState` from a registered GM endpoint
replaces only that endpoint's snapshot and acks `{ ok: true }`, and one from a socket that is not a registered endpoint
(never identified, refused, disconnected) changes nothing and acks `{ ok: false, error: { code: 'NOT_GM', message } }`;
those refusals are logged at most 10 per minute. If handling a snapshot throws, that endpoint's gates are all closed and
the sender gets `{ ok: false, error: { code: 'OP_FAILED', message } }`. Snapshots never appear in a tool result or a log
line.

The sidecar snapshot is a **pre-check only**. The executing browser re-enforces every gate from its own world settings
and never from a parameter, because the identify payload is self-declared and same-machine processes are trusted until
tokens exist: a forged GM endpoint can claim open gates, which is why the client re-checks. The sidecar enforces a gate
by passing `requireGate: { gate, moduleId? }` to `invoke`: the router picks one endpoint, judges that endpoint's own
snapshot, throws `GATE_DENIED` before sending when it is closed, and otherwise sends to that same endpoint, so no
endpoint change can split the check from the send. `bridge.gateState()` is a display accessor only. A gate denial is a
`GATE_DENIED` error of at most 256 bytes that names the gate and says only a GM can enable it in the Wiretap module
settings; `GATE_DENIED` is not a reserved code (the executing client may send it), so a received one is never proof that
a sidecar check ran. No write path may write a `Setting` whose key is in the `wiretap` namespace:
`denyWiretapSettingWrite` refuses it, and callers write the string `resolveSettingKey` returns (resolve a by-id update
to its key first; pass a namespaced setting as `{ namespace, key }`). The module's own client sends no snapshot, so every
gate reads closed.

**Wiretap client.** The module's Foundry client sends this identify (protocol 5, `dom: true`) on every (re)connect, with
`kind` taken from the client-scope setting `wiretap.endpointKind` (`human` by default; an agent runner sets `agent`). The
client counts as identified only after an `{ ok: true }` ack: `game.modules.get('wiretap').api.bridge.identified` is
`true` from that ack until a disconnect or a refusal, so a runner waits on it before invoking tools. A refused ack is
logged to the browser console with the sidecar's message; for `PROTOCOL_MISMATCH` reload Foundry. The client has no
fallback to an older protocol.

**Invocation and errors.** The sidecar emits `bridge:invoke` `{ op, params, requestId }` (`requestId` is a UUID per call
and appears in sidecar log lines). The client acks `{ ok: true, result }` or `{ ok: false, error: { code?, message,
failures? } }`. Failures reach the caller as `{ code, message, failures?, failureCount? }` with codes `NO_ENDPOINT`,
`ENDPOINT_UNAVAILABLE` (endpoints connected, all unresponsive; refused without sending), `ENDPOINT_TIMEOUT` (no ack
within the call's reply wait: 10 s, or `timeoutMs` + 2 s for a tool that declares `timeoutMs` when the call sets it;
the message names that wait and says the operation may still have applied; it is reported after up to the wait plus
the sidecar's health ping of at most 1 s), `ENDPOINT_GONE` (the endpoint disconnected, or could not be written to,
before it acked; reported at once, not after the wait), `OP_FAILED` (the default when the client gives no code), `PROTOCOL_MISMATCH`,
`NOT_GM`. All of them except `OP_FAILED` are reserved, as are `TOOL_GONE` and the backup codes
only the sidecar produces (`BACKUP_NOT_FOUND`, `BACKUP_INVALID`, `BACKUP_BUSY`, `BACKUP_FOLDER_INVALID`,
`BACKUP_WRITE_FAILED`, `TRASH_FAILED`): a code of that name in a client's failure ack is reported as `OP_FAILED`.
Messages are at most 512 bytes (256 for `NO_ENDPOINT`), truncated with `…`; `failures` is
capped at 10 entries with `failureCount` holding the true total. MCP error results are at most 512 bytes in total:
`<code>: <message>`, then as many `path: message` failure lines as fit, then ` (+N more)` for the failures not shown.
A registered script's ack result is shown as text (a string as is, anything else as JSON) behind the result enforcer with
the script's own `result.budgetBytes`; an ack with no result is shown as `null`.

## Settings and risk gates

Wiretap registers its settings in Foundry's module settings. The client-scope settings (sidecar URL, terminal command,
theme, font size, endpoint kind) belong to each browser. The risk gates are world-scope, GM-only (`restricted`)
settings, all off by default; each unlocks a class of dangerous operation for agents:

| Setting | Unlocks |
|---|---|
| `allowMacroExecution` | Running macros with `execute_macro` (arbitrary code), and writing code that runs later: a Macro `command`, a Macro `type` changed to `script`, an Adventure's stored macros, or a region behavior that runs a script (in a region, a scene or an Adventure); a `dryRun` of such a write needs it too |
| `allowUserWrites` | Creating, updating and deleting User documents |
| `allowSettingWrites` | Writing Setting documents and world or user settings |
| `allowFileUpload` | Base64 data in file-path fields and the file upload tool |
| `allowOwnershipWrites` | Changing the ownership of documents |
| `allowCompendiumWrites` | Writing compendium packs and their documents |
| `allowModuleConfigWrites` | Writing the module configuration (enables and disables modules) |
| `allowDelete` | Deleting documents with `delete_documents` or the deletes of a `batch` (previews need no gate) |
| `allowReplace` | Replacing whole documents with `replace_document` (previews need no gate) |
| `allowPackDeletion` | Deleting an unlocked world compendium pack and every document in it with `delete_pack`, irreversibly (previews need no gate); arbitrary-code paths (`execute_macro`, plugin tools, agent scripts) can delete a pack without it |
| `allowBackupAnyFolder` | Writing, listing, restoring and deleting backup files in a folder other than the default (`.wiretap/backups` in the module folder) or the Backup folder setting |
| `allowAgentScripts` | Saving, disabling and running agent-saved scripts (arbitrary code) |
| `allowedPluginModules` | Plugin tools of the module ids listed (comma-separated; empty by default; see [Plugin tools](#plugin-tools-for-module-authors)) |

Two more world-scope, GM-only settings are not gates:

| Setting | Holds |
|---|---|
| `backupFolder` | The absolute path of the folder backups are written to; empty (the default) uses `.wiretap/backups` in the module folder. A GM client sends it to the sidecar with its gate snapshot. |
| `terminalScrollback` | The terminal's scrollback size in characters, default 65,536. The browser's buffer follows a change at once; the sidecar's replay buffer takes the value at the next terminal launch, and logs one warning line for a value past 1,048,576. |

The gate definitions live in `shared/gates.js`; the settings are registered from that table. A GM client sends its
gate snapshot to the sidecar when it identifies and again whenever a gate setting changes. The sidecar uses the snapshot
as a pre-check, and the executing browser re-reads its own settings before it acts, so a gate is always judged by the
world setting of the client that would run the operation. No bridge operation can write a `wiretap.*` setting:
the write tools refuse one on create, update (by id or by a changed `key`) and delete, whatever the gates say.

The push ignores a change whose author is not a GM. Trust assumption: `restricted` only hides the setting in the
settings window; Foundry lets any user holding the `SETTINGS_MODIFY` permission write a world setting, and that
permission can be granted to a non-GM role. The executing browser reads the stored value whoever wrote it, so a user
holding `SETTINGS_MODIFY` is trusted at GM level for the gates.

Known limit: any arbitrary-code capability (`allowMacroExecution`, `allowAgentScripts`, the tools of a listed plugin
module) can call `game.settings.set` directly. While one is enabled, the guarantee is only that no tool of Wiretap's
own can change a gate.

## Documentation

See [`docs/README.md`](docs/README.md) for the index. Key files: [`docs/PLAN.md`](docs/PLAN.md) (plan and design),
[`docs/PROGRESS.md`](docs/PROGRESS.md) (milestone history), [`docs/TODO.md`](docs/TODO.md) (deferred work),
[`docs/OPEN_BUGS.md`](docs/OPEN_BUGS.md) and [`docs/CLOSED_BUGS.md`](docs/CLOSED_BUGS.md) (bugs).
