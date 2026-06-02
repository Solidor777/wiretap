# Wiretap MCP Bridge — Vertical Slice (`create_actor`)

**Date:** 2026-06-02
**Status:** Design approved; pending implementation plan
**Scope:** A thin, end-to-end vertical slice that proves the MCP bridge from `claude` into the
live Foundry world via a single tool, `create_actor`. Subsequent tools are cheap copies of the
established pattern.

## Goal & Motivation

The terminal relay gives `claude` a window onto the user's filesystem and shell, but **no access
to the running Foundry game** — it cannot read `game.actors` or call `Actor.create(...)`. The MCP
server is the actuator that turns "Claude Code in a Foundry-shaped window" into "an agent that
generates actors, items, and walls directly inside Foundry" (the module's stated vision).

This slice builds the full bridge with exactly one tool, so the request/response path,
GM-targeting, error surfacing, and onboarding are all proven before the toolset is widened.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Iteration scope | Thin vertical slice — one tool end-to-end |
| Proving tool | `create_actor` (write into the live game, meaningful return) |
| Actor `type` handling | Optional; defaults to the world's first concrete subtype, overridable |
| Execution targeting | GM identify handshake; route to a registered GM socket; error if none |
| Topology | Sidecar hosts the MCP server itself (Streamable HTTP) on its own port |

### Context that shaped the design

- The sidecar is already a `socket.io` **server** (port 31416); the Foundry browser connects as a
  **client**. The bidirectional channel (emit + ack) needed for tool execution already exists in
  skeleton form.
- `claude` runs in a PTY spawned by that same sidecar, on the same machine — no network-trust
  problem to solve, and the MCP server can live in the process that already owns the Foundry socket.
- The client **already connects GM-only**: `src/hooks/OnceReady.js` calls `connection.connect()`
  only when `game.user.isGM`. Non-GM browsers never touch the sidecar. So the handshake is not about
  filtering players out (they are absent) — it is a lightweight *identify + readiness registration*
  so the sidecar knows a socket is a live Foundry-GM endpoint and can error cleanly when none exists.

## Architecture & Components

Three new units, each with one job and a single clean boundary. The MCP server never sees a socket;
the bridge never sees Foundry; the client never sees MCP. Each is unit-testable with a mock at its
one boundary.

### 1. MCP server — `server/mcp.ts`

- Uses `@modelcontextprotocol/sdk` (`McpServer` + `StreamableHTTPServerTransport`).
- Listens on its own port: `WIRETAP_MCP_PORT`, default **31417**, bound to **`127.0.0.1` only**.
- Registers exactly one tool, `create_actor`, with a zod arg schema `{ name: string, type?: string }`.
- The handler contains no Foundry-specific logic. It calls `bridge.invokeOnGM('createActor', params)`
  and maps the typed result/error into MCP tool content.
- **Depends on:** the Foundry bridge.

### 2. Foundry bridge (GM-socket registry) — `server/foundryBridge.ts`

- The seam between MCP-land and socket-land. Tracks sockets that have completed the identify
  handshake.
- Exposes one method: `invokeOnGM(op, params) → Promise<result>` — picks a registered GM socket
  (rejects if none), emits `BRIDGE_INVOKE` with an ack + timeout, resolves on `{ok:true}`, rejects
  on `{ok:false}` or timeout.
- Knows nothing about which ops exist — a generic request/response pipe.
- **Depends on:** `socket.io` only.

### 3. Foundry client executor — `src/bridge/foundryBridge.js`

- Plain `.js` (no Svelte runes — it is a stateless op dispatcher, no reactive UI state), placed in
  `src/bridge/` alongside the existing connection code.
- **Reuses the single socket already owned by `TerminalConnection`** rather than opening a second
  connection. `TerminalConnection` exposes a registration hook (e.g. `onSocket(cb)` invoked with the
  live socket on `connect`); the executor uses it to send identify and attach the `BRIDGE_INVOKE`
  listener onto that same socket. One Foundry↔sidecar connection total.
- On `connect`, sends `BRIDGE_IDENTIFY { userId, userName, isGM }`.
- Listens for `BRIDGE_INVOKE`, dispatches `op` through a small op-handler registry, runs the real
  Foundry API, and acks `{ ok:true, result }` / `{ ok:false, error }`.
- The slice registers one handler: `createActor`.
- **Depends on:** `TerminalConnection` (for the socket hook) and Foundry globals (`Actor`, `game`,
  `CONST`).

Adding tool #2 later touches only the MCP tool list + the client op registry — never the bridge.

## Protocol Additions (`shared/protocol.js`)

Single source of truth, imported by both sides (plain JS, matching the existing file).

```js
// Client → server, once on connect: register this socket as a live Foundry-GM bridge endpoint.
export const BRIDGE_IDENTIFY = 'bridge:identify';   // payload: { userId, userName, isGM }

// Server → client, with ack callback: run a Foundry operation and return its result.
export const BRIDGE_INVOKE = 'bridge:invoke';       // payload: { op, params }
                                                    // ack: { ok:true, result } | { ok:false, error }

// Op name constants (shared so both sides agree).
export const OP_CREATE_ACTOR = 'createActor';
```

Plus typedefs (`BridgeIdentify`, `BridgeInvoke`, `BridgeAck`) in the existing file's JSDoc style.

## Data Flow — `create_actor` (happy path)

1. `claude` calls MCP tool `create_actor({ name: "Goblin Scout", type: "npc" })`.
2. MCP server validates args (zod), calls `bridge.invokeOnGM(OP_CREATE_ACTOR, { name, type })`.
3. Bridge picks a registered GM socket, emits `BRIDGE_INVOKE { op, params }` with a **10 s ack
   timeout** (`socket.timeout(10000).emit(...)`).
4. Client receives, looks up `createActor` in its op registry, runs `Actor.create({ name, type })`,
   acks `{ ok:true, result:{ uuid, id, name, type } }`.
5. Bridge resolves; MCP handler returns tool content — a short success line plus the `uuid` as
   structured content, so `claude` can reference the new actor.

## Error Handling

Every failure becomes a readable MCP tool error (`isError: true`). The bridge never throws raw — it
always resolves the MCP handler with a typed `{ok}` shape, so the MCP server's mapping is uniform.

| Failure | Where caught | Message to claude |
|---|---|---|
| No GM connected | bridge | "No Foundry GM client connected — open Foundry as a GM with Wiretap enabled." |
| Ack timeout (10 s) | bridge | "Foundry did not respond in time." |
| Unknown actor `type` | client (validates against available types) | "Unknown actor type 'x'. Valid types: character, npc, …" |
| `Actor.create` throws (permission, schema) | client | the caught error message |
| Invalid tool args | MCP SDK (zod) | schema validation error |

## `create_actor` Specifics

**Type defaulting (system-agnostic).** `type` is optional and resolved **client-side**, since only
the browser knows the world's system:

- Omitted → first concrete subtype:
  `game.documentTypes.Actor.filter((t) => t !== CONST.BASE_DOCUMENT_TYPE)[0]` (e.g. `character` on
  dnd5e). `CONST.BASE_DOCUMENT_TYPE === "base"` (confirmed in
  `C:\FoundryVTT\V14\foundry\common\constants.mjs:171`).
- Supplied but not in that list → reject with the valid-types list, so `claude` self-corrects.
- The resolved `type` is returned in the result, so `claude` always sees what was created.

This keeps the tool correct on any system with zero system-specific code, and the same
`documentTypes` pattern generalizes to `create_item` later.

## Onboarding

One-time, copy-paste. On startup the sidecar logs the exact registration line:

```
Wiretap MCP | ready on http://127.0.0.1:31417/mcp
Wiretap MCP | register once with:  claude mcp add --transport http wiretap http://127.0.0.1:31417/mcp
```

No Wiretap UI for it in the slice — env (`WIRETAP_MCP_PORT`) plus the log line is enough. A settings
toggle/port field is a natural later polish (deferred).

## Security

- MCP HTTP transport **binds to `127.0.0.1` only** — never `0.0.0.0`. The endpoint executes game
  mutations and must not be reachable off-host.
- Execution still flows through a real GM browser (the handshake), so Foundry's own permission system
  remains the backstop.
- The optional shared-secret handshake already in `TODO.md` applies here too — future
  defense-in-depth, out of slice scope.

## Testing

Unit-first, matching the project's existing split.

**Sidecar (vitest):**
- `foundryBridge` — identify registers a socket; disconnect deregisters; `invokeOnGM` rejects when
  registry empty; routes to a registered GM; ack `{ok:false}` rejects; timeout rejects. (Mock socket
  objects.)
- `mcp` tool handler — maps `{ok:true}` → success content with uuid; maps each error shape →
  `isError` content. (Mock bridge.)

**Module (vitest):**
- `createActor` op handler — calls `Actor.create` with defaulted type when omitted; passes through an
  explicit valid type; rejects unknown type with the valid-types list; surfaces a thrown
  `Actor.create` error. (Mock global `Actor`, `game.documentTypes`, `CONST`.)

**e2e (Playwright) — deferred.** A full live-Foundry path (drive an MCP HTTP client against the
sidecar, assert an Actor appears in the world) is the real integration proof, but it needs a live GM
world and inherits the known terminal-e2e environment flake. The slice ships on thorough unit
coverage; the live e2e goes into `TODO.md` as a follow-up, consistent with how the relay e2e was
staged.

## File Inventory

**New:**
- `server/mcp.ts` — MCP server, `create_actor` tool, HTTP transport on `WIRETAP_MCP_PORT`.
- `server/foundryBridge.ts` — GM-socket registry + `invokeOnGM`.
- `src/bridge/foundryBridge.js` — client handshake + op registry + `createActor` handler.
- Test files alongside each.

**Modified:**
- `shared/protocol.js` — `BRIDGE_IDENTIFY`, `BRIDGE_INVOKE`, `OP_CREATE_ACTOR` + typedefs.
- `server/server.ts` — instantiate the bridge, wire identify into the connection handler, start the
  MCP server, dispose it in `dispose()`.
- `server/index.ts` — MCP port env + startup `claude mcp add` log line.
- `src/bridge/TerminalConnection.svelte.js` — expose a socket-registration hook (`onSocket(cb)`) so
  the client executor can share the one socket.
- `src/hooks/OnceReady.js` — initialize the client bridge after `connection.connect()`.
- `package.json` — add `@modelcontextprotocol/sdk` + `zod`.
- `TODO.md` — tick the MCP item; add the deferred live-e2e follow-up.

**Dependencies added:** `@modelcontextprotocol/sdk`, `zod`.

## Out of Scope (this slice)

- Any tool other than `create_actor` (item/wall/scene reads & writes).
- A structured chat UI (independent axis; the existing terminal already shows tool calls).
- Wiretap settings UI for the MCP server (toggle, port).
- Shared-secret handshake on the sidecar socket.
- Live-Foundry e2e for the bridge.
