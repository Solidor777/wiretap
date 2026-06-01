import { Server } from 'socket.io';
import { registerEcho } from './echo.ts';

/**
 * Create and start a Wiretap sidecar Socket.IO server. CORS allows the Foundry origin so the browser
 * handshake succeeds. Each connecting socket receives the echo handler.
 * @param port - The TCP port to listen on (0 selects an ephemeral port, used by tests).
 * @returns The started Socket.IO server instance.
 */
export function createWiretapServer(port: number): Server {
   const io = new Server(port, {
      cors: {
         origin: 'http://localhost:30000',
      },
   });

   io.on('connection', (socket) => {
      console.log(`Wiretap sidecar | client connected: ${socket.id}`);
      registerEcho(socket);
      socket.on('disconnect', (reason) => {
         console.log(`Wiretap sidecar | client disconnected: ${socket.id} (${reason})`);
      });
   });

   return io;
}
