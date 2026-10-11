---
name: wiretap-mcp-bridge
description: Wiretap MCP server and Foundry bridge — MCP tool registration (create_actor), sidecar-to-GM-client op dispatch, client-side op handlers, wire ops. Use when reading or editing the MCP endpoint, adding MCP tools or bridge ops, or touching the bridge handshake.
paths:
  - "server/mcp.ts"
  - "server/foundryBridge.ts"
  - "src/bridge/foundryBridge.js"
  - "shared/protocol.js"
  - "tests/unit/mcp.test.js"
  - "tests/unit/foundryBridge.*.test.js"
---

# Wiretap MCP + Foundry bridge

Current-state reference; verify against code before relying on a detail. Core context: `wiretap-codebase-core`;
sidecar composition: `wiretap-sidecar`.

## Request flow (`create_actor`)

MCP client → `POST http://127.0.0.1:<WIRETAP_MCP_PORT>/mcp` → `server/mcp.ts` tool handler →
`bridge.invokeOnGM(OP_CREATE_ACTOR, params)` (`server/foundryBridge.ts`) → Socket.IO `BRIDGE_INVOKE` to the identified
GM client → `OP_HANDLERS` in `src/bridge/foundryBridge.js` → `createActor({ name, type })` → result returns the same
way as the tool result.

## Reaching the endpoint

- In-session: the terminal manager appends `--mcp-config "<module root>/.wiretap/mcp-<port>.json"` to a plain
  `claude <args>` launch whose arguments are allowlisted (`[A-Za-z0-9._:=/@+,-]` only: quoted arguments are not wired;
  no standalone `--`). The file is rewritten on every wired launch and never deleted (config:
  `{"mcpServers":{"wiretap":{"type":"http","url":"http://127.0.0.1:<port>/mcp"}}}`; see `wiretap-sidecar`).
- Standalone: `npm run server:mcp` (`mcp-only` mode: Socket.IO, bridge and MCP up, no terminal relay) plus
  `claude mcp add --transport http wiretap http://127.0.0.1:31417/mcp`.
- Only Streamable HTTP exists; stdio is not built (`TODO.md`).

## Pieces

- `server/mcp.ts`
  - `makeCreateActorHandler(bridge)`: pure handler; errors become `{ isError: true }` tool results.
  - `buildServer(bridge)`: a fresh `McpServer` (`name: 'wiretap'`) per request; registers `create_actor`
    (`name: string`, optional `type: string`; omitted `type` defaults to the world's first concrete actor subtype).
  - `startMcpServer(bridge, port)`: Streamable HTTP, stateless (`sessionIdGenerator: undefined`), `POST /mcp` only
    (other methods → 405), body-read failure → 400, dispatch failure → JSON-RPC `-32603`; listens on `127.0.0.1`. Returns `{ close, ready }`; `ready` resolves once bound and rejects on a bind failure
    (for example `EADDRINUSE`), so `createWiretapServer` folds it into its own `ready`.
- `server/foundryBridge.ts` — `createFoundryBridge()` exposes `invokeOnGM` and `handleConnection(socket)`; a GM client
  announces itself with `BRIDGE_IDENTIFY`.
- `src/bridge/foundryBridge.js` — `initFoundryBridge(connection)` (called from `OnceReady`) attaches to the shared
  socket via `TerminalConnection.onSocket`; `createActor` executes the world mutation on a GM client.

## Adding a tool or op

1. Add the `OP_*` constant in `shared/protocol.js`.
2. Add the handler to `OP_HANDLERS` in `src/bridge/foundryBridge.js`.
3. Add a pure `make<Tool>Handler(bridge)` and register it in `buildServer` in `server/mcp.ts`.
4. Unit-test both sides (`tests/unit/mcp.test.js`, `foundryBridge.client.test.js`, `foundryBridge.server.test.js`).
5. Update this skill and the deferred-work file (`TODO.md` at the repo root).

## Security boundary

Loopback-only HTTP; GM-only execution (identify handshake). A shared-secret handshake on the sidecar socket is a
tracked, unimplemented follow-up.
