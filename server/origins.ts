// The browser origins allowed to reach the sidecar: the Foundry page origins (port 30000) and the Vite dev-server page
// origins (port 30001, `server.port` in vite.config.mjs, where `npm run dev` serves the page). Requests with no Origin
// header (local non-browser processes) are allowed because the accepted trust model treats same-machine processes as
// trusted. This is the only place the list is defined; the Socket.IO handshake check, its CORS option and the MCP
// check read it.
export const ALLOWED_ORIGINS: readonly string[] = [
   'http://localhost:30000',
   'http://127.0.0.1:30000',
   'http://localhost:30001',
   'http://127.0.0.1:30001',
];

/**
 * Decide whether a request's `Origin` header is acceptable: absent (a non-browser local process) or listed.
 * A repeated header arrives as an array or a comma-joined string and never matches.
 * @param {string | undefined} origin - The raw `Origin` header value.
 * @returns {boolean} True when the request may proceed.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
   return origin === undefined || ALLOWED_ORIGINS.includes(origin);
}

/**
 * Decide whether a request's `Host` header names this MCP endpoint (DNS-rebinding defence): `127.0.0.1:<port>` or
 * `localhost:<port>`, compared case-insensitively.
 * @param {string | undefined} host - The raw `Host` header value.
 * @param {number} port - The port the MCP server listens on.
 * @returns {boolean} True when the Host header is acceptable.
 */
export function isMcpHostAllowed(host: string | undefined, port: number): boolean {
   if (host === undefined) {
      return false;
   }
   const normalized: string = host.toLowerCase();
   return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
}
