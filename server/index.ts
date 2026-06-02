import { createWiretapServer } from './server.ts';

// The port the sidecar listens on; overridable via the WIRETAP_PORT environment variable.
const port = Number(process.env.WIRETAP_PORT ?? 31416);

const { dispose } = createWiretapServer(port);
console.log(`Wiretap sidecar | listening on http://localhost:${port}`);

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
