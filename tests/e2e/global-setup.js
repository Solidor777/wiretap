import { execSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, derived from this file's location (tests/e2e/global-setup.js).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The sidecar port (must match the default `serverUrl` setting).
const SIDECAR_PORT = 31416;

/**
 * Poll a TCP port until it accepts a connection or the timeout elapses.
 * @param {number} port - The port to probe.
 * @param {number} timeoutMs - How long to keep retrying.
 * @returns {Promise<boolean>} Resolves true once connectable; rejects on timeout.
 */
function probePort(port, timeoutMs) {
   return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
         const socket = net.connect(port, '127.0.0.1');
         socket.on('connect', () => {
            socket.end();
            resolve(true);
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
 * Playwright global setup: build the e2e bundle (probe-enabled) and ensure the sidecar is running.
 * Returns a teardown that stops a sidecar we started.
 * @returns {Promise<() => Promise<void>>} The global-teardown function.
 */
export default async function globalSetup() {
   execSync('npm run build:e2e', { cwd: repoRoot, stdio: 'inherit' });

   // Reuse an already-running sidecar; otherwise spawn one for the suite.
   const alreadyUp = await probePort(SIDECAR_PORT, 500).then(() => true).catch(() => false);
   let child = null;
   if (!alreadyUp) {
      child = spawn('npm', ['run', 'server:start'], {
         cwd: repoRoot,
         stdio: 'ignore',
         shell: true,
         detached: process.platform !== 'win32',
      });
      await probePort(SIDECAR_PORT, 30_000);
   }

   return async () => {
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
   };
}
