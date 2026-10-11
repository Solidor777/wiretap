import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_MCP_PORT, GATE_OBSERVER_PORT, SIDECAR_PORT } from './ports.js';

// The repo root, derived from this file's location (tests/e2e/sidecar.js).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');


/**
 * Poll a TCP port until it accepts a connection or the timeout elapses. Each attempt is itself capped so a
 * hung connect (no response) cannot stall past the deadline.
 * @param {number} port - The port to probe.
 * @param {number} timeoutMs - How long to keep retrying.
 * @returns {Promise<void>} Resolves once connectable; rejects on timeout.
 */
function probePort(port, timeoutMs) {
   return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      let settled = false;
      const attempt = () => {
         const socket = net.connect(port, '127.0.0.1');
         socket.setTimeout(1000);
         const retry = () => {
            socket.destroy();
            if (settled) {
               return;
            }
            if (Date.now() > deadline) {
               settled = true;
               reject(new Error(`port ${port} not reachable within ${timeoutMs}ms`));
            } else {
               setTimeout(attempt, 300);
            }
         };
         socket.on('connect', () => {
            socket.end();
            if (!settled) {
               settled = true;
               resolve();
            }
         });
         socket.on('timeout', retry);
         socket.on('error', retry);
      };
      attempt();
   });
}

/**
 * Poll a TCP port until it is free (refuses connections) or the timeout elapses. Each attempt is itself
 * capped so a hung connect cannot stall past the deadline.
 * @param {number} port - The port to probe.
 * @param {number} timeoutMs - How long to keep retrying.
 * @returns {Promise<void>} Resolves once the port is free; rejects on timeout.
 */
function waitForPortFree(port, timeoutMs) {
   return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      let settled = false;
      const attempt = () => {
         const socket = net.connect(port, '127.0.0.1');
         socket.setTimeout(1000);
         const retry = () => {
            socket.destroy();
            if (settled) {
               return;
            }
            if (Date.now() > deadline) {
               settled = true;
               reject(new Error(`port ${port} still occupied after ${timeoutMs}ms — stop any stray sidecar`));
            } else {
               setTimeout(attempt, 300);
            }
         };
         socket.on('connect', () => {
            socket.end();
            retry();
         });
         socket.on('timeout', retry);
         socket.on('error', () => {
            socket.destroy();
            if (!settled) {
               settled = true;
               resolve();
            }
         });
      };
      attempt();
   });
}

/**
 * Spawn a sidecar process and wait until its ports listen. Waits for every port to be free first so a crashed prior
 * run cannot block the spawn; kills a child that never binds so it cannot orphan.
 * @param {string} command - The shell command that starts the sidecar.
 * @param {number[]} ports - The ports that must accept connections before the sidecar counts as started.
 * @returns {Promise<import('node:child_process').ChildProcess>} The spawned sidecar process.
 */
async function launch(command, ports) {
   for (const port of ports) {
      await waitForPortFree(port, 10_000);
   }
   const child = spawn(command, [], {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: true,
      detached: process.platform !== 'win32',
   });
   try {
      for (const port of ports) {
         await probePort(port, 30_000);
      }
   } catch (error) {
      await stopSidecar(child);
      throw error;
   }
   return child;
}

/**
 * Start a fresh Wiretap sidecar for one spec file and wait until it is listening.
 * @returns {Promise<import('node:child_process').ChildProcess>} The spawned sidecar process.
 */
export async function startSidecar() {
   return launch('npm run server:start', [SIDECAR_PORT]);
}

/**
 * Start the e2e gate sidecar: the real sidecar composition without the terminal relay, plus the loopback observer
 * on `GATE_OBSERVER_PORT` that reports the sidecar's risk-gate snapshot.
 * @returns {Promise<import('node:child_process').ChildProcess>} The spawned sidecar process.
 */
export async function startGateSidecar() {
   return launch('npx tsx tests/e2e/gateSidecar.mjs', [
      SIDECAR_PORT,
      E2E_MCP_PORT,
      GATE_OBSERVER_PORT,
   ]);
}

/**
 * Stop a sidecar started by startSidecar and wait until its port is released so the next file can bind.
 * @param {import('node:child_process').ChildProcess | null} child - The sidecar process, or null.
 * @returns {Promise<void>} Resolves once the sidecar is gone and the port is free.
 */
export async function stopSidecar(child) {
   if (!child) {
      return;
   }
   if (process.platform === 'win32') {
      try {
         execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {
         // Already gone.
      }
   } else {
      try {
         process.kill(-child.pid);
      } catch {
         // Already gone.
      }
   }
   await waitForPortFree(SIDECAR_PORT, 10_000);
}
