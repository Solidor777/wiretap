// @vitest-environment node
import { describe, it, expect } from 'vitest';
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
   truncateUtf8,
   validateIdentify,
} from '../../server/endpoints.ts';
import {
   ENDPOINT_GONE,
   ENDPOINT_LIMIT,
   ENDPOINT_TIMEOUT,
   NOT_GM,
   NO_ENDPOINT,
   OP_CREATE_ACTOR,
   OP_FAILED,
   PROTOCOL_MISMATCH,
   PROTOCOL_VERSION,
} from '$shared/protocol.js';

/**
 * Build a valid v2 identify payload.
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
 * @returns {void}
 */
function add(registry, socketId, kind) {
   registry.register(socketId, validateIdentify(identify({ userId: socketId, kind })).identity);
}

describe('createEndpointRegistry', () => {
   it('adds an endpoint with its identity and a registration time', () => {
      const registry = createEndpointRegistry(() => 1234);
      add(registry, 's1', 'agent');
      expect(registry.list()).toEqual([
         { socketId: 's1', userId: 's1', userName: 'GM', kind: 'agent', dom: true, registeredAt: 1234 },
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
   it('accepts a valid v2 GM payload', () => {
      expect(validateIdentify(identify())).toEqual({
         ok: true,
         identity: { userId: 'u1', userName: 'GM', kind: 'human', dom: true },
      });
   });

   it('refuses a v1 payload without protocolVersion as PROTOCOL_MISMATCH', () => {
      const result = validateIdentify({ userId: 'u', userName: 'GM', isGM: true });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe(PROTOCOL_MISMATCH);
      expect(result.error.message).toMatch(/reload/i);
   });

   it('refuses a wrong protocolVersion', () => {
      expect(validateIdentify(identify({ protocolVersion: 3 })).error.code).toBe(PROTOCOL_MISMATCH);
   });

   it('refuses a non-object payload', () => {
      expect(validateIdentify(undefined).error.code).toBe(PROTOCOL_MISMATCH);
      expect(validateIdentify('x').error.code).toBe(PROTOCOL_MISMATCH);
   });

   it('refuses a v2 payload with a malformed field as PROTOCOL_MISMATCH', () => {
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

   it('keeps a client-supplied code', () => {
      expect(normalizeAckError({ ok: false, error: { code: 'INVALID_TYPE', message: 'm' } }).code).toBe('INVALID_TYPE');
   });

   it.each([NO_ENDPOINT, ENDPOINT_TIMEOUT, ENDPOINT_GONE, ENDPOINT_LIMIT, PROTOCOL_MISMATCH, NOT_GM])(
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
         log: () => undefined,
         newRequestId: () => 'req-1',
      });
      return { router, registry, sent };
   }

   it('exports the default order as one constant', () => {
      expect(ROUTE_ORDER).toEqual(['agent', 'human']);
   });

   it('prefers an agent endpoint over an earlier human endpoint', async () => {
      const { router, sent } = setup([['h', 'human'], ['a', 'agent']]);
      await router.invoke(OP_CREATE_ACTOR, { name: 'Bob' });
      expect(sent[0].socketId).toBe('a');
   });

   it('falls back to a human endpoint when no agent is registered', async () => {
      const { router, sent } = setup([['h', 'human']]);
      await router.invoke(OP_CREATE_ACTOR, {});
      expect(sent[0].socketId).toBe('h');
   });

   it('uses insertion order between endpoints of the same kind', async () => {
      const { router, sent } = setup([['a1', 'agent'], ['a2', 'agent']]);
      await router.invoke(OP_CREATE_ACTOR, {});
      expect(sent[0].socketId).toBe('a1');
   });

   it('sends { op, params, requestId } and resolves with the ack result', async () => {
      const { router, sent } = setup([['h', 'human']]);
      await expect(router.invoke(OP_CREATE_ACTOR, { name: 'Bob' })).resolves.toEqual({ done: true });
      expect(sent[0].payload).toEqual({ op: OP_CREATE_ACTOR, params: { name: 'Bob' }, requestId: 'req-1' });
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
      await expect(router.invoke(OP_CREATE_ACTOR, {}, { endpoint: 'agent' })).rejects.toMatchObject({
         code: NO_ENDPOINT,
      });
      expect(sent).toEqual([]);
   });

   it('routes an override to the requested kind even when the other kind is preferred', async () => {
      const { router, sent } = setup([['a', 'agent'], ['h', 'human']]);
      await router.invoke(OP_CREATE_ACTOR, {}, { endpoint: 'human' });
      expect(sent[0].socketId).toBe('h');
   });

   it('rejects with NO_ENDPOINT, within 256 bytes, naming the fix, when nothing is registered', async () => {
      const { router } = setup([]);
      const err = await router.invoke(OP_CREATE_ACTOR, {}).catch((e) => e);
      expect(err).toBeInstanceOf(BridgeError);
      expect(err.code).toBe(NO_ENDPOINT);
      expect(Buffer.byteLength(err.message, 'utf8')).toBeLessThanOrEqual(256);
      expect(err.message).toMatch(/GM tab/);
      expect(err.message).toMatch(/agent/);
   });

   it('keeps the NO_ENDPOINT message within 256 bytes for an override', async () => {
      const { router } = setup([]);
      const err = await router.invoke(OP_CREATE_ACTOR, {}, { endpoint: 'agent' }).catch((e) => e);
      expect(Buffer.byteLength(err.message, 'utf8')).toBeLessThanOrEqual(256);
   });

   it('maps an EndpointTimeoutError from the transport to ENDPOINT_TIMEOUT', async () => {
      const { router } = setup([['h', 'human']], async () => {
         throw new EndpointTimeoutError('operation has timed out');
      });
      await expect(router.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
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
      await expect(router.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({ code: ENDPOINT_GONE });
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
      await expect(router.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({ code: ENDPOINT_GONE });
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
      await expect(router.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({ code: ENDPOINT_GONE });
      expect(lines.some((line) => line.includes('req-2') && line.includes('socket disconnected'))).toBe(true);
   });

   it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'ok'],
   ])('rejects with OP_FAILED when the ack is %s', async (_label, ack) => {
      const { router } = setup([['h', 'human']], async () => ack);
      await expect(router.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({ code: OP_FAILED });
   });

   it('resolves undefined for an ok:true ack without a result (the caller validates the result)', async () => {
      const { router } = setup([['h', 'human']], async () => ({ ok: true }));
      await expect(router.invoke(OP_CREATE_ACTOR, {})).resolves.toBeUndefined();
   });

   it('rejects with a normalized BridgeError when the client acks ok:false', async () => {
      const { router } = setup([['h', 'human']], async () => ({ ok: false, error: { message: 'Unknown type' } }));
      await expect(router.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({
         code: OP_FAILED,
         message: 'Unknown type',
      });
   });

   it('stops routing to an endpoint once it is removed from the registry', async () => {
      const { router, registry, sent } = setup([['a', 'agent'], ['h', 'human']]);
      registry.remove('a');
      await router.invoke(OP_CREATE_ACTOR, {});
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
