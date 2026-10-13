// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
   BridgeError,
   EndpointGoneError,
   EndpointTimeoutError,
   MAX_ENDPOINTS,
   ROUTE_ORDER,
   createEndpointRegistry,
   createRouter,
   formatBridgeError,
   normalizeAckError,
   validateIdentify,
} from '../../server/endpoints.ts';
import { sanitizeRegistry } from '../../server/toolRegistry.ts';
import { registryPayload, script } from './scriptFixtures.js';
import { truncateUtf8 } from '../../server/utf8.ts';
import { closedGateState } from '../../shared/gates.js';
import {
   ENDPOINT_GONE,
   GATE_DENIED,
   ENDPOINT_LIMIT,
   ENDPOINT_TIMEOUT,
   ENDPOINT_UNAVAILABLE,
   NOT_GM,
   NO_ENDPOINT,
   OP_CALL_TOOL,
   OP_FAILED,
   PROTOCOL_MISMATCH,
   PROTOCOL_VERSION,
   TOOL_GONE,
} from '$shared/protocol.js';

/**
 * Build a valid identify payload.
 * @param {object} [overrides] - Fields replacing the defaults.
 * @returns {object} The payload.
 */
function identify(overrides = {}) {
   return {
      protocolVersion: PROTOCOL_VERSION,
      userId: 'u1',
      userName: 'GM',
      isGM: true,
      kind: 'human',
      dom: true,
      ...overrides,
   };
}

/**
 * Register an endpoint of a kind in a registry.
 * @param {ReturnType<typeof createEndpointRegistry>} registry - The registry that receives the endpoint.
 * @param {string} socketId - The id of the fake socket the endpoint belongs to.
 * @param {string} kind - Either 'human' or 'agent'.
 * @param {boolean} [dom] - Whether the endpoint can run DOM scripts (default true).
 * @returns {void}
 */
function add(registry, socketId, kind, dom = true) {
   registry.register(socketId, validateIdentify(identify({ userId: socketId, kind, dom })).identity);
}

describe('createEndpointRegistry', () => {
   it('adds an endpoint with its identity and a registration time', () => {
      const registry = createEndpointRegistry(() => 1234);
      add(registry, 's1', 'agent');
      expect(registry.list()).toEqual([
         {
            socketId: 's1',
            userId: 's1',
            userName: 'GM',
            kind: 'agent',
            dom: true,
            gateState: closedGateState(),
            tools: [],
            health: 'healthy',
            registeredAt: 1234,
         },
      ]);
   });

   it('updates the entry of a repeated identify on the same socket and keeps its position', () => {
      const registry = createEndpointRegistry();
      add(registry, 's1', 'human');
      add(registry, 's2', 'human');
      add(registry, 's1', 'agent');
      expect(registry.list().map((e) => [e.socketId, e.kind])).toEqual([['s1', 'agent'], ['s2', 'human']]);
   });

   it('removes an endpoint', () => {
      const registry = createEndpointRegistry();
      add(registry, 's1', 'human');
      registry.remove('s1');
      expect(registry.list()).toEqual([]);
      expect(() => registry.remove('s1')).not.toThrow();
   });

   it('returns the first registered endpoint of a kind (insertion order tiebreak)', () => {
      const registry = createEndpointRegistry();
      add(registry, 'a', 'human');
      add(registry, 'b', 'agent');
      add(registry, 'c', 'agent');
      expect(registry.firstOfKind('agent')?.socketId).toBe('b');
      expect(registry.firstOfKind('human')?.socketId).toBe('a');
   });
});

describe('createEndpointRegistry gate state', () => {
   it('stores the gate state of the identity', () => {
      const registry = createEndpointRegistry();
      registry.register('s1', validateIdentify(identify({ gateState: { allowFileUpload: true } })).identity);
      expect(registry.get('s1').gateState).toEqual({ ...closedGateState(), allowFileUpload: true });
   });

   it('replaces the gate state with setGateState', () => {
      const registry = createEndpointRegistry();
      add(registry, 's1', 'human');
      registry.setGateState('s1', { ...closedGateState(), allowMacroExecution: true });
      expect(registry.get('s1').gateState.allowMacroExecution).toBe(true);
   });

   it('ignores setGateState for an unregistered socket', () => {
      const registry = createEndpointRegistry();
      registry.setGateState('ghost', { ...closedGateState(), allowMacroExecution: true });
      expect(registry.get('ghost')).toBeUndefined();
      expect(registry.list()).toEqual([]);
   });

   it('replaces the gate state when the same socket identifies again', () => {
      const registry = createEndpointRegistry();
      registry.register('s1', validateIdentify(identify({ gateState: { allowFileUpload: true } })).identity);
      add(registry, 's1', 'human');
      expect(registry.get('s1').gateState).toEqual(closedGateState());
   });
});

describe('createEndpointRegistry health', () => {
   it('registers a new endpoint as healthy', () => {
      const registry = createEndpointRegistry();
      add(registry, 's1', 'agent');
      expect(registry.get('s1').health).toBe('healthy');
   });

   it('restricts firstOfKind to DOM-capable endpoints when asked', () => {
      const registry = createEndpointRegistry();
      add(registry, 'a1', 'agent', false);
      add(registry, 'a2', 'agent', true);
      add(registry, 'h1', 'human', false);
      expect(registry.firstOfKind('agent')?.socketId).toBe('a1');
      expect(registry.firstOfKind('agent', { dom: true })?.socketId).toBe('a2');
      expect(registry.firstOfKind('human', { dom: true })).toBeUndefined();
      registry.setHealth('a2', 'unresponsive');
      expect(registry.firstOfKind('agent', { dom: true })).toBeUndefined();
   });

   it('skips an unresponsive endpoint in firstOfKind and keeps registration order among the rest', () => {
      const registry = createEndpointRegistry();
      add(registry, 'a1', 'agent');
      add(registry, 'a2', 'agent');
      add(registry, 'a3', 'agent');
      registry.setHealth('a1', 'unresponsive');
      expect(registry.firstOfKind('agent')?.socketId).toBe('a2');
      registry.setHealth('a2', 'unresponsive');
      expect(registry.firstOfKind('agent')?.socketId).toBe('a3');
      registry.setHealth('a3', 'unresponsive');
      expect(registry.firstOfKind('agent')).toBeUndefined();
      expect(registry.list()).toHaveLength(3);
   });

   it('keeps the current health and position on a repeated identify of the same socket', () => {
      const registry = createEndpointRegistry();
      add(registry, 'a1', 'agent');
      add(registry, 'a2', 'agent');
      registry.setHealth('a1', 'unresponsive');
      add(registry, 'a1', 'agent');
      expect(registry.get('a1').health).toBe('unresponsive');
      expect(registry.firstOfKind('agent')?.socketId).toBe('a2');
      registry.setHealth('a1', 'healthy');
      add(registry, 'a1', 'agent');
      expect(registry.get('a1').health).toBe('healthy');
      expect(registry.firstOfKind('agent')?.socketId).toBe('a1');
   });

   it('ignores setHealth and get for a socket that is not registered', () => {
      const registry = createEndpointRegistry();
      expect(() => registry.setHealth('ghost', 'unresponsive')).not.toThrow();
      expect(registry.get('ghost')).toBeUndefined();
      expect(registry.list()).toEqual([]);
   });
});

describe('createEndpointRegistry tools', () => {
   /**
    * Build a registry tool.
    * @param {string} name - The name to give the tool.
    * @returns {object} A tool in the shape the registry stores.
    */
   function tool(name) {
      return {
         name,
         description: 'A synthetic tool.',
         shape: {},
         signature: name,
      };
   }

   it('registers an endpoint with no tools', () => {
      const registry = createEndpointRegistry();
      add(registry, 's1', 'human');
      expect(registry.get('s1').tools).toEqual([]);
   });

   it('replaces the tools of a registered socket and ignores an unregistered one', () => {
      const registry = createEndpointRegistry();
      add(registry, 's1', 'human');
      registry.setTools('s1', [
         tool('a'),
         tool('b'),
      ]);
      expect(registry.get('s1').tools.map((entry) => entry.name)).toEqual([
         'a',
         'b',
      ]);
      registry.setTools('s1', [tool('c')]);
      expect(registry.get('s1').tools.map((entry) => entry.name)).toEqual(['c']);
      registry.setTools('ghost', [tool('x')]);
      expect(registry.get('ghost')).toBeUndefined();
   });

   it('keeps the tools when the same socket identifies again', () => {
      const registry = createEndpointRegistry();
      add(registry, 's1', 'human');
      registry.setTools('s1', [tool('a')]);
      add(registry, 's1', 'human');
      expect(registry.get('s1').tools.map((entry) => entry.name)).toEqual(['a']);
   });
});

describe('createEndpointRegistry change notifications', () => {
   /**
    * Build a registry with a counting listener.
    * @returns {{ registry: ReturnType<typeof createEndpointRegistry>, listener: import('vitest').Mock }} The pieces.
    */
   function setup() {
      const registry = createEndpointRegistry();
      const listener = vi.fn();
      registry.subscribe(listener);
      return { registry, listener };
   }

   it('notifies on register, a repeated identify, tools, health and removal', () => {
      const { registry, listener } = setup();
      add(registry, 's1', 'human');
      expect(listener).toHaveBeenCalledTimes(1);
      add(registry, 's1', 'human');
      expect(listener).toHaveBeenCalledTimes(2);
      registry.setTools('s1', []);
      expect(listener).toHaveBeenCalledTimes(3);
      registry.setHealth('s1', 'unresponsive');
      expect(listener).toHaveBeenCalledTimes(4);
      registry.remove('s1');
      expect(listener).toHaveBeenCalledTimes(5);
   });

   it('does not notify for a gate state, an unchanged health, or an unregistered socket', () => {
      const { registry, listener } = setup();
      add(registry, 's1', 'human');
      listener.mockClear();
      registry.setGateState('s1', {
         ...closedGateState(),
         allowFileUpload: true,
      });
      registry.setHealth('s1', 'healthy');
      registry.setHealth('ghost', 'unresponsive');
      registry.setTools('ghost', []);
      registry.remove('ghost');
      expect(listener).not.toHaveBeenCalled();
   });

   it('does not notify for a registration the limit refused', () => {
      const { registry, listener } = setup();
      const identity = validateIdentify(identify()).identity;
      for (let index = 0; index < MAX_ENDPOINTS; index += 1) {
         registry.register(`s${index}`, identity);
      }
      listener.mockClear();
      expect(registry.register('extra', identity)).toBe(false);
      expect(listener).not.toHaveBeenCalled();
   });

   it('stops notifying a listener after it unsubscribes and serves several listeners', () => {
      const registry = createEndpointRegistry();
      const first = vi.fn();
      const second = vi.fn();
      const stop = registry.subscribe(first);
      registry.subscribe(second);
      add(registry, 's1', 'human');
      stop();
      add(registry, 's2', 'human');
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(2);
   });
});

describe('createEndpointRegistry limit', () => {
   it('exports a limit of 64 endpoints', () => {
      expect(MAX_ENDPOINTS).toBe(64);
   });

   it('refuses a new socket beyond the limit and reports it', () => {
      const registry = createEndpointRegistry();
      const identity = validateIdentify(identify()).identity;
      for (let i = 0; i < MAX_ENDPOINTS; i++) {
         expect(registry.register(`s${i}`, identity)).toBe(true);
      }
      expect(registry.register('extra', identity)).toBe(false);
      expect(registry.list()).toHaveLength(MAX_ENDPOINTS);
   });

   it('still lets an already registered socket re-identify at the limit', () => {
      const registry = createEndpointRegistry();
      const identity = validateIdentify(identify()).identity;
      for (let i = 0; i < MAX_ENDPOINTS; i++) {
         registry.register(`s${i}`, identity);
      }
      expect(registry.register('s3', { ...identity, kind: 'agent' })).toBe(true);
      expect(registry.list().find((e) => e.socketId === 's3').kind).toBe('agent');
   });
});

describe('validateIdentify', () => {
   it('accepts a valid GM payload', () => {
      expect(validateIdentify(identify())).toEqual({
         ok: true,
         identity: { userId: 'u1', userName: 'GM', kind: 'human', dom: true, gateState: closedGateState() },
      });
   });

   it('closes every gate when the identify carries no gateState', () => {
      expect(validateIdentify(identify()).identity.gateState).toEqual(closedGateState());
   });

   it('sanitizes the gateState of the identify', () => {
      const hostile = JSON.parse(
         '{"__proto__":{"allowMacroExecution":true},"allowUserWrites":true,"allowFileUpload":"yes","extra":1,' +
            '"allowedPluginModules":["ok",5]}',
      );
      expect(validateIdentify(identify({ gateState: hostile })).identity.gateState).toEqual({
         ...closedGateState(),
         allowUserWrites: true,
         allowedPluginModules: ['ok'],
      });
   });

   it('accepts an identify whose gateState is not an object and closes every gate', () => {
      for (const gateState of ['open', 5, null, [], true]) {
         const result = validateIdentify(identify({ gateState }));
         expect(result.ok).toBe(true);
         expect(result.identity.gateState).toEqual(closedGateState());
      }
   });

   it('refuses a v1 payload without protocolVersion as PROTOCOL_MISMATCH', () => {
      const result = validateIdentify({ userId: 'u', userName: 'GM', isGM: true });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe(PROTOCOL_MISMATCH);
      expect(result.error.message).toMatch(/reload/i);
   });

   it('speaks protocol 4 and refuses the previous version 3', () => {
      expect(PROTOCOL_VERSION).toBe(4);
      expect(validateIdentify(identify({ protocolVersion: 3 })).error.code).toBe(PROTOCOL_MISMATCH);
   });

   it('refuses a wrong protocolVersion', () => {
      expect(validateIdentify(identify({ protocolVersion: 2 })).error.code).toBe(PROTOCOL_MISMATCH);
   });

   it('refuses a non-object payload', () => {
      expect(validateIdentify(undefined).error.code).toBe(PROTOCOL_MISMATCH);
      expect(validateIdentify('x').error.code).toBe(PROTOCOL_MISMATCH);
   });

   it('refuses a current-version payload with a malformed field as PROTOCOL_MISMATCH', () => {
      expect(validateIdentify(identify({ kind: 'robot' })).error.code).toBe(PROTOCOL_MISMATCH);
      expect(validateIdentify(identify({ dom: 'yes' })).error.code).toBe(PROTOCOL_MISMATCH);
      expect(validateIdentify(identify({ userId: 5 })).error.code).toBe(PROTOCOL_MISMATCH);
      expect(validateIdentify(identify({ isGM: 'true' })).error.code).toBe(PROTOCOL_MISMATCH);
   });

   it('accepts a userId of 64 bytes and a userName of 128 bytes', () => {
      expect(validateIdentify(identify({ userId: 'u'.repeat(64), userName: 'n'.repeat(128) })).ok).toBe(true);
   });

   it('refuses a userId over 64 bytes and a userName over 128 bytes as PROTOCOL_MISMATCH', () => {
      expect(validateIdentify(identify({ userId: 'u'.repeat(65) })).error.code).toBe(PROTOCOL_MISMATCH);
      expect(validateIdentify(identify({ userName: 'n'.repeat(129) })).error.code).toBe(PROTOCOL_MISMATCH);
   });

   it('counts bytes, not characters, for the identify limits', () => {
      expect(validateIdentify(identify({ userName: 'é'.repeat(64) })).ok).toBe(true);
      expect(validateIdentify(identify({ userName: 'é'.repeat(65) })).error.code).toBe(PROTOCOL_MISMATCH);
   });

   it('refuses a non-GM as NOT_GM', () => {
      const result = validateIdentify(identify({ isGM: false }));
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe(NOT_GM);
   });
});

describe('truncateUtf8', () => {
   it('returns text within the limit unchanged', () => {
      expect(truncateUtf8('short', 512)).toBe('short');
   });

   it('truncates to at most the limit in bytes including the ellipsis marker', () => {
      const out = truncateUtf8('x'.repeat(2000), 512);
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(512);
      expect(out.endsWith('…')).toBe(true);
   });

   it('never splits a multi-byte character', () => {
      const out = truncateUtf8('é'.repeat(1000), 512);
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(512);
      expect(out).not.toContain('�');
   });

   it.each([
      ['2-byte', 'é'],
      ['3-byte', '€'],
      ['4-byte', '😀'],
   ])('stays within the limit and valid UTF-8 for every limit on %s characters', (_label, char) => {
      for (let maxBytes = 0; maxBytes <= 40; maxBytes++) {
         const out = truncateUtf8(char.repeat(30), maxBytes);
         expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(maxBytes);
         expect(out).not.toContain('�');
         expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
      }
   });

   it('returns an empty string for a limit below the ellipsis size', () => {
      expect(truncateUtf8('x'.repeat(100), 0)).toBe('');
      expect(truncateUtf8('x'.repeat(100), 2)).toBe('');
      expect(truncateUtf8('x'.repeat(100), -5)).toBe('');
   });

   it('returns just the ellipsis for a limit equal to the ellipsis size', () => {
      expect(truncateUtf8('x'.repeat(100), 3)).toBe('…');
   });

   it('returns text that already fits unchanged even for a tiny limit', () => {
      expect(truncateUtf8('ab', 2)).toBe('ab');
   });
});

describe('normalizeAckError', () => {
   it('defaults the code to OP_FAILED when the client gives none', () => {
      const err = normalizeAckError({ ok: false, error: { message: 'bad type' } });
      expect(err).toBeInstanceOf(BridgeError);
      expect(err.code).toBe(OP_FAILED);
      expect(err.message).toBe('bad type');
   });

   it('keeps a client-sent GATE_DENIED code and bounds its message to 512 bytes', () => {
      const err = normalizeAckError({ ok: false, error: { code: GATE_DENIED, message: 'g'.repeat(2000) } });
      expect(err.code).toBe(GATE_DENIED);
      expect(Buffer.byteLength(err.message, 'utf8')).toBeLessThanOrEqual(512);
   });

   it('keeps a client-supplied code', () => {
      expect(normalizeAckError({ ok: false, error: { code: 'INVALID_TYPE', message: 'm' } }).code).toBe('INVALID_TYPE');
   });

   it.each([
      NO_ENDPOINT,
      ENDPOINT_TIMEOUT,
      ENDPOINT_GONE,
      ENDPOINT_LIMIT,
      ENDPOINT_UNAVAILABLE,
      PROTOCOL_MISMATCH,
      NOT_GM,
      TOOL_GONE,
   ])(
      'turns the reserved protocol code %s from a client into OP_FAILED',
      (code) => {
         expect(normalizeAckError({ ok: false, error: { code, message: 'm' } }).code).toBe(OP_FAILED);
      },
   );

   it.each([
      ['a null ack', null],
      ['an ack with a string error', { ok: false, error: 'boom' }],
      ['an ack with an array error', { ok: false, error: ['a', 'b'] }],
      ['an ack with a numeric message', { ok: false, error: { message: 42 } }],
      ['an ack with non-array failures', { ok: false, error: { message: 'm', failures: 'nope' } }],
      ['an ok:true ack read as a failure', { ok: true }],
   ])('survives %s', (_label, ack) => {
      const err = normalizeAckError(ack);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err.code).toBe(OP_FAILED);
      expect(err.message.length).toBeGreaterThan(0);
      expect(err.failures).toBeUndefined();
   });

   it('uses a string error as the message', () => {
      expect(normalizeAckError({ ok: false, error: 'boom' }).message).toBe('boom');
   });

   it('falls back to OP_FAILED for a malformed code', () => {
      expect(normalizeAckError({ ok: false, error: { code: 'x'.repeat(500), message: 'm' } }).code).toBe(OP_FAILED);
   });

   it('truncates a long message to 512 bytes', () => {
      const err = normalizeAckError({ ok: false, error: { message: 'x'.repeat(5000) } });
      expect(Buffer.byteLength(err.message, 'utf8')).toBeLessThanOrEqual(512);
   });

   it('caps 50 failures at 10 and carries the true total in failureCount', () => {
      const failures = Array.from({ length: 50 }, (_, i) => ({ path: `system.f${i}`, message: `bad ${i}` }));
      const err = normalizeAckError({ ok: false, error: { message: 'invalid', failures } });
      expect(err.failures).toHaveLength(10);
      expect(err.failures[0]).toEqual({ path: 'system.f0', message: 'bad 0' });
      expect(err.failureCount).toBe(50);
   });

   it('truncates an oversized failure message and path to 512 bytes', () => {
      const failures = [{ path: 'p'.repeat(2000), message: 'm'.repeat(2000) }];
      const err = normalizeAckError({ ok: false, error: { message: 'invalid', failures } });
      expect(Buffer.byteLength(err.failures[0].path, 'utf8')).toBeLessThanOrEqual(512);
      expect(Buffer.byteLength(err.failures[0].message, 'utf8')).toBeLessThanOrEqual(512);
   });

   it('honours a client-reported failureCount larger than the failures it sent', () => {
      const err = normalizeAckError({
         ok: false,
         error: { message: 'invalid', failures: [{ path: 'a', message: 'b' }], failureCount: 40 },
      });
      expect(err.failureCount).toBe(40);
   });

   it('survives an ack with no error object', () => {
      const err = normalizeAckError(undefined);
      expect(err.code).toBe(OP_FAILED);
      expect(err.message.length).toBeGreaterThan(0);
   });
});

describe('formatBridgeError', () => {
   it('formats <code>: <message>', () => {
      expect(formatBridgeError(new BridgeError(OP_FAILED, 'bad type'))).toBe('OP_FAILED: bad type');
   });

   it('lists the failures that fit, one per line, with (+N more) after the last one for the rest', () => {
      const failures = Array.from({ length: 50 }, (_, i) => ({ path: `p${i}`, message: 'm' }));
      const err = normalizeAckError({ ok: false, error: { message: 'invalid', failures } });
      const lines = formatBridgeError(err).split('\n');
      expect(lines[0]).toBe('OP_FAILED: invalid');
      expect(lines.slice(1, 10)).toEqual(Array.from({ length: 9 }, (_, i) => `p${i}: m`));
      expect(lines[10]).toBe('p9: m (+40 more)');
   });

   it('adds no suffix when every failure fits', () => {
      const err = normalizeAckError({
         ok: false,
         error: { message: 'invalid', failures: [{ path: 'a', message: 'b' }] },
      });
      expect(formatBridgeError(err)).toBe('OP_FAILED: invalid\na: b');
   });

   it('keeps the whole text within 512 bytes and counts the failures that do not fit as more', () => {
      const failures = Array.from({ length: 10 }, (_, i) => ({ path: `field${i}`, message: 'm'.repeat(100) }));
      const text = formatBridgeError(new BridgeError(OP_FAILED, 'invalid', failures, 10));
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(512);
      const shown = text.split('\n').length - 1;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(10);
      expect(text.endsWith(` (+${10 - shown} more)`)).toBe(true);
   });

   it('stays within 512 bytes when the message alone fills the budget, keeping the (+N more) suffix', () => {
      const failures = [{ path: 'a', message: 'b' }];
      const text = formatBridgeError(new BridgeError(OP_FAILED, 'x'.repeat(512), failures, 5));
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(512);
      expect(text.endsWith(' (+5 more)')).toBe(true);
   });

   it('truncates a message that alone exceeds the budget when there are no failures', () => {
      const text = formatBridgeError(new BridgeError(OP_FAILED, 'x'.repeat(512)));
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(512);
      expect(text.startsWith('OP_FAILED: x')).toBe(true);
   });
});

describe('createRouter', () => {
   /**
    * Build a router over a registry with a recording transport.
    * @param {Array<[string, string]>} endpoints - `[socketId, kind]` pairs registered in order.
    * @param {(socketId: string, payload: object) => Promise<unknown>} [respond] - The transport response.
    * @returns {{ router: object, registry: object, sent: object[] }} The router, registry and sent log.
    */
   function setup(endpoints, respond = async () => ({ ok: true, result: { done: true } })) {
      const registry = createEndpointRegistry();
      endpoints.forEach(([id, kind]) => add(registry, id, kind));
      const sent = [];
      const router = createRouter(registry, {
         send: async (socketId, payload) => {
            sent.push({ socketId, payload });
            return respond(socketId, payload);
         },
         ping: async () => undefined,
         log: () => undefined,
         newRequestId: () => 'req-1',
      });
      return { router, registry, sent };
   }

   it('exports the default order as one constant', () => {
      expect(ROUTE_ORDER).toEqual(['agent', 'human']);
   });

   it('reports the gate state of the endpoint a call would reach', () => {
      const { router, registry } = setup([['h', 'human'], ['a', 'agent']]);
      registry.setGateState('h', { ...closedGateState(), allowUserWrites: true });
      registry.setGateState('a', { ...closedGateState(), allowMacroExecution: true });
      expect(router.gateState().allowMacroExecution).toBe(true);
      expect(router.gateState().allowUserWrites).toBe(false);
      expect(router.gateState({ endpoint: 'human' }).allowUserWrites).toBe(true);
      expect(router.gateState({ endpoint: 'agent' }).allowMacroExecution).toBe(true);
   });

   it('reports every gate closed when no healthy endpoint is eligible', () => {
      const { router, registry } = setup([['h', 'human']]);
      registry.setGateState('h', { ...closedGateState(), allowUserWrites: true });
      expect(router.gateState({ endpoint: 'agent' })).toEqual(closedGateState());
      registry.setHealth('h', 'unresponsive');
      expect(router.gateState()).toEqual(closedGateState());
      expect(setup([]).router.gateState()).toEqual(closedGateState());
   });

   it('returns a copy of the gate state that cannot change the stored snapshot', () => {
      const { router, registry } = setup([['h', 'human']]);
      registry.setGateState('h', { ...closedGateState(), allowedPluginModules: ['m'] });
      const copy = router.gateState();
      copy.allowMacroExecution = true;
      copy.allowedPluginModules.push('x');
      expect(router.gateState().allowMacroExecution).toBe(false);
      expect(router.gateState().allowedPluginModules).toEqual(['m']);
   });

   describe('requireGate', () => {
      /**
       * Open a boolean gate on a registered endpoint.
       * @param {object} registry - The endpoint registry to modify.
       * @param {string} socketId - The endpoint's socket id.
       * @param {string} gate - The gate to open.
       * @returns {void}
       */
      function open(registry, socketId, gate) {
         registry.setGateState(socketId, { ...closedGateState(), [gate]: true });
      }

      it('throws GATE_DENIED before sending when the picked endpoint has the gate closed', async () => {
         const { router, sent } = setup([['a', 'agent']]);
         const rejection = router.invoke(OP_CALL_TOOL, {}, { requireGate: { gate: 'allowMacroExecution' } });
         await expect(rejection).rejects.toMatchObject({ name: 'BridgeError', code: GATE_DENIED });
         await rejection.catch((error) => {
            expect(error.message).toContain('allowMacroExecution');
            expect(Buffer.byteLength(error.message, 'utf8')).toBeLessThanOrEqual(256);
         });
         expect(sent).toEqual([]);
      });

      it('sends to the same endpoint whose snapshot opened the gate', async () => {
         const { router, registry, sent } = setup([['h', 'human'], ['a', 'agent']]);
         open(registry, 'a', 'allowMacroExecution');
         await router.invoke(OP_CALL_TOOL, {}, { requireGate: { gate: 'allowMacroExecution' } });
         expect(sent.map((entry) => entry.socketId)).toEqual(['a']);
      });

      it('judges the picked endpoint only: an open gate on another endpoint does not help', async () => {
         const { router, registry, sent } = setup([['h', 'human'], ['a', 'agent']]);
         open(registry, 'h', 'allowMacroExecution');
         await expect(
            router.invoke(OP_CALL_TOOL, {}, { requireGate: { gate: 'allowMacroExecution' } }),
         ).rejects.toMatchObject({ code: GATE_DENIED });
         expect(sent).toEqual([]);
      });

      it('cannot be split from the send by an endpoint change after the call starts', async () => {
         const { router, registry, sent } = setup([['a', 'agent'], ['h', 'human']]);
         open(registry, 'a', 'allowMacroExecution');
         const pending = router.invoke(OP_CALL_TOOL, {}, { requireGate: { gate: 'allowMacroExecution' } });
         // The pick and the gate check ran synchronously inside invoke; these changes come too late to matter.
         registry.setGateState('a', closedGateState());
         registry.remove('a');
         add(registry, 'a2', 'agent');
         await pending;
         expect(sent.map((entry) => entry.socketId)).toEqual(['a']);
      });

      it('skips an unresponsive endpoint and judges the next healthy one', async () => {
         const { router, registry, sent } = setup([['a1', 'agent'], ['a2', 'agent']]);
         open(registry, 'a1', 'allowFileUpload');
         registry.setHealth('a1', 'unresponsive');
         await expect(
            router.invoke(OP_CALL_TOOL, {}, { requireGate: { gate: 'allowFileUpload' } }),
         ).rejects.toMatchObject({ code: GATE_DENIED });
         expect(sent).toEqual([]);
      });

      it('honours the endpoint override when judging the gate', async () => {
         const { router, registry, sent } = setup([['h', 'human'], ['a', 'agent']]);
         open(registry, 'h', 'allowUserWrites');
         await router.invoke(OP_CALL_TOOL, {}, { endpoint: 'human', requireGate: { gate: 'allowUserWrites' } });
         expect(sent.map((entry) => entry.socketId)).toEqual(['h']);
         await expect(
            router.invoke(OP_CALL_TOOL, {}, { endpoint: 'agent', requireGate: { gate: 'allowUserWrites' } }),
         ).rejects.toMatchObject({ code: GATE_DENIED });
      });

      it('reports NO_ENDPOINT, not GATE_DENIED, when nothing is connected', async () => {
         const { router } = setup([]);
         await expect(
            router.invoke(OP_CALL_TOOL, {}, { requireGate: { gate: 'allowMacroExecution' } }),
         ).rejects.toMatchObject({ code: NO_ENDPOINT });
      });

      it('reports ENDPOINT_UNAVAILABLE, not GATE_DENIED, when every endpoint is unresponsive', async () => {
         const { router, registry } = setup([['a', 'agent']]);
         registry.setHealth('a', 'unresponsive');
         await expect(
            router.invoke(OP_CALL_TOOL, {}, { requireGate: { gate: 'allowMacroExecution' } }),
         ).rejects.toMatchObject({ code: ENDPOINT_UNAVAILABLE });
      });

      it('requires the module id to be listed for the plugin module gate', async () => {
         const { router, registry, sent } = setup([['a', 'agent']]);
         registry.setGateState('a', { ...closedGateState(), allowedPluginModules: ['my-module'] });
         await router.invoke(OP_CALL_TOOL, {}, {
            requireGate: { gate: 'allowedPluginModules', moduleId: 'my-module' },
         });
         expect(sent).toHaveLength(1);
         await expect(
            router.invoke(OP_CALL_TOOL, {}, { requireGate: { gate: 'allowedPluginModules', moduleId: 'other' } }),
         ).rejects.toMatchObject({ code: GATE_DENIED });
         await expect(
            router.invoke(OP_CALL_TOOL, {}, { requireGate: { gate: 'allowedPluginModules' } }),
         ).rejects.toMatchObject({ code: GATE_DENIED });
         expect(sent).toHaveLength(1);
      });

      it('denies an unknown gate name', async () => {
         const { router, sent } = setup([['a', 'agent']]);
         await expect(
            router.invoke(OP_CALL_TOOL, {}, { requireGate: { gate: 'allowDelete' } }),
         ).rejects.toMatchObject({ code: GATE_DENIED });
         expect(sent).toEqual([]);
      });

      it('does not gate a call that sets no requireGate', async () => {
         const { router, sent } = setup([['a', 'agent']]);
         await router.invoke(OP_CALL_TOOL, {});
         expect(sent).toHaveLength(1);
      });
   });

   it('prefers an agent endpoint over an earlier human endpoint', async () => {
      const { router, sent } = setup([['h', 'human'], ['a', 'agent']]);
      await router.invoke(OP_CALL_TOOL, { name: 'Bob' });
      expect(sent[0].socketId).toBe('a');
   });

   it('falls back to a human endpoint when no agent is registered', async () => {
      const { router, sent } = setup([['h', 'human']]);
      await router.invoke(OP_CALL_TOOL, {});
      expect(sent[0].socketId).toBe('h');
   });

   it('uses insertion order between endpoints of the same kind', async () => {
      const { router, sent } = setup([['a1', 'agent'], ['a2', 'agent']]);
      await router.invoke(OP_CALL_TOOL, {});
      expect(sent[0].socketId).toBe('a1');
   });

   it('sends { op, params, requestId } and resolves with the ack result', async () => {
      const { router, sent } = setup([['h', 'human']]);
      await expect(router.invoke(OP_CALL_TOOL, { name: 'Bob' })).resolves.toEqual({ done: true });
      expect(sent[0].payload).toEqual({ op: OP_CALL_TOOL, params: { name: 'Bob' }, requestId: 'req-1' });
   });

   it('generates a distinct UUID requestId per invocation by default', async () => {
      const registry = createEndpointRegistry();
      add(registry, 'h', 'human');
      const ids = [];
      const router = createRouter(registry, {
         send: async (_id, payload) => {
            ids.push(payload.requestId);
            return { ok: true, result: null };
         },
         log: () => undefined,
      });
      await router.invoke('x', {});
      await router.invoke('x', {});
      expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(ids[1]).not.toBe(ids[0]);
   });

   it('restricts an endpoint override to that kind with no fallback', async () => {
      const { router, sent } = setup([['h', 'human']]);
      await expect(router.invoke(OP_CALL_TOOL, {}, { endpoint: 'agent' })).rejects.toMatchObject({
         code: NO_ENDPOINT,
      });
      expect(sent).toEqual([]);
   });

   it('routes an override to the requested kind even when the other kind is preferred', async () => {
      const { router, sent } = setup([['a', 'agent'], ['h', 'human']]);
      await router.invoke(OP_CALL_TOOL, {}, { endpoint: 'human' });
      expect(sent[0].socketId).toBe('h');
   });

   it('rejects with NO_ENDPOINT, within 256 bytes, naming the fix, when nothing is registered', async () => {
      const { router } = setup([]);
      const err = await router.invoke(OP_CALL_TOOL, {}).catch((e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err.code).toBe(NO_ENDPOINT);
      expect(Buffer.byteLength(err.message, 'utf8')).toBeLessThanOrEqual(256);
      expect(err.message).toMatch(/GM tab/);
      expect(err.message).toMatch(/agent/);
   });

   it('keeps the NO_ENDPOINT message within 256 bytes for an override', async () => {
      const { router } = setup([]);
      const err = await router.invoke(OP_CALL_TOOL, {}, { endpoint: 'agent' }).catch((e) => e);
      expect(Buffer.byteLength(err.message, 'utf8')).toBeLessThanOrEqual(256);
   });

   it('maps an EndpointTimeoutError from the transport to ENDPOINT_TIMEOUT', async () => {
      const { router } = setup([['h', 'human']], async () => {
         throw new EndpointTimeoutError('operation has timed out');
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
   });

   it('maps any other transport rejection to ENDPOINT_GONE and logs the cause, not ENDPOINT_TIMEOUT', async () => {
      const lines = [];
      const registry = createEndpointRegistry();
      add(registry, 'h', 'human');
      const router = createRouter(registry, {
         send: async () => {
            throw new Error('emit blew up');
         },
         log: (line) => lines.push(line),
         newRequestId: () => 'req-3',
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_GONE });
      expect(lines.some((line) => line.includes('req-3') && line.includes('emit blew up'))).toBe(true);
   });

   it('logs a non-Error transport rejection as its string form', async () => {
      const lines = [];
      const registry = createEndpointRegistry();
      add(registry, 'h', 'human');
      const router = createRouter(registry, {
         send: async () => {
            throw 'plain string';
         },
         log: (line) => lines.push(line),
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_GONE });
      expect(lines.some((line) => line.includes('plain string'))).toBe(true);
   });

   it('maps an EndpointGoneError from the transport to ENDPOINT_GONE and logs the cause', async () => {
      const lines = [];
      const registry = createEndpointRegistry();
      add(registry, 'h', 'human');
      const router = createRouter(registry, {
         send: async () => {
            throw new EndpointGoneError('socket disconnected');
         },
         log: (line) => lines.push(line),
         newRequestId: () => 'req-2',
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_GONE });
      expect(lines.some((line) => line.includes('req-2') && line.includes('socket disconnected'))).toBe(true);
   });

   it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'ok'],
   ])('rejects with OP_FAILED when the ack is %s', async (_label, ack) => {
      const { router } = setup([['h', 'human']], async () => ack);
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: OP_FAILED });
   });

   it('resolves undefined for an ok:true ack without a result (the caller validates the result)', async () => {
      const { router } = setup([['h', 'human']], async () => ({ ok: true }));
      await expect(router.invoke(OP_CALL_TOOL, {})).resolves.toBeUndefined();
   });

   it('rejects with a normalized BridgeError when the client acks ok:false', async () => {
      const { router } = setup([['h', 'human']], async () => ({ ok: false, error: { message: 'Unknown type' } }));
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({
         code: OP_FAILED,
         message: 'Unknown type',
      });
   });

   it('stops routing to an endpoint once it is removed from the registry', async () => {
      const { router, registry, sent } = setup([['a', 'agent'], ['h', 'human']]);
      registry.remove('a');
      await router.invoke(OP_CALL_TOOL, {});
      expect(sent[0].socketId).toBe('h');
   });

   it('logs the requestId on dispatch', async () => {
      const lines = [];
      const registry = createEndpointRegistry();
      add(registry, 'h', 'human');
      const router = createRouter(registry, {
         send: async () => ({ ok: true, result: null }),
         log: (line) => lines.push(line),
         newRequestId: () => 'req-9',
      });
      await router.invoke('x', {});
      expect(lines.some((line) => line.includes('req-9'))).toBe(true);
   });
});

describe('createRouter endpoint health', () => {
   /** @type {object[]} The routers created by the current test, disposed afterwards. */
   let routers = [];

   beforeEach(() => {
      vi.useFakeTimers();
   });

   afterEach(() => {
      routers.forEach((router) => router.dispose());
      routers = [];
      vi.useRealTimers();
   });

   /**
    * Build a router whose transport times out for the sockets listed in `silent` and whose ping is controllable.
    * @param {Array<[string, string]>} endpoints - `[socketId, kind]` pairs registered in order.
    * @param {object} [options] - `silent`: socket ids whose invocations time out; `ping`: the ping implementation.
    * @returns {{ router: object, registry: object, sent: string[], pings: string[], lines: string[] }} The parts.
    */
   function setup(endpoints, options = {}) {
      const silent = new Set(options.silent ?? []);
      const registry = createEndpointRegistry();
      endpoints.forEach(([id, kind]) => add(registry, id, kind));
      const sent = [];
      const pings = [];
      const lines = [];
      const router = createRouter(registry, {
         send: async (socketId) => {
            sent.push(socketId);
            if (silent.has(socketId)) {
               throw new EndpointTimeoutError('operation has timed out');
            }
            return { ok: true, result: { who: socketId } };
         },
         ping: async (socketId) => {
            pings.push(socketId);
            return (options.ping ?? (async () => undefined))(socketId);
         },
         log: (line) => lines.push(line),
         newRequestId: () => 'req-h',
      });
      routers.push(router);
      return { router, registry, sent, pings, lines };
   }

   /**
    * Make a ping implementation that rejects until `state.up` is true.
    * @param {{ up: boolean }} state - The switch the ping reads.
    * @returns {(socketId: string) => Promise<void>} The ping implementation.
    */
   function switchablePing(state) {
      return async () => {
         if (!state.up) {
            throw new EndpointTimeoutError('ping timed out');
         }
      };
   }

   it('keeps routing to the same agent when the ping after a timeout is acked', async () => {
      const { router, registry, sent, pings } = setup([['a', 'agent'], ['h', 'human']], { silent: ['a'] });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      expect(pings).toEqual(['a']);
      expect(registry.get('a').health).toBe('healthy');
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      expect(sent).toEqual(['a', 'a']);
      expect(vi.getTimerCount()).toBe(0);
   });

   it('routes the next call to the human at once when the ping after a timeout fails', async () => {
      const { router, registry, sent } = setup([['a', 'agent'], ['h', 'human']], {
         silent: ['a'],
         ping: switchablePing({ up: false }),
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      expect(registry.get('a').health).toBe('unresponsive');
      await expect(router.invoke(OP_CALL_TOOL, {})).resolves.toEqual({ who: 'h' });
      expect(sent).toEqual(['a', 'h']);
   });

   it('marks the endpoint unresponsive when the ping transport fails with any error', async () => {
      const { router, registry } = setup([['a', 'agent']], {
         silent: ['a'],
         ping: async () => {
            throw new EndpointGoneError('socket gone');
         },
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      expect(registry.get('a').health).toBe('unresponsive');
   });

   it('does not probe after a non-timeout transport failure', async () => {
      const registry = createEndpointRegistry();
      add(registry, 'a', 'agent');
      const pings = [];
      const router = createRouter(registry, {
         send: async () => {
            throw new EndpointGoneError('socket disconnected');
         },
         ping: async (socketId) => {
            pings.push(socketId);
         },
         log: () => undefined,
      });
      routers.push(router);
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_GONE });
      expect(pings).toEqual([]);
   });

   it('fails at once with ENDPOINT_UNAVAILABLE within 256 bytes when every endpoint is unresponsive', async () => {
      const { router, sent } = setup([['a', 'agent']], { silent: ['a'], ping: switchablePing({ up: false }) });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      const err = await router.invoke(OP_CALL_TOOL, {}).catch((e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err.code).toBe(ENDPOINT_UNAVAILABLE);
      expect(Buffer.byteLength(err.message, 'utf8')).toBeLessThanOrEqual(256);
      expect(err.message).toMatch(/reload/i);
      expect(sent).toEqual(['a']);
   });

   it('gives ENDPOINT_UNAVAILABLE, not a human fallback, for an unresponsive agent override', async () => {
      const { router, sent } = setup([['a', 'agent'], ['h', 'human']], {
         silent: ['a'],
         ping: switchablePing({ up: false }),
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      const err = await router.invoke(OP_CALL_TOOL, {}, { endpoint: 'agent' }).catch((e) => e);
      expect(err.code).toBe(ENDPOINT_UNAVAILABLE);
      expect(Buffer.byteLength(err.message, 'utf8')).toBeLessThanOrEqual(256);
      expect(sent).toEqual(['a']);
   });

   it('keeps NO_ENDPOINT for an override of a kind that is not connected', async () => {
      const { router } = setup([['a', 'agent']], { silent: ['a'], ping: switchablePing({ up: false }) });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      await expect(router.invoke(OP_CALL_TOOL, {}, { endpoint: 'human' })).rejects.toMatchObject({
         code: NO_ENDPOINT,
      });
   });

   it('picks the second agent for an agent override when the first is unresponsive', async () => {
      const { router, sent } = setup([['a1', 'agent'], ['a2', 'agent']], {
         silent: ['a1'],
         ping: switchablePing({ up: false }),
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      await expect(router.invoke(OP_CALL_TOOL, {}, { endpoint: 'agent' })).resolves.toEqual({ who: 'a2' });
      expect(sent).toEqual(['a1', 'a2']);
   });

   it('probes an unresponsive endpoint every 5 seconds and restores routing on a ping ack', async () => {
      const state = { up: false };
      const { router, registry, pings } = setup([['a', 'agent'], ['h', 'human']], {
         silent: ['a'],
         ping: switchablePing(state),
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      expect(pings).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(pings).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(pings).toHaveLength(2);
      expect(registry.get('a').health).toBe('unresponsive');
      state.up = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pings).toHaveLength(3);
      expect(registry.get('a').health).toBe('healthy');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(pings).toHaveLength(3);
      expect(registry.firstOfKind('agent')?.socketId).toBe('a');
   });

   it('keeps one probe in flight per endpoint while a ping has not settled', async () => {
      let first = true;
      const { router, pings } = setup([['a', 'agent']], {
         silent: ['a'],
         ping: async () => {
            if (first) {
               first = false;
               throw new EndpointTimeoutError('ping timed out');
            }
            return new Promise(() => undefined);
         },
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pings).toEqual(['a', 'a']);
   });

   it('starts one probe for concurrent timeouts on the same endpoint', async () => {
      const { router, pings, registry } = setup([['a', 'agent']], {
         silent: ['a'],
         ping: switchablePing({ up: false }),
      });
      const results = await Promise.all([
         router.invoke(OP_CALL_TOOL, {}).catch((e) => e),
         router.invoke(OP_CALL_TOOL, {}).catch((e) => e),
         router.invoke(OP_CALL_TOOL, {}).catch((e) => e),
      ]);
      expect(results.map((e) => e.code)).toEqual([ENDPOINT_TIMEOUT, ENDPOINT_TIMEOUT, ENDPOINT_TIMEOUT]);
      expect(pings).toEqual(['a']);
      expect(registry.get('a').health).toBe('unresponsive');
      expect(vi.getTimerCount()).toBe(1);
   });

   it('sends a timed-out call exactly once and never retries it on another endpoint', async () => {
      const { router, sent } = setup([['a', 'agent'], ['h', 'human']], {
         silent: ['a'],
         ping: switchablePing({ up: false }),
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent).toEqual(['a']);
   });

   it('words ENDPOINT_TIMEOUT as possibly applied, within 512 bytes', async () => {
      const { router } = setup([['a', 'agent']], { silent: ['a'] });
      const err = await router.invoke(OP_CALL_TOOL, {}).catch((e) => e);
      expect(err.message).toBe(
         'Foundry did not respond in 10 s; the operation may still have applied. Check before retrying.',
      );
      expect(Buffer.byteLength(err.message, 'utf8')).toBeLessThanOrEqual(512);
   });

   it('keeps an unresponsive endpoint skipped and its single probe when it identifies again', async () => {
      const state = { up: false };
      const { router, registry, pings, sent } = setup([['a', 'agent'], ['h', 'human']], {
         silent: ['a'],
         ping: switchablePing(state),
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      add(registry, 'a', 'agent');
      expect(registry.get('a').health).toBe('unresponsive');
      expect(registry.firstOfKind('agent')).toBeUndefined();
      await expect(router.invoke(OP_CALL_TOOL, {})).resolves.toEqual({ who: 'h' });
      expect(sent).toEqual(['a', 'h']);
      expect(vi.getTimerCount()).toBe(1);
      state.up = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pings).toEqual(['a', 'a']);
      expect(registry.get('a').health).toBe('healthy');
      expect(vi.getTimerCount()).toBe(0);
   });

   it('stops the probe of an endpoint that forget() reports gone', async () => {
      const { router, registry, pings } = setup([['a', 'agent']], {
         silent: ['a'],
         ping: switchablePing({ up: false }),
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      expect(vi.getTimerCount()).toBe(1);
      registry.remove('a');
      router.forget('a');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(pings).toEqual(['a']);
   });

   it('starts no probe when the endpoint is forgotten while its first ping is in flight', async () => {
      /** @type {(reason: Error) => void} Fails the in-flight first ping. */
      let failPing;
      const { router, registry } = setup([['a', 'agent']], {
         silent: ['a'],
         ping: () =>
            new Promise((_resolve, reject) => {
               failPing = reject;
            }),
      });
      const call = router.invoke(OP_CALL_TOOL, {}).catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      registry.remove('a');
      router.forget('a');
      failPing(new EndpointGoneError('gone'));
      expect((await call).code).toBe(ENDPOINT_TIMEOUT);
      expect(vi.getTimerCount()).toBe(0);
   });

   it('leaves no timer and no later state change when disposed while the first ping is in flight', async () => {
      /** @type {(reason: Error) => void} Fails the in-flight first ping. */
      let failPing;
      const { router, registry, pings, lines } = setup([['a', 'agent']], {
         silent: ['a'],
         ping: () =>
            new Promise((_resolve, reject) => {
               failPing = reject;
            }),
      });
      const call = router.invoke(OP_CALL_TOOL, {}).catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      expect(pings).toEqual(['a']);
      router.dispose();
      const logged = lines.length;
      failPing(new EndpointTimeoutError('ping timed out'));
      expect((await call).code).toBe(ENDPOINT_TIMEOUT);
      expect(vi.getTimerCount()).toBe(0);
      expect(registry.get('a').health).toBe('healthy');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pings).toEqual(['a']);
      expect(lines.slice(logged).filter((line) => line.includes('unresponsive'))).toEqual([]);
   });

   it('clears every probe and starts no new one after dispose', async () => {
      const { router, pings } = setup([['a1', 'agent'], ['a2', 'agent']], {
         silent: ['a1', 'a2'],
         ping: switchablePing({ up: false }),
      });
      await expect(router.invoke(OP_CALL_TOOL, {}, { endpoint: 'agent' })).rejects.toMatchObject({
         code: ENDPOINT_TIMEOUT,
      });
      await expect(router.invoke(OP_CALL_TOOL, {}, { endpoint: 'agent' })).rejects.toMatchObject({
         code: ENDPOINT_TIMEOUT,
      });
      expect(vi.getTimerCount()).toBe(2);
      router.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(pings).toEqual(['a1', 'a2']);
   });

   it('schedules probes through the injected timers at a 5000 ms interval and clears them', async () => {
      const registry = createEndpointRegistry();
      add(registry, 'a', 'agent');
      const calls = [];
      const router = createRouter(registry, {
         send: async () => {
            throw new EndpointTimeoutError('operation has timed out');
         },
         ping: async () => {
            throw new EndpointTimeoutError('ping timed out');
         },
         timers: {
            setInterval: (_callback, ms) => {
               calls.push(['set', ms]);
               return 77;
            },
            clearInterval: (handle) => calls.push(['clear', handle]),
         },
         log: () => undefined,
      });
      await expect(router.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
      router.dispose();
      expect(calls).toEqual([['set', 5_000], ['clear', 77]]);
   });
});

describe('createRouter tools', () => {
   /**
    * Build a router over a registry whose endpoints each carry one tool named after their socket.
    * @param {Array<[string, string]>} endpoints - `[socketId, kind]` pairs registered in order.
    * @returns {{ router: ReturnType<typeof createRouter>, registry: ReturnType<typeof createEndpointRegistry> }} The
    * router and the registry it routes over.
    */
   function setup(endpoints) {
      const registry = createEndpointRegistry();
      for (const [id, kind] of endpoints) {
         add(registry, id, kind);
         registry.setTools(id, [
            {
               name: `tool_${id}`,
               description: 'A synthetic tool.',
               shape: {},
               signature: id,
            },
         ]);
      }
      const router = createRouter(registry, {
         send: async () => ({ ok: true }),
         ping: async () => undefined,
         log: () => undefined,
      });
      return { router, registry };
   }

   it('lists the tools of the endpoint a call would reach, agents first', () => {
      const { router } = setup([
         [
            'h',
            'human',
         ],
         [
            'a',
            'agent',
         ],
      ]);
      expect(router.tools().map((entry) => entry.name)).toEqual(['tool_a']);
      expect(router.tools({ endpoint: 'human' }).map((entry) => entry.name)).toEqual(['tool_h']);
      expect(router.tools({ endpoint: 'agent' }).map((entry) => entry.name)).toEqual(['tool_a']);
   });

   it('skips an unresponsive endpoint and lists nothing when none is eligible', () => {
      const { router, registry } = setup([
         [
            'h',
            'human',
         ],
         [
            'a',
            'agent',
         ],
      ]);
      registry.setHealth('a', 'unresponsive');
      expect(router.tools().map((entry) => entry.name)).toEqual(['tool_h']);
      registry.setHealth('h', 'unresponsive');
      expect(router.tools()).toEqual([]);
      expect(router.tools({ endpoint: 'agent' })).toEqual([]);
   });

   it('returns a copy, so the caller cannot change the registered tools', () => {
      const { router, registry } = setup([[
         'h',
         'human',
      ]]);
      router.tools().pop();
      expect(registry.get('h').tools).toHaveLength(1);
   });
});

describe('router invokeTool', () => {
   /**
    * Build the registry tool a client would register.
    * @param {string} name - Name the tool registers under.
    * @param {object} [overrides] - Registry entry fields replacing the defaults.
    * @returns {object} The sanitized tool.
    */
   function tool(name, overrides = {}) {
      const outcome = sanitizeRegistry(
         registryPayload([
            script(name, {
               inputSchema: { type: 'object' },
               ...overrides,
            }),
         ]),
         () => undefined,
      );
      return outcome.tools[0];
   }

   /**
    * Build a router over endpoints that registered tools.
    * @param {Array<[string, string, object[]]>} endpoints - Socket id, kind and registered tools of each endpoint.
    * @returns {{ router: ReturnType<typeof createRouter>, registry: ReturnType<typeof createEndpointRegistry>,
    * sent: object[] }} The router, its registry and the payloads it sent.
    */
   function setup(endpoints) {
      const registry = createEndpointRegistry();
      endpoints.forEach(([id, kind, tools]) => {
         add(registry, id, kind);
         registry.setTools(id, tools);
      });
      const sent = [];
      const router = createRouter(registry, {
         send: async (socketId, payload) => {
            sent.push({
               socketId,
               payload,
            });
            return {
               ok: true,
               result: 'ran',
            };
         },
         ping: async () => undefined,
         log: () => undefined,
         newRequestId: () => 'req-1',
      });
      return {
         router,
         registry,
         sent,
      };
   }

   it('runs the tool on the picked endpoint and returns that endpoint\'s declaration with the result', async () => {
      const listed = tool('echo');
      const picked = tool('echo', { result: { budgetBytes: 50 } });
      const { router, sent } = setup([['a', 'agent', [picked]]]);
      const outcome = await router.invokeTool('echo', { text: 'hi' }, { listed });
      expect(outcome.result).toBe('ran');
      expect(outcome.tool).toBe(picked);
      expect(sent).toEqual([
         {
            socketId: 'a',
            payload: {
               op: OP_CALL_TOOL,
               params: {
                  name: 'echo',
                  arguments: { text: 'hi' },
               },
               requestId: 'req-1',
            },
         },
      ]);
   });

   it('fails with TOOL_GONE, sending nothing, when the picked endpoint does not register the name', async () => {
      const { router, sent } = setup([['a', 'agent', [tool('other')]]]);
      await expect(router.invokeTool('echo', {}, { listed: tool('echo') })).rejects.toMatchObject({
         name: 'BridgeError',
         code: TOOL_GONE,
      });
      expect(sent).toEqual([]);
   });

   it('denies, sending nothing, when the picked endpoint declares a different gate than the listed tool', async () => {
      const listed = tool('writer', { gate: 'allowUserWrites' });
      const { router, registry, sent } = setup([['a', 'agent', [tool('writer')]]]);
      registry.setGateState('a', {
         ...closedGateState(),
         allowUserWrites: true,
      });
      await expect(router.invokeTool('writer', {}, { listed })).rejects.toMatchObject({ code: GATE_DENIED });
      expect(sent).toEqual([]);
   });

   it('denies when the picked endpoint declares a gate the listed tool did not', async () => {
      const listed = tool('writer');
      const { router, sent } = setup([['a', 'agent', [tool('writer', { gate: 'allowUserWrites' })]]]);
      await expect(router.invokeTool('writer', {}, { listed })).rejects.toMatchObject({ code: GATE_DENIED });
      expect(sent).toEqual([]);
   });

   it('judges the shared gate on the snapshot of the picked endpoint only', async () => {
      const gated = tool('writer', { gate: 'allowUserWrites' });
      const { router, registry, sent } = setup([
         ['h', 'human', [gated]],
         ['a', 'agent', [gated]],
      ]);
      registry.setGateState('h', {
         ...closedGateState(),
         allowUserWrites: true,
      });
      await expect(router.invokeTool('writer', {}, { listed: gated })).rejects.toMatchObject({ code: GATE_DENIED });
      registry.setGateState('a', {
         ...closedGateState(),
         allowUserWrites: true,
      });
      await router.invokeTool('writer', {}, { listed: gated });
      expect(sent.map((entry) => entry.socketId)).toEqual(['a']);
   });

   it('restricts the pick to the endpoint kind and does not fall back', async () => {
      const listed = tool('echo');
      const { router, sent } = setup([['a', 'agent', [listed]]]);
      await expect(router.invokeTool('echo', {}, {
         endpoint: 'human',
         listed,
      })).rejects.toMatchObject({ code: NO_ENDPOINT });
      expect(sent).toEqual([]);
   });

   it('refuses the call, sending nothing, when the picked endpoint declares other arguments for the name', async () => {
      const listed = tool('echo');
      const other = tool('echo', {
         inputSchema: {
            type: 'object',
            properties: { count: { type: 'integer' } },
         },
      });
      const { router, sent } = setup([['a', 'agent', [other]]]);
      await expect(router.invokeTool('echo', {}, { listed })).rejects.toMatchObject({ code: TOOL_GONE });
      expect(sent).toEqual([]);
   });

   it('runs the call when only the description or the result budget differs', async () => {
      const listed = tool('echo');
      const picked = tool('echo', {
         description: 'Another description.',
         result: { budgetBytes: 50 },
      });
      const { router, sent } = setup([['a', 'agent', [picked]]]);
      await router.invokeTool('echo', {}, { listed });
      expect(sent).toHaveLength(1);
   });

   it('routes a dom script to the agent endpoint, not to the first healthy endpoint of the route order', async () => {
      const listed = tool('shot', { requires: 'dom' });
      const { router, sent } = setup([
         ['h', 'human', [listed]],
         ['a', 'agent', [listed]],
      ]);
      await router.invokeTool('shot', {}, { listed });
      expect(sent.map((entry) => entry.socketId)).toEqual(['a']);
   });

   it('does not fall back from the agent to a human tab for a dom script', async () => {
      const listed = tool('shot', { requires: 'dom' });
      const { router, sent } = setup([['h', 'human', [listed]]]);
      await expect(router.invokeTool('shot', {}, { listed })).rejects.toMatchObject({
         name: 'BridgeError',
         code: NO_ENDPOINT,
      });
      expect(sent).toEqual([]);
   });

   it('still falls back from the agent to a human tab for an api script', async () => {
      const listed = tool('reader', { requires: 'api' });
      const { router, sent } = setup([['h', 'human', [listed]]]);
      await router.invokeTool('reader', {}, { listed });
      expect(sent.map((entry) => entry.socketId)).toEqual(['h']);
   });

   it('names the missing endpoint kind in an error of at most 256 bytes', async () => {
      const listed = tool('shot', { requires: 'dom' });
      const { router } = setup([['h', 'human', [listed]]]);
      const error = await router.invokeTool('shot', {}, { listed }).catch((cause) => cause);
      expect(error.message).toContain("'agent'");
      expect(error.message).toContain('DOM');
      expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(256);
      const named = await router.invokeTool('shot', {}, {
         endpoint: 'agent',
         listed,
      }).catch((cause) => cause);
      expect(named.message).toContain("'agent'");
   });

   it('refuses a dom script when the only agent endpoint cannot run DOM scripts', async () => {
      const listed = tool('shot', { requires: 'dom' });
      const { router, registry, sent } = setup([]);
      add(registry, 'a', 'agent', false);
      registry.setTools('a', [listed]);
      await expect(router.invokeTool('shot', {}, { listed })).rejects.toMatchObject({ code: NO_ENDPOINT });
      expect(sent).toEqual([]);
   });

   it('skips an agent endpoint without DOM and uses a later one that has it', async () => {
      const listed = tool('shot', { requires: 'dom' });
      const { router, registry, sent } = setup([]);
      add(registry, 'a1', 'agent', false);
      registry.setTools('a1', [listed]);
      add(registry, 'a2', 'agent', true);
      registry.setTools('a2', [listed]);
      await router.invokeTool('shot', {}, { listed });
      expect(sent.map((entry) => entry.socketId)).toEqual(['a2']);
   });

   it('routes a dom script to a human tab only when the session restricts the kind to human', async () => {
      const listed = tool('shot', { requires: 'dom' });
      const { router, sent } = setup([
         ['h', 'human', [listed]],
         ['a', 'agent', [listed]],
      ]);
      await router.invokeTool('shot', {}, {
         endpoint: 'human',
         listed,
      });
      expect(sent.map((entry) => entry.socketId)).toEqual(['h']);
   });

   it('refuses a dom script on a restricted human kind whose tabs cannot run DOM scripts', async () => {
      const listed = tool('shot', { requires: 'dom' });
      const { router, registry, sent } = setup([]);
      add(registry, 'h', 'human', false);
      registry.setTools('h', [listed]);
      const error = await router.invokeTool('shot', {}, {
         endpoint: 'human',
         listed,
      }).catch((cause) => cause);
      expect(error.code).toBe(NO_ENDPOINT);
      expect(error.message).toContain("'human'");
      expect(sent).toEqual([]);
   });

   it('reports ENDPOINT_UNAVAILABLE for a dom script whose only DOM agent is unresponsive', async () => {
      const listed = tool('shot', { requires: 'dom' });
      const { router, registry, sent } = setup([['a', 'agent', [listed]]]);
      registry.setHealth('a', 'unresponsive');
      await expect(router.invokeTool('shot', {}, { listed })).rejects.toMatchObject({ code: ENDPOINT_UNAVAILABLE });
      expect(sent).toEqual([]);
   });

   it('reports NO_ENDPOINT, not unavailable, when the unresponsive agent has no DOM anyway', async () => {
      const listed = tool('shot', { requires: 'dom' });
      const { router, registry } = setup([]);
      add(registry, 'a', 'agent', false);
      registry.setTools('a', [listed]);
      registry.setHealth('a', 'unresponsive');
      await expect(router.invokeTool('shot', {}, { listed })).rejects.toMatchObject({ code: NO_ENDPOINT });
   });

   it('refuses the call when the picked endpoint declares another requires for the name', async () => {
      const listed = tool('shot', { requires: 'api' });
      const { router, sent } = setup([['a', 'agent', [tool('shot', { requires: 'dom' })]]]);
      await expect(router.invokeTool('shot', {}, { listed })).rejects.toMatchObject({ code: TOOL_GONE });
      expect(sent).toEqual([]);
   });

   it('refuses the call when the picked endpoint declares another mutates for the name', async () => {
      const listed = tool('shot', { mutates: false });
      const { router, sent } = setup([['a', 'agent', [tool('shot', { mutates: true })]]]);
      await expect(router.invokeTool('shot', {}, { listed })).rejects.toMatchObject({ code: TOOL_GONE });
      expect(sent).toEqual([]);
   });
});
