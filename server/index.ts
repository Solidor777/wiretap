import { createWiretapServer } from './server.ts';

// The port the sidecar listens on; overridable via the WIRETAP_PORT environment variable.
const port = Number(process.env.WIRETAP_PORT ?? 31416);

createWiretapServer(port);
console.log(`Wiretap sidecar | listening on http://localhost:${port}`);
