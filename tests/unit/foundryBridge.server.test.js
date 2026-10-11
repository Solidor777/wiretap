// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createFoundryBridge } from '../../server/foundryBridge.ts';
import { MAX_ENDPOINTS } from '../../server/endpoints.ts';
import {
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
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
 * Build a fake Socket.IO server socket whose ack-emit is controllable, recording emitted events.
 * @param {string} id - The id the fake socket reports.
 * @param {(payload: object) => *} ackResponder - Maps the emitted payload to the ack response (or 'timeout').
 * @returns {object} The fake socket, a `fire` helper to trigger registered handlers, and the `emitted` log.
 */
function makeSocket(id, ackResponder = () => ({ ok: true, result: {} })) {
   const handlers = {};
   const emitted = [];
   const socket = {
      id,
      on: (event, fn) => {
         handlers[event] = fn;
      },
      timeout: (ms) => ({
         emit: (event, payload, ack) => {
            emitted.push({ event, payload, timeoutMs: ms });
            const response = ackResponder(payload);
            if (response === 'timeout') {
               ack(new Error('timed out'));
            } else if (response === 'timer') {
               setTimeout(() => ack(new Error('timed out')), ms);
            } else if (response === 'hang') {
               return;
            } else if (response === 'throw') {
               throw new Error('write after end');
            } else {
               ack(null, response);
            }
         },
      }),
   };
   const fire = (event, ...args) => handlers[event]?.(...args);
   return { socket, fire, emitted };
}

/**
 * Build a valid v2 identify payload.
 * @param {object} [overrides] - Fields replacing the defaults.
 * @returns {object} The payload.
 */
function identify(overrides = {}) {
   return {
      protocolVersion: PROTOCOL_VERSION,
      userId: 'u',
      userName: 'GM',
      isGM: true,
      kind: 'human',
      dom: true,
      ...overrides,
   };
}

/**
 * Create a bridge with a silent logger that records log lines.
 * @param {() => number} [now] - The clock the refusal-log throttle reads (default: the real clock).
 * @returns {{ bridge: ReturnType<typeof createFoundryBridge>, lines: string[] }} The bridge and the log.
 */
function makeBridge(now) {
   const lines = [];
   return { bridge: createFoundryBridge({ log: (line) => lines.push(line), now }), lines };
}

describe('createFoundryBridge identify', () => {
   it('acks { ok: true } after registering a valid v2 GM identify', async () => {
      const { bridge } = makeBridge();
      const { socket, fire } = makeSocket('a');
      bridge.handleConnection(socket);
      const acks = [];
      fire(BRIDGE_IDENTIFY, identify(), (ack) => acks.push(ack));
      expect(acks).toEqual([{ ok: true }]);
      await expect(bridge.invoke(OP_CREATE_ACTOR, {})).resolves.toEqual({});
   });

   it('registers before acking (a call made inside the ack callback is routed)', async () => {
      const { bridge } = makeBridge();
      const { socket, fire } = makeSocket('a', () => ({ ok: true, result: { uuid: 'Actor.x' } }));
      bridge.handleConnection(socket);
      /** @type {Promise<unknown>} The invocation started from inside the ack. */
      let invoked;
      fire(BRIDGE_IDENTIFY, identify(), () => {
         invoked = bridge.invoke(OP_CREATE_ACTOR, {});
      });
      await expect(invoked).resolves.toEqual({ uuid: 'Actor.x' });
   });

   it('refuses a v1 payload with PROTOCOL_MISMATCH, logs it, and does not register', async () => {
      const { bridge, lines } = makeBridge();
      const { socket, fire } = makeSocket('a');
      bridge.handleConnection(socket);
      const acks = [];
      fire(BRIDGE_IDENTIFY, { userId: 'u', userName: 'GM', isGM: true }, (ack) => acks.push(ack));
      expect(acks[0].ok).toBe(false);
      expect(acks[0].error.code).toBe(PROTOCOL_MISMATCH);
      expect(lines.some((line) => line.startsWith('Wiretap sidecar | refused identify'))).toBe(true);
      await expect(bridge.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({ code: NO_ENDPOINT });
   });

   it('refuses a non-GM with NOT_GM and does not register', async () => {
      const { bridge, lines } = makeBridge();
      const { socket, fire } = makeSocket('a');
      bridge.handleConnection(socket);
      const acks = [];
      fire(BRIDGE_IDENTIFY, identify({ isGM: false }), (ack) => acks.push(ack));
      expect(acks[0]).toMatchObject({ ok: false, error: { code: NOT_GM } });
      expect(lines.some((line) => line.startsWith('Wiretap sidecar | refused identify'))).toBe(true);
      await expect(bridge.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({ code: NO_ENDPOINT });
   });

   it('tolerates an identify with no ack callback', () => {
      const { bridge } = makeBridge();
      const { socket, fire } = makeSocket('a');
      bridge.handleConnection(socket);
      expect(() => fire(BRIDGE_IDENTIFY, identify())).not.toThrow();
      expect(() => fire(BRIDGE_IDENTIFY, { userId: 'u' })).not.toThrow();
   });

   it('drops an existing registration when the same socket re-identifies as a non-GM', async () => {
      const { bridge } = makeBridge();
      const { socket, fire } = makeSocket('a');
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, identify(), () => undefined);
      fire(BRIDGE_IDENTIFY, identify({ isGM: false }), () => undefined);
      await expect(bridge.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({ code: NO_ENDPOINT });
   });

   it('refuses an identify beyond the endpoint limit with ENDPOINT_LIMIT', async () => {
      const { bridge, lines } = makeBridge();
      for (let i = 0; i < MAX_ENDPOINTS; i++) {
         const { socket, fire } = makeSocket(`s${i}`);
         bridge.handleConnection(socket);
         fire(BRIDGE_IDENTIFY, identify({ userId: `u${i}` }), () => undefined);
      }
      const extra = makeSocket('extra');
      bridge.handleConnection(extra.socket);
      const acks = [];
      extra.fire(BRIDGE_IDENTIFY, identify(), (ack) => acks.push(ack));
      expect(acks[0]).toMatchObject({ ok: false, error: { code: ENDPOINT_LIMIT } });
      expect(lines.some((line) => line.includes('refused identify') && line.includes(ENDPOINT_LIMIT))).toBe(true);
   });

   it('refuses an over-long userId with PROTOCOL_MISMATCH', () => {
      const { bridge } = makeBridge();
      const { socket, fire } = makeSocket('a');
      bridge.handleConnection(socket);
      const acks = [];
      fire(BRIDGE_IDENTIFY, identify({ userId: 'u'.repeat(65) }), (ack) => acks.push(ack));
      expect(acks[0]).toMatchObject({ ok: false, error: { code: PROTOCOL_MISMATCH } });
   });

   it('logs at most 10 refused identifies per minute in total, across sockets, and resumes after the window', () => {
      /** @type {number} The injected clock reading in milliseconds. */
      let clock = 1_000_000;
      const { bridge, lines } = makeBridge(() => clock);
      const refusedLines = () => lines.filter((line) => line.startsWith('Wiretap sidecar | refused identify'));
      for (let i = 0; i < 25; i++) {
         const { socket, fire } = makeSocket(`s${i}`);
         bridge.handleConnection(socket);
         fire(BRIDGE_IDENTIFY, identify({ isGM: false }), () => undefined);
      }
      expect(refusedLines()).toHaveLength(10);
      clock += 59_000;
      const late = makeSocket('late');
      bridge.handleConnection(late.socket);
      late.fire(BRIDGE_IDENTIFY, identify({ isGM: false }), () => undefined);
      expect(refusedLines()).toHaveLength(10);
      clock += 2_000;
      late.fire(BRIDGE_IDENTIFY, identify({ isGM: false }), () => undefined);
      expect(refusedLines()).toHaveLength(11);
      // 15 of the first 25 and the one at 59 s were dropped; one summary line reports them.
      expect(lines.filter((line) => line.includes('suppressed'))).toEqual([
         'Wiretap sidecar | 16 further identify refusals suppressed',
      ]);
   });

   it('still acks every refused identify when its log line is throttled', () => {
      const { bridge } = makeBridge(() => 0);
      const acks = [];
      for (let i = 0; i < 15; i++) {
         const { socket, fire } = makeSocket(`s${i}`);
         bridge.handleConnection(socket);
         fire(BRIDGE_IDENTIFY, identify({ isGM: false }), (ack) => acks.push(ack));
      }
      expect(acks).toHaveLength(15);
      expect(acks.every((ack) => ack.ok === false)).toBe(true);
   });

   it('deregisters on disconnect', async () => {
      const { bridge } = makeBridge();
      const { socket, fire } = makeSocket('a');
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, identify(), () => undefined);
      fire('disconnect');
      await expect(bridge.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({ code: NO_ENDPOINT });
   });
});

describe('createFoundryBridge invoke', () => {
   it('emits BRIDGE_INVOKE with { op, params, requestId }', async () => {
      const { bridge } = makeBridge();
      const { socket, fire, emitted } = makeSocket('a', () => ({ ok: true, result: { uuid: 'Actor.x' } }));
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, identify(), () => undefined);
      await expect(bridge.invoke(OP_CREATE_ACTOR, { name: 'Bob' })).resolves.toEqual({ uuid: 'Actor.x' });
      expect(emitted[0].event).toBe(BRIDGE_INVOKE);
      expect(emitted[0].payload).toEqual({
         op: OP_CREATE_ACTOR,
         params: { name: 'Bob' },
         requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
   });

   it('rejects with a normalized OP_FAILED error when the client acks ok:false', async () => {
      const { bridge } = makeBridge();
      const { socket, fire } = makeSocket('a', () => ({ ok: false, error: { message: 'Unknown actor type' } }));
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, identify(), () => undefined);
      await expect(bridge.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({
         code: OP_FAILED,
         message: 'Unknown actor type',
      });
   });

   it('rejects with ENDPOINT_TIMEOUT on ack timeout', async () => {
      const { bridge } = makeBridge();
      const { socket, fire } = makeSocket('a', () => 'timeout');
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, identify(), () => undefined);
      await expect(bridge.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({ code: ENDPOINT_TIMEOUT });
   });

   it('keeps servicing invocations when one of several endpoints disconnects', async () => {
      const { bridge } = makeBridge();
      const first = makeSocket('a', () => ({ ok: true, result: { uuid: 'Actor.first' } }));
      const second = makeSocket('b', () => ({ ok: true, result: { uuid: 'Actor.second' } }));
      bridge.handleConnection(first.socket);
      bridge.handleConnection(second.socket);
      first.fire(BRIDGE_IDENTIFY, identify({ userId: 'u1' }), () => undefined);
      second.fire(BRIDGE_IDENTIFY, identify({ userId: 'u2' }), () => undefined);
      first.fire('disconnect');
      await expect(bridge.invoke(OP_CREATE_ACTOR, {})).resolves.toEqual({ uuid: 'Actor.second' });
   });

   it('logs the same requestId the endpoint receives', async () => {
      const { bridge, lines } = makeBridge();
      const { socket, fire, emitted } = makeSocket('a', () => ({ ok: true, result: {} }));
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, identify(), () => undefined);
      await bridge.invoke(OP_CREATE_ACTOR, {});
      expect(lines.some((line) => line.includes(emitted[0].payload.requestId))).toBe(true);
   });

   it('keeps servicing an in-flight invoke when its socket identifies again as another kind', async () => {
      const { bridge } = makeBridge();
      /** @type {(ack: unknown) => void} Completes the pending client ack. */
      let complete;
      const { socket, fire } = makeSocket('a');
      socket.timeout = () => ({
         emit: (_event, _payload, ack) => {
            complete = (response) => ack(null, response);
         },
      });
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, identify({ kind: 'human' }), () => undefined);
      const pending = bridge.invoke(OP_CREATE_ACTOR, {});
      fire(BRIDGE_IDENTIFY, identify({ kind: 'agent' }), () => undefined);
      complete({ ok: true, result: { uuid: 'Actor.late' } });
      await expect(pending).resolves.toEqual({ uuid: 'Actor.late' });
      socket.timeout = makeSocket('b', () => ({ ok: true, result: { uuid: 'Actor.next' } })).socket.timeout;
      await expect(bridge.invoke(OP_CREATE_ACTOR, {}, { endpoint: 'agent' })).resolves.toEqual({
         uuid: 'Actor.next',
      });
   });

   it('rejects a pending invoke with ENDPOINT_GONE as soon as its endpoint disconnects', async () => {
      const { bridge, lines } = makeBridge();
      const { socket, fire } = makeSocket('a', () => 'hang');
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, identify(), () => undefined);
      const pending = bridge.invoke(OP_CREATE_ACTOR, {}).catch((error) => error);
      fire('disconnect');
      await expect(pending).resolves.toMatchObject({ code: ENDPOINT_GONE });
      expect(lines.some((line) => line.includes('disconnected'))).toBe(true);
   });

   it('rejects with ENDPOINT_GONE, not ENDPOINT_TIMEOUT, when writing to the socket throws', async () => {
      const { bridge, lines } = makeBridge();
      const { socket, fire } = makeSocket('a', () => 'throw');
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, identify(), () => undefined);
      await expect(bridge.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({ code: ENDPOINT_GONE });
      expect(lines.some((line) => line.includes('write after end'))).toBe(true);
   });

   describe('with fake timers', () => {
      afterEach(() => {
         vi.useRealTimers();
      });

      it('rejects with ENDPOINT_TIMEOUT only after the 10 second ack window elapses', async () => {
         vi.useFakeTimers();
         const { bridge } = makeBridge();
         const { socket, fire, emitted } = makeSocket('a', () => 'timer');
         bridge.handleConnection(socket);
         fire(BRIDGE_IDENTIFY, identify(), () => undefined);
         /** @type {unknown} The settled outcome of the invoke, once it settles. */
         let outcome;
         const pending = bridge.invoke(OP_CREATE_ACTOR, {}).catch((error) => {
            outcome = error;
         });
         expect(emitted[0].timeoutMs).toBe(10_000);
         await vi.advanceTimersByTimeAsync(9_999);
         expect(outcome).toBeUndefined();
         await vi.advanceTimersByTimeAsync(1);
         await pending;
         expect(outcome).toMatchObject({ code: ENDPOINT_TIMEOUT });
      });
   });

   it.each([
      ['a null ack', null],
      ['an ok:false ack with an array error', { ok: false, error: ['x'] }],
      ['an ok:false ack with a numeric message', { ok: false, error: { message: 7 } }],
      ['an ok:false ack with non-array failures', { ok: false, error: { message: 'm', failures: 'x' } }],
   ])('turns %s into an OP_FAILED rejection', async (_label, ack) => {
      const { bridge } = makeBridge();
      const { socket, fire } = makeSocket('a', () => ack);
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, identify(), () => undefined);
      await expect(bridge.invoke(OP_CREATE_ACTOR, {})).rejects.toMatchObject({ code: OP_FAILED });
   });

   it('routes to the agent endpoint first and honours the endpoint override without fallback', async () => {
      const { bridge } = makeBridge();
      const human = makeSocket('h', () => ({ ok: true, result: { who: 'human' } }));
      const agent = makeSocket('a', () => ({ ok: true, result: { who: 'agent' } }));
      bridge.handleConnection(human.socket);
      bridge.handleConnection(agent.socket);
      human.fire(BRIDGE_IDENTIFY, identify({ kind: 'human' }), () => undefined);
      await expect(bridge.invoke(OP_CREATE_ACTOR, {}, { endpoint: 'agent' })).rejects.toMatchObject({
         code: NO_ENDPOINT,
      });
      agent.fire(BRIDGE_IDENTIFY, identify({ kind: 'agent' }), () => undefined);
      await expect(bridge.invoke(OP_CREATE_ACTOR, {})).resolves.toEqual({ who: 'agent' });
      await expect(bridge.invoke(OP_CREATE_ACTOR, {}, { endpoint: 'human' })).resolves.toEqual({ who: 'human' });
   });
});
