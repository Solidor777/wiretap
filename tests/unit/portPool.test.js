import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { reservePort, PORT_POOL_FIRST, PORT_POOL_LAST } from '../portPool.js';

/** @type {number} First port of the Windows and Linux dynamic (ephemeral) range, shared with outbound sockets. */
const EPHEMERAL_FIRST = 49152;

describe('test port pool', () => {
   it('hands out ports below the OS ephemeral range, where outbound client sockets cannot take them', async () => {
      /** @type {number[]} Ports reserved by one worker. */
      const ports = [];
      for (let index = 0; index < 20; index += 1) {
         ports.push(await reservePort());
      }
      for (const port of ports) {
         expect(port).toBeGreaterThanOrEqual(PORT_POOL_FIRST);
         expect(port).toBeLessThanOrEqual(PORT_POOL_LAST);
         expect(port).toBeLessThan(EPHEMERAL_FIRST);
      }
   });

   it('never hands out one port twice while the earlier holder still listens on it', async () => {
      /** @type {net.Server[]} Servers holding reserved ports. */
      const holders = [];
      /** @type {Set<number>} Ports seen so far. */
      const seen = new Set();
      try {
         for (let index = 0; index < 20; index += 1) {
            /** @type {number} The reserved port. */
            const port = await reservePort();
            expect(seen.has(port)).toBe(false);
            seen.add(port);
            /** @type {net.Server} The holder binding the port. */
            const holder = net.createServer();
            await new Promise((resolve, reject) => {
               holder.once('error', reject);
               holder.listen(port, '127.0.0.1', resolve);
            });
            holders.push(holder);
         }
      } finally {
         await Promise.all(holders.map((holder) => new Promise((resolve) => holder.close(resolve))));
      }
   });

   it('binds exactly the reserved port afterwards', async () => {
      /** @type {number} The reserved port. */
      const port = await reservePort();
      /** @type {net.Server} The later real server. */
      const server = net.createServer();
      await new Promise((resolve, reject) => {
         server.once('error', reject);
         server.listen(port, '127.0.0.1', resolve);
      });
      expect(server.address().port).toBe(port);
      await new Promise((resolve) => server.close(resolve));
   });
});
