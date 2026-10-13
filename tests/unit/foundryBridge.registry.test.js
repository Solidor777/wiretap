// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getBudget } from '../../shared/budgets.js';
import { createFoundryBridge } from '../../server/foundryBridge.ts';
import { BRIDGE_IDENTIFY, BRIDGE_REGISTRY, NOT_GM, OP_FAILED, PROTOCOL_VERSION } from '../../shared/protocol.js';
import { registryPayload, script } from './scriptFixtures.js';

/**
 * Build a fake Socket.IO server socket that records its registered handlers.
 * @param {string} id - The id the fake socket reports.
 * @returns {{ socket: object, fire: Function }} The socket and a trigger.
 */
function makeSocket(id) {
   /** @type {Record<string, Function>} Handlers registered through `socket.on`. */
   const handlers = {};
   return {
      socket: {
         id,
         on: (event, fn) => {
            handlers[event] = fn;
         },
         timeout: () => ({ emit: () => undefined }),
      },
      fire: (event, ...args) => handlers[event]?.(...args),
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
 * Build a valid script definition.
 * @param {string} name - The tool name.
 * @returns {object} A definition that passes every budget.
 */
function entry(name) {
   return script(name, { description: 'A synthetic tool.' });
}

/**
 * Create a bridge with a recording logger and a controllable clock.
 * @returns {{ bridge: ReturnType<typeof createFoundryBridge>, lines: string[], advance: (ms: number) => void }} The
 * bridge, its log and a clock mover.
 */
function makeBridge() {
   /** @type {string[]} Recorded log lines. */
   const lines = [];
   /** @type {number} The clock the log throttles read. */
   let clock = 1_000_000;
   return {
      bridge: createFoundryBridge({
         log: (line) => lines.push(line),
         now: () => clock,
      }),
      lines,
      advance: (ms) => {
         clock += ms;
      },
   };
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

/**
 * Send a registry event and return the ack.
 * @param {{ fire: Function }} fake - The fake socket.
 * @param {unknown} payload - The value sent as the registry event payload.
 * @returns {any} The single ack the bridge sent back.
 */
function sendRegistry(fake, payload) {
   /** @type {unknown[]} Acks received. */
   const acks = [];
   fake.fire(BRIDGE_REGISTRY, payload, (ack) => acks.push(ack));
   expect(acks).toHaveLength(1);
   return acks[0];
}

/**
 * Send a list of script definitions in a well-formed registry payload and return the ack.
 * @param {{ fire: Function }} fake - The fake socket.
 * @param {unknown[]} scripts - The definitions.
 * @returns {any} The single ack the bridge sent back.
 */
function sendScripts(fake, scripts) {
   return sendRegistry(fake, registryPayload(scripts));
}

describe('createFoundryBridge registry event', () => {
   it('names the event bridge:registry', () => {
      expect(BRIDGE_REGISTRY).toBe('bridge:registry');
   });

   it('lists no tools when nothing is registered', () => {
      const { bridge } = makeBridge();
      expect(bridge.tools()).toEqual([]);
   });

   it('stores the tools a registered endpoint sends and acks the counts', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a');
      expect(sendScripts(fake, [entry('first'), entry('second')])).toEqual({
         ok: true,
         accepted: 2,
         refused: 0,
      });
      expect(bridge.tools().map((tool) => tool.name)).toEqual([
         'first',
         'second',
      ]);
   });

   it('replaces the whole list on every event, and an empty array clears it', () => {
      const { bridge, advance } = makeBridge();
      const fake = register(bridge, 'a');
      sendScripts(fake, [
         entry('first'),
         entry('second'),
      ]);
      sendScripts(fake, [entry('third')]);
      expect(bridge.tools().map((tool) => tool.name)).toEqual(['third']);
      advance(1000);
      expect(sendScripts(fake, [])).toEqual({
         ok: true,
         accepted: 0,
         refused: 0,
      });
      expect(bridge.tools()).toEqual([]);
   });

   it('keeps the valid tools of a payload and counts the refused ones', () => {
      const { bridge, lines } = makeBridge();
      const fake = register(bridge, 'a');
      expect(sendScripts(fake, [entry('good'), entry('BAD NAME'), null, entry('read_handle')])).toEqual({
         ok: true,
         accepted: 1,
         refused: 3,
      });
      expect(bridge.tools().map((tool) => tool.name)).toEqual(['good']);
      expect(lines.filter((line) => line.includes('registry refused tool'))).toHaveLength(3);
   });

   it('keeps a separate list per endpoint and lists the routed one', () => {
      const { bridge } = makeBridge();
      const human = register(bridge, 'h', { kind: 'human' });
      const agent = register(bridge, 'a', { kind: 'agent' });
      sendScripts(human, [entry('human_tool')]);
      sendScripts(agent, [entry('agent_tool')]);
      expect(bridge.tools().map((tool) => tool.name)).toEqual(['agent_tool']);
      expect(bridge.tools({ endpoint: 'human' }).map((tool) => tool.name)).toEqual(['human_tool']);
   });

   it('refuses a payload that is not a registry object: acks OP_FAILED and clears the endpoint tools', () => {
      const { bridge, lines, advance } = makeBridge();
      const fake = register(bridge, 'a');
      sendScripts(fake, [entry('first')]);
      for (const payload of [undefined, null, 'x', 5, {}, { tools: [entry('first')] }, [entry('first')]]) {
         advance(1000);
         const ack = sendRegistry(fake, payload);
         expect(ack.ok).toBe(false);
         expect(ack.error.code).toBe(OP_FAILED);
         expect(bridge.tools()).toEqual([]);
         advance(1000);
         sendScripts(fake, [entry('first')]);
      }
      expect(lines.some((line) => line.includes('registry payload'))).toBe(true);
   });

   it('refuses a socket that never identified: NOT_GM, logged, nothing stored', () => {
      const { bridge, lines } = makeBridge();
      const stranger = makeSocket('stranger');
      bridge.handleConnection(stranger.socket);
      const ack = sendScripts(stranger, [entry('first')]);
      expect(ack).toEqual({
         ok: false,
         error: {
            code: NOT_GM,
            message: 'Only a registered GM endpoint may push a registry.',
         },
      });
      expect(bridge.tools()).toEqual([]);
      expect(lines).toEqual(['Wiretap sidecar | refused registry from stranger: NOT_GM']);
   });

   it('refuses a socket whose identify was refused', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'p', { isGM: false });
      expect(sendScripts(fake, [entry('first')]).error.code).toBe(NOT_GM);
      expect(bridge.tools()).toEqual([]);
   });

   it('drops the tools with the endpoint when the socket disconnects', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a');
      sendScripts(fake, [entry('first')]);
      fake.fire('disconnect');
      expect(bridge.tools()).toEqual([]);
   });

   it('keeps the tools across a repeated identify of the same socket', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a');
      sendScripts(fake, [entry('first')]);
      fake.fire(BRIDGE_IDENTIFY, identify(), () => undefined);
      expect(bridge.tools().map((tool) => tool.name)).toEqual(['first']);
   });

   it('tolerates a missing ack callback', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a');
      expect(() => fake.fire(BRIDGE_REGISTRY, registryPayload([entry('first')]))).not.toThrow();
      expect(bridge.tools()).toHaveLength(1);
      const stranger = makeSocket('s');
      bridge.handleConnection(stranger.socket);
      expect(() => stranger.fire(BRIDGE_REGISTRY, registryPayload([entry('first')]))).not.toThrow();
   });

   it('closes the endpoint list and acks OP_FAILED when sanitizing throws', () => {
      const { bridge, lines } = makeBridge();
      const fake = register(bridge, 'a');
      sendScripts(fake, [entry('first')]);
      const hostile = new Proxy([], {
         get(target, property) {
            if (property === 'length') {
               throw new Error('hostile length');
            }
            return Reflect.get(target, property);
         },
      });
      const ack = sendScripts(fake, hostile);
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe(OP_FAILED);
      expect(bridge.tools()).toEqual([]);
      expect(lines.some((line) => line.includes('hostile length'))).toBe(true);
   });

   it('throttles refusal lines to 10 per minute with one summary line after the window', () => {
      const { bridge, lines, advance } = makeBridge();
      const fake = register(bridge, 'a');
      sendScripts(fake, Array.from({ length: 15 }, (_, index) => entry(`BAD ${index}`)));
      expect(lines.filter((line) => line.includes('registry refused tool'))).toHaveLength(10);
      advance(61_000);
      sendScripts(fake, [entry('BAD again')]);
      expect(lines.some((line) => line.includes('5 further registry refusal lines suppressed'))).toBe(true);
   });

   it('notifies subscribers when a registry is applied', () => {
      const { bridge } = makeBridge();
      const fake = register(bridge, 'a');
      const listener = vi.fn();
      const stop = bridge.subscribe(listener);
      sendScripts(fake, [entry('first')]);
      expect(listener).toHaveBeenCalledTimes(1);
      stop();
      sendScripts(fake, [entry('second')]);
      expect(listener).toHaveBeenCalledTimes(1);
   });
});

describe('createFoundryBridge registry rate limit', () => {
   afterEach(() => {
      vi.useRealTimers();
   });

   /**
    * Create a bridge on fake timers, with the real clock the timers also drive, and a registered GM endpoint.
    * @returns {{ bridge: ReturnType<typeof createFoundryBridge>, fake: { socket: object, fire: Function } }} The pair.
    */
   function makeLimited() {
      vi.useFakeTimers();
      const bridge = createFoundryBridge({ log: () => undefined });
      return {
         bridge,
         fake: register(bridge, 'a'),
      };
   }

   /**
    * Push a registry of one named script and collect the ack.
    * @param {{ fire: Function }} fake - The fake socket.
    * @param {string} name - The script name.
    * @returns {unknown[]} The acks received so far for this push (filled when the ack arrives).
    */
   function push(fake, name) {
      /** @type {unknown[]} Acks of this push. */
      const acks = [];
      fake.fire(BRIDGE_REGISTRY, registryPayload([entry(name)]), (ack) => acks.push(ack));
      return acks;
   }

   it('applies the pushes within the per-second limit at once', () => {
      const { bridge, fake } = makeLimited();
      const limit = getBudget('REGISTRY_PUSHES_PER_SECOND_MAX').value;
      for (let index = 0; index < limit; index += 1) {
         const acks = push(fake, `tool_${index}`);
         expect(acks).toHaveLength(1);
         expect(acks[0].ok).toBe(true);
         expect(bridge.tools().map((tool) => tool.name)).toEqual([`tool_${index}`]);
      }
   });

   it('coalesces the pushes past the limit and applies only the latest when the second ends', async () => {
      const { bridge, fake } = makeLimited();
      const limit = getBudget('REGISTRY_PUSHES_PER_SECOND_MAX').value;
      for (let index = 0; index < limit; index += 1) {
         push(fake, `tool_${index}`);
      }
      const early = push(fake, 'early');
      const latest = push(fake, 'latest');
      expect(bridge.tools().map((tool) => tool.name)).toEqual([`tool_${limit - 1}`]);
      expect(early).toEqual([{ ok: true, coalesced: true }]);
      expect(latest).toEqual([]);
      await vi.advanceTimersByTimeAsync(999);
      expect(latest).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(bridge.tools().map((tool) => tool.name)).toEqual(['latest']);
      expect(latest).toHaveLength(1);
      expect(latest[0].ok).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
   });

   it('applies at most the limit plus one registry in the second after a flood of pushes', async () => {
      const { bridge, fake } = makeLimited();
      /** @type {string[]} Every tool name set seen after each applied push. */
      const applied = [];
      bridge.subscribe(() => applied.push(bridge.tools().map((tool) => tool.name).join(',')));
      for (let index = 0; index < 500; index += 1) {
         push(fake, `flood_${index}`);
      }
      await vi.advanceTimersByTimeAsync(1000);
      expect(applied.length).toBeLessThanOrEqual(getBudget('REGISTRY_PUSHES_PER_SECOND_MAX').value + 1);
      expect(bridge.tools().map((tool) => tool.name)).toEqual(['flood_499']);
   });

   it('allows a new burst after the window passes', async () => {
      const { bridge, fake } = makeLimited();
      const limit = getBudget('REGISTRY_PUSHES_PER_SECOND_MAX').value;
      for (let index = 0; index < limit; index += 1) {
         push(fake, `a_${index}`);
      }
      await vi.advanceTimersByTimeAsync(1000);
      const acks = push(fake, 'b_0');
      expect(acks).toHaveLength(1);
      expect(bridge.tools().map((tool) => tool.name)).toEqual(['b_0']);
   });

   it('limits each socket on its own', () => {
      const { bridge, fake } = makeLimited();
      const other = register(bridge, 'b');
      const limit = getBudget('REGISTRY_PUSHES_PER_SECOND_MAX').value;
      for (let index = 0; index < limit + 1; index += 1) {
         push(fake, `a_${index}`);
      }
      expect(push(other, 'other_0')).toHaveLength(1);
   });

   it('drops the pending push and its timer when the socket disconnects', async () => {
      const { bridge, fake } = makeLimited();
      const limit = getBudget('REGISTRY_PUSHES_PER_SECOND_MAX').value;
      for (let index = 0; index < limit + 1; index += 1) {
         push(fake, `a_${index}`);
      }
      expect(vi.getTimerCount()).toBe(1);
      fake.fire('disconnect');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(bridge.tools()).toEqual([]);
   });

   it('drops the pending push and its timer on dispose', async () => {
      const { bridge, fake } = makeLimited();
      const limit = getBudget('REGISTRY_PUSHES_PER_SECOND_MAX').value;
      for (let index = 0; index < limit + 1; index += 1) {
         push(fake, `a_${index}`);
      }
      bridge.dispose();
      expect(vi.getTimerCount()).toBe(0);
   });
});
