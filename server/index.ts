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
