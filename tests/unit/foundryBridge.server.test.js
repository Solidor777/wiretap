// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createFoundryBridge } from '../../server/foundryBridge.ts';
import { BRIDGE_IDENTIFY, BRIDGE_INVOKE, OP_CREATE_ACTOR } from '$shared/protocol.js';

/**
 * Build a fake Socket.IO server socket whose ack-emit is controllable, recording emitted events.
 * @param {string} id - The socket id.
 * @param {(payload: object) => *} ackResponder - Maps the emitted payload to the ack response (or 'timeout').
 * @returns {object} The fake socket, a `fire` helper to trigger registered handlers, and the `emitted` log.
 */
function makeSocket(id, ackResponder = () => ({ ok: true, result: {} })) {
   const handlers = {};
   const emitted = [];
   const socket = {
      id,
      on: (event, fn) => { handlers[event] = fn; },
      timeout: () => ({
         emit: (event, payload, ack) => {
            emitted.push({ event, payload });
            const response = ackResponder(payload);
            if (response === 'timeout') { ack(new Error('timed out')); } else { ack(null, response); }
         },
      }),
   };
   const fire = (event, ...args) => handlers[event]?.(...args);
   return { socket, fire, emitted };
}

describe('createFoundryBridge', () => {
   it('rejects invokeOnGM when no GM is registered', async () => {
      const bridge = createFoundryBridge();
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, {})).rejects.toThrow(/No Foundry GM/);
   });

   it('registers a GM on identify and routes a successful invoke to it', async () => {
      const bridge = createFoundryBridge();
      const { socket, fire, emitted } = makeSocket('a', () => ({ ok: true, result: { uuid: 'Actor.x' } }));
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, { userId: 'u', userName: 'GM', isGM: true });
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, { name: 'Bob' })).resolves.toEqual({ uuid: 'Actor.x' });
      expect(emitted[0].event).toBe(BRIDGE_INVOKE);
      expect(emitted[0].payload).toEqual({ op: OP_CREATE_ACTOR, params: { name: 'Bob' } });
   });

   it('does not register a non-GM socket', async () => {
      const bridge = createFoundryBridge();
      const { socket, fire } = makeSocket('a');
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, { userId: 'u', userName: 'Player', isGM: false });
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, {})).rejects.toThrow(/No Foundry GM/);
   });

   it('rejects when the GM acks ok:false', async () => {
      const bridge = createFoundryBridge();
      const { socket, fire } = makeSocket('a', () => ({ ok: false, error: 'Unknown actor type' }));
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, { userId: 'u', userName: 'GM', isGM: true });
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, {})).rejects.toThrow(/Unknown actor type/);
   });

   it('rejects on ack timeout', async () => {
      const bridge = createFoundryBridge();
      const { socket, fire } = makeSocket('a', () => 'timeout');
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, { userId: 'u', userName: 'GM', isGM: true });
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, {})).rejects.toThrow(/did not respond/);
   });

   it('deregisters a GM on disconnect', async () => {
      const bridge = createFoundryBridge();
      const { socket, fire } = makeSocket('a');
      bridge.handleConnection(socket);
      fire(BRIDGE_IDENTIFY, { userId: 'u', userName: 'GM', isGM: true });
      fire('disconnect');
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, {})).rejects.toThrow(/No Foundry GM/);
   });

   it('keeps servicing invocations when one of several GM sockets disconnects', async () => {
      const bridge = createFoundryBridge();
      const first = makeSocket('a', () => ({ ok: true, result: { uuid: 'Actor.first' } }));
      const second = makeSocket('b', () => ({ ok: true, result: { uuid: 'Actor.second' } }));
      bridge.handleConnection(first.socket);
      bridge.handleConnection(second.socket);
      first.fire(BRIDGE_IDENTIFY, { userId: 'u1', userName: 'GM1', isGM: true });
      second.fire(BRIDGE_IDENTIFY, { userId: 'u2', userName: 'GM2', isGM: true });
      first.fire('disconnect');
      // The remaining GM still services invocations.
      await expect(bridge.invokeOnGM(OP_CREATE_ACTOR, {})).resolves.toEqual({ uuid: 'Actor.second' });
   });
});
