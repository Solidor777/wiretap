import { createWiretapServer } from './server.ts';
import { resolveMode, type ServerMode } from './serverMode.ts';
import { awaitStartup, shutdown } from './shutdown.ts';

// The Socket.IO port the sidecar listens on; overridable via WIRETAP_PORT.
const port: number = Number(process.env.WIRETAP_PORT ?? 31416);

// The MCP HTTP port; overridable via WIRETAP_MCP_PORT.
const mcpPort: number = Number(process.env.WIRETAP_MCP_PORT ?? 31417);

// The run mode: `--mcp-only` or WIRETAP_MODE=mcp-only|full; an invalid WIRETAP_MODE exits before listening.
let mode: ServerMode;
try {
   mode = resolveMode(process.argv.slice(2), process.env);
} catch (error) {
   console.error(`Wiretap sidecar | ${(error as Error).message}`);
   process.exit(1);
}

// The started sidecar: its ports bind asynchronously, so `ready` settles once both are bound or one fails.
const server: { ready: Promise<void>; dispose: () => void } = createWiretapServer(port, mcpPort, mode);
// Tears down the PTY and both servers.
const { dispose }: { dispose: () => void } = server;

// Status lines are printed only after both ports are bound; a bind failure logs, disposes and exits 1.
await awaitStartup(
   server,
   () => {
      console.log(`Wiretap sidecar | mode: ${mode}`);
      console.log(`Wiretap sidecar | listening on http://127.0.0.1:${port}`);
      console.log(`Wiretap MCP | ready on http://127.0.0.1:${mcpPort}/mcp`);
      console.log(
         `Wiretap MCP | register once with:  claude mcp add --transport http wiretap http://127.0.0.1:${mcpPort}/mcp`,
      );
   },
   (code) => process.exit(code),
);

// Kill the PTY and close the servers on a graceful termination signal so the PTY child does not orphan.
// (Windows console-window-close sends CTRL_CLOSE_EVENT, which Node cannot reliably trap; Ctrl-C, `kill`,
// and the e2e teardown are covered.)
process.once('SIGINT', () => shutdown(dispose, (code) => process.exit(code)));
process.once('SIGTERM', () => shutdown(dispose, (code) => process.exit(code)));
