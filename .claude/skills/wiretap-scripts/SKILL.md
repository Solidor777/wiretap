---
name: wiretap-scripts
description: Wiretap client script runtime — the shipped script registry, the callTool dispatcher, ctx (core, shape, signal, dom), argument validation, create_actor, and the user-facing skill skills/wiretap. Use when reading or editing src/bridge/scripts/, shared/schemaValidate.js, shared/utf8.js, shared/logText.js or skills/.
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
| `ctx.js` | `buildContext(definition, signal)` → frozen `{ core, shape, signal, dom? }` |
| `core.js` | `scriptCore` (frozen): `createActor({ name, type? })`; `ERROR_MESSAGE_MAX_BYTES` (256) |
| `shape.js` | `shape` (frozen): `compact`, `project`, `paths`, `ack` |
| `createActor.js` | `createActorDefinition`, `createActorHandler` |
| `index.js` | `SHIPPED_SCRIPTS` (static list), `registerShippedScripts(registry?)`; called by `hooks/OnceReady.js` for a GM before `initFoundryBridge` |

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

- `compact(doc, { keyPattern?, embedded? })`: `uuid`, `name`, `type` (bounded), `fields` (≤ 24 `system` scalar leaves whose
  key matches the pattern, depth ≤ 6, ≤ 2000 objects visited), `embedded.<collection>` = `{ total, rows: [id, name, type][] }`
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

## User-facing skill

`skills/wiretap/SKILL.md` (module root, installed by copying; README). It may name only existing tools as
`mcp__wiretap__<tool>` and must stay ≤ 60 lines (`tests/unit/shippedSkill.test.js`, plus the context-budget test).

## Tests

`schemaValidate`, `scriptRegistry`, `scriptShape` (MOCK_ fixtures with 120 embedded items), `callTool`, `scriptCore`,
`createActor`, `shippedSkill`, `OnceReady`, `foundryBridge.scripts` (registry push, ack handling, callTool acks) and
`foundryBridge.client` (create_actor through the bridge). e2e: `tests/e2e/scripts.spec.js` (real sidecar, SDK client,
create_actor creates and deletes an Actor; the e2e-only `e2e_gated` script from `src/test-probe/registerProbe.js` for the
gate path, and `e2e_matrix` to reach the client argument validator with arguments the sidecar accepts) with the
running list in `tests/e2e/registryCore.js` (`test/state/registry.json`; re-exported by `registry.js`, which adds the
headless setup and teardown steps). `tests/e2e/registry.spec.js` covers the sweep and the refusal to delete a
non-prefixed document.
