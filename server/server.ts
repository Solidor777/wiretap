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
