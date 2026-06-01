# Wiretap AI Bridge — Sub-project #1: Transport + Sidecar Skeleton

**Date:** 2026-06-01
**Status:** Approved (design); pending implementation plan
**Scope:** The transport pipe only — a Node sidecar (socket.io server) and the Foundry module client, proving a message round-trips end-to-end into the Wiretap tab. No Claude, no Foundry tools, no auth.

## 0. Context: the AI bridge roadmap

Wiretap's AI-agent bridge lets a user chat with an AI agent **inside Foundry** (the Wiretap tab is the
chat surface) where **Claude Code is the engine**. Inspired by `adambdooley/foundry-vtt-mcp`, but that
project chats in Claude Desktop with Foundry as a tool target; Wiretap inverts this — the tab is the
chat UI and Claude Code runs behind it.

Because a Foundry module runs in the browser (and Foundry's own Node server is not module-extensible for
spawning processes), Claude Code must run in a **separate Node sidecar process** that the browser tab
talks to over a socket. The agent engine is the **Claude Agent SDK (TypeScript)** (`@anthropic-ai/claude-agent-sdk`),
embedded in the sidecar. Claude's tools will round-trip back through the socket into the browser module
to read/write the game (same pattern foundry-vtt-mcp uses for its MCP server ↔ module link).

```
Wiretap tab (browser, Svelte)  ⇄ socket.io ⇄  Wiretap agent (Node, runs Claude Code)
                                                      │ tool calls (later sub-projects)
                                                      ▼ back over the same socket
                                              Foundry module executes in Foundry's API
```

The bridge is decomposed into a spec sequence; **this spec is #1 only**:

1. **Transport + sidecar skeleton** ← THIS SPEC
2. Claude Code in the sidecar (embed Agent SDK, stream responses, session)
3. Read-only Foundry tool surface (tools round-trip into the module)
4. Write operations + features (create actors/items/walls, permission model)
5. Chat UX polish (streaming, tool-call display, approvals, history)
6. Security / permissions / auth (cross-cutting pass)

## 1. Goal

Stand up the Node sidecar (socket.io server) and the module client, and prove a message round-trips
end-to-end into the Wiretap tab. No Claude, no Foundry tools — just the pipe.

## 2. Decisions (locked in brainstorming)

- **Bridge shape:** chat inside Foundry; Claude Code as backend (Shape B).
- **Engine:** Claude Agent SDK (TypeScript) — embedded later (#2), not in #1.
- **Sidecar packaging:** same repo, `server/` directory, single root `package.json`. Node-only deps
  (socket.io, later the Agent SDK) stay out of the vite browser bundle because vite only bundles `src/`.
- **Transport:** socket.io. The sidecar runs a socket.io **server**; the browser tab connects with
  Foundry's already-bundled `io` **client** (`io('http://<host>:<port>')`) — no extra browser bundle
  weight, free auto-reconnect, ack callbacks for request/response correlation, named events.
- **Default port:** 31416 (one above foundry-vtt-mcp's 31415 to avoid collision), configurable.
- **socket.io version pin:** Foundry v14 bundles `socket.io-client@^4.8.3` (verified in
  `C:\FoundryVTT\V14\foundry\package.json`). The sidecar's `socket.io` server MUST be the matching v4
  line (pin `socket.io@^4.8.3`) so the browser handshake is protocol-compatible. Re-verify this pin on
  any future Foundry version bump.
- **UI:** replace the placeholder counter in `Wiretap.svelte` with connection-status + echo UI.
- **Connection lifecycle:** connect on Foundry `ready` as a persistent singleton; the tab observes its
  reactive state (connection survives the tab opening/closing).

## 3. Components

### 3.1 Sidecar — `server/` (TypeScript, run via `tsx`)
- `server/index.ts` — boots a socket.io server on the configured port (default 31416), CORS allowing
  the Foundry origin (`http://localhost:30000`), logs connect/disconnect, registers the echo handler.
- `server/echo.ts` — the sole handler: on the `wiretap:message` event, ack-replies `{ text, receivedAt }`
  (where `receivedAt` is an ISO timestamp stamped by the sidecar).
- Root `package.json` additions: `socket.io@^4.8.3` (dependency — matches Foundry's bundled
  `socket.io-client`), `tsx` (devDependency); scripts
  `"server": "tsx watch server/index.ts"` and `"server:start": "tsx server/index.ts"`.

### 3.2 Shared wire contract — `shared/protocol.js` (plain JS + JSDoc)
Single source of truth imported by BOTH the browser module and the TS sidecar:
- Event-name constants, e.g. `export const WIRETAP_MESSAGE = 'wiretap:message';`
- JSDoc typedefs for the message payload (`{ text: string }`) and the ack reply
  (`{ text: string, receivedAt: string }`).
Plain JS (not TS) so the browser ESM module imports it directly; the TS sidecar imports the same JS.

### 3.3 Browser module
- `src/bridge/WiretapConnection.svelte.js` — a reactive singleton wrapping Foundry's `io`. Reactive
  `$state`: `status` (`'disconnected'` | `'connecting'` | `'connected'`) and `messages` (array of
  `{ direction: 'out' | 'in', text: string, at: string }`). Methods:
  - `connect()` — reads the `serverUrl` setting, calls `io(serverUrl, { ... })`, wires socket
    `connect` / `disconnect` / `connect_error` events to `status`.
  - `send(text)` — appends an `out` entry, emits `WIRETAP_MESSAGE` with an ack callback; on ack,
    appends an `in` entry from the echoed payload. Rejects/no-ops when not connected.
  - Exported as a singleton instance the component and hooks share.
- `src/components/Wiretap.svelte` — **replaces the counter**. Renders: a connection-status badge bound
  to `connection.status`; a scrollable message log over `connection.messages`; a text input + Send
  button (disabled unless `status === 'connected'`) calling `connection.send()`.
- `src/hooks/OnceInit.js` — additionally registers a **client**-scoped setting `serverUrl`
  (`{ scope: 'client', config: true, type: String, default: 'http://localhost:31416' }`).
- `src/hooks/OnceReady.js` — additionally calls `connection.connect()` on `ready`.

## 4. Data flow

1. Foundry `ready` → singleton reads `serverUrl` setting → `io(serverUrl)` → `status = 'connecting'` →
   on socket `connect` → `status = 'connected'`.
2. User types in the tab → `connection.send(text)` appends an `out` entry and emits `wiretap:message`
   with an ack callback.
3. Sidecar echo handler receives → acks `{ text, receivedAt }`.
4. Ack callback appends an `in` entry → reactive `messages` updates → tab log re-renders.

## 5. Error handling

- Sidecar down / unreachable → `status = 'disconnected'`; socket.io auto-reconnection retries; Send is
  disabled while not connected.
- CORS: the socket.io server sets `cors: { origin: 'http://localhost:30000' }` (the Foundry origin) so
  the browser handshake succeeds.
- Misconfigured `serverUrl` → persistent `disconnected` + a `console.warn` from the connection wrapper.

## 6. Testing

- **Server integration (vitest, node environment):** boot the echo server on an ephemeral port, connect
  a socket.io client, emit `wiretap:message`, assert the ack payload echoes `text` and includes a
  `receivedAt` ISO string. (Adds `socket.io-client` as a devDependency for the test.)
- **Browser unit (vitest, happy-dom):** construct `WiretapConnection` with an injected fake `io` factory
  returning a controllable fake socket; assert (a) `status` transitions on `connect`/`disconnect`
  events, and (b) `send()` appends an `out` entry, and on ack appends an `in` entry with the echoed
  text.
- **Manual verification (not automated in #1):** with the sidecar running (`npm run server`) and a live
  Foundry world, the Wiretap tab shows `connected`, echoes a typed message, and flips to `disconnected`
  when the sidecar stops (reconnecting when it restarts). Full Playwright e2e requires launching the
  sidecar from the test harness; deferred to a later spec to avoid CI orchestration now.

## 7. Out of scope for #1

Claude Agent SDK integration, real AI responses, Foundry game tools, authentication, and token
streaming — all addressed in later sub-projects (see §0 roadmap).

## 8. Definition of done

`npm run server` starts the sidecar; the Wiretap tab shows `connected`; a typed message echoes back from
the sidecar; stopping the sidecar flips status to `disconnected` and it reconnects when restarted; the
server-integration and browser-unit tests pass; `npm run build`, eslint, and stylelint stay green.
