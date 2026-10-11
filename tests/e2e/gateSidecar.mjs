// E2E-only sidecar launcher: runs the real sidecar composition (Socket.IO, bridge, MCP; no terminal relay) and adds a
// loopback HTTP observer that reports the risk-gate snapshot the bridge would apply to the next call, plus the ids of
// the connected sockets. The snapshot is read through the same `bridge.gateState()` accessor the sidecar uses. The MCP
// server binds `E2E_MCP_PORT`, not the sidecar default, and `mcp-only` mode creates no terminal manager, so nothing
// here writes a `.wiretap/mcp-<port>.json` config file. Started only by tests/e2e/sidecar.js; never part of the
// shipping build.
import http from 'node:http';
import { createWiretapServer } from '../../server/server.ts';
import { isMcpHostAllowed } from '../../server/origins.ts';
import { E2E_MCP_PORT, GATE_OBSERVER_PORT, SIDECAR_PORT } from './ports.js';

/** @type {ReturnType<typeof createWiretapServer>} The started sidecar: Socket.IO server, bridge and MCP server. */
const server = createWiretapServer(SIDECAR_PORT, E2E_MCP_PORT, 'mcp-only');
await server.ready;

/** @type {http.Server} The observer: GET gives `{ gateState, socketIds }`; loopback only; refuses a foreign Host. */
const observer = http.createServer((request, response) => {
   if (!isMcpHostAllowed(request.headers.host, GATE_OBSERVER_PORT)) {
      response.statusCode = 403;
      response.end();
      return;
   }
   response.setHeader('Content-Type', 'application/json');
   response.end(
      JSON.stringify({
         gateState: server.bridge.gateState(),
         socketIds: [...server.io.sockets.sockets.keys()],
      }),
   );
});
observer.listen(GATE_OBSERVER_PORT, '127.0.0.1', () => {
   console.log(`Wiretap e2e | gate observer ready on http://127.0.0.1:${GATE_OBSERVER_PORT}`);
});

/**
 * Stop the observer and the sidecar, then exit.
 * @returns {never} Never returns; the process exits.
 */
const shutdown = () => {
   observer.close();
   server.dispose();
   process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
