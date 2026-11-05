---
name: wiretap-mcp-bridge
description: Wiretap MCP tools and Foundry bridge — the built-in tool (read_handle) and the registered scripts (list_document_types, get_document, search_documents, describe_schema, create_documents, update_documents, delete_documents, replace_document and batch among them), the result enforcer and handle store, endpoint registry and router (gates, health, routing), sidecar-to-GM-client op dispatch, client-side op handlers, wire ops. Use when reading or editing MCP tools, bridge ops, routing, result budgets or the bridge handshake. Sessions and the tool registry are in wiretap-mcp-sessions.
paths:
  - "server/mcp.ts"
  - "server/endpoints.ts"
  - "server/foundryBridge.ts"
  - "server/resultBudget.ts"
  - "server/handles.ts"
  - "server/handleInput.ts"
  - "server/utf8.ts"
  - "src/bridge/foundryBridge.js"
  - "src/bridge/gates.js"
  - "src/settings/gates.js"
  - "shared/gates.js"
  - "shared/protocol.js"
  - "tests/unit/mcp.test.js"
  - "tests/unit/endpoints.test.js"
  - "tests/unit/handles.test.js"
  - "tests/unit/handleInput.test.js"
  - "tests/unit/resultBudget.test.js"
  - "tests/integration/resultHandles.test.js"
  - "tests/unit/foundryBridge.*.test.js"
---

# Wiretap MCP + Foundry bridge

Current-state reference; verify against code before relying on a detail. Core context: `wiretap-codebase-core`;
sidecar composition: `wiretap-sidecar`; MCP sessions and the tool registry: `wiretap-mcp-sessions`.

## Request flow (a registered script such as `create_documents`)

MCP client → `initialize` `POST http://127.0.0.1:<WIRETAP_MCP_PORT>/mcp` (opens a session; later requests carry its
`Mcp-Session-Id`) → the session lists the scripts the routed endpoint registered with `bridge:registry` → the SDK
validates the arguments against the listed schema → `makeRegistryToolHandler` in `server/mcp.ts` →
`bridge.invokeTool(name, args, { endpoint?, listed })` (`server/foundryBridge.ts`, the router of `server/endpoints.ts`) → Socket.IO
`BRIDGE_INVOKE` `{ op: 'callTool', params: { name, arguments }, requestId }` to the chosen endpoint → the client's `callTool` op handler (`src/bridge/scripts/callTool.js`, see `wiretap-scripts`: script lookup, gate, argument validation, handler under an 8 s limit) → result returns the same
way as the tool result.

## Reaching the endpoint

- In-session: the terminal manager appends `--mcp-config "<module root>/.wiretap/mcp-<port>.json"` to a plain
  `claude <args>` launch whose arguments are allowlisted (`[A-Za-z0-9._:=/@+,-]` only: quoted arguments are not wired;
  no standalone `--`). The file is rewritten on every wired launch and never deleted (config:
  `{"mcpServers":{"wiretap":{"type":"http","url":"http://127.0.0.1:<port>/mcp"}}}`; see `wiretap-sidecar`).
- Standalone: `npm run server:mcp` (`mcp-only` mode: Socket.IO, bridge and MCP up, no terminal relay) plus
  `claude mcp add --transport http wiretap http://127.0.0.1:31417/mcp`.
- Only Streamable HTTP exists; stdio is not built (`docs/TODO.md`).

## Pieces

Covers `server/mcp.ts`, `server/endpoints.ts` (registry, router, health, error normalization), `server/foundryBridge.ts` and `src/bridge/foundryBridge.js`. Read references/bridge-pieces.md before changing any of those files.

## Client gate enforcement (`src/bridge/gates.js`, `src/settings/gates.js`)

- The gates are world-scope `restricted` settings registered from `GATES` (see `wiretap-client`). `readGateState()`
  builds the sanitized snapshot from `game.settings`; `requireGate(name, moduleId?)` is the executing client's own check
  (`gateDenial` over a snapshot read at call time). A gated op handler calls `requireGate` first and acks the denial as
  `GATE_DENIED`. The write scripts enforce their category gates per call in `src/bridge/scripts/writeGuard.js` (see `wiretap-scripts`).
- Push: `initFoundryBridge` registers one listener on `createSetting`, `updateSetting` and `deleteSetting` (a first
  change creates the Setting document, a later one updates it, a reset to default deletes it; each document hook
  runs on every client; the world collection is updated before the hook, so `game.settings.get` already returns the new value, or the default after a delete; the author is the last hook argument). For a `wiretap.<gate>` key written by a GM user (`game.users.get(userId)?.isGM`), and only on a connected GM client, it emits `BRIDGE_GATE_STATE` with a fresh
  `readGateState()` and an ack callback; a non-ok ack is logged with `console.error`
  (`Wiretap | bridge gate state refused (<code>): <message>`). A second `initFoundryBridge` call replaces the listener
  (`Hooks.off` first), so a change is never pushed twice. A non-GM author is ignored; a user holding `SETTINGS_MODIFY` can still write a gate and is trusted at GM level (README). A change while disconnected needs no push: the next identify
  carries the snapshot.
- No op can set a setting: the op table holds only `callTool`. The write scripts reach a `Setting` only through `guardWrite`, which applies `denyWiretapSettingWrite` to every Setting create, update (by id too, from the key of the existing document) and delete, and then needs `allowSettingWrites`.
  `foundryBridge.noSettingWrites.test.js` documents it. Every write path goes through `guardWrite`, which wires `denyWiretapSettingWrite`.

## Adding a tool or op

1. Add the `OP_*` constant in `shared/protocol.js` (the wire contract — `PROTOCOL_VERSION`, error codes, identify /
   invoke / ack typedefs — lives there too).
2. Add the handler to the op table in `initFoundryBridge` (`src/bridge/foundryBridge.js`); a new MCP tool is normally a script (`src/bridge/scripts/`, `wiretap-scripts`) rather than an op.
3. Add a pure `make<Tool>Handler(bridge)` (calling `bridge.invoke`) and add it to the tool list in `buildServer` in
   `server/mcp.ts` (built-in tools exist in every session; a tool a GM client supplies is registered at runtime with `bridge:registry` instead, see `server/toolRegistry.ts`); registration wraps it in the result enforcer, so a result over 8,000 bytes becomes a handle; a tool that wants the per-call
   `maxBytes` limit declares an optional integer `maxBytes` in its `inputSchema`.
4. Add a representative-result fixture for the tool to `FIXTURES` in `tests/unit/contextBudgetHarness.js`; `tests/unit/contextBudget.test.js` fails for a listed tool without one and for a definition or fixture result over its budget.
5. Unit-test both sides (`tests/unit/mcp.test.js`, `mcpSessions.test.js`, `toolRegistry.test.js`, `foundryBridge.registry.test.js`, `foundryBridge.client.test.js`, `foundryBridge.server.test.js`,
   `endpoints.test.js`); routing over real sockets is in `tests/integration/endpointRouting.test.js` (fake v4 clients), `create_documents` through the registry, argument validation before sending, the payload shape, annotations and `requires` routing in `tests/integration/scriptRegistry.test.js`; `get_document` and `list_document_types` (read-only annotations, `maxBytes` declared, arguments forwarded, handle over the default cap and inline with `maxBytes` 16000, `DOC_EXCLUDED` as `<code>: <message>`) and the forwarding and bounds of `search_documents` and `describe_schema` (limit, cursor, filter count, field length, path length; refusals asserted as exact MCP validation issues, and the undeclared `maxBytes` of `search_documents` dropped before the client is called) in `tests/integration/readTools.test.js`; sessions, `list_changed`, registry tools, expiry and the cap over real HTTP with the SDK client are in `tests/integration/mcpSessions.test.js` (`tests/integration/mcpHttp.js` is the raw session helper the older integration tests use, because a raw POST without a session no longer works); gate snapshots: `tests/unit/gates.test.js`, `foundryBridge.gateState.test.js` (fake sockets: registered-only rule, throttle, per-endpoint) and `tests/integration/gateState.test.js` (real sockets: identify and event paths, hostile snapshots, two endpoints, no gate state in tool results).
6. Update this skill and the deferred-work file (`docs/TODO.md`).

## Result enforcer, handles and `read_handle`

Covers the result enforcer (`withResultBudget`), byte limits, handles, the handle store, owner keys and `read_handle`. Read references/result-enforcer-handles.md before changing result budgets, handles or `read_handle`.

## Security boundary

Loopback-only HTTP; the `Mcp-Session-Id` is a random UUID and not a credential (same-machine processes are trusted); browser requests with a foreign `Origin` are refused on both the socket handshake and `/mcp` (and a
foreign `Host` on `/mcp`), while requests without `Origin` are trusted as same-machine processes; GM-only execution (a v4 identify with `isGM: true` is the only way to register an endpoint). A shared-secret handshake on the sidecar socket is a
tracked, unimplemented follow-up.

## Reference files

| File | Holds | Read it when |
|---|---|---|
| references/bridge-pieces.md | The Pieces section: mcp.ts, endpoints.ts, foundryBridge.ts, src/bridge/foundryBridge.js | changing MCP, router, endpoint registry, health or the bridge handshake |
| references/result-enforcer-handles.md | The Result enforcer, handles and read_handle section | changing result budgets, handles or read_handle |
