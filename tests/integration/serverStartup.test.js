// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import { createWiretapServer } from '../../server/server.ts';
import { startMcpServer } from '../../server/mcp.ts';
import { awaitStartup } from '../../server/shutdown.ts';

/**
 * Build a bridge that has no endpoint: no tools, no changes and an invoke that resolves to nothing.
 * @returns {{ invoke: Function, tools: Function, subscribe: Function }} A bridge with no endpoint behind it.
 */
function idleBridge() {
   return {
      invoke: async () => undefined,
      tools: () => [],
      subscribe: () => () => undefined,
   };
}

/** @type {import('node:net').Server[]} Occupier servers opened by a test, closed afterwards. */
const occupiers = [];

/** @type {Array<{ dispose: () => void }>} Servers created by a test, disposed afterwards. */
const servers = [];

/**
 * Occupy a free loopback TCP port with a listening server and return the port.
 * @returns {Promise<number>} The occupied port.
 */
function occupyPort() {
   return new Promise((resolve, reject) => {
      /** @type {import('node:net').Server} The server holding the port. */
      const holder = net.createServer();
      occupiers.push(holder);
      holder.once('error', reject);
      holder.listen(0, '127.0.0.1', () => resolve(holder.address().port));
   });
}

/**
 * Reserve a free loopback TCP port by listening on port 0 and releasing it.
 * @returns {Promise<number>} A port that was free at probe time.
 */
async function freePort() {
   /** @type {number} A port held only for the duration of the probe. */
   const port = await occupyPort();
   /** @type {import('node:net').Server} The probe server. */
   const probe = occupiers.pop();
   await new Promise((resolve) => probe.close(resolve));
   return port;
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

afterEach(async () => {
   vi.restoreAllMocks();
   for (const server of servers.splice(0)) {
      try {
         server.dispose();
      } catch {
         // A server whose test already disposed it may throw on a second close; teardown continues.
      }
   }
   for (const holder of occupiers.splice(0)) {
      await new Promise((resolve) => holder.close(resolve));
   }
});

describe('startMcpServer ready', () => {
   it('resolves once the port is bound', async () => {
      /** @type {{ close: () => void, ready: Promise<void> }} The started MCP server. */
      const mcp = startMcpServer(idleBridge(), await freePort());
      servers.push({ dispose: mcp.close });
      await expect(mcp.ready).resolves.toBeUndefined();
   });

   it('rejects with EADDRINUSE when the MCP port is occupied', async () => {
      /** @type {{ close: () => void, ready: Promise<void> }} The MCP server that cannot bind. */
      const mcp = startMcpServer(idleBridge(), await occupyPort());
      servers.push({ dispose: mcp.close });
      await expect(mcp.ready).rejects.toMatchObject({ code: 'EADDRINUSE' });
   });
});

describe('createWiretapServer ready', () => {
   it('rejects when the MCP port is occupied', async () => {
      /** @type {{ ready: Promise<void>, dispose: () => void }} The server whose MCP port is taken. */
      const server = createWiretapServer(0, await occupyPort(), 'mcp-only');
      servers.push(server);
      await expect(server.ready).rejects.toMatchObject({ code: 'EADDRINUSE' });
   });

   it('rejects when the Socket.IO port is occupied', async () => {
      /** @type {{ ready: Promise<void>, dispose: () => void }} The server whose Socket.IO port is taken. */
      const server = createWiretapServer(await occupyPort(), await freePort(), 'mcp-only');
      servers.push(server);
      await expect(server.ready).rejects.toMatchObject({ code: 'EADDRINUSE' });
   });
});

describe('awaitStartup', () => {
   it('runs onReady only after ready resolves and never exits', async () => {
      /** @type {string[]} The order of the steps. */
      const order = [];
      /** @type {PromiseWithResolvers<void>} The ready promise and its resolver, under control of the test. */
      const { promise: ready, resolve: resolveReady } = Promise.withResolvers();
      /** @type {Promise<void>} The startup in flight. */
      const started = awaitStartup(
         { ready, dispose: () => order.push('dispose') },
         () => order.push('onReady'),
         (code) => order.push(`exit${code}`),
      );
      await Promise.resolve();
      expect(order).toEqual([]);
      resolveReady();
      await started;
      expect(order).toEqual(['onReady']);
   });

   it('on rejection logs a Wiretap-prefixed cause, disposes, exits 1 and never runs onReady', async () => {
      /** @type {import('vitest').MockInstance} Records console.error output. */
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      /** @type {string[]} The order of the steps. */
      const order = [];
      await awaitStartup(
         { ready: Promise.reject(new Error('listen EADDRINUSE')), dispose: () => order.push('dispose') },
         () => order.push('onReady'),
         (code) => order.push(`exit${code}`),
      );
      expect(order).toEqual(['dispose', 'exit1']);
      expect(errorSpy.mock.calls[0].join(' ')).toMatch(/^Wiretap sidecar \| .*EADDRINUSE/);
   });

   it('still exits 1 when dispose throws', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      /** @type {import('vitest').Mock} The exit function. */
      const exit = vi.fn();
      await awaitStartup(
         {
            ready: Promise.reject(new Error('boom')),
            dispose: () => {
               throw new Error('dispose failed');
            },
         },
         vi.fn(),
         exit,
      );
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
   });

   it('with a real occupied port: exits 1 and releases the other (MCP) port', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      /** @type {number} The free MCP port that the failed server binds before disposing. */
      const mcpPort = await freePort();
      /** @type {{ ready: Promise<void>, dispose: () => void }} The server whose Socket.IO port is taken. */
      const server = createWiretapServer(await occupyPort(), mcpPort, 'mcp-only');
      /** @type {import('vitest').Mock} The exit function. */
      const exit = vi.fn();
      await awaitStartup(server, vi.fn(), exit);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      await vi.waitFor(async () => expect(await isListening(mcpPort)).toBe(false), { timeout: 1000 });
   });
});
