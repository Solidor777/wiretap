# Wiretap MCP Bridge (create_actor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MCP bridge end-to-end with one tool, `create_actor`, so `claude` (running in the Wiretap terminal) can create an Actor in the live Foundry world.

**Architecture:** The sidecar hosts an MCP server over Streamable HTTP on its own port (127.0.0.1 only). A tool call flows MCP → a generic Foundry bridge (GM-socket registry) → `socket.emit` with ack to the GM's Foundry browser → real `Actor.create` → result back. Three isolated units: MCP server, Foundry bridge (server), client executor (browser). Each is unit-tested at its single boundary.

**Tech Stack:** Node + `tsx` sidecar, `socket.io` (existing), `@modelcontextprotocol/sdk@^1.29` + `zod@^4` (new), Svelte 5 client (existing), `vitest` for unit tests.

---

## Reference facts (verified — do not re-derive)

- **MCP SDK package:** `@modelcontextprotocol/sdk` (stable, latest 1.29.0). Do **NOT** use `@modelcontextprotocol/server` — that is an unstable 2.0 alpha with a different API. zod is a peer dep (`^3.25 || ^4`); install `zod@^4`.
- **MCP imports (1.x):** `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';` and `import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';`
- **registerTool (1.x):** `server.registerTool(name, { description, inputSchema: { field: z.string() } }, async (args) => ({ content: [{ type: 'text', text }], isError? }))`. `inputSchema` is a **zod raw shape object**, not `z.object(...)`.
- **Stateless transport (1.x):** per POST request create a fresh `McpServer` and `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, `await server.connect(transport)`, then `await transport.handleRequest(req, res, parsedBody)`. Clean up both on `res` close. The 3rd arg is the already-parsed JSON body, so when using Node's built-in `http` we read+parse the body ourselves.
- **socket.io server-side ack with timeout:** `socket.timeout(ms).emit(event, payload, (err, response) => {...})` — `err` is truthy on timeout; otherwise `response` is what the client passed to its ack callback.
- **Foundry actor types:** `game.documentTypes.Actor` is an array of subtype strings (verified at `C:\FoundryVTT\V14\foundry\client\game.mjs:180,624`). The base type constant is `CONST.BASE_DOCUMENT_TYPE === "base"` (verified at `C:\FoundryVTT\V14\foundry\common\constants.mjs:171`). Concrete subtypes = that array minus `"base"`.
- **Actor creation:** `await Actor.create({ name, type })` resolves to the created Actor document with `.uuid`, `.id`, `.name`, `.type`.
- **Aliases:** client/test imports use `~/` → `src/` and `$shared/` → `shared/`. Server code imports the protocol via the relative path `../shared/protocol.js`.
- **Test layout:** all unit tests live in `tests/unit/*.test.js`. Server-side tests start with `// @vitest-environment node`. Mock sockets with plain objects (see `tests/unit/sidecarPty.test.js` and `tests/unit/TerminalConnection.test.js` for the established style).

## Commit convention (every commit step)

Use the project identity and trailer:

```bash
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "<subject>" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(Subject shown per task. Do **not** push — the user pushes manually.)

---

## File Structure

**New:**
- `server/foundryBridge.ts` — GM-socket registry + `invokeOnGM(op, params)`. Generic request/response pipe; knows no ops.
- `server/mcp.ts` — `makeCreateActorHandler(bridge)` (pure, testable) + `startMcpServer(bridge, port)` (HTTP transport).
- `src/bridge/foundryBridge.js` — client op registry (`createActor`) + `initFoundryBridge(connection)`. Plain `.js` (no runes — stateless dispatcher).
- `tests/unit/foundryBridge.server.test.js`, `tests/unit/mcp.test.js`, `tests/unit/foundryBridge.client.test.js`, `tests/unit/TerminalConnection.onSocket.test.js`.

**Modified:**
- `shared/protocol.js` — `BRIDGE_IDENTIFY`, `BRIDGE_INVOKE`, `OP_CREATE_ACTOR` + typedefs.
- `src/bridge/TerminalConnection.svelte.js` — add `onSocket(cb)` hook.
- `server/server.ts` — instantiate the bridge, wire identify per connection, start/stop MCP server.
- `server/index.ts` — MCP port env + startup `claude mcp add` log line.
- `src/hooks/OnceReady.js` — call `initFoundryBridge(connection)` for GMs.
- `package.json` — add deps.
- `TODO.md` — tick the MCP item; add deferred live-e2e follow-up.

---

## Task 1: Dependencies + protocol constants

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `shared/protocol.js`

- [ ] **Step 1: Install the new dependencies**

Run:
```bash
npm install @modelcontextprotocol/sdk@^1.29 zod@^4
```
Expected: both added under `dependencies` in `package.json`, no peer-dep warnings about zod.

- [ ] **Step 2: Add the bridge protocol constants + typedefs**

Append to `shared/protocol.js` (after the terminal section, before EOF):

```js
// --- Foundry bridge events (MCP tool execution) ---

// Client → server, once per (re)connect: register this socket as a live Foundry-GM bridge endpoint.
export const BRIDGE_IDENTIFY = 'bridge:identify';

// Server → client, with an ack callback: run a Foundry operation and return its result.
export const BRIDGE_INVOKE = 'bridge:invoke';

// Operation names dispatched over BRIDGE_INVOKE (shared so both sides agree).
export const OP_CREATE_ACTOR = 'createActor';

/**
 * @typedef {object} BridgeIdentify
 * @property {string} userId - The Foundry user id.
 * @property {string} userName - The Foundry user display name.
 * @property {boolean} isGM - Whether the identifying user is a GM.
 */

/**
 * @typedef {object} BridgeInvoke
 * @property {string} op - The operation name (one of the OP_* constants).
 * @property {object} params - Operation parameters.
 */

/**
 * @typedef {object} BridgeAck
 * @property {boolean} ok - Whether the operation succeeded.
 * @property {*} [result] - The operation result when ok is true.
 * @property {string} [error] - A human-readable error when ok is false.
 */
```

- [ ] **Step 3: Verify the module still imports cleanly**

Run:
```bash
npx vitest run tests/unit/TerminalConnection.test.js
```
Expected: PASS (the existing suite imports `$shared/protocol.js`; this confirms the file still parses).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json shared/protocol.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "feat(mcp): add MCP SDK + zod deps and bridge protocol constants" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Foundry bridge (server GM-socket registry)

**Files:**
- Create: `server/foundryBridge.ts`
- Test: `tests/unit/foundryBridge.server.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/foundryBridge.server.test.js`:

```js
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createFoundryBridge } from '../../server/foundryBridge.ts';
import { BRIDGE_IDENTIFY, BRIDGE_INVOKE, OP_CREATE_ACTOR } from '$shared/protocol.js';

/**
 * Build a fake Socket.IO server socket whose ack-emit is controllable.
 * @param {string} id - The socket id.
 * @param {(payload: object) => *} ackResponder - Maps the emitted payload to the ack response (or 'timeout').
 * @returns {object} The fake socket plus a `fire` helper to trigger registered handlers.
 */
function makeSocket(id, ackResponder = () => ({ ok: true, result: {} })) {
   const handlers = {};
   const socket = {
      id,
      on: (event, fn) => { handlers[event] = fn; },
      timeout: () => ({
         emit: (event, payload, ack) => {
            const response = ackResponder(payload);
            if (response === 'timeout') { ack(new Error('timed out')); } else { ack(null, response); }
         },
      }),
   };
   const fire = (event, ...args) => handlers[event]?.(...args);
   return { socket, fire };
}

describe('createFoundryBridge', () => {
   it('rejects invokeOnGM when no GM is registered', async () => {
      const bridge = createFoundryBridge();
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, {})).rejects.toThrow(/No Foundry GM/);
   });

   it('registers a GM on identify and routes a successful invoke to it', async () => {
      const bridge = createFoundryBridge();
      const { socket, fire } = makeSocket('a', () => ({ ok: true, result: { uuid: 'Actor.x' } }));
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, { userId: 'u', userName: 'GM', isGM: true });
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, { name: 'Bob' })).resolves.toEqual({ uuid: 'Actor.x' });
   });

   it('does not register a non-GM socket', async () => {
      const bridge = createFoundryBridge();
      const { socket, fire } = makeSocket('a');
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, { userId: 'u', userName: 'Player', isGM: false });
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, {})).rejects.toThrow(/No Foundry GM/);
   });

   it('rejects when the GM acks ok:false', async () => {
      const bridge = createFoundryBridge();
      const { socket, fire } = makeSocket('a', () => ({ ok: false, error: 'Unknown actor type' }));
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, { userId: 'u', userName: 'GM', isGM: true });
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, {})).rejects.toThrow(/Unknown actor type/);
   });

   it('rejects on ack timeout', async () => {
      const bridge = createFoundryBridge();
      const { socket, fire } = makeSocket('a', () => 'timeout');
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, { userId: 'u', userName: 'GM', isGM: true });
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, {})).rejects.toThrow(/did not respond/);
   });

   it('deregisters a GM on disconnect', async () => {
      const bridge = createFoundryBridge();
      const { socket, fire } = makeSocket('a');
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, { userId: 'u', userName: 'GM', isGM: true });
      fire('disconnect');
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, {})).rejects.toThrow(/No Foundry GM/);
   });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run tests/unit/foundryBridge.server.test.js
```
Expected: FAIL — cannot resolve `../../server/foundryBridge.ts` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `server/foundryBridge.ts`:

```ts
import type { Socket } from 'socket.io';
import { BRIDGE_IDENTIFY, BRIDGE_INVOKE } from '../shared/protocol.js';

// Milliseconds to wait for a Foundry client to ack a bridge invocation before failing.
const INVOKE_TIMEOUT_MS = 10_000;

interface IdentifyPayload {
   userId: string;
   userName: string;
   isGM: boolean;
}

interface BridgeAck {
   ok: boolean;
   result?: unknown;
   error?: string;
}

/**
 * Create the Foundry bridge: a registry of GM-identified Socket.IO sockets plus a generic
 * request/response pipe (`invokeOnGM`) that forwards an operation to a GM client and awaits its ack.
 * Knows nothing about which operations exist — callers pass an op name and params.
 * @returns The bridge with a per-socket connection handler and an `invokeOnGM` method.
 */
export function createFoundryBridge(): {
   handleConnection: (socket: Socket) => void;
   invokeOnGM: (op: string, params: object) => Promise<unknown>;
} {
   // Sockets that have identified as a GM Foundry client, keyed by socket id.
   const gmSockets = new Map<string, Socket>();

   return {
      handleConnection(socket: Socket): void {
         socket.on(BRIDGE_IDENTIFY, (payload: IdentifyPayload) => {
            if (payload?.isGM) {
               gmSockets.set(socket.id, socket);
            }
         });
         socket.on('disconnect', () => {
            gmSockets.delete(socket.id);
         });
      },

      invokeOnGM(op: string, params: object): Promise<unknown> {
         return new Promise((resolve, reject) => {
            const socket = gmSockets.values().next().value as Socket | undefined;
            if (!socket) {
               reject(new Error('No Foundry GM client connected — open Foundry as a GM with Wiretap enabled.'));
               return;
            }
            socket.timeout(INVOKE_TIMEOUT_MS).emit(BRIDGE_INVOKE, { op, params }, (err: unknown, ack: BridgeAck) => {
               if (err) {
                  reject(new Error('Foundry did not respond in time.'));
                  return;
               }
               if (ack?.ok) {
                  resolve(ack.result);
               } else {
                  reject(new Error(ack?.error ?? 'Foundry operation failed.'));
               }
            });
         });
      },
   };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run tests/unit/foundryBridge.server.test.js
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/foundryBridge.ts tests/unit/foundryBridge.server.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "feat(mcp): Foundry bridge — GM-socket registry + invokeOnGM" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: MCP server (create_actor tool)

**Files:**
- Create: `server/mcp.ts`
- Test: `tests/unit/mcp.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mcp.test.js`:

```js
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { makeCreateActorHandler } from '../../server/mcp.ts';

describe('makeCreateActorHandler', () => {
   it('returns success content containing the new actor uuid', async () => {
      const bridge = { invokeOnGM: async () => ({ uuid: 'Actor.abc', id: 'abc', name: 'Bob', type: 'npc' }) };
      const handler = makeCreateActorHandler(bridge);
      const result = await handler({ name: 'Bob', type: 'npc' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Actor.abc');
      expect(result.content[0].text).toContain('Bob');
   });

   it('forwards name and type to the bridge as createActor params', async () => {
      let captured;
      const bridge = { invokeOnGM: async (op, params) => { captured = { op, params }; return { uuid: 'Actor.x', name: 'Z', type: 'character' }; } };
      const handler = makeCreateActorHandler(bridge);
      await handler({ name: 'Z' });
      expect(captured.op).toBe('createActor');
      expect(captured.params).toEqual({ name: 'Z', type: undefined });
   });

   it('maps a bridge rejection to an isError tool result', async () => {
      const bridge = { invokeOnGM: async () => { throw new Error('No Foundry GM client connected'); } };
      const handler = makeCreateActorHandler(bridge);
      const result = await handler({ name: 'Bob' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No Foundry GM');
   });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run tests/unit/mcp.test.js
```
Expected: FAIL — cannot resolve `../../server/mcp.ts`.

- [ ] **Step 3: Write the implementation**

Create `server/mcp.ts`:

```ts
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { OP_CREATE_ACTOR } from '../shared/protocol.js';

interface FoundryBridge {
   invokeOnGM: (op: string, params: object) => Promise<unknown>;
}

interface CreateActorResult {
   uuid: string;
   id?: string;
   name: string;
   type: string;
}

interface ToolResult {
   content: Array<{ type: 'text'; text: string }>;
   isError?: boolean;
}

/**
 * Build the `create_actor` tool handler bound to a Foundry bridge. Pure of any HTTP/transport concern,
 * so it is unit-testable in isolation.
 * @param bridge - The Foundry bridge used to execute the operation on a GM client.
 * @returns An async handler mapping tool args to an MCP tool result.
 */
export function makeCreateActorHandler(bridge: FoundryBridge): (args: { name: string; type?: string }) => Promise<ToolResult> {
   return async ({ name, type }) => {
      try {
         const result = (await bridge.invokeOnGM(OP_CREATE_ACTOR, { name, type })) as CreateActorResult;
         return {
            content: [{ type: 'text', text: `Created actor "${result.name}" (${result.type}) — ${result.uuid}` }],
         };
      } catch (err) {
         return {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
         };
      }
   };
}

/**
 * Construct a fresh MCP server with the create_actor tool registered. A new instance is created per
 * request in stateless mode.
 * @param bridge - The Foundry bridge passed to the tool handler.
 * @returns A configured McpServer.
 */
function buildServer(bridge: FoundryBridge): McpServer {
   const server = new McpServer({ name: 'wiretap', version: '0.0.1' });
   const handler = makeCreateActorHandler(bridge);
   server.registerTool(
      'create_actor',
      {
         description:
            'Create an Actor in the live Foundry world. Returns the created actor uuid. ' +
            "If 'type' is omitted it defaults to the world's first concrete actor subtype.",
         inputSchema: {
            name: z.string().describe('The actor name.'),
            type: z
               .string()
               .optional()
               .describe("The actor subtype, e.g. 'character' or 'npc'. Defaults to the world's first concrete subtype."),
         },
      },
      handler,
   );
   return server;
}

/**
 * Start the MCP HTTP server (Streamable HTTP, stateless) bound to localhost only.
 * @param bridge - The Foundry bridge the tools execute against.
 * @param port - The TCP port to listen on.
 * @returns A handle with a `close` method to stop the HTTP server.
 */
export function startMcpServer(bridge: FoundryBridge, port: number): { close: () => void } {
   const httpServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/mcp') {
         const chunks: Buffer[] = [];
         for await (const chunk of req) {
            chunks.push(chunk as Buffer);
         }
         let body: unknown;
         try {
            body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
         } catch {
            res.writeHead(400).end();
            return;
         }
         const server = buildServer(bridge);
         const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
         res.on('close', () => {
            transport.close();
            server.close();
         });
         await server.connect(transport);
         await transport.handleRequest(req, res, body);
      } else {
         res.writeHead(405).end();
      }
   });
   // Bind to loopback only: this endpoint executes game mutations and must not be reachable off-host.
   httpServer.listen(port, '127.0.0.1');
   return { close: () => httpServer.close() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run tests/unit/mcp.test.js
```
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck the new server files**

Run:
```bash
npm run typecheck
```
Expected: no errors. If `@modelcontextprotocol/sdk` types complain about the zod raw-shape, confirm `zod@^4` is installed (Task 1) and the import is `import { z } from 'zod';`.

- [ ] **Step 6: Commit**

```bash
git add server/mcp.ts tests/unit/mcp.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "feat(mcp): MCP server with create_actor tool (stateless Streamable HTTP)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire the bridge + MCP server into the sidecar

**Files:**
- Modify: `server/server.ts`
- Modify: `server/index.ts`

- [ ] **Step 1: Wire the bridge and MCP server into `createWiretapServer`**

Replace the contents of `server/server.ts` with:

```ts
import { Server } from 'socket.io';
import { createTerminalManager } from './terminal.ts';
import { createFoundryBridge } from './foundryBridge.ts';
import { startMcpServer } from './mcp.ts';

/**
 * Create and start a Wiretap sidecar Socket.IO server with the terminal relay and the MCP bridge attached.
 * @param port - The TCP port the Socket.IO server listens on (0 selects an ephemeral port, used by tests).
 * @param mcpPort - The TCP port the MCP HTTP server listens on.
 * @returns The started server and a dispose function that kills the PTY and closes both servers.
 */
export function createWiretapServer(port: number, mcpPort: number): { io: Server; dispose: () => void } {
   const io = new Server(port, {
      cors: {
         origin: 'http://localhost:30000',
      },
   });

   const terminal = createTerminalManager(io);
   const bridge = createFoundryBridge();
   const mcp = startMcpServer(bridge, mcpPort);

   io.on('connection', (socket) => {
      console.log(`Wiretap sidecar | client connected: ${socket.id}`);
      terminal.handleConnection(socket);
      bridge.handleConnection(socket);
      socket.on('disconnect', (reason) => {
         console.log(`Wiretap sidecar | client disconnected: ${socket.id} (${reason})`);
      });
   });

   /**
    * Tear down the sidecar: kill any running PTY, stop the MCP server, then close the Socket.IO server.
    * @returns Nothing.
    */
   function dispose(): void {
      terminal.dispose();
      mcp.close();
      io.close();
   }

   return { io, dispose };
}
```

- [ ] **Step 2: Add the MCP port + onboarding log to `server/index.ts`**

Replace the contents of `server/index.ts` with:

```ts
import { createWiretapServer } from './server.ts';

// The Socket.IO port the sidecar listens on; overridable via WIRETAP_PORT.
const port = Number(process.env.WIRETAP_PORT ?? 31416);

// The MCP HTTP port; overridable via WIRETAP_MCP_PORT.
const mcpPort = Number(process.env.WIRETAP_MCP_PORT ?? 31417);

const { dispose } = createWiretapServer(port, mcpPort);
console.log(`Wiretap sidecar | listening on http://localhost:${port}`);
console.log(`Wiretap MCP | ready on http://127.0.0.1:${mcpPort}/mcp`);
console.log(`Wiretap MCP | register once with:  claude mcp add --transport http wiretap http://127.0.0.1:${mcpPort}/mcp`);

// Kill the PTY and close the servers on a graceful termination signal so the PTY child does not orphan.
// (Windows console-window-close sends CTRL_CLOSE_EVENT, which Node cannot reliably trap; Ctrl-C, `kill`,
// and the e2e teardown are covered.)
process.once('SIGINT', () => {
   dispose();
   process.exit(0);
});
process.once('SIGTERM', () => {
   dispose();
   process.exit(0);
});
```

- [ ] **Step 3: Update the existing integration test's server constructor call if present**

Check `tests/integration/terminal.test.js` for a `createWiretapServer(` call. If it exists, it now needs a second argument. Update each call to pass an ephemeral MCP port, e.g.:

Run:
```bash
grep -rn "createWiretapServer(" tests
```
For each match, change `createWiretapServer(0)` → `createWiretapServer(0, 0)` (port 0 = ephemeral, so the MCP HTTP server binds a free port and never collides between tests). If there are no matches, skip.

- [ ] **Step 4: Run the full unit suite + typecheck**

Run:
```bash
npm test && npm run typecheck
```
Expected: all unit + integration tests PASS, typecheck clean.

- [ ] **Step 5: Smoke-test the sidecar boots and prints the MCP onboarding line**

Run (Windows PowerShell, foreground, then Ctrl-C):
```bash
npm run server:start
```
Expected: logs include `Wiretap MCP | ready on http://127.0.0.1:31417/mcp` and the `claude mcp add ...` line. Stop with Ctrl-C and confirm it exits cleanly (the SIGINT handler runs).

- [ ] **Step 6: Commit**

```bash
git add server/server.ts server/index.ts tests/integration/terminal.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "feat(mcp): start MCP server + bridge in the sidecar; onboarding log" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Client executor (createActor op handler)

**Files:**
- Create: `src/bridge/foundryBridge.js`
- Test: `tests/unit/foundryBridge.client.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/foundryBridge.client.test.js`:

```js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor } from '~/bridge/foundryBridge.js';

/**
 * Install fake Foundry globals for an actor-creation test.
 * @param {string[]} types - The values of game.documentTypes.Actor.
 * @param {Function} createImpl - The implementation of Actor.create.
 * @returns {void}
 */
function installGlobals(types, createImpl) {
   globalThis.CONST = { BASE_DOCUMENT_TYPE: 'base' };
   globalThis.game = { documentTypes: { Actor: types } };
   globalThis.Actor = { create: createImpl };
}

afterEach(() => {
   delete globalThis.CONST;
   delete globalThis.game;
   delete globalThis.Actor;
});

describe('createActor op handler', () => {
   it('defaults the type to the first concrete subtype when omitted', async () => {
      let received;
      installGlobals(['base', 'character', 'npc'], async (data) => {
         received = data;
         return { uuid: 'Actor.1', id: '1', name: data.name, type: data.type };
      });
      const result = await createActor({ name: 'Bob' });
      expect(received).toEqual({ name: 'Bob', type: 'character' });
      expect(result).toEqual({ uuid: 'Actor.1', id: '1', name: 'Bob', type: 'character' });
   });

   it('passes an explicit valid type through', async () => {
      installGlobals(['base', 'character', 'npc'], async (data) => ({ uuid: 'Actor.2', id: '2', name: data.name, type: data.type }));
      const result = await createActor({ name: 'Goblin', type: 'npc' });
      expect(result.type).toBe('npc');
   });

   it('rejects an unknown type with the valid-types list', async () => {
      installGlobals(['base', 'character', 'npc'], async () => { throw new Error('should not be called'); });
      await expect(createActor({ name: 'X', type: 'wizard' })).rejects.toThrow(/Unknown actor type 'wizard'.*character.*npc/);
   });

   it('surfaces an error thrown by Actor.create', async () => {
      installGlobals(['base', 'character'], async () => { throw new Error('permission denied'); });
      await expect(createActor({ name: 'X' })).rejects.toThrow(/permission denied/);
   });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run tests/unit/foundryBridge.client.test.js
```
Expected: FAIL — cannot resolve `~/bridge/foundryBridge.js`.

- [ ] **Step 3: Write the implementation**

Create `src/bridge/foundryBridge.js`:

```js
import { BRIDGE_IDENTIFY, BRIDGE_INVOKE, OP_CREATE_ACTOR } from '$shared/protocol.js';

/**
 * Create an Actor in the live world. Resolves the actor subtype client-side so the tool stays
 * system-agnostic: an omitted type defaults to the world's first concrete subtype, and an unknown
 * type is rejected with the list of valid types.
 * @param {{ name: string, type?: string }} params - The actor name and optional subtype.
 * @returns {Promise<{ uuid: string, id: string, name: string, type: string }>} The created actor summary.
 */
export async function createActor({ name, type }) {
   // Concrete subtypes = all declared Actor types minus the abstract base type.
   const concreteTypes = game.documentTypes.Actor.filter((t) => t !== CONST.BASE_DOCUMENT_TYPE);
   const resolvedType = type ?? concreteTypes[0];
   if (type !== undefined && !concreteTypes.includes(type)) {
      throw new Error(`Unknown actor type '${type}'. Valid types: ${concreteTypes.join(', ')}`);
   }
   const actor = await Actor.create({ name, type: resolvedType });
   return { uuid: actor.uuid, id: actor.id, name: actor.name, type: actor.type };
}

// Registry mapping op names to their handlers. New tools add one entry here.
const OP_HANDLERS = {
   [OP_CREATE_ACTOR]: createActor,
};

/**
 * Wire the Foundry bridge onto the connection's socket: send identify on each connect and answer
 * BRIDGE_INVOKE requests by dispatching through the op registry. Reuses the single socket owned by
 * the TerminalConnection (no second connection is opened).
 * @param {import('~/bridge/TerminalConnection.svelte.js').TerminalConnection} connection - The shared connection.
 * @returns {void}
 */
export function initFoundryBridge(connection) {
   connection.onSocket((socket) => {
      // Answer operation requests (registered once per socket; persists across reconnects).
      socket.on(BRIDGE_INVOKE, async ({ op, params }, ack) => {
         const handler = OP_HANDLERS[op];
         if (!handler) {
            ack({ ok: false, error: `Unknown op '${op}'.` });
            return;
         }
         try {
            const result = await handler(params);
            ack({ ok: true, result });
         } catch (err) {
            ack({ ok: false, error: err?.message ?? String(err) });
         }
      });

      // Identify as a GM bridge endpoint on every (re)connect.
      const identify = () => {
         socket.emit(BRIDGE_IDENTIFY, { userId: game.user.id, userName: game.user.name, isGM: game.user.isGM });
      };
      socket.on('connect', identify);
      if (socket.connected) {
         identify();
      }
   });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run tests/unit/foundryBridge.client.test.js
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bridge/foundryBridge.js tests/unit/foundryBridge.client.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "feat(mcp): client executor — createActor op + initFoundryBridge" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `onSocket` hook on TerminalConnection

**Files:**
- Modify: `src/bridge/TerminalConnection.svelte.js`
- Test: `tests/unit/TerminalConnection.onSocket.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/TerminalConnection.onSocket.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { TerminalConnection } from '~/bridge/TerminalConnection.svelte.js';

/**
 * Build a controllable fake Socket.IO socket.
 * @returns {{ socket: object, fire: (event: string, ...args: *[]) => void }} Test helpers.
 */
function makeFakeSocket() {
   const handlers = {};
   const socket = {
      connected: false,
      on(event, fn) { (handlers[event] ??= []).push(fn); },
      emit() {},
   };
   const fire = (event, ...args) => (handlers[event] ?? []).forEach((fn) => fn(...args));
   return { socket, fire };
}

describe('TerminalConnection.onSocket', () => {
   it('invokes the listener with the socket created by connect()', () => {
      const { socket } = makeFakeSocket();
      const conn = new TerminalConnection();
      let received = null;
      conn.onSocket((s) => { received = s; });
      conn.connect('http://localhost:31416', () => socket);
      expect(received).toBe(socket);
   });

   it('invokes a listener registered after connect with the existing socket', () => {
      const { socket } = makeFakeSocket();
      const conn = new TerminalConnection();
      conn.connect('http://localhost:31416', () => socket);
      let received = null;
      conn.onSocket((s) => { received = s; });
      expect(received).toBe(socket);
   });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run tests/unit/TerminalConnection.onSocket.test.js
```
Expected: FAIL — `conn.onSocket is not a function`.

- [ ] **Step 3: Add the `onSocket` hook**

In `src/bridge/TerminalConnection.svelte.js`, add a private field alongside the other private fields (after the `#sinks` field, around line 71):

```js
   /**
    * Listeners invoked with the live socket whenever a socket is created (and immediately on
    * registration if a socket already exists). Used by the Foundry bridge to share the one connection.
    * @type {Set<(socket: object) => void>}
    */
   #socketListeners = new Set();
```

In `connect()`, immediately after `this.#socket = socket;` (around line 90), notify listeners:

```js
      for (const listener of this.#socketListeners) {
         listener(socket);
      }
```

Add this new public method (after `attach()`, before `launch()`):

```js
   /**
    * Register a listener invoked with the live socket each time one is created. If a socket already
    * exists, the listener is invoked immediately. Returns an unsubscribe function.
    * @param {(socket: object) => void} listener - Receives the socket.
    * @returns {() => void} An unsubscribe function.
    */
   onSocket(listener) {
      this.#socketListeners.add(listener);
      if (this.#socket) {
         listener(this.#socket);
      }
      return () => {
         this.#socketListeners.delete(listener);
      };
   }
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run tests/unit/TerminalConnection.onSocket.test.js tests/unit/TerminalConnection.test.js
```
Expected: both PASS (the existing TerminalConnection suite is unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/bridge/TerminalConnection.svelte.js tests/unit/TerminalConnection.onSocket.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "feat(mcp): TerminalConnection.onSocket hook for socket sharing" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Initialize the client bridge on ready

**Files:**
- Modify: `src/hooks/OnceReady.js`

- [ ] **Step 1: Call `initFoundryBridge` for GMs**

Replace the contents of `src/hooks/OnceReady.js` with:

```js
import { connection } from '~/bridge/TerminalConnection.svelte.js';
import { initFoundryBridge } from '~/bridge/foundryBridge.js';

/**
 * Foundry `ready` handler. Logs readiness, connects the persistent sidecar socket using the configured
 * server URL, and wires the Foundry bridge so the user's `claude` can execute tools against this world.
 * @returns {void}
 */
export default function onceReady() {
   console.log('Wiretap | Module ready.');
   // GM-only: the sidecar exposes a terminal on the host, so non-GM clients never connect.
   if (game.user.isGM) {
      connection.connect(game.settings.get('wiretap', 'serverUrl'));
      initFoundryBridge(connection);
   }
}
```

- [ ] **Step 2: Run the full unit suite + lint + typecheck + build**

Run:
```bash
npm test && npm run eslint && npm run stylelint && npm run typecheck && npm run build
```
Expected: all green. (`build` rewrites root `index.js`/`style.css` for production — that is expected and committed elsewhere; do not commit build output here unless the repo already tracks it; check `git status` and only add source files.)

- [ ] **Step 3: Commit**

```bash
git add src/hooks/OnceReady.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "feat(mcp): initialize the Foundry bridge for GM clients on ready" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: TODO update + manual end-to-end verification

**Files:**
- Modify: `TODO.md`

- [ ] **Step 1: Update `TODO.md`**

In `TODO.md`, under "AI bridge roadmap", change the dedicated Foundry MCP line to mark the slice done and add the deferred follow-ups. Replace:

```markdown
- [ ] (optional/future) dedicated Foundry MCP server for the user's `claude` to call
```

with:

```markdown
- [x] dedicated Foundry MCP server for the user's `claude` to call — vertical slice: `create_actor`
      (sidecar hosts MCP over Streamable HTTP on 127.0.0.1:31417; GM identify handshake routes tool
      calls to the GM browser; `Actor.create` round-trips the uuid back). See
      `docs/superpowers/specs/2026-06-02-wiretap-mcp-bridge-design.md`.
- [ ] MCP follow-ups: more tools (`create_item`, `create_walls`, scene reads); live-Foundry e2e for
      the bridge (drive an MCP HTTP client against the sidecar, assert an Actor appears); optional
      Wiretap settings UI (enable toggle + port); shared-secret handshake on the sidecar socket.
```

- [ ] **Step 2: Commit**

```bash
git add TODO.md
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "docs: tick MCP create_actor slice in TODO; record follow-ups" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Manual end-to-end verification (requires the user driving live Foundry)**

This proves the full bridge; it is not automated in this slice. With the sidecar running in an external terminal (`npm run server`) and Foundry open as a GM with Wiretap enabled:

1. In a terminal, register the server once: `claude mcp add --transport http wiretap http://127.0.0.1:31417/mcp` (or run it inside the Wiretap terminal's `claude`).
2. Confirm `claude mcp list` shows `wiretap` as connected.
3. In `claude`, ask it to call the `create_actor` tool with `name: "Wiretap Test Goblin"`.
4. Expect: the tool returns `Created actor "Wiretap Test Goblin" (<type>) — Actor.<id>`, and the actor appears in the Foundry Actors sidebar.
5. Negative check: close the Foundry browser tab, call `create_actor` again, expect the readable error "No Foundry GM client connected …".
6. Negative check: call `create_actor` with `type: "bogus"`, expect "Unknown actor type 'bogus'. Valid types: …".

Report results. If all pass, the slice is complete and ready to push (push only when the user asks).

---

## Self-Review (completed during planning)

- **Spec coverage:** every spec section maps to a task — MCP server (T3), Foundry bridge + GM handshake (T2, T4, T6, T7), protocol additions (T1), create_actor + type defaulting (T5), onboarding log (T4), security/loopback bind (T3), error table (T2 bridge messages, T5 type errors, T3 mapping), unit testing (T2/T3/T5/T6), deferred live e2e (T8 manual + TODO).
- **Placeholder scan:** no TBD/TODO/"handle errors" — every code step shows complete code.
- **Type consistency:** `createFoundryBridge().invokeOnGM(op, params)` used identically in T2/T3/T4; `makeCreateActorHandler(bridge)` (T3) matches its test (T3); `createActor({name,type})` shape consistent across T5 client + the `OP_CREATE_ACTOR` constant (T1); `onSocket(listener)` defined in T6 and consumed in T5/`initFoundryBridge`; ack shape `{ok, result, error}` (`BridgeAck`) consistent between server bridge (T2) and client ack (T5); ports 31416 (socket) / 31417 (MCP) consistent (T4).
