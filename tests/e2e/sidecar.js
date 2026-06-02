import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, derived from this file's location (tests/e2e/sidecar.js).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The sidecar port (must match the default `serverUrl` setting).
const SIDECAR_PORT = 31416;

/**
 * Poll a TCP port until it accepts a connection or the timeout elapses.
 * @param {number} port - The port to probe.
 * @param {number} timeoutMs - How long to keep retrying.
 * @returns {Promise<void>} Resolves once connectable; rejects on timeout.
 */
function probePort(port, timeoutMs) {
   return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
         const socket = net.connect(port, '127.0.0.1');
         socket.on('connect', () => {
            socket.end();
            resolve();
         });
         socket.on('error', () => {
            socket.destroy();
            if (Date.now() > deadline) {
               reject(new Error(`port ${port} not reachable within ${timeoutMs}ms`));
            } else {
               setTimeout(attempt, 300);
            }
         });
      };
      attempt();
   });
}

/**
 * Poll a TCP port until it is free (refuses connections) or the timeout elapses.
 * @param {number} port - The port to probe.
 * @param {number} timeoutMs - How long to keep retrying.
 * @returns {Promise<void>} Resolves once the port is free; rejects on timeout.
 */
function waitForPortFree(port, timeoutMs) {
   return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
         const socket = net.connect(port, '127.0.0.1');
         socket.on('connect', () => {
            socket.end();
            if (Date.now() > deadline) {
               reject(new Error(`port ${port} still occupied after ${timeoutMs}ms — stop any stray sidecar`));
            } else {
               setTimeout(attempt, 300);
            }
         });
         socket.on('error', () => {
            socket.destroy();
            resolve();
         });
      };
      attempt();
   });
}

/**
 * Start a fresh Wiretap sidecar for one spec file and wait until it is listening. Waits for the port to be
 * free first so a crashed prior run cannot block the spawn.
 * @returns {Promise<import('node:child_process').ChildProcess>} The spawned sidecar process.
 */
export async function startSidecar() {
   await waitForPortFree(SIDECAR_PORT, 10_000);
   const child = spawn('npm', ['run', 'server:start'], {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: true,
      detached: process.platform !== 'win32',
   });
   await probePort(SIDECAR_PORT, 30_000);
   return child;
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
