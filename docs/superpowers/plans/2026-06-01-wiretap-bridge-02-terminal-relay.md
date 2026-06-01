# Wiretap AI Bridge #2 — Claude Code Terminal Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Project rule:** Route `.js`/`.svelte`/`.svelte.js` work to the `foundry-module-dev` contract — implementer invokes `svelte-5`, `foundry-vtt`, `foundry-svelte` via the Skill tool first. Follow `.claude/CLAUDE.md` style (120-col; multi-line objects/arrays; JSDoc; typed+commented declarations; no `:global`). The sidecar is TypeScript (run via `tsx`, type-checked via `npm run typecheck`, NOT eslint-linted — `server/` is eslint-ignored).

**Goal:** Turn the Wiretap tab into a PTY-backed terminal: a Launch/Close toggle spawns/kills an interactive `claude` in a pseudo-terminal on the sidecar, and the tab is a themed `xterm.js` terminal streaming its output and sending input, reattaching across Foundry reloads.

**Architecture:** Reuse #1's socket.io transport. The sidecar replaces its echo handler with a `node-pty` terminal manager (single PTY, scrollback buffer, broadcast to all sockets). The browser swaps the chat UI for an `xterm.js` terminal driven by a reactive `TerminalConnection`. Wiretap never calls Anthropic — the `claude` inside the PTY is the user's interactive session.

**Tech Stack:** `node-pty` (sidecar, native/ConPTY), `@xterm/xterm` + `@xterm/addon-fit` (browser, bundled), socket.io (reused), Svelte 5 runes, Vitest (node integration + happy-dom unit).

**Spec:** `docs/superpowers/specs/2026-06-01-wiretap-bridge-02-terminal-relay-design.md`

**Carried facts:** socket.io reused from #1 (Foundry's global `io`); `serverUrl` client setting exists; `server/` is TS + eslint-ignored + typechecked; commits authored `Solidor <justintarquin2019@gmail.com>` (user-confirmed) with the Claude co-author trailer.

---

## File structure

| File | Change | Task |
|---|---|---|
| `package.json` | add `node-pty`, `@xterm/xterm`, `@xterm/addon-fit` | 1 |
| `shared/protocol.js` | add `TERMINAL_*` events (keep `WIRETAP_MESSAGE` until Task 4) | 1 |
| `server/terminal.ts` | NEW — PTY terminal manager (replaces `echo.ts`) | 2 |
| `server/echo.ts` | DELETE | 2 |
| `server/server.ts` | wire terminal manager instead of `registerEcho` | 2 |
| `tests/integration/echo.test.js` | DELETE | 2 |
| `tests/integration/terminal.test.js` | NEW — node-pty round-trip | 2 |
| `src/bridge/TerminalConnection.svelte.js` | NEW — reactive terminal socket wrapper | 3 |
| `tests/unit/TerminalConnection.test.js` | NEW | 3 |
| `src/components/Wiretap.svelte` | rewrite → xterm terminal + toolbar | 4 |
| `tests/unit/Wiretap.test.js` | rewrite for terminal UI | 4 |
| `src/hooks/OnceInit.js` | add `terminalCommand` setting | 4 |
| `src/hooks/OnceReady.js` | import `connection` from TerminalConnection | 4 |
| `src/bridge/WiretapConnection.svelte.js` + `tests/unit/WiretapConnection.test.js` | DELETE | 4 |
| `shared/protocol.js` | remove `WIRETAP_MESSAGE` + echo typedefs | 4 |
| `TODO.md` | refresh bridge roadmap for the pivot | 5 |

---

### Task 1: Dependencies + protocol additions

**Files:** modify `package.json`, `shared/protocol.js`

- [ ] **Step 1: Add deps to `package.json`.** In `dependencies` add `"node-pty": "^1.0.0"`, `"@xterm/xterm": "^5.5.0"`, `"@xterm/addon-fit": "^0.10.0"` (keep existing `socket.io`).

- [ ] **Step 2: Install.** Run `npm install`.
Expected: completes. **If `node-pty` fails to build** (native module; Windows needs ConPTY + possibly VS Build Tools), report BLOCKED with the exact error — do not bump versions blindly; a known fallback is the API-compatible `@homebridge/node-pty-prebuilt-multiarch` (prebuilt binaries), which the controller can approve.

- [ ] **Step 3: Add terminal events to `shared/protocol.js`** — append after the existing exports (do NOT remove `WIRETAP_MESSAGE` yet):
```js

// --- Terminal relay events (sub-project #2) ---

// Client → server: spawn the PTY with a command at an initial size.
export const TERMINAL_LAUNCH = 'terminal:launch';

// Client → server: forward user keystrokes to the PTY stdin.
export const TERMINAL_INPUT = 'terminal:input';

// Client → server: resize the PTY to match the terminal viewport.
export const TERMINAL_RESIZE = 'terminal:resize';

// Client → server: kill the PTY.
export const TERMINAL_CLOSE = 'terminal:close';

// Server → client: a chunk of PTY output (live or replayed scrollback).
export const TERMINAL_DATA = 'terminal:data';

// Server → client: current terminal state (broadcast on change + on connect).
export const TERMINAL_STATE = 'terminal:state';

// Server → client: the PTY process exited.
export const TERMINAL_EXIT = 'terminal:exit';

/**
 * @typedef {object} TerminalLaunch
 * @property {string} [command] - Command line to run in the PTY (default 'claude').
 * @property {number} cols - Initial column count.
 * @property {number} rows - Initial row count.
 */

/**
 * @typedef {object} TerminalResize
 * @property {number} cols - New column count.
 * @property {number} rows - New row count.
 */

/**
 * @typedef {object} TerminalInput
 * @property {string} data - Raw input bytes to write to the PTY stdin.
 */

/**
 * @typedef {object} TerminalData
 * @property {string} chunk - A chunk of PTY output.
 */

/**
 * @typedef {object} TerminalState
 * @property {boolean} running - Whether a PTY is currently active.
 * @property {number} [cols] - Current column count, when running.
 * @property {number} [rows] - Current row count, when running.
 */

/**
 * @typedef {object} TerminalExit
 * @property {number|null} code - Process exit code.
 * @property {string} [signal] - Terminating signal, if any.
 */
```

- [ ] **Step 4: Verify.** Run `npm run eslint` (expect clean) and `node -e "import('./shared/protocol.js').then(m=>console.log(!!m.TERMINAL_LAUNCH&&!!m.WIRETAP_MESSAGE?'OK':'MISSING'))"` (expect `OK`).

- [ ] **Step 5: Commit:**
```bash
git add package.json package-lock.json shared/protocol.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'chore: add node-pty + xterm deps and terminal protocol events\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Sidecar terminal manager (TDD)

**Files:** create `server/terminal.ts`, `tests/integration/terminal.test.js`; modify `server/server.ts`; delete `server/echo.ts`, `tests/integration/echo.test.js`

- [ ] **Step 1: Write the failing integration test — `tests/integration/terminal.test.js`:**
```js
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import { createWiretapServer } from '../../server/server.ts';
import {
   TERMINAL_LAUNCH,
   TERMINAL_INPUT,
   TERMINAL_CLOSE,
   TERMINAL_DATA,
   TERMINAL_EXIT,
} from '../../shared/protocol.js';

/**
 * Connect a client and wait until accumulated TERMINAL_DATA satisfies a predicate, or time out.
 * @param {object} client - The socket.io client.
 * @param {(acc: string) => boolean} predicate - Resolves when this returns true.
 * @param {number} [ms] - Timeout in milliseconds.
 * @returns {Promise<string>} The accumulated output.
 */
function waitForData(client, predicate, ms = 8000) {
   return new Promise((resolve, reject) => {
      let acc = '';
      const timer = setTimeout(() => reject(new Error(`timeout; got: ${JSON.stringify(acc)}`)), ms);
      client.on(TERMINAL_DATA, ({ chunk }) => {
         acc += chunk;
         if (predicate(acc)) {
            clearTimeout(timer);
            resolve(acc);
         }
      });
   });
}

describe('Wiretap sidecar terminal manager', () => {
   /** @type {import('socket.io').Server | undefined} */
   let server;

   afterEach(async () => {
      if (server) {
         await new Promise((resolve) => server.close(resolve));
         server = undefined;
      }
   });

   it('launches a command and streams output, then exits', async () => {
      server = createWiretapServer(0);
      const port = server.httpServer.address().port;
      const client = ioClient(`http://localhost:${port}`);
      await new Promise((r) => client.on('connect', r));

      const exited = new Promise((resolve) => client.on(TERMINAL_EXIT, resolve));
      const dataP = waitForData(client, (acc) => /v\d+\.\d+\.\d+/.test(acc));
      client.emit(TERMINAL_LAUNCH, { command: 'node --version', cols: 80, rows: 24 });

      const out = await dataP;
      const exit = await exited;
      client.close();
      expect(out).toMatch(/v\d+\.\d+\.\d+/);
      expect(exit.code).toBe(0);
   });

   it('forwards input to the PTY and closes on demand', async () => {
      server = createWiretapServer(0);
      const port = server.httpServer.address().port;
      const client = ioClient(`http://localhost:${port}`);
      await new Promise((r) => client.on('connect', r));

      client.emit(TERMINAL_LAUNCH, { command: 'node', cols: 80, rows: 24 });
      // Wait for the Node REPL prompt, then send a command whose output is deterministic.
      await waitForData(client, (acc) => acc.includes('>'));
      const pong = waitForData(client, (acc) => acc.includes('PONG'));
      client.emit(TERMINAL_INPUT, { data: 'console.log("PONG")\r' });
      await pong;

      const exited = new Promise((resolve) => client.on(TERMINAL_EXIT, resolve));
      client.emit(TERMINAL_CLOSE, {});
      const exit = await exited;
      client.close();
      expect(exit).toBeTruthy();
   });
});
```

- [ ] **Step 2: Run it to verify it FAILS.** Run `npm test -- tests/integration/terminal.test.js`. Expected: FAIL (server still wires the echo handler; `TERMINAL_LAUNCH` is unhandled → timeout). Confirm.

- [ ] **Step 3: Create `server/terminal.ts`:**
```ts
import * as pty from 'node-pty';
import type { Server, Socket } from 'socket.io';
import {
   TERMINAL_LAUNCH,
   TERMINAL_INPUT,
   TERMINAL_RESIZE,
   TERMINAL_CLOSE,
   TERMINAL_DATA,
   TERMINAL_STATE,
   TERMINAL_EXIT,
} from '../shared/protocol.js';

// Maximum bytes of recent PTY output retained for reattach replay.
const SCROLLBACK_LIMIT = 64 * 1024;

interface LaunchPayload {
   command?: string;
   cols: number;
   rows: number;
}

interface ResizePayload {
   cols: number;
   rows: number;
}

interface InputPayload {
   data: string;
}

/**
 * Resolve a command line into a PTY spawn file + args, routed through the platform shell so PATH and
 * Windows `.cmd` shims (e.g. `claude`) resolve.
 * @param command - The command line to run.
 * @returns The shell file and its arguments.
 */
function resolveSpawn(command: string): { file: string; args: string[] } {
   if (process.platform === 'win32') {
      return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/c', command] };
   }
   return { file: '/bin/sh', args: ['-c', command] };
}

/**
 * Create the single-PTY terminal manager bound to a Socket.IO server. Spawns at most one PTY, broadcasts
 * its output to all connected sockets, retains a scrollback buffer for reattach, and accepts input/resize/
 * close from any socket.
 * @param io - The Socket.IO server used to broadcast terminal events.
 * @returns The manager with a per-socket connection handler.
 */
export function createTerminalManager(io: Server): { handleConnection: (socket: Socket) => void } {
   let term: pty.IPty | null = null;
   let scrollback = '';
   let size = { cols: 80, rows: 24 };

   /**
    * Append a chunk to the scrollback buffer, trimming to the byte cap.
    * @param chunk - The output chunk to retain.
    */
   function appendScrollback(chunk: string): void {
      scrollback += chunk;
      if (scrollback.length > SCROLLBACK_LIMIT) {
         scrollback = scrollback.slice(scrollback.length - SCROLLBACK_LIMIT);
      }
   }

   /**
    * Spawn the PTY if none is running.
    * @param payload - The launch parameters.
    */
   function launch(payload: LaunchPayload): void {
      if (term) {
         return;
      }
      const command = payload.command ?? 'claude';
      size = { cols: payload.cols, rows: payload.rows };
      scrollback = '';
      const { file, args } = resolveSpawn(command);
      const child = pty.spawn(file, args, {
         name: 'xterm-color',
         cols: size.cols,
         rows: size.rows,
         cwd: process.cwd(),
         env: process.env as { [key: string]: string },
      });
      term = child;
      child.onData((chunk) => {
         appendScrollback(chunk);
         io.emit(TERMINAL_DATA, { chunk });
      });
      child.onExit(({ exitCode, signal }) => {
         term = null;
         scrollback = '';
         io.emit(TERMINAL_EXIT, { code: exitCode, signal: signal ? String(signal) : undefined });
         io.emit(TERMINAL_STATE, { running: false });
      });
      io.emit(TERMINAL_STATE, { running: true, cols: size.cols, rows: size.rows });
   }

   return {
      handleConnection(socket: Socket): void {
         // Report current state and replay scrollback so a fresh/reconnecting client reattaches.
         socket.emit(TERMINAL_STATE, { running: term !== null, cols: size.cols, rows: size.rows });
         if (term && scrollback) {
            socket.emit(TERMINAL_DATA, { chunk: scrollback });
         }
         socket.on(TERMINAL_LAUNCH, (payload: LaunchPayload) => launch(payload));
         socket.on(TERMINAL_INPUT, (payload: InputPayload) => term?.write(payload.data));
         socket.on(TERMINAL_RESIZE, (payload: ResizePayload) => {
            size = { cols: payload.cols, rows: payload.rows };
            term?.resize(payload.cols, payload.rows);
         });
         socket.on(TERMINAL_CLOSE, () => term?.kill());
      },
   };
}
```

- [ ] **Step 4: Rewire `server/server.ts`** — replace the echo import/usage with the terminal manager:
```ts
import { Server } from 'socket.io';
import { createTerminalManager } from './terminal.ts';

/**
 * Create and start a Wiretap sidecar Socket.IO server with the terminal relay attached.
 * @param port - The TCP port to listen on (0 selects an ephemeral port, used by tests).
 * @returns The started Socket.IO server instance.
 */
export function createWiretapServer(port: number): Server {
   const io = new Server(port, {
      cors: {
         origin: 'http://localhost:30000',
      },
   });

   const terminal = createTerminalManager(io);

   io.on('connection', (socket) => {
      console.log(`Wiretap sidecar | client connected: ${socket.id}`);
      terminal.handleConnection(socket);
      socket.on('disconnect', (reason) => {
         console.log(`Wiretap sidecar | client disconnected: ${socket.id} (${reason})`);
      });
   });

   return io;
}
```

- [ ] **Step 5: Delete the echo files.** Run:
```bash
git rm server/echo.ts tests/integration/echo.test.js
```

- [ ] **Step 6: Run the test to verify it PASSES.** Run `npm test -- tests/integration/terminal.test.js`. Expected: PASS (2 tests). If the second test is flaky on the REPL prompt detection, confirm the predicate against actual output rather than weakening the assertion; report if `node-pty` behaves unexpectedly.

- [ ] **Step 7: Typecheck.** Run `npm run typecheck`. Expected: exit 0.

- [ ] **Step 8: Commit:**
```bash
git add server/terminal.ts server/server.ts tests/integration/terminal.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: replace echo with node-pty terminal manager + integration test\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: TerminalConnection (TDD, additive)

**Files:** create `src/bridge/TerminalConnection.svelte.js`, `tests/unit/TerminalConnection.test.js` (leave `WiretapConnection` intact for now)

- [ ] **Step 1: Write the failing unit test — `tests/unit/TerminalConnection.test.js`:**
```js
import { describe, it, expect } from 'vitest';
import { TerminalConnection } from '~/bridge/TerminalConnection.svelte.js';
import {
   TERMINAL_LAUNCH,
   TERMINAL_INPUT,
   TERMINAL_CLOSE,
} from '$shared/protocol.js';

/**
 * Build a controllable fake Socket.IO socket.
 * @returns {{ socket: object, fire: (event: string, ...args: *[]) => void, sent: object[] }} Test helpers.
 */
function makeFakeSocket() {
   const handlers = {};
   const sent = [];
   const socket = {
      on(event, fn) {
         (handlers[event] ??= []).push(fn);
      },
      emit(event, payload) {
         sent.push({ event, payload });
      },
   };
   const fire = (event, ...args) => {
      (handlers[event] ?? []).forEach((fn) => fn(...args));
   };
   return { socket, fire, sent };
}

describe('TerminalConnection', () => {
   it('tracks running state from TERMINAL_STATE and TERMINAL_EXIT', () => {
      const { socket, fire } = makeFakeSocket();
      const conn = new TerminalConnection();
      conn.connect('http://localhost:31416', () => socket);
      fire('connect');
      expect(conn.status).toBe('connected');
      expect(conn.running).toBe(false);
      fire('terminal:state', { running: true, cols: 80, rows: 24 });
      expect(conn.running).toBe(true);
      fire('terminal:exit', { code: 0 });
      expect(conn.running).toBe(false);
   });

   it('buffers output and replays it to a newly attached sink', () => {
      const { socket, fire } = makeFakeSocket();
      const conn = new TerminalConnection();
      conn.connect('http://localhost:31416', () => socket);
      fire('connect');
      fire('terminal:data', { chunk: 'abc' });
      const writes = [];
      conn.attach((chunk) => writes.push(chunk));
      expect(writes.join('')).toBe('abc');
      fire('terminal:data', { chunk: 'de' });
      expect(writes.join('')).toBe('abcde');
   });

   it('emits launch / input / close events', () => {
      const { socket, fire, sent } = makeFakeSocket();
      const conn = new TerminalConnection();
      conn.connect('http://localhost:31416', () => socket);
      fire('connect');
      conn.launch('claude', 80, 24);
      conn.sendInput('x');
      conn.close();
      const events = sent.map((s) => s.event);
      expect(events).toContain(TERMINAL_LAUNCH);
      expect(events).toContain(TERMINAL_INPUT);
      expect(events).toContain(TERMINAL_CLOSE);
   });
});
```

- [ ] **Step 2: Run it to verify it FAILS.** Run `npm test -- tests/unit/TerminalConnection.test.js`. Expected: FAIL (module missing).

- [ ] **Step 3: Create `src/bridge/TerminalConnection.svelte.js`:**
```js
import {
   TERMINAL_LAUNCH,
   TERMINAL_INPUT,
   TERMINAL_RESIZE,
   TERMINAL_CLOSE,
   TERMINAL_DATA,
   TERMINAL_STATE,
   TERMINAL_EXIT,
} from '$shared/protocol.js';

// Maximum bytes of received output retained client-side for replay to a (re)attached terminal sink.
const OUTPUT_LIMIT = 64 * 1024;

/**
 * @typedef {'disconnected' | 'connecting' | 'connected'} SocketStatus
 */

/**
 * Reactive wrapper around the Socket.IO connection to the Wiretap sidecar terminal. Tracks socket status
 * and PTY running-state as Svelte 5 runes, buffers PTY output for reattach, and exposes terminal controls.
 * Exported as a shared singleton; the class is exported for tests (which inject a fake io factory).
 */
export class TerminalConnection {

   /**
    * Socket connection status.
    * @type {SocketStatus}
    */
   status = $state('disconnected');

   /**
    * Whether a PTY is currently running on the sidecar.
    * @type {boolean}
    */
   running = $state(false);

   /**
    * The active Socket.IO socket, or null when not connected.
    * @type {object | null}
    */
   #socket = null;

   /**
    * Ring buffer of received PTY output, replayed when a terminal sink attaches.
    * @type {string}
    */
   #output = '';

   /**
    * The current output sink (the xterm writer), or null when no terminal is mounted.
    * @type {((chunk: string) => void) | null}
    */
   #sink = null;

   /**
    * Connect to the sidecar and wire terminal events. Idempotent while a socket exists.
    * @param {string} url - The sidecar URL.
    * @param {Function} [ioFactory] - Socket.IO client factory; defaults to Foundry's global `io`.
    * @returns {void}
    */
   connect(url, ioFactory = globalThis.io) {
      if (this.#socket) {
         return;
      }
      if (typeof ioFactory !== 'function') {
         console.warn('Wiretap | Socket.IO client (io) unavailable; cannot connect.');
         return;
      }

      this.status = 'connecting';
      const socket = ioFactory(url, { reconnection: true });
      this.#socket = socket;

      socket.on('connect', () => {
         this.status = 'connected';
         this.#output = '';
      });
      socket.on('disconnect', () => {
         this.status = 'disconnected';
      });
      socket.on('connect_error', () => {
         this.status = 'disconnected';
      });
      socket.on(TERMINAL_STATE, (state) => {
         this.running = state.running;
         if (!state.running) {
            this.#output = '';
         }
      });
      socket.on(TERMINAL_DATA, ({ chunk }) => {
         this.#output += chunk;
         if (this.#output.length > OUTPUT_LIMIT) {
            this.#output = this.#output.slice(this.#output.length - OUTPUT_LIMIT);
         }
         this.#sink?.(chunk);
      });
      socket.on(TERMINAL_EXIT, () => {
         this.running = false;
      });
   }

   /**
    * Attach a terminal output sink (the xterm writer). Immediately replays the buffered output.
    * @param {(chunk: string) => void} sink - Receives output chunks.
    * @returns {() => void} A detach function.
    */
   attach(sink) {
      this.#sink = sink;
      if (this.#output) {
         sink(this.#output);
      }
      return () => {
         if (this.#sink === sink) {
            this.#sink = null;
         }
      };
   }

   /**
    * Request the sidecar spawn a PTY.
    * @param {string} command - The command line to run.
    * @param {number} cols - Initial columns.
    * @param {number} rows - Initial rows.
    * @returns {void}
    */
   launch(command, cols, rows) {
      this.#socket?.emit(TERMINAL_LAUNCH, { command, cols, rows });
   }

   /**
    * Send input to the PTY.
    * @param {string} data - Raw input bytes.
    * @returns {void}
    */
   sendInput(data) {
      this.#socket?.emit(TERMINAL_INPUT, { data });
   }

   /**
    * Resize the PTY.
    * @param {number} cols - New columns.
    * @param {number} rows - New rows.
    * @returns {void}
    */
   resize(cols, rows) {
      this.#socket?.emit(TERMINAL_RESIZE, { cols, rows });
   }

   /**
    * Kill the PTY.
    * @returns {void}
    */
   close() {
      this.#socket?.emit(TERMINAL_CLOSE, {});
   }
}

// Shared singleton used by the tab component and the ready hook.
export const connection = new TerminalConnection();
```

- [ ] **Step 4: Run the test to verify it PASSES.** Run `npm test -- tests/unit/TerminalConnection.test.js`. Expected: PASS (3 tests).

- [ ] **Step 5: Lint.** Run `npm run eslint -- src/bridge/TerminalConnection.svelte.js`. Expected: clean.

- [ ] **Step 6: Commit:**
```bash
git add src/bridge/TerminalConnection.svelte.js tests/unit/TerminalConnection.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: add reactive TerminalConnection (status, running, output buffer)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Tab terminal UI + cutover

**Files:** rewrite `src/components/Wiretap.svelte`, `tests/unit/Wiretap.test.js`; modify `src/hooks/OnceInit.js`, `src/hooks/OnceReady.js`; modify `shared/protocol.js`; delete `src/bridge/WiretapConnection.svelte.js`, `tests/unit/WiretapConnection.test.js`

- [ ] **Step 1: Add the `terminalCommand` setting in `src/hooks/OnceInit.js`.** After the existing `serverUrl` registration, insert:
```js

   // The command launched in the PTY when the user clicks Launch (per-client; default `claude`).
   game.settings.register('wiretap', 'terminalCommand', {
      name: 'WIRETAP.Settings.TerminalCommand.Name',
      hint: 'WIRETAP.Settings.TerminalCommand.Hint',
      scope: 'client',
      config: true,
      type: String,
      default: 'claude',
   });
```

- [ ] **Step 2: Update `src/hooks/OnceReady.js`** to import the new connection module:
```js
import { connection } from '~/bridge/TerminalConnection.svelte.js';

/**
 * Foundry `ready` handler. Logs readiness and connects the persistent sidecar socket using the
 * configured server URL.
 * @returns {void}
 */
export default function onceReady() {
   console.log('Wiretap | Module ready.');
   // GM-only: the sidecar exposes a terminal on the host, so non-GM clients never connect.
   if (game.user.isGM) {
      connection.connect(game.settings.get('wiretap', 'serverUrl'));
   }
}
```

- [ ] **Step 3: Add localization keys to `lang/en.json`** — add a `TerminalCommand` block and a few UI labels under `WIRETAP`:
```json
{
   "WIRETAP": {
      "Title": "Wiretap",
      "SidebarTab": "Wiretap",
      "Launch": "Launch",
      "Close": "Close",
      "Settings": {
         "ServerUrl": {
            "Name": "Sidecar Server URL",
            "Hint": "URL of the Wiretap agent sidecar (default http://localhost:31416)."
         },
         "TerminalCommand": {
            "Name": "Terminal Command",
            "Hint": "Command launched in the terminal (default `claude`)."
         }
      }
   }
}
```

- [ ] **Step 4: Update the component test FIRST — `tests/unit/Wiretap.test.js`:**
```js
import { render, screen } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import Wiretap from '~/components/Wiretap.svelte';

// xterm touches DOM APIs happy-dom lacks; stub it so the component mounts in the unit test.
vi.mock('@xterm/xterm', () => ({
   Terminal: class {
      cols = 80;
      rows = 24;
      open() {}
      write() {}
      onData() {}
      onResize() {}
      loadAddon() {}
      dispose() {}
      reset() {}
   },
}));
vi.mock('@xterm/addon-fit', () => ({
   FitAddon: class {
      fit() {}
      activate() {}
      dispose() {}
   },
}));

describe('Wiretap.svelte', () => {
   it('renders the title header', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('heading', { name: 'WIRETAP.Title' })).toBeTruthy();
   });

   it('shows a Launch control when no terminal is running', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('button', { name: 'WIRETAP.Launch' })).toBeTruthy();
   });
});
```

- [ ] **Step 5: Run it to verify it FAILS.** Run `npm test -- tests/unit/Wiretap.test.js`. Expected: FAIL (old chat UI has no Launch button / still imports the echo connection).

- [ ] **Step 6: Rewrite `src/components/Wiretap.svelte`:**
```svelte
<script>
   import { onMount } from 'svelte';
   import { Terminal } from '@xterm/xterm';
   import { FitAddon } from '@xterm/addon-fit';
   import '@xterm/xterm/css/xterm.css';
   import { connection } from '~/bridge/TerminalConnection.svelte.js';

   /** @type {{ foundryApp: object }} */
   let { foundryApp } = $props();

   // The DOM node the xterm terminal mounts into.
   let viewport = $state(null);

   // The xterm instance and its fit addon, created on mount.
   /** @type {Terminal | null} */
   let term = null;
   /** @type {FitAddon | null} */
   let fit = null;

   onMount(() => {
      term = new Terminal({ convertEol: false, cursorBlink: true });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(viewport);
      fit.fit();

      // Pipe PTY output into the terminal (replays buffered scrollback immediately).
      const detach = connection.attach((chunk) => term?.write(chunk));
      // Forward keystrokes to the PTY.
      term.onData((data) => connection.sendInput(data));
      // Keep the PTY sized to the viewport.
      term.onResize(({ cols, rows }) => connection.resize(cols, rows));

      // Refit on container resize.
      const observer = new ResizeObserver(() => fit?.fit());
      observer.observe(viewport);

      return () => {
         detach();
         observer.disconnect();
         term?.dispose();
         term = null;
         fit = null;
      };
   });

   /**
    * Toggle the terminal: launch the configured command if idle, otherwise close it.
    * @returns {void}
    */
   function toggle() {
      if (connection.running) {
         connection.close();
      } else {
         const command = game.settings.get('wiretap', 'terminalCommand');
         connection.launch(command, term?.cols ?? 80, term?.rows ?? 24);
      }
   }
</script>

<section class="wiretap">
   <header class="wiretap__header">
      <i class="fa-solid fa-user-secret"></i>
      <h2>{game.i18n.localize('WIRETAP.Title')}</h2>
      <span
         class="wiretap__status"
         data-status={connection.status}
      >
         {connection.status}
      </span>
      <button
         type="button"
         class="wiretap__toggle"
         disabled={connection.status !== 'connected'}
         onclick={toggle}
      >
         {connection.running ? game.i18n.localize('WIRETAP.Close') : game.i18n.localize('WIRETAP.Launch')}
      </button>
   </header>

   <div
      class="wiretap__terminal"
      bind:this={viewport}
   ></div>
</section>

<style lang="scss">
   .wiretap {
      display: flex;
      flex-direction: column;
      height: 100%;

      &__header {
         display: flex;
         align-items: center;
         gap: $wiretap-padding;

         i {
            color: $wiretap-accent;
         }
      }

      &__status {
         margin-left: auto;
         font-size: 12px;
      }

      &__toggle {
         border: 1px solid $wiretap-accent;
      }

      &__terminal {
         flex: 1;
         min-height: 0;
         padding: $wiretap-padding;
      }
   }
</style>
```

- [ ] **Step 7: Run the component test to verify it PASSES.** Run `npm test -- tests/unit/Wiretap.test.js`. Expected: PASS (2 tests).

- [ ] **Step 8: Remove the obsolete echo connection + protocol constant.**
```bash
git rm src/bridge/WiretapConnection.svelte.js tests/unit/WiretapConnection.test.js
```
Then edit `shared/protocol.js` to delete `WIRETAP_MESSAGE` and the `WiretapMessage` / `WiretapEcho` typedefs (keep the `TERMINAL_*` exports and their typedefs).

- [ ] **Step 9: Full local gate.** Run `npm test && npm run eslint && npm run stylelint && npm run typecheck`. Expected: all PASS (no dangling `WIRETAP_MESSAGE` import remains anywhere).

- [ ] **Step 10: Commit:**
```bash
git add src/components/Wiretap.svelte tests/unit/Wiretap.test.js src/hooks/OnceInit.js src/hooks/OnceReady.js lang/en.json shared/protocol.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: replace chat UI with xterm.js terminal + Launch/Close toggle\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: Build gate, bundle checks, TODO, manual verification

**Files:** modify `TODO.md`

- [ ] **Step 1: Production build.** Run `npm run build`. Expected: emits `index.js` + `style.css` (now larger — xterm + its CSS are bundled).

- [ ] **Step 2: Bundle inclusion/exclusion checks.** Run:
```bash
node -e "const s=require('fs').readFileSync('index.js','utf8');if(!s.includes('xterm')&&!/Terminal/.test(s))throw new Error('xterm missing from browser bundle');['node-pty','socket.io/dist','registerProbe'].forEach(t=>{if(s.includes(t))throw new Error('leak: '+t)});console.log('OK')"
```
Expected: `OK` (xterm present; `node-pty`/server socket.io/probe absent).

- [ ] **Step 3: Confirm xterm CSS landed in `style.css`.** Run:
```bash
node -e "const s=require('fs').readFileSync('style.css','utf8');console.log(s.includes('xterm')?'OK':'MISSING xterm css')"
```
Expected: `OK`.

- [ ] **Step 4: Clean any stray e2e chunk.** `rm -f registerProbe-*.js registerProbe-*.js.map`.

- [ ] **Step 5: Update `TODO.md`** — replace the AI-bridge sections to reflect the pivot:
```markdown
## AI bridge roadmap (terminal-relay design)

- [x] #1 transport + sidecar skeleton (socket.io)
- [x] #2 Claude Code terminal relay (node-pty + xterm.js; Launch/Close; reattach)
- [ ] #3 terminal UX polish (theming, toolbar niceties, popout fit, scrollback tuning)
- [ ] (optional/future) structured chat UI — only viable via headless/programmatic mode
      (Agent SDK / `claude -p`), which draws on the $200/mo Agent SDK credit + Commercial Terms
- [ ] (optional/future) dedicated Foundry MCP server for the user's `claude` to call

## Carried-over cleanups

- [ ] Sidecar `index.ts`: log on the `'listening'` event, not synchronously
- [ ] Optional shared-secret handshake for the sidecar socket (defense in depth)
- [ ] Configurable terminal working directory (`terminalCwd`)
- [ ] Reattach fidelity for full-screen TUIs (resize nudge / repaint on reconnect)
- [ ] Automate sidecar-backed e2e (launch sidecar from the Playwright harness)
```
(Keep the "Completed" scaffold items and the "Deferred (later)" section.)

- [ ] **Step 6: Commit:**
```bash
git add TODO.md
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'docs: mark bridge #2 complete; refresh roadmap for terminal-relay pivot\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 7: Manual verification (report results; not automated).** With the sidecar running in an EXTERNAL terminal (`npm run server`) and the live Foundry world:
  1. Open the Wiretap tab → status `connected`, a **Launch** button, empty terminal.
  2. Click **Launch** → `claude` starts in the embedded terminal; interact with it (e.g., have it create an actor as you do today).
  3. Resize the sidebar / pop the tab out → the terminal reflows; the pop-out mirrors the same session.
  4. Reload Foundry → reopen the tab → terminal **reattaches** to the live session with scrollback.
  5. Click **Close** (or exit `claude`) → terminal ends, button returns to **Launch**.

---

## Self-review

**Spec coverage:** §2 decisions → command/default (Task 1 setting + Task 2 default), Launch/Close toggle (Task 4 `toggle`), persistence+reattach (Task 2 scrollback + state-on-connect; Task 3 output buffer + `attach` replay), xterm bundled (Tasks 1/4/5 checks), transport reuse (Task 2/3), localhost+GM (localhost from #1; GM gating — see note), node-pty (Tasks 1/2). §3 components all created. §4 data flow exercised by Task 2 integration + Task 3 unit + Task 4 wiring + Task 5 manual. §5 security: localhost bind carried from #1; **GM gating** — Task 4 should also guard `connect()`/launch for GM only; ADD: in `OnceReady.js` wrap the connect in `if (game.user.isGM)`. (Add that to Task 4 Step 2.) §6 error handling: spawn failure → exit event (Task 2 onExit; spawn errors surface as immediate exit), process exit → state false, socket drop → reattach, multi-client broadcast. §7 testing: integration (Task 2), unit (Task 3, Task 4), manual (Task 5). §9 DoD → Tasks 4/5.

**Gap found & fixed inline:** GM-only gating is now in Task 4 Step 2 (`OnceReady.js` wraps `connect()` in `if (game.user.isGM)`), satisfying §5.

**Placeholder scan:** none; all code complete. The `vi.mock` of xterm in the component test is necessary because happy-dom lacks the canvas/DOM APIs xterm needs.

**Type/name consistency:** `TERMINAL_*` constants defined in Task 1 (`shared/protocol.js`), imported identically by `server/terminal.ts` (`../shared/protocol.js`, Task 2), `TerminalConnection` (`$shared/protocol.js`, Task 3), and the integration/unit tests. `createTerminalManager(io)` (Task 2) returns `{ handleConnection }`, used in `server.ts`. `connection` singleton + `TerminalConnection` class (Task 3) consumed by `OnceReady.js` and `Wiretap.svelte` (Task 4) via the methods `attach`/`launch`/`sendInput`/`resize`/`close` and `status`/`running` state — all defined in Task 3. `terminalCommand` setting key consistent (Task 4 register / Task 4 component read).
