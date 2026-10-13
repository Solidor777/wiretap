import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getBudget } from '$shared/budgets.js';
import { GATE_DENIED, OP_FAILED, TOOL_GONE } from '$shared/protocol.js';
import { gateDenial, closedGateState } from '$shared/gates.js';
import { createCallTool, RESULT_WIRE_MAX_BYTES, SCRIPT_BUSY, SCRIPT_TIMEOUT_MS } from '~/bridge/scripts/callTool.js';
import { createScriptRegistry, ScriptError } from '~/bridge/scripts/registry.js';
import { script } from './scriptFixtures.js';

/** @type {Record<string, unknown>} The stored gate setting values the fake game returns. */
let stored;

/** @type {ReturnType<typeof createScriptRegistry>} The registry under test. */
let registry;

/** @type {(params: unknown) => Promise<unknown>} The `callTool` op handler under test. */
let callTool;

beforeEach(() => {
   stored = {};
   globalThis.game = {
      settings: {
         get: (module, key) => {
            if (!Object.hasOwn(stored, key)) {
               return key === 'allowedPluginModules' ? '' : false;
            }
            const value = stored[key];
            if (value instanceof Error) {
               throw value;
            }
            return value;
         },
      },
   };
   registry = createScriptRegistry({ log: () => {} });
   callTool = createCallTool({ registry });
});

afterEach(() => {
   delete globalThis.game;
   vi.useRealTimers();
});

/**
 * Run a call and return the rejection it produced.
 * @param {unknown} params - The op params.
 * @returns {Promise<Error>} The error the handler threw.
 */
async function failure(params) {
   try {
      await callTool(params);
   } catch (error) {
      return error;
   }
   throw new Error('the call succeeded');
}

describe('callTool: lookup', () => {
   it('runs the named script with the validated arguments and returns its result', async () => {
      const handler = vi.fn(async (args) => ({ echoed: args.text }));
      registry.register(script('echo'), handler);
      await expect(callTool({ name: 'echo', arguments: { text: 'hi' } })).resolves.toEqual({ echoed: 'hi' });
      expect(handler).toHaveBeenCalledTimes(1);
   });

   it('reports an unregistered name as TOOL_GONE without running anything', async () => {
      const error = await failure({ name: 'missing', arguments: {} });
      expect(error).toBeInstanceOf(ScriptError);
      expect(error.code).toBe(TOOL_GONE);
      expect(error.message).toMatch(/missing/);
   });

   it.each([
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
   ])('does not find the inherited name %s', async (name) => {
      const error = await failure({ name, arguments: {} });
      expect(error.code).toBe(TOOL_GONE);
   });

   it('bounds and cleans a hostile name in the error', async () => {
      const error = await failure({ name: `x\ny${'z'.repeat(10_000)}`, arguments: {} });
      expect(error.code).toBe(TOOL_GONE);
      expect(error.message).not.toContain('\n');
      expect(new TextEncoder().encode(error.message).length).toBeLessThanOrEqual(256);
   });

   it.each([
      undefined,
      null,
      [],
      'echo',
      {},
      { name: 1 },
      { arguments: {} },
   ])('refuses the params %j as a malformed call', async (params) => {
      registry.register(script('echo'), async () => 'unused');
      const error = await failure(params);
      expect(error.code).toBe(OP_FAILED);
      expect(error.message).toMatch(/name/);
   });
});

describe('callTool: gate enforcement on this client', () => {
   it('denies a script whose gate is closed, with the gate denial, and never runs the handler', async () => {
      const handler = vi.fn(async () => 'ran');
      registry.register(script('macro', { gate: 'allowMacroExecution' }), handler);
      const error = await failure({ name: 'macro', arguments: { text: 'x' } });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toBe(gateDenial(closedGateState(), 'allowMacroExecution').message);
      expect(handler).not.toHaveBeenCalled();
   });

   it('runs the script once its gate is open and reads the setting at call time', async () => {
      const handler = vi.fn(async () => 'ran');
      registry.register(script('macro', { gate: 'allowMacroExecution' }), handler);
      stored.allowMacroExecution = true;
      await expect(callTool({ name: 'macro', arguments: { text: 'x' } })).resolves.toBe('ran');
      stored.allowMacroExecution = false;
      expect((await failure({ name: 'macro', arguments: { text: 'x' } })).code).toBe(GATE_DENIED);
      expect(handler).toHaveBeenCalledTimes(1);
   });

   it('judges only the declared gate', async () => {
      registry.register(script('macro', { gate: 'allowMacroExecution' }), async () => 'ran');
      stored.allowUserWrites = true;
      expect((await failure({ name: 'macro', arguments: { text: 'x' } })).code).toBe(GATE_DENIED);
   });

   it('takes no gate value from the call params', async () => {
      registry.register(script('macro', { gate: 'allowMacroExecution' }), async () => 'ran');
      const error = await failure({
         name: 'macro',
         arguments: {
            text: 'x',
            allowMacroExecution: true,
         },
         gateState: { allowMacroExecution: true },
         allowMacroExecution: true,
      });
      expect(error.code).toBe(GATE_DENIED);
   });

   it('fails closed when the setting cannot be read', async () => {
      registry.register(script('macro', { gate: 'allowMacroExecution' }), async () => 'ran');
      stored.allowMacroExecution = new Error('settings unavailable');
      expect((await failure({ name: 'macro', arguments: { text: 'x' } })).code).toBe(GATE_DENIED);
   });

   it('checks the gate before the arguments, so a denied call learns nothing about them', async () => {
      registry.register(script('macro', { gate: 'allowMacroExecution' }), async () => 'ran');
      const error = await failure({ name: 'macro', arguments: { text: 5 } });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).not.toMatch(/text/);
   });

   it('runs an ungated script with every gate closed', async () => {
      registry.register(script('plain'), async () => 'ran');
      await expect(callTool({ name: 'plain', arguments: { text: 'x' } })).resolves.toBe('ran');
   });
});

describe('callTool: argument validation', () => {
   it('refuses invalid arguments with ARGS_INVALID naming the path and never runs the handler', async () => {
      const handler = vi.fn(async () => 'ran');
      registry.register(script('echo'), handler);
      const error = await failure({ name: 'echo', arguments: { text: 5 } });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toBe('text: expected a string');
      expect(handler).not.toHaveBeenCalled();
   });

   it('treats missing arguments as an empty object', async () => {
      registry.register(script('echo'), async () => 'ran');
      const error = await failure({ name: 'echo' });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toBe('text: is required');
      registry.register(script('optional', { inputSchema: { type: 'object', properties: {} } }), async (args) => args);
      await expect(callTool({ name: 'optional' })).resolves.toEqual({});
   });

   it.each([
      null,
      'text',
      7,
      [],
   ])('refuses arguments %j that are not an object', async (value) => {
      registry.register(script('echo'), async () => 'ran');
      const error = await failure({ name: 'echo', arguments: value });
      expect(error.code).toBe('ARGS_INVALID');
   });

   it('hands the handler a validated copy without undeclared properties', async () => {
      const seen = [];
      registry.register(script('echo'), async (args) => {
         seen.push(args);
         return 'ok';
      });
      const sent = {
         text: 'hi',
         junk: 1,
      };
      await callTool({ name: 'echo', arguments: sent });
      expect(seen[0]).toEqual({ text: 'hi' });
      expect(seen[0]).not.toBe(sent);
   });

   it('enforces the declared bounds of the argument schema', async () => {
      registry.register(
         script('bounded', {
            inputSchema: {
               type: 'object',
               properties: {
                  n: {
                     type: 'integer',
                     minimum: 1,
                     maximum: 3,
                  },
               },
               required: ['n'],
            },
         }),
         async (args) => args.n,
      );
      await expect(callTool({ name: 'bounded', arguments: { n: 3 } })).resolves.toBe(3);
      expect((await failure({ name: 'bounded', arguments: { n: 4 } })).message).toBe('n: must be at most 3');
      expect((await failure({ name: 'bounded', arguments: { n: 0 } })).message).toBe('n: must be at least 1');
   });
});

describe('callTool: context and result', () => {
   it('passes core, shape and a signal, and no dom for an api script', async () => {
      let received;
      registry.register(script('echo'), async (args, ctx) => {
         received = ctx;
         return 'ok';
      });
      await callTool({ name: 'echo', arguments: { text: 'x' } });
      expect(typeof received.core.createActor).toBe('function');
      expect(typeof received.shape.compact).toBe('function');
      expect(received.signal).toBeInstanceOf(AbortSignal);
      expect(received.signal.aborted).toBe(false);
      expect(Object.hasOwn(received, 'dom')).toBe(false);
   });

   it('passes dom only to a script that requires it', async () => {
      let received;
      registry.register(script('looker', { requires: 'dom' }), async (args, ctx) => {
         received = ctx;
         return 'ok';
      });
      await callTool({ name: 'looker', arguments: { text: 'x' } });
      expect(Object.hasOwn(received, 'dom')).toBe(true);
      expect(received.dom).toBeDefined();
   });

   it('freezes the context so a script cannot replace its helpers', async () => {
      let received;
      registry.register(script('echo'), async (args, ctx) => {
         received = ctx;
         return 'ok';
      });
      await callTool({ name: 'echo', arguments: { text: 'x' } });
      expect(Object.isFrozen(received)).toBe(true);
      expect(Object.isFrozen(received.core)).toBe(true);
   });

   it('returns a plain copy of an object result, and null for no result', async () => {
      const returned = { a: [1, { b: 2 }] };
      registry.register(script('obj'), async () => returned);
      registry.register(script('nothing'), async () => undefined);
      registry.register(script('sync'), () => 'sync result');
      const result = await callTool({ name: 'obj', arguments: { text: 'x' } });
      expect(result).toEqual(returned);
      expect(result).not.toBe(returned);
      await expect(callTool({ name: 'nothing', arguments: { text: 'x' } })).resolves.toBeNull();
      await expect(callTool({ name: 'sync', arguments: { text: 'x' } })).resolves.toBe('sync result');
   });

   it('refuses a result that cannot be serialized', async () => {
      const cycle = {};
      cycle.self = cycle;
      registry.register(script('cycle'), async () => cycle);
      registry.register(script('big_int'), async () => 10n);
      for (const name of ['cycle', 'big_int']) {
         const error = await failure({ name, arguments: { text: 'x' } });
         expect(error.code).toBe('RESULT_INVALID');
      }
   });

   it('refuses a result larger than the wire bound', async () => {
      registry.register(script('huge'), async () => 'x'.repeat(RESULT_WIRE_MAX_BYTES + 1));
      registry.register(script('edge'), async () => 'x'.repeat(RESULT_WIRE_MAX_BYTES - 2));
      expect((await failure({ name: 'huge', arguments: { text: 'x' } })).code).toBe('RESULT_TOO_LARGE');
      await expect(callTool({ name: 'edge', arguments: { text: 'x' } })).resolves.toHaveLength(
         RESULT_WIRE_MAX_BYTES - 2,
      );
   });
});

describe('callTool: handler failures', () => {
   it('rethrows a handler error unchanged', async () => {
      const original = new Error('permission denied');
      registry.register(script('boom'), async () => {
         throw original;
      });
      expect(await failure({ name: 'boom', arguments: { text: 'x' } })).toBe(original);
   });

   it('keeps the code of a ScriptError', async () => {
      registry.register(script('boom'), async () => {
         throw new ScriptError('BAD_THING', 'a bad thing');
      });
      const error = await failure({ name: 'boom', arguments: { text: 'x' } });
      expect(error.code).toBe('BAD_THING');
   });

   it('turns a synchronous throw into a rejection', async () => {
      registry.register(script('boom'), () => {
         throw new Error('sync failure');
      });
      expect((await failure({ name: 'boom', arguments: { text: 'x' } })).message).toBe('sync failure');
   });
});

describe('callTool: timeout', () => {
   it('fails a handler that does not finish, aborts its signal and clears the timer', async () => {
      vi.useFakeTimers();
      let signal;
      registry.register(script('slow'), (args, ctx) => {
         signal = ctx.signal;
         return new Promise(() => {});
      });
      const pending = callTool({ name: 'slow', arguments: { text: 'x' } }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS - 1);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await pending;
      expect(error.code).toBe('SCRIPT_TIMEOUT');
      expect(error.message).toMatch(/may still have applied/);
      expect(signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
   });

   it('ignores a result or failure that arrives after the timeout, with no unhandled rejection', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      /** @type {unknown[]} Rejections nobody handled. */
      const unhandled = [];
      const listener = (reason) => unhandled.push(reason);
      process.on('unhandledRejection', listener);
      try {
         let finish;
         let fail;
         registry.register(script('slow'), () => new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
         }));
         /** @type {unknown[]} Every settlement the call produced. */
         const settled = [];
         const pending = callTool({ name: 'slow', arguments: { text: 'x' } }).then(
            (value) => settled.push(['value', value]),
            (error) => settled.push(['error', error.code]),
         );
         await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS);
         await pending;
         expect(settled).toEqual([['error', 'SCRIPT_TIMEOUT']]);
         finish('late');
         fail(new Error('later still'));
         await vi.advanceTimersByTimeAsync(10);
         await new Promise((resolve) => setImmediate(resolve));
         expect(settled).toEqual([['error', 'SCRIPT_TIMEOUT']]);
         expect(unhandled).toEqual([]);
      } finally {
         process.off('unhandledRejection', listener);
      }
   });

   it('clears the timer when the handler finishes or fails first', async () => {
      vi.useFakeTimers();
      registry.register(script('fast'), async () => 'done');
      registry.register(script('boom'), async () => {
         throw new Error('x');
      });
      await callTool({ name: 'fast', arguments: { text: 'x' } });
      expect(vi.getTimerCount()).toBe(0);
      await failure({ name: 'boom', arguments: { text: 'x' } });
      expect(vi.getTimerCount()).toBe(0);
   });

   it('keeps the client timeout below the sidecar ack window of 10 s', () => {
      expect(SCRIPT_TIMEOUT_MS).toBeLessThan(10_000);
   });

   it('takes the timeout from the options', async () => {
      vi.useFakeTimers();
      const quick = createCallTool({
         registry,
         timeoutMs: 50,
      });
      registry.register(script('slow'), () => new Promise(() => {}));
      const pending = quick({ name: 'slow', arguments: { text: 'x' } }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(50);
      expect((await pending).code).toBe('SCRIPT_TIMEOUT');
   });
});

describe('callTool: concurrency cap', () => {
   it('refuses a call beyond the cap with SCRIPT_BUSY and runs it once a slot frees', async () => {
      /** @type {number} The most executions the client runs at once. */
      const cap = getBudget('SCRIPT_CONCURRENCY_MAX').value;
      /** @type {Function[]} Resolvers of the running handlers. */
      const releases = [];
      const handler = vi.fn(() => new Promise((resolve) => {
         releases.push(resolve);
      }));
      registry.register(script('hold'), handler);
      const running = Array.from({ length: cap }, () => callTool({ name: 'hold', arguments: { text: 'x' } }));
      await Promise.resolve();
      await Promise.resolve();
      expect(handler).toHaveBeenCalledTimes(cap);
      const error = await failure({ name: 'hold', arguments: { text: 'x' } });
      expect(error.code).toBe(SCRIPT_BUSY);
      expect(error.message.length).toBeLessThan(100);
      expect(handler).toHaveBeenCalledTimes(cap);
      releases[0]('done');
      await expect(running[0]).resolves.toBe('done');
      const next = callTool({ name: 'hold', arguments: { text: 'x' } });
      await Promise.resolve();
      await Promise.resolve();
      expect(handler).toHaveBeenCalledTimes(cap + 1);
      releases.slice(1).forEach((release) => release('done'));
      releases[cap]('done');
      await Promise.all([...running.slice(1), next]);
   });

   it('frees the slot when a handler fails or times out', async () => {
      vi.useFakeTimers();
      /** @type {number} The most executions the client runs at once. */
      const cap = getBudget('SCRIPT_CONCURRENCY_MAX').value;
      registry.register(script('boom'), async () => {
         throw new Error('x');
      });
      registry.register(script('slow'), () => new Promise(() => {}));
      for (let index = 0; index < cap + 2; index += 1) {
         expect((await failure({ name: 'boom', arguments: { text: 'x' } })).code).not.toBe(SCRIPT_BUSY);
      }
      /** @type {Promise<unknown>[]} Calls that will time out. */
      const hung = Array.from({ length: cap }, () => {
         return callTool({ name: 'slow', arguments: { text: 'x' } }).catch((error) => error);
      });
      await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS);
      expect((await Promise.all(hung)).every((error) => error.code === 'SCRIPT_TIMEOUT')).toBe(true);
      registry.register(script('ok'), async () => 'ran');
      await expect(callTool({ name: 'ok', arguments: { text: 'x' } })).resolves.toBe('ran');
   });
});
