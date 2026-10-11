// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';

/** @type {{ terminalThrows: boolean, mcpCloseThrows: boolean }} Failure switches read by the mocked modules. */
const failures = vi.hoisted(() => ({ terminalThrows: false, mcpCloseThrows: false }));

vi.mock('../../server/terminal.ts', () => ({
   createTerminalManager: () => ({
      handleConnection: () => {},
      dispose: () => {
         if (failures.terminalThrows) {
            throw new Error('terminal dispose failed');
         }
      },
   }),
}));

// The real MCP server is started and really closed; the wrapper only throws afterwards, so no listener leaks.
vi.mock('../../server/mcp.ts', async (importOriginal) => {
   const actual = await importOriginal();
   return {
      ...actual,
      startMcpServer: (bridge, port) => {
         const handle = actual.startMcpServer(bridge, port);
         return {
            ready: handle.ready,
            close: () => {
               handle.close();
               if (failures.mcpCloseThrows) {
                  throw new Error('mcp close failed');
               }
            },
         };
      },
   };
});

const { createWiretapServer } = await import('../../server/server.ts');

/**
 * Reserve a free loopback TCP port by listening on port 0 and releasing it.
 * @returns {Promise<number>} A port that was free at probe time.
 */
function freePort() {
   return new Promise((resolve, reject) => {
      /** @type {import('node:net').Server} A throwaway server used to reserve a port. */
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
         /** @type {number} The port the OS assigned. */
         const { port } = probe.address();
         probe.close(() => resolve(port));
      });
   });
}

/**
 * Report whether something accepts TCP connections on a loopback port.
 * @param {number} port - The loopback port to probe.
 * @returns {Promise<boolean>} True when a connection was accepted.
 */
function isListening(port) {
   return new Promise((resolve) => {
      /** @type {import('node:net').Socket} The probing connection. */
      const probe = net.connect({ port, host: '127.0.0.1' });
      probe.once('connect', () => {
         probe.destroy();
         resolve(true);
      });
      probe.once('error', () => resolve(false));
   });
}

/**
 * Retry an async check every 20 ms until it returns true, failing after 1000 ms.
 * @param {() => Promise<boolean>} check - The condition to evaluate.
 * @param {string} what - A description used in the timeout error.
 * @returns {Promise<void>} Resolves once the check returned true.
 */
async function poll(check, what) {
   /** @type {number} The epoch-millisecond time after which the poll fails. */
   const deadline = Date.now() + 1000;
   while (Date.now() < deadline) {
      if (await check()) {
         return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
   }
   throw new Error(`Timed out after 1000 ms waiting for ${what}`);
}

describe('createWiretapServer dispose ordering', () => {
   afterEach(() => {
      failures.terminalThrows = false;
      failures.mcpCloseThrows = false;
   });

   it('releases both ports when terminal.dispose throws', async () => {
      failures.terminalThrows = true;
      /** @type {number} The MCP port under test. */
      const mcpPort = await freePort();
      const server = createWiretapServer(0, mcpPort, 'full');
      await server.ready;
      /** @type {number} The Socket.IO port assigned to the server. */
      const socketPort = server.io.httpServer.address().port;
      await poll(() => isListening(mcpPort), 'the MCP port to accept connections');

      expect(() => server.dispose()).toThrow('terminal dispose failed');
      await poll(async () => !(await isListening(mcpPort)), 'the MCP port to be released');
      await poll(async () => !(await isListening(socketPort)), 'the socket port to be released');
   });

   it('still closes the Socket.IO server when mcp.close throws', async () => {
      failures.mcpCloseThrows = true;
      /** @type {number} The MCP port under test. */
      const mcpPort = await freePort();
      const server = createWiretapServer(0, mcpPort, 'full');
      await server.ready;
      /** @type {number} The Socket.IO port assigned to the server. */
      const socketPort = server.io.httpServer.address().port;
      expect(await isListening(socketPort)).toBe(true);

      expect(() => server.dispose()).toThrow('mcp close failed');
      await poll(async () => !(await isListening(socketPort)), 'the socket port to be released');
   });
});
