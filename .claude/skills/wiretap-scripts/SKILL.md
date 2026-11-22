---
name: wiretap-scripts
description: Wiretap client script runtime — the shipped script registry, the callTool dispatcher and its timeoutMs convention, ctx (core, shape, signal, dom), argument validation, the core read scripts list_document_types, get_document, search_documents and describe_schema, the core write scripts create_documents, update_documents and delete_documents (canonical export, exclusions, key-field lists, search paging, schema walker), and the user-facing skill skills/wiretap. Use when reading or editing src/bridge/scripts/, shared/schemaValidate.js, shared/utf8.js, shared/logText.js or skills/.
paths:
  - "src/bridge/scripts/**"
  - "shared/schemaValidate.js"
  - "shared/utf8.js"
  - "shared/logText.js"
  - "skills/**"
  - "tests/unit/schemaValidate.test.js"
  - "tests/unit/scriptRegistry.test.js"
  - "tests/unit/scriptShape.test.js"
  - "tests/unit/scriptCore.test.js"
  - "tests/unit/callTool.test.js"
  - "tests/unit/canonical.test.js"
  - "tests/unit/getDocument.test.js"
  - "tests/unit/listDocumentTypes.test.js"
  - "tests/unit/searchDocuments.test.js"
  - "tests/unit/canonicalBackup.test.js"
  - "tests/unit/schemaWalk.test.js"
  - "tests/unit/describeSchema.test.js"
  - "tests/unit/mockFields.js"
  - "tests/e2e/searchSchema.spec.js"
  - "tests/e2e/everyType.spec.js"
  - "tests/unit/e2eRegistry.test.js"
  - "tests/unit/mockDocuments.js"
  - "tests/integration/readTools.test.js"
  - "tests/e2e/readTools.spec.js"
  - "tests/e2e/keyFields.measure.spec.js"
  - "tests/unit/shippedSkill.test.js"
  - "tests/unit/foundryBridge.scripts.test.js"
  - "tests/e2e/scripts.spec.js"
  - "tests/e2e/registry.js"
  - "tests/e2e/registryCore.js"
  - "tests/e2e/registry.spec.js"
---

# Wiretap client script runtime (`src/bridge/scripts/`)

Current-state reference; verify against code before relying on a detail. Core context: `wiretap-codebase-core`; the
wire side (sidecar, router, `bridge:registry` sanitizing) is in `wiretap-mcp-bridge` and `wiretap-mcp-sessions`; the
bridge wiring that pushes the registry and acks ops is in `wiretap-client`.

A **script** is a named, versioned routine the Foundry client registers (definition: `shared/scripts.js`; handler:
client-only, never on the wire). Every MCP tool except the sidecar's built-ins (`read_handle` and the four backup tools,
the names in `RESERVED_SCRIPT_NAMES`) is a script. Scripts call ops
(`ctx.core`), never the reverse.

## Files

| File | Role |
|---|---|
| `registry.js` | `createScriptRegistry({ log? })` → `{ register, get, definitions, subscribe }`; module singleton `scriptRegistry`; `registerScript(def, handler)`; `ScriptError(code, message)` |
| `callTool.js` | `createCallTool({ registry, timeoutMs? })` → the `callTool` op handler; `SCRIPT_TIMEOUT_MS` (8000), `RESULT_WIRE_MAX_BYTES` (900,000), `SCRIPT_BUSY` |
| `ctx.js` | `buildContext(definition, signal, log)` → frozen `{ core, shape, signal, log, dom? }`; `log` is the registry's log sink (`registry.log`) |
| `core.js` | `scriptCore` (frozen): `createDocuments(params)`, `updateDocuments(params)`, `deleteDocuments(params)`, `documentTypes()`, `readDocument(reference, { derived? })`, `searchDocuments(params)`, `describeSchema(params)`; `ERROR_MESSAGE_MAX_BYTES` (256) |
| `shape.js` | `shape` (frozen): `compact`, `project`, `paths`, `ack` |
| `canonical.js` | `exportDocument(document, { derived? })` (the canonical export, the exclusions and the secret redaction), `exportForBackup(document)` (below), `unreadable(document)`, `resolveDocument(reference)`, `WIRETAP_SETTING_PREFIX`, `USER_EXCLUDED_FIELDS`, `SECRET_CORE_SETTINGS`, `SECRET_KEY`, `SECRET_SETTING_KEY`, `REDACT_MAX_DEPTH`, `REDACT_MAX_NODES` |
| `contentHash.js` | `hashText(text)` (cyrb53, 14 lowercase hex digits), `stableStringify(value)` (`JSON.stringify` with every plain object's keys sorted by code unit, an own `__proto__` key kept), `contentVersion(value)` (`hashText(stableStringify(value))`); used by `requestHash` of `writeIdempotency.js` and the `get_document` version |
| `keyFields.js`, `keyFields.json` | `keyPathsFor(systemId, documentName, type)` over the reviewed per-subtype key-field lists (the `titan` system only) |
| `search.js` | `searchDocuments(params, signal)`: candidates, canonical exclusions, filters, ordering, cursor, page bound, work caps; `FILTERS_MAX` |
| `schemaWalk.js` | The field walker: `createWalkState`, `describeField`, `outlineFields`, `stepInto`; `SCHEMA_DEPTH_MAX` (3), `SCHEMA_NODES_MAX` (150), `OUTLINE_MAX` (80) |
| `schemaDescribe.js` | `describeSchema(params, log)`: blank example, outlines, path subtree, size bound |
| `definitions.js` | `listDocumentTypesDefinition`, `getDocumentDefinition`, `searchDocumentsDefinition`, `describeSchemaDefinition`, `createDocumentsDefinition`, `updateDocumentsDefinition`, `deleteDocumentsDefinition`, `replaceDocumentDefinition`, `batchDefinition`; relative imports only, so the `tsx`-run measurement can load them through `tests/unit/scriptFixtures.js` |
| `writes.js` | `createDocuments`, `updateDocuments`, `deleteDocuments`, the planners `prepareCreate` / `prepareUpdates` / `prepareDeletes`, `DELETE_PREVIEW_ROWS_MAX`: the write operations behind `ctx.core` (phase B files `writeReplace.js`, `writeBatch.js`, `writeBatchSettle.js`, `writeActAs.js`, `writeIdempotency.js`, `replaceDocument.js`, `batch.js`: see `wiretap-writes`) |
| `writeGuard.js`, `writeFields.js` | The write guard: see `wiretap-write-guard` |
| `writeArgs.js`, `writeAck.js` | Argument helpers (`shapeRefusal`, `parseDataObjects`, `parseJson`, `checkDataBytes`, `checkReadbackPaths`) and ack shaping (`ackDocuments`, `ackUpdates`, `attachReadback`, `fitPreview`) |
| `createDocuments.js`, `updateDocuments.js`, `deleteDocuments.js` | The handlers of the write scripts (`updateDocuments.js` groups patch entries by uuid) |
| `listDocumentTypes.js`, `getDocument.js`, `searchDocuments.js`, `describeSchema.js` | The handlers of the read scripts (the last two only call `ctx.core`) |
| `sheetDefinitions.js`, `diceDefinitions.js`, `macroDefinitions.js` | The per-family definitions of the gameplay scripts (`open_sheet`, `close_sheet`; `roll`, `draw_table`; `execute_macro`); relative imports only, like `definitions.js` |
| `sheets.js`, `openSheet.js`, `closeSheet.js`, `roll.js`, `drawTable.js`, `executeMacro.js` | The gameplay script handlers and their shared sheet helpers: see `wiretap-gameplay` |
| `packDefinitions.js`, `packCommon.js`, `createPack.js`, `deletePack.js` | The compendium pack scripts `create_pack` and `delete_pack` (definitions with relative imports only, shared gate and ack helpers, handlers): see `wiretap-packs` |
| `index.js` | `SHIPPED_SCRIPTS` (static list: `list_document_types`, `get_document`, `search_documents`, `describe_schema`, `create_documents`, `update_documents`, `delete_documents`, `replace_document`, `batch`, `open_sheet`, `close_sheet`, `roll`, `draw_table`, `execute_macro`, `create_pack`, `delete_pack`), `registerShippedScripts(registry?)`; called by `hooks/OnceReady.js` for a GM before `initFoundryBridge` |

## Registration (`registry.js`)

`register(definition, handler)` never throws and returns `{ ok: true, name }` or `{ ok: false, reason }`; every refusal is
logged as `Wiretap | script registry refused "<name>": <reason>` (name and reason cleaned and bounded). Checks, in order:
the shared `validateScriptDefinition(def, 'shipped')` (name, version, description, definition ≤ 800 B, budget ≤ 16,000,
`requires`, `mutates`, gate, the optional `requiresUserInteraction` that may only be `true`); `requires: 'none'` refused; handler is a function; name not registered; count ≤
`ALWAYS_LISTED_TOOLS_MAX` − `RESERVED_SCRIPT_NAMES.length` (25); `inputSchema` compiles with `compileSchema`; the listed
definition (`definitionBytes(name, description, compiled.listed)`, the form the sidecar lists) ≤ `DEFINITION_MAX_BYTES`;
the sum of listed bytes plus one `DEFINITION_MAX_BYTES` per sidecar built-in (five) ≤ `ALL_DEFINITIONS_MAX_BYTES`
(the sidecar enforces the same total in `sanitizeRegistry`). The stored
definition is a deep copy; `definitions()` returns fresh copies. `subscribe(listener)` fires after each accepted script
(a throwing listener is logged and skipped). The bridge subscribes and pushes `bridge:registry`.

## Dispatch (`callTool.js`)

At most `SCRIPT_CONCURRENCY_MAX` (8) handlers run at once; a call beyond it is refused with `SCRIPT_BUSY` after validation
(the slot frees when the call ends, timeouts included). The gate read cannot throw (`readGateState` closes an unreadable gate).
Order: params `{ name: string, arguments? }` (else `OP_FAILED`) → script lookup by exact name (`TOOL_GONE`, name echoed
cleaned and ≤ 48 B) → declared gate via `requireGate` from this client's settings, fail closed (`GATE_DENIED`, text from
`gateDenial`) → `validate(arguments ?? {})` (`ARGS_INVALID`, text names the path) → handler under an `AbortController`
timer (`SCRIPT_TIMEOUT`, aborts `ctx.signal`; the text names the limit in seconds, `limit / 1000` unrounded) → result must serialize (`RESULT_INVALID`) within 900,000 B
(`RESULT_TOO_LARGE`); a result of `undefined` is `null`; the acked result is a `JSON.parse` copy. A handler error is
rethrown; `foundryBridge.js` acks `ScriptError` codes as is and every other error as `OP_FAILED`, message ≤ 256 B.

The handler limit is `SCRIPT_TIMEOUT_MS` (8 s; `createCallTool`'s `timeoutMs` option overrides it) unless the script's
input schema declares the shared `timeoutMs` argument and the call sets it: the limit is then `args.timeoutMs` (the
validated arguments hold only declared properties, so no other script can set it; the bounds are in the declaring
schema). The sidecar reads the same argument and waits `timeoutMs` + 2 s for that call (`wiretap-mcp-bridge`). Only
`execute_macro` declares it (1,000 to 300,000 ms).

## Argument validation (`shared/schemaValidate.js`)

`compileSchema(schema)` → `{ ok, validate, listed }` (`listed` is the schema as the sidecar lists it, equal to the SDK's
output; the parity test asserts it) or `{ ok: false, reason }` mirrors `jsonSchemaToZodShape` in
`server/toolRegistry.ts` (same keywords, limits and refusals); `validate(value)` returns a cleaned copy holding only
declared properties (like zod's default object) or the first problem as `path: phrase`, ≤ 256 B, never caller text. At
most `VALUE_NODES_MAX` (10,000) values are visited. `tests/unit/schemaValidate.test.js` holds the parity fixtures run
through both implementations; a change to either side must keep them equal. Every array schema must declare `maxItems` of
at most `SCHEMA_ARRAY_ITEMS_MAX` (1000) on both sides. The sidecar imports the limits (`SCHEMA_*`, `TYPE_KEYWORDS`,
`PROPERTY_NAME_PATTERN`) from this file.

## `ctx.shape` (`shape.js`)

- `compact(doc, { keyPattern?, keyPaths?, embedded?, version? })`: `uuid`, `name`, `type` (bounded), `version` (the
  option, cut to 32 B, when it is a non-empty string; `get_document` passes its content version), `fields` (≤ 24 `system` scalar leaves: those named by `keyPaths` (dotted paths below
  `system`, in order, own properties only, unsafe segments skipped) when it is a list, else those whose key matches the
  pattern, depth ≤ 6, ≤ 2000 objects visited), `embedded.<collection>` = `{ total, rows: [id, name, type][] }`
  (≤ 8 collections with names shortened to 32 B, ≤ 40 tuples in all). The serialized view is held to
  `COMPACT_VIEW_MAX_BYTES` for any data: the larger of leaves and tuples loses its last entry, then leaves, then
  collections, then header fields, until it fits, and `cut: true` is set (35 tuples fit with 18-character names).
- `project(doc, fields)`: ≤ 20 paths, nested result, `missing` list, wildcard refused.
- `paths(doc, list)`: `resolvePaths` of `shared/docPath.js` → `{ values, missing }`.
- `ack(fields)`: scalar fields only, ≤ 16 keys, strings shortened then fields dropped until ≤ `ACK_MAX_BYTES`.

`ctx.dom` is `{ document }` and exists only for `requires: 'dom'`.

## Core write scripts

In `wiretap-writes` (the scripts and `writes.js`) and `wiretap-write-guard` (the guard).

## Core read scripts

Covers the four read scripts (list_document_types, get_document, search_documents, describe_schema): arguments, work bounds, exclusions and secret redaction in the canonical export, paging and cursors, the schema walker and error codes. Read references/core-read-scripts.md before changing any of them or src/bridge/scripts/canonical.js, search.js, schemaWalk.js or schemaDescribe.js, or adding a read script or any new read path.

## User-facing skill

`skills/wiretap/SKILL.md` (module root, installed by copying; README). It may name only existing tools as
`mcp__wiretap__<tool>` (it names every shipped script and every sidecar built-in; its Backups recipe tells the agent
to make or offer `backup_documents` before a bulk update, a replace, a delete or a document-changing macro, and to
restore only when the user asks; its opening says `list_backups` and `delete_backup` work without a GM; its Compendium
packs line names both pack tools, their gates and that Claude Code asks before every `delete_pack`) and must stay
≤ 75 lines (`tests/unit/shippedSkill.test.js`, plus the context-budget test; it is 74 now).

## Backup export (`canonical.js`)

`exportForBackup(document)` is the backup form of the canonical export: `exportDocument(document, {})` without `uuid`,
plus `secretPaths`, the path of every key the exclusions removed and every string the redaction changed. It returns
`{ ok: true, data, secretPaths }` or `{ ok: false, code, message }`: the `unreadable(document)` refusal
(`DOC_EXCLUDED`), or `DOC_UNREADABLE` for an export that throws or a redaction walk cut at `REDACT_MAX_NODES`,
`REDACT_MAX_DEPTH` or `REDACT_MAX_STRING_NESTING`. It never throws; the backup export counts every refusal as
unreadable. Its caller and the restore that reads `secretPaths` are in `wiretap-backups`. Tests:
`tests/unit/canonicalBackup.test.js`.

## Tests

`schemaValidate`, `scriptRegistry`, `scriptShape` (MOCK_ fixtures with 120 embedded items; `version` and `keyPaths`),
`contentHash` (`hashText`, `stableStringify`, `contentVersion`, `requestHash` equal to `hashText` of the JSON),
`callTool`, `scriptCore`, `canonical` and `getDocument` (mocked documents from `mockDocuments.js`: exclusions,
password path in `missing`, compact bound over every list of `keyFields.json`, projection, `items.*.name`, derived,
`version` and `ifChanged` (embedded, `_stats`, reordered keys, secret-named values, derived), argument combinations), `listDocumentTypes`, `searchDocuments` (paging, cursor stability, clamps, filters, exclusions, index use), `schemaWalk` (every field class with `mockFields.js`), `describeSchema`, `shippedSkill`, `OnceReady`, `foundryBridge.scripts` (registry push, ack handling, callTool acks) and
`foundryBridge.client` (write scripts through the bridge); `tests/integration/readTools.test.js` (both read scripts through the
sidecar with a fake client). e2e: `tests/e2e/readTools.spec.js` (a created actor, then compact/paths/derived/full
handle and `maxBytes` 16000 on the created actor; every type and subtype present in the titan world read at ≤ 2,000 B;
`wiretap.*` setting refused, real Settings with secret-named keys redacted, flags redacted, and User password paths in
`missing` (after asserting the client holds the fields); embedded and compendium reads); `tests/e2e/everyType.spec.js`
(creates, as recorded `Wiretap E2E ` documents, every class and subtype of the titan world except the classes and folder
types it lists with a reason, embedded documents under recorded parents; reads each in the compact view ≤ 2,000 B and
compares `list_document_types` with `CONST.ALL_DOCUMENT_TYPES`); `tests/e2e/searchSchema.spec.js` (search by the created name prefix with a limit of 2 over 5 actors, filters and fields, the wiretap Setting absent, the User password refusals, an index-only compendium search that loads no document, `describe_schema` for every class and subtype of the titan world <= 8000 B, the User/Setting exclusions of `describe_schema`, path examples with constraints), `tests/e2e/scripts.spec.js` (real sidecar, SDK client,
`create_documents` creates an Actor that the test records and tears down; the e2e-only `e2e_gated` script from `src/test-probe/registerProbe.js` for the
gate path, and `e2e_matrix` to reach the client argument validator with arguments the sidecar accepts) with the
running list in `tests/e2e/registryCore.js` (`test/state/registry.json`; re-exported by `registry.js`, which adds the
headless setup and teardown steps). The registry allows `ChatMessage` (identified by `flavor`), `Combat`, `Setting` (key
prefix `wiretap-e2e.`), `User` (never the signed-in user or a game master), `Scene`, `Playlist`, `RollTable`,
`JournalEntry`, `Macro`, `Cards`, `Actor`, `Item`, `Folder` and `Compendium` (a world pack, id `world.<name>`, uuid
`Compendium.world.<name>`, resolved with `game.packs.get` and deleted with `deleteCompendium`, unlocked first when
locked; a pack must be a world pack titled with the prefix), deleted in that order (`tests/unit/e2eRegistry.test.js`). `tests/e2e/registry.spec.js` covers the sweep and the refusal to delete a
non-prefixed document.

## Reference files

| File | Holds | Read it when |
|---|---|---|
| references/core-read-scripts.md | The Core read scripts section with its search_documents and describe_schema subsections | changing the read scripts, the canonical export, search paging or the schema walker |
