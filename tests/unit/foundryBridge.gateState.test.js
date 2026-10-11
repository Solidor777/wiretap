// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createFoundryBridge } from '../../server/foundryBridge.ts';
import { closedGateState } from '../../shared/gates.js';
import {
   BRIDGE_GATE_STATE,
   BRIDGE_IDENTIFY,
   GATE_DENIED,
   NOT_GM,
   OP_CREATE_ACTOR,
   OP_FAILED,
   PROTOCOL_VERSION,
} from '../../shared/protocol.js';

/**
 * Build a fake Socket.IO server socket that records its registered handlers.
 * @param {string} id - The id the fake socket reports.
 * @returns {{ socket: object, fire: Function, emitted: object[] }} The socket, a trigger and the emitted events.
 */
function makeSocket(id) {
   /** @type {Record<string, Function>} Handlers registered through `socket.on`. */
   const handlers = {};
   /** @type {object[]} Events emitted to this socket. */
   const emitted = [];
   return {
      socket: {
         id,
         on: (event, fn) => {
            handlers[event] = fn;
         },
         timeout: () => ({
            emit: (event, payload, ack) => {
               emitted.push({ event, payload });
               ack(null, { ok: true, result: { from: id } });
            },
         }),
      },
      fire: (event, ...args) => handlers[event]?.(...args),
      emitted,
   };
}

/**
 * Build a valid identify payload.
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
 * Create a bridge with a recording logger.
 * @param {() => number} [now] - The clock the log throttles read.
 * @returns {{ bridge: ReturnType<typeof createFoundryBridge>, lines: string[] }} The bridge and the log.
 */
function makeBridge(now) {
   /** @type {string[]} Recorded log lines. */
   const lines = [];
   return { bridge: createFoundryBridge({ log: (line) => lines.push(line), now }), lines };
}

/**
 * Connect a fake socket and identify it as a GM endpoint.
 * @param {ReturnType<typeof createFoundryBridge>} bridge - The bridge that receives the connection.
 * @param {string} id - The socket id.
 * @param {object} [overrides] - Identify overrides.
 * @returns {{ socket: object, fire: Function }} The registered fake socket.
 */
function register(bridge, id, overrides = {}) {
   const fake = makeSocket(id);
   bridge.handleConnection(fake.socket);
   fake.fire(BRIDGE_IDENTIFY, identify(overrides), () => undefined);
   return fake;
}

describe('createFoundryBridge gate state', () => {
   it('reports every gate closed when nothing is registered', () => {
      const { bridge } = makeBridge();
      expect(bridge.gateState()).toEqual(closedGateState());
   });

   it('reports every gate closed for an endpoint whose identify carried no snapshot', () => {
      const { bridge } = makeBridge();
      register(bridge, 'a');
      expect(bridge.gateState()).toEqual(closedGateState());
   });

   it('stores the sanitized snapshot of the identify', () => {
      const { bridge } = makeBridge();
      register(bridge, 'a', { gateState: { allowMacroExecution: true, junk: 1 } });
      expect(bridge.gateState()).toEqual({ ...closedGateState(), allowMacroExecution: true });
   });

   it('replaces the snapshot with the one of a repeated identify, closing it when the new identify has none', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a', { gateState: { allowMacroExecution: true } });
      fake.fire(BRIDGE_IDENTIFY, identify(), () => undefined);
      expect(bridge.gateState()).toEqual(closedGateState());
   });

   it('applies a snapshot sent by a registered endpoint and acks ok', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a');
      const acks = [];
      fake.fire(BRIDGE_GATE_STATE, { allowUserWrites: true }, (ack) => acks.push(ack));
      expect(acks).toEqual([{ ok: true }]);
      expect(bridge.gateState().allowUserWrites).toBe(true);
   });

   it('tolerates a missing ack callback', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a');
      expect(() => fake.fire(BRIDGE_GATE_STATE, { allowUserWrites: true })).not.toThrow();
      expect(bridge.gateState().allowUserWrites).toBe(true);
   });

   it('closes every gate when a registered endpoint sends a non-object snapshot', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a', { gateState: { allowMacroExecution: true } });
      const acks = [];
      fake.fire(BRIDGE_GATE_STATE, 'open', (ack) => acks.push(ack));
      expect(acks).toEqual([{ ok: true }]);
      expect(bridge.gateState()).toEqual(closedGateState());
   });

   it('refuses a snapshot from a socket that never identified and leaves every snapshot unchanged', () => {
      const { bridge, lines } = makeBridge();
      register(bridge, 'gm', { gateState: { allowFileUpload: true } });
      const stranger = makeSocket('stranger');
      bridge.handleConnection(stranger.socket);
      const acks = [];
      stranger.fire(BRIDGE_GATE_STATE, { allowMacroExecution: true }, (ack) => acks.push(ack));
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({ ok: false, error: { code: NOT_GM } });
      expect(bridge.gateState()).toEqual({ ...closedGateState(), allowFileUpload: true });
      expect(lines.some((line) => line.includes('refused gate state from stranger') && line.includes(NOT_GM))).toBe(
         true,
      );
   });

   it('refuses a snapshot from a socket whose identify was refused as non-GM', () => {
      const { bridge } = makeBridge();
      const fake = makeSocket('player');
      bridge.handleConnection(fake.socket);
      fake.fire(BRIDGE_IDENTIFY, identify({ isGM: false }), () => undefined);
      const acks = [];
      fake.fire(BRIDGE_GATE_STATE, { allowMacroExecution: true }, (ack) => acks.push(ack));
      expect(acks[0]).toMatchObject({ ok: false, error: { code: NOT_GM } });
      expect(bridge.gateState()).toEqual(closedGateState());
   });

   it('refuses a snapshot from a socket that disconnected', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a');
      fake.fire('disconnect');
      const acks = [];
      fake.fire(BRIDGE_GATE_STATE, { allowMacroExecution: true }, (ack) => acks.push(ack));
      expect(acks[0]).toMatchObject({ ok: false, error: { code: NOT_GM } });
      expect(bridge.gateState()).toEqual(closedGateState());
   });

   it('tolerates a missing ack callback on a refused snapshot', () => {
      const { bridge } = makeBridge();
      const stranger = makeSocket('stranger');
      bridge.handleConnection(stranger.socket);
      expect(() => stranger.fire(BRIDGE_GATE_STATE, {})).not.toThrow();
   });

   it('keeps one snapshot per endpoint', () => {
      const { bridge } = makeBridge();
      const human = register(bridge, 'h', { kind: 'human', userId: 'uh' });
      register(bridge, 'a', { kind: 'agent', userId: 'ua', gateState: { allowMacroExecution: true } });
      human.fire(BRIDGE_GATE_STATE, { allowUserWrites: true }, () => undefined);
      expect(bridge.gateState({ endpoint: 'agent' })).toEqual({ ...closedGateState(), allowMacroExecution: true });
      expect(bridge.gateState({ endpoint: 'human' })).toEqual({ ...closedGateState(), allowUserWrites: true });
      expect(bridge.gateState()).toEqual({ ...closedGateState(), allowMacroExecution: true });
   });

   it('throttles the refused-snapshot log to 10 per minute and still acks every refusal', () => {
      /** @type {number} The injected clock reading in milliseconds. */
      let clock = 5_000_000;
      const { bridge, lines } = makeBridge(() => clock);
      const acks = [];
      for (let i = 0; i < 25; i++) {
         const fake = makeSocket(`s${i}`);
         bridge.handleConnection(fake.socket);
         fake.fire(BRIDGE_GATE_STATE, {}, (ack) => acks.push(ack));
      }
      expect(acks).toHaveLength(25);
      expect(lines.filter((line) => line.startsWith('Wiretap sidecar | refused gate state'))).toHaveLength(10);
      clock += 61_000;
      const late = makeSocket('late');
      bridge.handleConnection(late.socket);
      late.fire(BRIDGE_GATE_STATE, {}, () => undefined);
      expect(lines.filter((line) => line.includes('suppressed'))).toEqual([
         'Wiretap sidecar | 15 further gate state refusals suppressed',
      ]);
   });

   it('never writes a snapshot into the log, on the accepted or the refused path', () => {
      const { bridge, lines } = makeBridge();
      const fake = register(bridge, 'a', { gateState: { allowMacroExecution: true } });
      fake.fire(BRIDGE_GATE_STATE, { allowUserWrites: true }, () => undefined);
      const stranger = makeSocket('stranger');
      bridge.handleConnection(stranger.socket);
      const probe = { allowFileUpload: true, allowedPluginModules: ['secret-module'] };
      stranger.fire(BRIDGE_GATE_STATE, probe, () => undefined);
      expect(lines.some((line) => line.includes('refused gate state'))).toBe(true);
      expect(lines.join('\n')).not.toMatch(
         /allowMacroExecution|allowUserWrites|allowFileUpload|allowedPluginModules|secret-module|gateState/,
      );
   });

   it('treats a snapshot whose reads throw as all-closed', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a', { gateState: { allowMacroExecution: true } });
      const hostile = new Proxy(
         {},
         {
            getOwnPropertyDescriptor() {
               throw new Error('trap');
            },
         },
      );
      const acks = [];
      expect(() => fake.fire(BRIDGE_GATE_STATE, hostile, (ack) => acks.push(ack))).not.toThrow();
      expect(acks).toEqual([{ ok: true }]);
      expect(bridge.gateState()).toEqual(closedGateState());
   });

   it('closes the endpoint snapshot and acks a failure when the handler throws', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a', { gateState: { allowMacroExecution: true } });
      const acks = [];
      expect(() =>
         fake.fire(BRIDGE_GATE_STATE, { allowUserWrites: true }, (ack) => {
            acks.push(ack);
            if (acks.length === 1) {
               throw new Error('ack failed');
            }
         }),
      ).not.toThrow();
      expect(acks).toHaveLength(2);
      expect(acks[1]).toMatchObject({ ok: false, error: { code: OP_FAILED } });
      expect(bridge.gateState()).toEqual(closedGateState());
   });

   it('does not throw when the failure ack throws too', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a');
      expect(() =>
         fake.fire(BRIDGE_GATE_STATE, {}, () => {
            throw new Error('ack failed');
         }),
      ).not.toThrow();
      expect(bridge.gateState()).toEqual(closedGateState());
   });
});

describe('createFoundryBridge invoke with requireGate', () => {
   it('sends nothing and throws GATE_DENIED when the picked endpoint has the gate closed', async () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a');
      await expect(
         bridge.invoke(OP_CREATE_ACTOR, {}, { requireGate: { gate: 'allowMacroExecution' } }),
      ).rejects.toMatchObject({ code: GATE_DENIED });
      expect(fake.emitted).toEqual([]);
   });

   it('sends to the endpoint whose own snapshot opened the gate', async () => {
      const { bridge } = makeBridge();
      const closed = register(bridge, 'h', { kind: 'human', userId: 'uh' });
      const open = register(bridge, 'a', { kind: 'agent', userId: 'ua', gateState: { allowMacroExecution: true } });
      await expect(
         bridge.invoke(OP_CREATE_ACTOR, {}, { requireGate: { gate: 'allowMacroExecution' } }),
      ).resolves.toEqual({ from: 'a' });
      expect(open.emitted).toHaveLength(1);
      expect(closed.emitted).toEqual([]);
   });

   it('uses a snapshot pushed through BRIDGE_GATE_STATE', async () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a');
      fake.fire(BRIDGE_GATE_STATE, { allowFileUpload: true }, () => undefined);
      await expect(bridge.invoke(OP_CREATE_ACTOR, {}, { requireGate: { gate: 'allowFileUpload' } })).resolves.toEqual({
         from: 'a',
      });
   });

});
