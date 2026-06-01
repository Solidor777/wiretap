# Wiretap AI Bridge #1 — Transport + Sidecar Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Project rule:** Route `.js` / `.svelte` / `.svelte.js` work to the `foundry-module-dev` contract — the implementer must first invoke `svelte-5`, `foundry-vtt`, `foundry-svelte` via the Skill tool (the custom agent type may not be dispatchable mid-session; replicate its contract via general-purpose). Follow `.claude/CLAUDE.md` style exactly (120-col wrap; multi-line objects/arrays; typed+commented declarations; JSDoc on functions; no `:global`).

**Goal:** Stand up the Node sidecar (socket.io server) and the Foundry module client, and prove a message round-trips end-to-end into the Wiretap tab. No Claude, no Foundry tools.

**Architecture:** A `server/` TypeScript sidecar runs a socket.io v4 server (echo handler). The browser module connects with Foundry's global `io` client to `http://localhost:<port>`, via a reactive `WiretapConnection` singleton. The Wiretap tab shows connection status + an echo log + an input.

**Tech Stack:** Node + TypeScript (run via `tsx`), socket.io `^4.8.3` (server) / Foundry's bundled `socket.io-client` `^4.8.3` (browser global `io`), Svelte 5 runes, Vitest (node integration + happy-dom unit).

**Spec:** `docs/superpowers/specs/2026-06-01-wiretap-bridge-01-transport-design.md`

**Verified facts (do not re-litigate):**
- Foundry v14 bundles `socket.io-client@^4.8.3`; the sidecar pins `socket.io@^4.8.3`.
- Foundry exposes a runtime global `io` (used at `foundry/client/.../game.mjs:477` as `io.connect(...)`); the browser module uses `globalThis.io(url)`.
- The sidecar is TypeScript run via `tsx`; it is NOT eslint-linted (no TS parser in the project eslint), it is type-checked with `tsc` via a `typecheck` script.

---

## File structure

| File | Responsibility | Created in |
|---|---|---|
| `shared/protocol.js` | Wire contract (event names + payload typedefs), imported by both sides | Task 1 |
| `server/tsconfig.json` | TS config for the sidecar (`tsc` typecheck + tsx) | Task 1 |
| `server/echo.ts` | The echo socket handler | Task 2 |
| `server/server.ts` | `createWiretapServer(port)` factory | Task 2 |
| `server/index.ts` | Sidecar entry (reads `WIRETAP_PORT`, starts server) | Task 2 |
| `tests/integration/echo.test.js` | Node integration test of the echo round-trip | Task 2 |
| `src/bridge/WiretapConnection.svelte.js` | Reactive socket singleton (status + messages) | Task 3 |
| `tests/unit/WiretapConnection.test.js` | Unit test with injected fake socket | Task 3 |
| `src/hooks/OnceInit.js` | (modify) register `serverUrl` client setting | Task 4 |
| `src/hooks/OnceReady.js` | (modify) connect on ready | Task 4 |
| `lang/en.json` | (modify) settings strings | Task 4 |
| `src/components/Wiretap.svelte` | (modify) replace counter with connection/echo UI | Task 5 |
| `tests/unit/Wiretap.test.js` | (modify) update for new UI | Task 5 |
| `package.json` / `vite.config.mjs` / `vitest.config.mjs` / `eslint.config.js` | (modify) deps, scripts, `$shared` alias, ignore `server/` | Task 1 |
| `TODO.md` | (modify) bridge roadmap + #1 done | Task 6 |

---

### Task 1: Foundation — deps, configs, shared protocol

**Files:** modify `package.json`, `vite.config.mjs`, `vitest.config.mjs`, `eslint.config.js`; create `shared/protocol.js`, `server/tsconfig.json`

- [ ] **Step 1: Add deps + scripts to `package.json`.** Add to `dependencies` (create the block; titan's had none):
```json
   "dependencies": {
      "socket.io": "^4.8.3"
   },
```
Add to `devDependencies`: `"socket.io-client": "^4.8.3"`, `"tsx": "^4.19.0"`, `"typescript": "^5.7.0"`. Add to `scripts`:
```json
      "server": "tsx watch server/index.ts",
      "server:start": "tsx server/index.ts",
      "typecheck": "tsc -p server/tsconfig.json",
```

- [ ] **Step 2: Install.** Run `npm install`. Expected: completes, lock updated.

- [ ] **Step 3: Add the `$shared` alias to `vite.config.mjs`.** In `resolve.alias`, add a third entry after `$fonts/`:
```js
            '$shared/': `${path.resolve(__dirname, 'shared')}/`,
```

- [ ] **Step 4: Add the `$shared` alias to `vitest.config.mjs`.** In `resolve.alias`, add after `$fonts/`:
```js
         '$shared/': `${path.resolve(__dirname, 'shared')}/`,
```

- [ ] **Step 5: Add the integration glob to `vitest.config.mjs`.** Change the `test.include` array to:
```js
      include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
```

- [ ] **Step 6: Ignore `server/` in `eslint.config.js`.** In the `ignores` array, add `'server/',` immediately after `'index.js',` (the sidecar is type-checked by `tsc`, not eslint, which lacks a TS parser here):
```js
         'index.js',
         'server/',
```

- [ ] **Step 7: Create `shared/protocol.js`:**
```js
/**
 * Shared wire contract between the Wiretap browser module and the Node sidecar. Imported by both sides,
 * so it is plain JS (no TypeScript) and is the single source of truth for socket event names and payload
 * shapes.
 */

// Socket.IO event (client to server) carrying a user message; the server replies via the ack callback.
export const WIRETAP_MESSAGE = 'wiretap:message';

/**
 * @typedef {object} WiretapMessage
 * @property {string} text - The message text sent from the tab to the sidecar.
 */

/**
 * @typedef {object} WiretapEcho
 * @property {string} text - The echoed message text.
 * @property {string} receivedAt - ISO-8601 timestamp stamped by the sidecar on receipt.
 */
```

- [ ] **Step 8: Create `server/tsconfig.json`:**
```json
{
   "compilerOptions": {
      "module": "esnext",
      "moduleResolution": "bundler",
      "target": "es2022",
      "strict": true,
      "allowJs": true,
      "checkJs": false,
      "allowImportingTsExtensions": true,
      "noEmit": true,
      "skipLibCheck": true,
      "types": ["node"]
   },
   "include": [
      "**/*.ts",
      "../shared/**/*.js"
   ]
}
```

- [ ] **Step 9: Verify configs parse and lint is unaffected.** Run `npm run eslint`. Expected: clean (0 problems). Run `node -e "JSON.parse(require('fs').readFileSync('server/tsconfig.json','utf8'));console.log('OK')"`. Expected: `OK`.

- [ ] **Step 10: Commit:**
```bash
git add package.json package-lock.json vite.config.mjs vitest.config.mjs eslint.config.js shared/protocol.js server/tsconfig.json
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'chore: add sidecar deps, $shared alias, and wire protocol\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Sidecar echo server (TDD)

**Files:** create `server/echo.ts`, `server/server.ts`, `server/index.ts`, `tests/integration/echo.test.js`

- [ ] **Step 1: Write the failing integration test — `tests/integration/echo.test.js`:**
```js
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import { createWiretapServer } from '../../server/server.ts';
import { WIRETAP_MESSAGE } from '../../shared/protocol.js';

describe('Wiretap sidecar echo', () => {
   /** @type {import('socket.io').Server | undefined} */
   let server;

   afterEach(async () => {
      if (server) {
         await new Promise((resolve) => server.close(resolve));
         server = undefined;
      }
   });

   it('echoes a message with a timestamp via the ack callback', async () => {
      server = createWiretapServer(0);
      const port = server.httpServer.address().port;
      const client = ioClient(`http://localhost:${port}`);

      const reply = await new Promise((resolve, reject) => {
         client.emit(WIRETAP_MESSAGE, { text: 'ping' }, resolve);
         setTimeout(() => reject(new Error('no ack within 2s')), 2000);
      });

      client.close();
      expect(reply.text).toBe('ping');
      expect(typeof reply.receivedAt).toBe('string');
      expect(Number.isNaN(Date.parse(reply.receivedAt))).toBe(false);
   });
});
```

- [ ] **Step 2: Run it to verify it FAILS.** Run `npm test -- tests/integration/echo.test.js`. Expected: FAIL (cannot resolve `../../server/server.ts`).

- [ ] **Step 3: Create `server/echo.ts`:**
```ts
import type { Socket } from 'socket.io';
import { WIRETAP_MESSAGE } from '../shared/protocol.js';

/**
 * The payload sent by the tab on a WIRETAP_MESSAGE event.
 */
interface MessagePayload {
   text?: string;
}

/**
 * The ack reply sent back to the tab.
 */
interface EchoReply {
   text: string;
   receivedAt: string;
}

/**
 * Register the echo handler on a connected socket. On a WIRETAP_MESSAGE event, replies via the ack
 * callback with the original text and an ISO timestamp. This is the sub-project #1 placeholder for the
 * eventual Claude Code round-trip.
 * @param socket - The connected Socket.IO socket.
 */
export function registerEcho(socket: Socket): void {
   socket.on(WIRETAP_MESSAGE, (payload: MessagePayload, ack?: (reply: EchoReply) => void): void => {
      ack?.({ text: payload?.text ?? '', receivedAt: new Date().toISOString() });
   });
}
```

- [ ] **Step 4: Create `server/server.ts`:**
```ts
import { Server } from 'socket.io';
import { registerEcho } from './echo.ts';

/**
 * Create and start a Wiretap sidecar Socket.IO server. CORS allows the Foundry origin so the browser
 * handshake succeeds. Each connecting socket receives the echo handler.
 * @param port - The TCP port to listen on (0 selects an ephemeral port, used by tests).
 * @returns The started Socket.IO server instance.
 */
export function createWiretapServer(port: number): Server {
   const io = new Server(port, {
      cors: {
         origin: 'http://localhost:30000',
      },
   });

   io.on('connection', (socket) => {
      console.log(`Wiretap sidecar | client connected: ${socket.id}`);
      registerEcho(socket);
      socket.on('disconnect', (reason) => {
         console.log(`Wiretap sidecar | client disconnected: ${socket.id} (${reason})`);
      });
   });

   return io;
}
```

- [ ] **Step 5: Create `server/index.ts`:**
```ts
import { createWiretapServer } from './server.ts';

// The port the sidecar listens on; overridable via the WIRETAP_PORT environment variable.
const port = Number(process.env.WIRETAP_PORT ?? 31416);

createWiretapServer(port);
console.log(`Wiretap sidecar | listening on http://localhost:${port}`);
```

- [ ] **Step 6: Run the test to verify it PASSES.** Run `npm test -- tests/integration/echo.test.js`. Expected: PASS (1 test).

- [ ] **Step 7: Type-check the sidecar.** Run `npm run typecheck`. Expected: no errors (exit 0).

- [ ] **Step 8: Commit:**
```bash
git add server/echo.ts server/server.ts server/index.ts tests/integration/echo.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: add Wiretap sidecar echo server with integration test\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Browser connection singleton (TDD)

**Files:** create `src/bridge/WiretapConnection.svelte.js`, `tests/unit/WiretapConnection.test.js`

- [ ] **Step 1: Write the failing unit test — `tests/unit/WiretapConnection.test.js`:**
```js
import { describe, it, expect } from 'vitest';
import { WiretapConnection } from '~/bridge/WiretapConnection.svelte.js';

/**
 * Build a controllable fake Socket.IO socket for injection.
 * @returns {{ socket: object, fire: (event: string, ...args: *[]) => void, sent: object[] }} Test helpers.
 */
function makeFakeSocket() {
   const handlers = {};
   const sent = [];
   const socket = {
      on(event, fn) {
         (handlers[event] ??= []).push(fn);
      },
      emit(event, payload, ack) {
         sent.push({ event, payload, ack });
      },
   };
   const fire = (event, ...args) => {
      (handlers[event] ?? []).forEach((fn) => fn(...args));
   };
   return { socket, fire, sent };
}

describe('WiretapConnection', () => {
   // Status must track the socket lifecycle events.
   it('transitions status on connect and disconnect', () => {
      const { socket, fire } = makeFakeSocket();
      const conn = new WiretapConnection();
      conn.connect('http://localhost:31416', () => socket);
      expect(conn.status).toBe('connecting');
      fire('connect');
      expect(conn.status).toBe('connected');
      fire('disconnect');
      expect(conn.status).toBe('disconnected');
   });

   // send() records the outbound message and, on ack, the echoed reply.
   it('records sent message and echoed reply', () => {
      const { socket, fire, sent } = makeFakeSocket();
      const conn = new WiretapConnection();
      conn.connect('http://localhost:31416', () => socket);
      fire('connect');
      conn.send('ping');
      expect(conn.messages).toHaveLength(1);
      expect(conn.messages[0]).toMatchObject({ direction: 'out', text: 'ping' });
      sent[0].ack({ text: 'ping', receivedAt: '2026-06-01T00:00:00.000Z' });
      expect(conn.messages).toHaveLength(2);
      expect(conn.messages[1]).toMatchObject({ direction: 'in', text: 'ping' });
   });
});
```

- [ ] **Step 2: Run it to verify it FAILS.** Run `npm test -- tests/unit/WiretapConnection.test.js`. Expected: FAIL (module does not exist).

- [ ] **Step 3: Create `src/bridge/WiretapConnection.svelte.js`:**
```js
import { WIRETAP_MESSAGE } from '$shared/protocol.js';

/**
 * @typedef {'disconnected' | 'connecting' | 'connected'} WiretapStatus
 */

/**
 * @typedef {object} WiretapLogEntry
 * @property {'out' | 'in'} direction - Whether the user sent the entry or the sidecar returned it.
 * @property {string} text - The entry text.
 * @property {string} at - ISO-8601 timestamp recorded when the entry was logged.
 */

/**
 * Reactive wrapper around the Socket.IO connection to the Wiretap sidecar. Connection status and the
 * message log are Svelte 5 runes so the tab re-renders on change. Exported as a shared singleton; the
 * class is also exported so tests can inject a fake io factory.
 */
export class WiretapConnection {

   /**
    * The current connection status.
    * @type {WiretapStatus}
    */
   status = $state('disconnected');

   /**
    * The running message log (sent and echoed).
    * @type {WiretapLogEntry[]}
    */
   messages = $state([]);

   /**
    * The active Socket.IO socket, or null when not connected.
    * @type {object | null}
    */
   #socket = null;

   /**
    * Connect to the sidecar. Idempotent: a second call while a socket exists is a no-op.
    * @param {string} url - The sidecar URL (e.g. 'http://localhost:31416').
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
      });
      socket.on('disconnect', () => {
         this.status = 'disconnected';
      });
      socket.on('connect_error', () => {
         this.status = 'disconnected';
      });
   }

   /**
    * Send a message to the sidecar and record the echoed reply on ack.
    * @param {string} text - The message text.
    * @returns {void}
    */
   send(text) {
      if (!this.#socket || this.status !== 'connected') {
         return;
      }
      this.messages.push({ direction: 'out', text, at: new Date().toISOString() });
      this.#socket.emit(WIRETAP_MESSAGE, { text }, (reply) => {
         this.messages.push({ direction: 'in', text: reply.text, at: reply.receivedAt });
      });
   }
}

// Shared singleton used by the tab component and the ready hook.
export const connection = new WiretapConnection();
```

- [ ] **Step 4: Run the test to verify it PASSES.** Run `npm test -- tests/unit/WiretapConnection.test.js`. Expected: PASS (2 tests).

- [ ] **Step 5: Lint.** Run `npm run eslint -- src/bridge/WiretapConnection.svelte.js`. Expected: clean.

- [ ] **Step 6: Commit:**
```bash
git add src/bridge/WiretapConnection.svelte.js tests/unit/WiretapConnection.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: add reactive WiretapConnection socket singleton\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Settings + connect-on-ready wiring

**Files:** modify `src/hooks/OnceInit.js`, `src/hooks/OnceReady.js`, `lang/en.json`

- [ ] **Step 1: Register the setting in `src/hooks/OnceInit.js`.** Immediately after the `sidebar.Sidebar.TABS.wiretap = { ... };` block, add:
```js
   // The sidecar URL is per-client (each GM's machine runs its own sidecar), so the setting is client-scoped.
   game.settings.register('wiretap', 'serverUrl', {
      name: 'WIRETAP.Settings.ServerUrl.Name',
      hint: 'WIRETAP.Settings.ServerUrl.Hint',
      scope: 'client',
      config: true,
      type: String,
      default: 'http://localhost:31416',
   });
```

- [ ] **Step 2: Connect on ready in `src/hooks/OnceReady.js`.** Replace the file with:
```js
import { connection } from '~/bridge/WiretapConnection.svelte.js';

/**
 * Foundry `ready` handler. Logs readiness and connects the persistent sidecar socket using the
 * configured server URL.
 * @returns {void}
 */
export default function onceReady() {
   console.log('Wiretap | Module ready.');
   connection.connect(game.settings.get('wiretap', 'serverUrl'));
}
```

- [ ] **Step 3: Add settings strings to `lang/en.json`.** Replace the file with:
```json
{
   "WIRETAP": {
      "Title": "Wiretap",
      "SidebarTab": "Wiretap",
      "Settings": {
         "ServerUrl": {
            "Name": "Sidecar Server URL",
            "Hint": "URL of the Wiretap agent sidecar (default http://localhost:31416)."
         }
      }
   }
}
```

- [ ] **Step 4: Lint + validate.** Run `npm run eslint -- src/hooks/OnceInit.js src/hooks/OnceReady.js`. Expected: clean. Run `node -e "JSON.parse(require('fs').readFileSync('lang/en.json','utf8'));console.log('OK')"`. Expected: `OK`.

- [ ] **Step 5: Commit:**
```bash
git add src/hooks/OnceInit.js src/hooks/OnceReady.js lang/en.json
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: register serverUrl setting and connect sidecar on ready\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: Tab UI — connection status + echo (replace counter)

**Files:** modify `src/components/Wiretap.svelte`, `tests/unit/Wiretap.test.js`

- [ ] **Step 1: Update the test FIRST — `tests/unit/Wiretap.test.js`.** Replace the file with:
```js
import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import Wiretap from '~/components/Wiretap.svelte';

describe('Wiretap.svelte', () => {
   // The component must render its localized title header.
   it('renders the title header', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('heading', { name: 'WIRETAP.Title' })).toBeTruthy();
   });

   // With no live connection, status shows 'disconnected' and the input + send are disabled.
   it('shows disconnected status and disables input when not connected', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByText('disconnected')).toBeTruthy();
      expect(screen.getByPlaceholderText('Message the sidecar…').disabled).toBe(true);
      expect(screen.getByRole('button', { name: 'Send' }).disabled).toBe(true);
   });
});
```

- [ ] **Step 2: Run the test to verify it FAILS.** Run `npm test -- tests/unit/Wiretap.test.js`. Expected: FAIL (no `disconnected` text / placeholder yet — the old component still has the counter).

- [ ] **Step 3: Replace `src/components/Wiretap.svelte`:**
```svelte
<script>
   import { connection } from '~/bridge/WiretapConnection.svelte.js';

   /** @type {{ foundryApp: object }} */
   let { foundryApp } = $props();

   // The current draft message in the input box.
   let draft = $state('');

   /**
    * Send the trimmed draft to the sidecar and clear the input.
    * @returns {void}
    */
   function send() {
      const text = draft.trim();
      if (!text) {
         return;
      }
      connection.send(text);
      draft = '';
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
   </header>

   <ul class="wiretap__log">
      {#each connection.messages as entry, index (index)}
         <li
            class="wiretap__entry"
            data-direction={entry.direction}
         >
            {entry.text}
         </li>
      {/each}
   </ul>

   <form
      class="wiretap__compose"
      onsubmit={(event) => {
         event.preventDefault();
         send();
      }}
   >
      <input
         class="wiretap__input"
         type="text"
         placeholder="Message the sidecar…"
         bind:value={draft}
         disabled={connection.status !== 'connected'}
      />
      <button
         type="submit"
         class="wiretap__send"
         disabled={connection.status !== 'connected'}
      >
         Send
      </button>
   </form>
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

      &__log {
         flex: 1;
         overflow-y: auto;
         margin: 0;
         padding: 0;
         list-style: none;
      }

      &__entry {
         padding: 4px $wiretap-padding;

         &[data-direction='out'] {
            text-align: right;
         }
      }

      &__compose {
         display: flex;
         gap: $wiretap-padding;
      }

      &__input {
         flex: 1;
      }

      &__send {
         border: 1px solid $wiretap-accent;
      }
   }
</style>
```

- [ ] **Step 4: Run the test to verify it PASSES.** Run `npm test -- tests/unit/Wiretap.test.js`. Expected: PASS (2 tests).

- [ ] **Step 5: Lint styles.** Run `npm run stylelint`. Expected: clean. (Fix any genuine violations preserving no-`:global` and px-only units.)

- [ ] **Step 6: Commit:**
```bash
git add src/components/Wiretap.svelte tests/unit/Wiretap.test.js
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'feat: replace counter with connection status and echo chat UI\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: Full gate, manual verification, TODO update

**Files:** modify `TODO.md`

- [ ] **Step 1: Full quality gate.** Run `npm test && npm run eslint && npm run stylelint && npm run typecheck && npm run build`. Expected: all PASS; build emits `index.js` + `style.css`; probe still dead-code-eliminated (production build).

- [ ] **Step 2: Verify the production bundle is unaffected by the sidecar.** Run:
`node -e "const s=require('fs').readFileSync('index.js','utf8');['socket.io','engine.io'].forEach(t=>{if(s.includes(t))throw new Error('sidecar dep leaked into browser bundle: '+t)});console.log('OK')"`
Expected: `OK` (the browser bundle uses Foundry's global `io`, not a bundled socket.io).

- [ ] **Step 3: Clean any stray e2e chunk** (if a prior `build:e2e` ran): `rm -f registerProbe-*.js registerProbe-*.js.map`.

- [ ] **Step 4: Update `TODO.md`.** Replace its body with:
```markdown
# Wiretap TODO

## Completed

- [x] Package scaffold (Svelte 5 + SCSS + Vite, titan-parity tooling)
- [x] Wiretap sidebar tab with Svelte mount + pop-out
- [x] Unit + e2e smoke tests
- [x] AI bridge #1 — transport + sidecar skeleton (socket.io echo round-trip)

## AI bridge roadmap (remaining sub-projects)

- [ ] #2 Claude Code in the sidecar (embed Agent SDK, stream responses, session)
- [ ] #3 Read-only Foundry tool surface (tools round-trip into the module)
- [ ] #4 Write operations + features (create actors/items/walls, permission model)
- [ ] #5 Chat UX polish (streaming, tool-call display, approvals, history)
- [ ] #6 Security / permissions / auth

## Deferred (later)

- [ ] Settings menu beyond serverUrl, keybindings, fonts, compendium packs
```

- [ ] **Step 5: Manual verification (document results in the task report, not automated).**
  1. In one terminal: `npm run server` → expect `Wiretap sidecar | listening on http://localhost:31416`.
  2. Reload the live Foundry world; open the Wiretap sidebar tab → status badge shows `connected`; the sidecar logs `client connected`.
  3. Type a message + Send → it appears in the log and an echoed copy returns from the sidecar.
  4. Stop the sidecar (Ctrl-C) → badge flips to `disconnected`, input disables; restart → reconnects to `connected`.

- [ ] **Step 6: Commit:**
```bash
git add TODO.md
git -c user.name="Solidor" -c user.email="justintarquin2019@gmail.com" commit -m "$(printf 'docs: mark bridge #1 complete and record bridge roadmap in TODO\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-review

**Spec coverage:** §2 decisions → Tasks 1 (deps/alias/port via setting in Task 4), 2 (socket.io server), 3 (connection), 5 (UI swap), 4 (connect-on-ready). §3 components → all created (server Task 2, shared Task 1, connection Task 3, settings/ready Task 4, UI Task 5). §4 data flow → exercised by Task 2 integration test + Task 3 unit test + Task 5 UI + Task 6 manual. §5 error handling → connection `connect_error`/`disconnect` → `disconnected` (Task 3), Send disabled while not connected (Tasks 3 + 5), CORS set (Task 2), missing `io` warns (Task 3). §6 testing → server integration (Task 2), browser unit (Task 3), manual checklist (Task 6). §8 DoD → Task 6.

**Placeholder scan:** No TBDs; every code step is complete. The `tsc`/typecheck path replaces eslint for TS (server eslint-ignored) — explicit and consistent.

**Type/name consistency:** `WIRETAP_MESSAGE` defined in `shared/protocol.js` (Task 1), imported identically by `server/echo.ts` (`../shared/protocol.js`, Task 2) and `WiretapConnection.svelte.js` (`$shared/protocol.js`, Task 3). `createWiretapServer(port)` defined Task 2, called identically in the Task 2 test. `connection` singleton + `WiretapConnection` class exported Task 3, consumed by `OnceReady.js` (Task 4) and `Wiretap.svelte` (Task 5). Echo reply shape `{ text, receivedAt }` consistent across `echo.ts`, the integration test, and `send()`'s ack handler. `serverUrl` setting key consistent (Task 4 register / Task 4 read).
```
