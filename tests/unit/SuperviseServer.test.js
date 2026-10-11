import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import {
   getAncestors,
   isAlive,
   isPortInUse,
   pickStandaloneWatchPid,
   pickWatchPid,
   superviseServer,
} from '../../scripts/lib/superviseServer.mjs';

/** @type {string} A node one-liner that stays alive until killed. */
const IDLE_SCRIPT = 'setInterval(() => {}, 1000)';

/** @type {import('node:child_process').ChildProcess[]} Processes to reap after each test. */
const spawned = [];

/**
 * Spawns an idle node process that the test controls, registered for cleanup.
 * @returns {import('node:child_process').ChildProcess} The idle process.
 */
function spawnIdle() {
   const child = spawn(process.execPath, [
      '-e',
      IDLE_SCRIPT,
   ], { stdio: 'ignore' });
   spawned.push(child);
   return child;
}

/**
 * Polls until the predicate holds or the timeout elapses.
 * @param {() => boolean} predicate - The condition to wait for.
 * @param {number} [timeoutMs] - Maximum wait (default 5000).
 * @returns {Promise<boolean>} True when the predicate held before the timeout.
 */
async function waitFor(predicate, timeoutMs = 5000) {
   const deadline = Date.now() + timeoutMs;
   while (Date.now() < deadline) {
      if (predicate()) {
         return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
   }
   return predicate();
}

/**
 * Binds a TCP listener on an ephemeral port.
 * @returns {Promise<{ server: net.Server, port: number }>} The listener and its port.
 */
function listenEphemeral() {
   return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => resolve({
         server,
         port: server.address().port,
      }));
   });
}

afterEach(() => {
   for (const child of spawned.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
         child.kill('SIGKILL');
      }
   }
});

describe('superviseServer', () => {
   it('kills the spawned server when the watched process dies', async () => {
      const watched = spawnIdle();
      const { server, port } = await listenEphemeral();
      server.close();

      const handle = await superviseServer({
         command: process.execPath,
         args: [
            '-e',
            IDLE_SCRIPT,
         ],
         cwd: process.cwd(),
         port,
         watchPid: watched.pid,
         pollMs: 50,
         log: () => {},
      });
      spawned.push(handle.child);
      expect(handle.child, 'a server is spawned when the port is free').not.toBeNull();
      expect(isAlive(handle.child.pid), 'the spawned server is running').toBe(true);

      watched.kill('SIGKILL');

      const code = await handle.done;
      expect(code, 'the supervisor settles once the watched process is gone').toBe(0);
      expect(
         await waitFor(() => !isAlive(handle.child.pid)),
         'the spawned server is dead after the watched process died',
      ).toBe(true);
   });

   it('reuses an existing listener and spawns nothing', async () => {
      const { server, port } = await listenEphemeral();
      try {
         const handle = await superviseServer({
            command: process.execPath,
            args: [
               '-e',
               IDLE_SCRIPT,
            ],
            cwd: process.cwd(),
            port,
            log: () => {},
         });
         expect(handle.child, 'nothing is spawned while the port answers').toBeNull();
         handle.stop();
         expect(await handle.done, 'stop settles the reuse handle').toBe(0);
      }
      finally {
         server.close();
      }
   });

   it('reports the exit code of a server that exits on its own', async () => {
      const { server, port } = await listenEphemeral();
      server.close();

      const handle = await superviseServer({
         command: process.execPath,
         args: [
            '-e',
            'process.exit(7)',
         ],
         cwd: process.cwd(),
         port,
         log: () => {},
      });
      expect(await handle.done, 'the child exit code is surfaced').toBe(7);
   });

   it('stop() kills the spawned server', async () => {
      const { server, port } = await listenEphemeral();
      server.close();

      const handle = await superviseServer({
         command: process.execPath,
         args: [
            '-e',
            IDLE_SCRIPT,
         ],
         cwd: process.cwd(),
         port,
         log: () => {},
      });
      spawned.push(handle.child);
      handle.stop();
      expect(await handle.done, 'stop settles with 0').toBe(0);
      expect(await waitFor(() => !isAlive(handle.child.pid)), 'the server is dead after stop').toBe(true);
   });
});

describe('process helpers', () => {
   it('isPortInUse distinguishes a bound port from a free one', async () => {
      const { server, port } = await listenEphemeral();
      try {
         expect(await isPortInUse('127.0.0.1', port), 'bound port').toBe(true);
      }
      finally {
         server.close();
      }
      await new Promise((resolve) => server.once('close', resolve));
      expect(await isPortInUse('127.0.0.1', port), 'released port').toBe(false);
   });

   it('getAncestors starts with the real parent process', () => {
      const ancestors = getAncestors(process.pid, 1);
      expect(ancestors[0]?.pid, 'nearest ancestor is process.ppid').toBe(process.ppid);
   });

   it('pickWatchPid skips shells and returns the first real ancestor', () => {
      expect(pickWatchPid([
         {
            pid: 10,
            name: 'cmd.exe',
         },
         {
            pid: 20,
            name: 'node.exe',
         },
         {
            pid: 30,
            name: 'bash',
         },
      ])).toBe(20);
      expect(pickWatchPid([{
         pid: 10,
         name: 'sh',
      }])).toBeUndefined();
   });
});

describe('pickStandaloneWatchPid', () => {
   /** @type {{ pid: number, name: string }[]} The measured `npm run foundry:start` chain, nearest first. */
   const npmChain = [
      {
         pid: 10,
         name: 'cmd.exe',
      },
      {
         pid: 20,
         name: 'node.exe',
      },
      {
         pid: 30,
         name: 'cmd.exe',
      },
      {
         pid: 40,
         name: 'claude.exe',
      },
   ];

   it('through npm, watches the shell that launched the npm wrapper', () => {
      expect(pickStandaloneWatchPid(npmChain, true)).toBe(30);
   });

   it('through npm, watches a non-shell invoker when no shell sits between', () => {
      expect(pickStandaloneWatchPid([
         npmChain[0],
         npmChain[1],
         npmChain[3],
      ], true)).toBe(40);
   });

   it('without npm, watches the nearest ancestor even when it is a shell', () => {
      expect(pickStandaloneWatchPid([
         {
            pid: 10,
            name: 'bash',
         },
         npmChain[3],
      ], false)).toBe(10);
   });

   it('returns undefined when the chain is exhausted', () => {
      expect(pickStandaloneWatchPid([], false), 'empty, direct').toBeUndefined();
      expect(pickStandaloneWatchPid(npmChain.slice(0, 2), true), 'npm wrapper is the last entry').toBeUndefined();
      expect(pickStandaloneWatchPid([npmChain[0]], true), 'only shells').toBeUndefined();
   });

   it('leaves pickWatchPid on the npm chain at the npm wrapper', () => {
      expect(pickWatchPid(npmChain)).toBe(20);
   });
});
