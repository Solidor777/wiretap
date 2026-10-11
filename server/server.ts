import http from 'node:http';
import { Server } from 'socket.io';
import { createTerminalManager } from './terminal.ts';
import { createFoundryBridge } from './foundryBridge.ts';
import { startMcpServer } from './mcp.ts';
import type { ServerMode } from './serverMode.ts';

/**
 * Create and start a Wiretap sidecar Socket.IO server with the MCP bridge attached and, in `full` mode, the terminal
 * relay. In `mcp-only` mode no terminal manager is created and terminal events are not handled.
 * @param {number} port - The TCP port the Socket.IO server listens on, on 127.0.0.1 only (0 selects an ephemeral port,
 *        used by tests).
 * @param {number} mcpPort - The TCP port the MCP HTTP server listens on.
 * @param {ServerMode} [mode] - `'full'` (terminal + MCP, default) or `'mcp-only'` (MCP and the Foundry bridge only).
 * @returns {{ io: Server; ready: Promise<void>; dispose: () => void }} The started server, a promise that resolves once
 *          both ports are bound (or rejects when either bind fails), and a dispose function that kills any PTY and
 *          closes both servers.
 */
export function createWiretapServer(
   port: number,
   mcpPort: number,
   mode: ServerMode = 'full',
): { io: Server; ready: Promise<void>; dispose: () => void } {
   // The HTTP server Socket.IO attaches to; bound to loopback only, because the terminal launch and GM-bridge
   // identify events are unauthenticated and the `cors` option constrains browsers, not other network hosts.
   const httpServer: http.Server = http.createServer();
   // Resolves once the HTTP server is bound (`address()` is null before that); rejects when the bind fails.
   const socketReady: Promise<void> = new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', () => {
         httpServer.off('error', reject);
         resolve();
      });
   });
   // The Socket.IO server carrying terminal and bridge events; `io.close()` also closes `httpServer`.
   const io: Server = new Server(httpServer, {
      cors: {
         origin: 'http://localhost:30000',
      },
   });

   // The terminal relay; absent in `mcp-only` mode.
   const terminal: ReturnType<typeof createTerminalManager> | undefined =
      mode === 'full' ? createTerminalManager(io, undefined, { mcpPort }) : undefined;
   // The Foundry bridge that routes MCP operations to an identified GM client.
   const bridge: ReturnType<typeof createFoundryBridge> = createFoundryBridge();
   // The MCP HTTP server.
   const mcp: ReturnType<typeof startMcpServer> = startMcpServer(bridge, mcpPort);
   // Resolves once both the Socket.IO and MCP ports are bound; rejects with the first bind failure.
   const ready: Promise<void> = Promise.all([socketReady, mcp.ready]).then(() => undefined);

   io.on('connection', (socket) => {
      console.log(`Wiretap sidecar | client connected: ${socket.id}`);
      terminal?.handleConnection(socket);
      bridge.handleConnection(socket);
      socket.on('disconnect', (reason) => {
         console.log(`Wiretap sidecar | client disconnected: ${socket.id} (${reason})`);
      });
   });

   /**
    * Tear down the sidecar: kill any running PTY (full mode), stop the MCP server, then close the Socket.IO server.
    * Each step runs even when an earlier one throws, so both ports are always released; the first error propagates.
    * @returns {void}
    */
   function dispose(): void {
      try {
         terminal?.dispose();
      } finally {
         try {
            mcp.close();
         } finally {
            io.close();
         }
      }
   }

   return { io, ready, dispose };
}
