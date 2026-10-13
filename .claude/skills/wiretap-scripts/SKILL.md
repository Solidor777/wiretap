---
name: wiretap-scripts
description: Wiretap client script runtime — the shipped script registry, the callTool dispatcher, ctx (core, shape, signal, dom), argument validation, create_actor, the core read scripts list_document_types, get_document, search_documents and describe_schema (canonical export, exclusions, key-field lists, search paging, schema walker), and the user-facing skill skills/wiretap. Use when reading or editing src/bridge/scripts/, shared/schemaValidate.js, shared/utf8.js, shared/logText.js or skills/.
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
  - "tests/unit/createActor.test.js"
  - "tests/unit/canonical.test.js"
  - "tests/unit/getDocument.test.js"
  - "tests/unit/listDocumentTypes.test.js"
  - "tests/unit/searchDocuments.test.js"
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
client-only, never on the wire). Every MCP tool except the sidecar's `read_handle` is a script. Scripts call ops
(`ctx.core`), never the reverse.

## Files

| File | Role |
|---|---|
| `registry.js` | `createScriptRegistry({ log? })` → `{ register, get, definitions, subscribe }`; module singleton `scriptRegistry`; `registerScript(def, handler)`; `ScriptError(code, message)` |
| `callTool.js` | `createCallTool({ registry, timeoutMs? })` → the `callTool` op handler; `SCRIPT_TIMEOUT_MS` (8000), `RESULT_WIRE_MAX_BYTES` (900,000), `SCRIPT_BUSY` |
| `ctx.js` | `buildContext(definition, signal, log)` → frozen `{ core, shape, signal, log, dom? }`; `log` is the registry's log sink (`registry.log`) |
| `core.js` | `scriptCore` (frozen): `createActor({ name, type? })`, `documentTypes()`, `readDocument(reference, { derived? })`, `searchDocuments(params)`, `describeSchema(params)`; `ERROR_MESSAGE_MAX_BYTES` (256) |
| `shape.js` | `shape` (frozen): `compact`, `project`, `paths`, `ack` |
| `canonical.js` | `exportDocument(document, { derived? })` (the canonical export, the exclusions and the secret redaction), `unreadable(document)`, `resolveDocument(reference)`, `WIRETAP_SETTING_PREFIX`, `USER_EXCLUDED_FIELDS`, `SECRET_CORE_SETTINGS`, `SECRET_KEY`, `SECRET_SETTING_KEY`, `REDACT_MAX_DEPTH`, `REDACT_MAX_NODES` |
| `keyFields.js`, `keyFields.json` | `keyPathsFor(systemId, documentName, type)` over the reviewed per-subtype key-field lists (the `titan` system only) |
| `search.js` | `searchDocuments(params, signal)`: candidates, canonical exclusions, filters, ordering, cursor, page bound, work caps; `FILTERS_MAX` |
| `schemaWalk.js` | The field walker: `createWalkState`, `describeField`, `outlineFields`, `stepInto`; `SCHEMA_DEPTH_MAX` (3), `SCHEMA_NODES_MAX` (150), `OUTLINE_MAX` (80) |
| `schemaDescribe.js` | `describeSchema(params, log)`: blank example, outlines, path subtree, size bound |
| `definitions.js` | `listDocumentTypesDefinition`, `getDocumentDefinition`, `searchDocumentsDefinition`, `describeSchemaDefinition`; relative imports only, so the `tsx`-run measurement can load them through `tests/unit/scriptFixtures.js` |
| `createActor.js` | `createActorDefinition`, `createActorHandler` |
| `listDocumentTypes.js`, `getDocument.js`, `searchDocuments.js`, `describeSchema.js` | The handlers of the read scripts (the last two only call `ctx.core`) |
| `index.js` | `SHIPPED_SCRIPTS` (static list: `create_actor`, `list_document_types`, `get_document`, `search_documents`, `describe_schema`), `registerShippedScripts(registry?)`; called by `hooks/OnceReady.js` for a GM before `initFoundryBridge` |

## Registration (`registry.js`)

`register(definition, handler)` never throws and returns `{ ok: true, name }` or `{ ok: false, reason }`; every refusal is
logged as `Wiretap | script registry refused "<name>": <reason>` (name and reason cleaned and bounded). Checks, in order:
the shared `validateScriptDefinition(def, 'shipped')` (name, version, description, definition ≤ 800 B, budget ≤ 16,000,
`requires`, `mutates`, gate); `requires: 'none'` refused; handler is a function; name not registered; count ≤
`ALWAYS_LISTED_TOOLS_MAX` − `RESERVED_SCRIPT_NAMES.length` (29); `inputSchema` compiles with `compileSchema`; the listed
definition (`definitionBytes(name, description, compiled.listed)`, the form the sidecar lists) ≤ `DEFINITION_MAX_BYTES`;
the sum of listed bytes plus one `DEFINITION_MAX_BYTES` kept for the sidecar built-ins ≤ `ALL_DEFINITIONS_MAX_BYTES`
(the sidecar enforces the same total in `sanitizeRegistry`). The stored
definition is a deep copy; `definitions()` returns fresh copies. `subscribe(listener)` fires after each accepted script
(a throwing listener is logged and skipped). The bridge subscribes and pushes `bridge:registry`.

## Dispatch (`callTool.js`)

At most `SCRIPT_CONCURRENCY_MAX` (8) handlers run at once; a call beyond it is refused with `SCRIPT_BUSY` after validation
(the slot frees when the call ends, timeouts included). The gate read cannot throw (`readGateState` closes an unreadable gate).
Order: params `{ name: string, arguments? }` (else `OP_FAILED`) → script lookup by exact name (`TOOL_GONE`, name echoed
cleaned and ≤ 48 B) → declared gate via `requireGate` from this client's settings, fail closed (`GATE_DENIED`, text from
`gateDenial`) → `validate(arguments ?? {})` (`ARGS_INVALID`, text names the path) → handler under an `AbortController`
timer (`SCRIPT_TIMEOUT`, aborts `ctx.signal`) → result must serialize (`RESULT_INVALID`) within 900,000 B
(`RESULT_TOO_LARGE`); a result of `undefined` is `null`; the acked result is a `JSON.parse` copy. A handler error is
rethrown; `foundryBridge.js` acks `ScriptError` codes as is and every other error as `OP_FAILED`, message ≤ 256 B.

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

- `compact(doc, { keyPattern?, keyPaths?, embedded? })`: `uuid`, `name`, `type` (bounded), `modified` (the export's
  `_stats.modifiedTime` when finite), `fields` (≤ 24 `system` scalar leaves: those named by `keyPaths` (dotted paths below
  `system`, in order, own properties only, unsafe segments skipped) when it is a list, else those whose key matches the
  pattern, depth ≤ 6, ≤ 2000 objects visited), `embedded.<collection>` = `{ total, rows: [id, name, type][] }`
  (≤ 8 collections with names shortened to 32 B, ≤ 40 tuples in all). The serialized view is held to
  `COMPACT_VIEW_MAX_BYTES` for any data: the larger of leaves and tuples loses its last entry, then leaves, then
  collections, then header fields, until it fits, and `cut: true` is set (35 tuples fit with 18-character names).
- `project(doc, fields)`: ≤ 20 paths, nested result, `missing` list, wildcard refused.
- `paths(doc, list)`: `resolvePaths` of `shared/docPath.js` → `{ values, missing }`.
- `ack(fields)`: scalar fields only, ≤ 16 keys, strings shortened then fields dropped until ≤ `ACK_MAX_BYTES`.

`ctx.dom` is `{ document }` and exists only for `requires: 'dom'`.

## create_actor

`mutates: true`, `requires: 'api'`, no gate, `result.budgetBytes` 256, `name` 1 to 128 characters, `type` 1 to 64,
`additionalProperties: false`. Returns `ctx.shape.ack({ uuid, name, type })`. `scriptCore.createActor` resolves the
default type (first non-base Actor subtype), rejects an unknown one with a list of whole valid types within 256 B
(`(+N more)` for the rest) and rejects a creation a hook cancelled (`Actor.create` resolved `undefined`).

## Core read scripts

Both are `mutates: false`, `requires: 'api'`, no gate. Definitions are in `definitions.js` (listed 243 B and 682 B,
MEASURED by `tests/measure/measureContext.mjs`).

- `list_document_types` (no arguments, `result.budgetBytes` = `DOCUMENT_TYPES_MAX_BYTES` 3000): `scriptCore.documentTypes()`
  returns `{ system, world, embedded, packOnly?, subtypes, omitted? }` from `CONST` and `game.documentTypes` (the base type
  left out; classes with no subtype are not in `subtypes`). While over the budget the longest subtype list is dropped and
  its class named in `omitted`.
- `get_document` (`result.budgetBytes` 16000): `uuid`, or `documentName` + `id` with `parentUuid` (embedded) or `pack`;
  `mode` `compact` (default) or `full`; `fields` and `paths` (≤ 20 each); `derived`; `ifModifiedSince`; `maxBytes`
  (integer 128..16000, declared only so the enforcer receives it; the handler ignores it). `paths`, `fields` and
  `mode: 'full'` exclude each other, `derived` needs `paths` or `fields` (`ARGS_INVALID`). Order: combination check →
  `ctx.core.readDocument` → `ifModifiedSince` (`{ unchanged: true }` when the export's `_stats.modifiedTime` is a finite
  number `<=` the argument; never for an unreadable document) → `paths` (`{ values, missing }`) / `fields`
  (`{ fields, missing }`) / full (the export) / compact with `keyPathsFor(game.system.id, documentName, type)`. A shape
  refusal `<code>: <message>` is rethrown as a `ScriptError` with that code (`PATH_*`).
- `canonical.js` `exportDocument`: `toCompendium(null, { clearSource: false, keepId: true, clearSort: false,
  clearOwnership: false })` (or `toObject(false)` when derived), JSON round trip (a `Set` becomes an array), the
  exclusions, `uuid` added; never throws (`DOC_EXCLUDED`, `DOC_UNREADABLE`). Exclusions: a `Setting` whose `key` is not
  text, starts with `wiretap.` (case-insensitive), is in `SECRET_CORE_SETTINGS` (`core.rtcworldsettings`, the WebRTC TURN
  credentials: `client/av/settings.mjs:97-102,162-167`) or matches `SECRET_SETTING_KEY` is refused before any export call;
  `password` and `passwordSalt` are deleted from a `User` export, so a path to one is in `missing`. Redaction
  (`redactNode`, in the one export function, so every read path inherits it): keys matching `SECRET_KEY`
  (`/pass(word|phrase)?|secret|token|api[-_]?key|credential|private[-_]?key/i`) are dropped from a Setting `value` (JSON
  text, parsed and re-serialized) and from every `flags` object of any export, to depth 24 and 50,000 nodes per walk
  (separate budgets for the setting value and the rest; lists are walked in order and cut at the first member beyond a
  bound; strings that hold JSON are parsed and redacted too, to 4 nesting levels (`REDACT_MAX_STRING_NESTING`); what lies beyond is dropped). Core schema fields and `system` data are not scanned (`prototypeToken` matches the pattern); the
  limits are listed in docs/PLAN.md section 4.4. Any new read path (`search_documents`) must go through
  `readDocument`/`exportDocument`. `resolveDocument` throws `ARGS_INVALID` (unclear reference) or `DOC_NOT_FOUND`; caller text echoed in
  errors is cleaned and ≤ 48 B.
- Codes of the read scripts (`ScriptError`): `ARGS_INVALID`, `DOC_NOT_FOUND`, `DOC_EXCLUDED`, `DOC_UNREADABLE`, `PATH_NOT_FOUND`,
  `PATH_EXCLUDED`, `PATH_EMBEDDED`, `PATH_FREE_FORM`, `PATH_UNSAFE_SEGMENT`, `PATH_INVALID`, `PATH_LIMIT`, `CURSOR_INVALID`,
  `SEARCH_ABORTED`.
- A full export over the 900,000 B client limit fails with `RESULT_TOO_LARGE`; over the call's cap (8,000 B or `maxBytes`)
  the sidecar enforcer makes a handle.
- Key-field lists: `keyFields.json` is generated by `tests/e2e/keyFields.measure.spec.js` (skipped unless
  `WIRETAP_MEASURE_KEYFIELDS=1`) and reviewed; provenance in `docs/experiments/2026-10-m4-keyfields.md`.

### search_documents

`mutates: false`, `requires: 'api'`, `result.budgetBytes` = `SEARCH_PAGE_MAX_BYTES` (4000); listed 687 B. Arguments: `documentName`
(required), `type`, `query` (name substring, case-insensitive, <= 64), `filters` (<= 5 strings `path=value`, each <= 256; a
value matches when the scalar at the dotted path, as text, equals it; no wildcard), `pack`, `parentUuid` (exclusive),
`fields` (<= 20 dotted paths of <= 64 B (`SEARCH_FIELD_PATH_MAX_BYTES`, rows echo them as keys; longer is `PATH_INVALID`)
whose scalars are added to each row as a fourth element, strings <= 64 B), `limit` (1..100, default 20; the engine also
clamps), `cursor` (<= 512; base64url of the name, one NUL and the uuid); there is no `maxBytes` (an undeclared argument is stripped by the schema validator). The engine
refuses more than 5 filters with `ARGS_INVALID`. Result `{ rows: [uuid, name, type, values?][], total, cut?, scanned?,
nextCursor? }`; a lone row whose `fields` overflow the page degrades to `[uuid, name, type]`.
- Work bounds: the ordering key of every readable document comes from its live name; candidates after the cursor are examined
  in key order up to `SEARCH_SCAN_MAX` (2000); `type`, `query` and `name`/`type`/`folder` filters read the live document; a
  document is exported (once, kept on the candidate) only for a filter on another path or for a page row with `fields`,
  at most `SEARCH_EXPORT_MAX` (300) per call. At a cap the call reports `cut: true` and `scanned` and `nextCursor` resumes
  after the last candidate examined. `total` counts the matches among the candidates examined from the cursor on. Every
  `SEARCH_BATCH_SIZE` (25) candidates the loop awaits a `MessageChannel` message (a macrotask) and throws `SEARCH_ABORTED`
  when `ctx.signal` (passed by the handler) aborted.
- Sources: world collection (`game.collections`), `parent.getEmbeddedCollection`, or `pack.getIndex({ fields })` with only the
  filter and field paths (no document is loaded; `Setting` and `User` are refused with a pack). Index paths are bounded
  (`indexPathsOf`: <= `SEARCH_INDEX_FIELDS_MAX` (5) distinct, <= `SEARCH_INDEX_SEGMENTS_MAX` (3) segments, no whole
  `WHOLE_SUBTREE_ROOTS` subtree, else `ARGS_INVALID`; a segment matching `SECRET_KEY` is `PATH_EXCLUDED`; both before the
  index is asked), because `getIndex` merges the fields into the
  pack's shared index for the session (`compendium-collection.mjs:334-367`). A class that is not a world
  collection needs `pack` or `parentUuid` (`ARGS_INVALID`).
- Exclusions: a live document is skipped when `canonical.unreadable()` refuses it (a `wiretap.` Setting never appears in a
  row, the total or any match) and filters and fields read the canonical `exportDocument`, so a User password path has no
  value; a filter or field whose first segment is `password` or `passwordSalt` on a `User` is `PATH_EXCLUDED`.
- Order and cursor: matches sort by the name cut to 40 B, then the uuid (code-unit order); the cursor is the base64url of
  the key text (cut name, one NUL, uuid; no JSON escaping, so it stays within 512 characters) and the next page is every match with a greater key, so inserts and deletes do not shift it. The rows
  are cut from the end until the serialized page is <= 4000 B (at least one row stays) and `nextCursor` follows the last row
  kept. A cursor that does not decode is `CURSOR_INVALID`.

### describe_schema

`mutates: false`, `requires: 'api'`, `result.budgetBytes` = `DESCRIBE_SCHEMA_MAX_BYTES` (8000); listed 382 B. Arguments:
`documentName` (required), `subtype` (the base type, else the first type, when omitted; an unknown one is `ARGS_INVALID`
listing the valid ones within 256 B), `path` (<= 512, dotted).
- Without `path`: `{ documentName, subtype, example, outline, systemOutline? }`. `example` is the canonical export of a
  blank document built in memory (`new documentClass({ name: 'Example', type })` plus `MINIMAL_DATA` for Setting, Wall,
  Tile and Drawing); a construction that throws gives `example: null` and `exampleNote`. `outline` is `[name, class,
  document?]` of the class's top-level fields, `systemOutline` the same for the subtype's `system` schema.
- With `path`: `stepInto` walks the schema (`TypeDataField` resolves by subtype; a list takes an integer index or `*` only,
  else `PATH_NOT_FOUND`, as does a list without an element field; an embedded
  collection or document is `PATH_EMBEDDED`, a free-form field `PATH_FREE_FORM`, a missing name `PATH_NOT_FOUND`, an unsafe
  one `PATH_UNSAFE_SEGMENT`, an empty one or a wildcard outside a list `PATH_INVALID`), and the result is `{ path,
  example?, schema, cut? }`, where `schema` is `describeField` of the reached field.
- Walker output (`schemaWalk.js`): `{ class, required?, nullable?, readonly?, blank?, integer?, positive?, min?, max?, step?,
  choices?, choicesMore?, categories?, free?, element?, types?, document?, type?, fields?, more?, cycle? }`. Kinds come from
  the first class name in the prototype chain found in `KIND_BY_CLASS` (so subclasses need no entry). Free-form: ObjectField,
  AnyField, JSONField, TypedObjectField (and subclasses), TypedSchemaField. Referenced by document name: collections,
  EmbeddedDocumentField, foreign keys. Bounds: depth 3, 150 nodes, 16 choices, cycle guard on the schemas being expanded.
- Size: the example is replaced by `exampleKeys` (`exampleCut`) and the outlines shortened until the result is <= 8000 B; a
  path result drops the example first (`exampleCut`) and only then re-walks at depth 3, 2, 1, 0 (`cut: true`). A blank that
  cannot be built is logged once through `ctx.log` (cleaned, <= 120 B of the cause) and the result keeps `example: null`.
- Exclusions: the blank example goes through `exportDocument` (no User password field, no wiretap Setting), the User outline
  and tree skip `password` and `passwordSalt`, and a path to either is `PATH_EXCLUDED`.

## User-facing skill

`skills/wiretap/SKILL.md` (module root, installed by copying; README). It may name only existing tools as
`mcp__wiretap__<tool>` and must stay ≤ 60 lines (`tests/unit/shippedSkill.test.js`, plus the context-budget test).

## Tests

`schemaValidate`, `scriptRegistry`, `scriptShape` (MOCK_ fixtures with 120 embedded items; `modified` and `keyPaths`),
`callTool`, `scriptCore`, `createActor`, `canonical` and `getDocument` (mocked documents from `mockDocuments.js`: exclusions,
password path in `missing`, compact bound over every list of `keyFields.json`, projection, `items.*.name`, derived,
`ifModifiedSince`, argument combinations), `listDocumentTypes`, `searchDocuments` (paging, cursor stability, clamps, filters, exclusions, index use), `schemaWalk` (every field class with `mockFields.js`), `describeSchema`, `shippedSkill`, `OnceReady`, `foundryBridge.scripts` (registry push, ack handling, callTool acks) and
`foundryBridge.client` (create_actor through the bridge); `tests/integration/readTools.test.js` (both read scripts through the
sidecar with a fake client). e2e: `tests/e2e/readTools.spec.js` (create_actor then compact/paths/derived/`ifModifiedSince`/full
handle and `maxBytes` 16000 on the created actor; every type and subtype present in the titan world read at ≤ 2,000 B;
`wiretap.*` setting refused, real Settings with secret-named keys redacted, flags redacted, and User password paths in
`missing` (after asserting the client holds the fields); embedded and compendium reads); `tests/e2e/everyType.spec.js`
(creates, as recorded `Wiretap E2E ` documents, every class and subtype of the titan world except the classes and folder
types it lists with a reason, embedded documents under recorded parents; reads each in the compact view ≤ 2,000 B and
compares `list_document_types` with `CONST.ALL_DOCUMENT_TYPES`); `tests/e2e/searchSchema.spec.js` (search by the created name prefix with a limit of 2 over 5 actors, filters and fields, the wiretap Setting absent, the User password refusals, an index-only compendium search that loads no document, `describe_schema` for every class and subtype of the titan world <= 8000 B, the User/Setting exclusions of `describe_schema`, path examples with constraints), `tests/e2e/scripts.spec.js` (real sidecar, SDK client,
create_actor creates and deletes an Actor; the e2e-only `e2e_gated` script from `src/test-probe/registerProbe.js` for the
gate path, and `e2e_matrix` to reach the client argument validator with arguments the sidecar accepts) with the
running list in `tests/e2e/registryCore.js` (`test/state/registry.json`; re-exported by `registry.js`, which adds the
headless setup and teardown steps). The registry allows `ChatMessage` (identified by `flavor`), `Combat`, `Setting` (key
prefix `wiretap-e2e.`), `User` (never the signed-in user or a game master), `Scene`, `Playlist`, `RollTable`,
`JournalEntry`, `Macro`, `Cards`, `Actor`, `Item` and `Folder`, deleted in that order (`tests/unit/e2eRegistry.test.js`). `tests/e2e/registry.spec.js` covers the sweep and the refusal to delete a
non-prefixed document.
