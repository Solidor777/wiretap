import { Server } from 'socket.io';
import { createTerminalManager } from './terminal.ts';

/**
 * Create and start a Wiretap sidecar Socket.IO server with the terminal relay attached, and register
 * SIGINT/SIGTERM handlers that kill the PTY and close the server so the PTY child does not orphan.
 * @param port - The TCP port to listen on (0 selects an ephemeral port, used by tests).
 * @returns The started server and a dispose function that kills the PTY and closes the server.
 */
export function createWiretapServer(port: number): { io: Server; dispose: () => void } {
   const io = new Server(port, {
      cors: {
         origin: 'http://localhost:30000',
      },
   });

   const terminal = createTerminalManager(io);

   io.on('connection', (socket) => {
      console.log(`Wiretap sidecar | client connected: ${socket.id}`);
      terminal.handleConnection(socket);
      socket.on('disconnect', (reason) => {
         console.log(`Wiretap sidecar | client disconnected: ${socket.id} (${reason})`);
      });
   });

   /**
    * Tear down the sidecar: kill any running PTY, then close the Socket.IO server.
    * @returns Nothing.
    */
   function dispose(): void {
      terminal.dispose();
      io.close();
   }

   // Kill the PTY and close the server on a graceful termination signal so the PTY child does not orphan.
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

   return { io, dispose };
}
