import net from 'node:net';

/** @type {number} First port of the pool; above Foundry (30000) and the default MCP port (31417). */
export const PORT_POOL_FIRST = 32000;

/** @type {number} Last port of the pool; the OS dynamic range, shared with outbound sockets, starts at 49152. */
export const PORT_POOL_LAST = 48999;

/** @type {number} Ports in one worker's slice of the pool. */
const SLICE_SIZE = 300;

/**
 * @type {number} This worker's slice index. Vitest numbers the workers of one run from 1 (`VITEST_POOL_ID`), so slices
 * never overlap inside a run; a process outside vitest falls back to its pid.
 */
const SLICE_INDEX = (Number(process.env.VITEST_POOL_ID ?? process.pid) || 0) % Math.floor(
   (PORT_POOL_LAST - PORT_POOL_FIRST + 1) / SLICE_SIZE,
);

/**
 * @type {number} Offset of the next candidate inside this worker's slice. It starts at a random offset so that two
 * separate vitest runs whose worker numbers coincide do not walk the same ports in step.
 */
let cursor = Math.floor(Math.random() * SLICE_SIZE);

/**
 * Report whether a loopback port can be bound right now.
 * @param {number} port - The candidate port.
 * @returns {Promise<boolean>} True when the bind succeeded and was released.
 */
function canBind(port) {
   return new Promise((resolve) => {
      /** @type {net.Server} The throwaway binder. */
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
   });
}

/**
 * Reserve a loopback TCP port for a server the test starts next. Ports come from a pool below the OS dynamic range,
 * sliced per vitest worker. Asking the OS for port 0 and releasing it instead draws from the range that outbound
 * client sockets use, so another worker's connection can take the port before the real server binds (EADDRINUSE).
 * @returns {Promise<number>} A port that is bindable now and that no other worker of the run hands out.
 */
export async function reservePort() {
   for (let attempt = 0; attempt < SLICE_SIZE; attempt += 1) {
      /** @type {number} The candidate port. */
      const port = PORT_POOL_FIRST + SLICE_INDEX * SLICE_SIZE + (cursor % SLICE_SIZE);
      cursor += 1;
      if (await canBind(port)) {
         return port;
      }
   }
   throw new Error('Test port pool exhausted: every port in this worker slice is in use');
}
