// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDebouncer, createSessionManager } from '../../server/mcpSessions.ts';

beforeEach(() => {
   vi.useFakeTimers({ toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'performance',
   ] });
});

afterEach(() => {
   vi.useRealTimers();
});

/**
 * Build a fake session that records how often it was closed.
 * @param {string} id - The id the manager files the session under.
 * @returns {{ id: string, close: import('vitest').Mock }} A session whose close calls can be counted.
 */
function fakeSession(id) {
   return {
      id,
      close: vi.fn(async () => undefined),
   };
}

/**
 * Create a manager with small, fast limits and a recording end hook.
 * @param {object} [options] - Overrides for the manager options.
 * @returns {{ manager: ReturnType<typeof createSessionManager>, ended: string[], logs: string[] }} The manager and
 * what it reported.
 */
function makeManager(options = {}) {
   /** @type {string[]} Ids passed to the end hook, in order. */
   const ended = [];
   /** @type {string[]} Log lines. */
   const logs = [];
   return {
      manager: createSessionManager({
         maxSessions: 3,
         idleMs: 1000,
         sweepMs: 100,
         onEnd: (id) => ended.push(id),
         log: (line) => logs.push(line),
         ...options,
      }),
      ended,
      logs,
   };
}

describe('session manager: membership', () => {
   it('stores sessions by id and reports the count', () => {
      const { manager } = makeManager();
      const a = fakeSession('a');
      manager.add(a);
      expect(manager.get('a')).toBe(a);
      expect(manager.get('b')).toBeUndefined();
      expect(manager.size()).toBe(1);
      manager.dispose();
   });

   it('ends a session once: the end hook and close run once, and a repeat or unknown id does nothing', async () => {
      const { manager, ended } = makeManager();
      const a = fakeSession('a');
      manager.add(a);
      await manager.end('a');
      await manager.end('a');
      await manager.end('unknown');
      expect(ended).toEqual(['a']);
      expect(a.close).toHaveBeenCalledTimes(1);
      expect(manager.get('a')).toBeUndefined();
      expect(manager.size()).toBe(0);
   });

   it('keeps ending the other sessions when a close rejects or throws, and logs it', async () => {
      const { manager, ended, logs } = makeManager({ maxSessions: 5 });
      const rejecting = {
         id: 'r',
         close: vi.fn(async () => {
            throw new Error('close failed');
         }),
      };
      const throwing = {
         id: 't',
         close: vi.fn(() => {
            throw new Error('close threw');
         }),
      };
      const fine = fakeSession('f');
      manager.add(rejecting);
      manager.add(throwing);
      manager.add(fine);
      manager.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(ended.sort()).toEqual([
         'f',
         'r',
         't',
      ]);
      expect(fine.close).toHaveBeenCalledTimes(1);
      expect(logs.filter((line) => line.includes('session r close failed: close failed'))).toHaveLength(1);
      expect(logs.filter((line) => line.includes('session t close failed: close threw'))).toHaveLength(1);
   });
});

describe('session manager: idle expiry', () => {
   it('keeps a session before the idle limit and ends it at the first sweep after it', async () => {
      const { manager, ended } = makeManager();
      const a = fakeSession('a');
      manager.add(a);
      await vi.advanceTimersByTimeAsync(900);
      expect(ended).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(ended).toEqual(['a']);
      expect(a.close).toHaveBeenCalledTimes(1);
      expect(manager.size()).toBe(0);
   });

   it('resets the idle clock on every touch', async () => {
      const { manager, ended } = makeManager();
      manager.add(fakeSession('a'));
      for (let step = 0; step < 5; step += 1) {
         await vi.advanceTimersByTimeAsync(800);
         manager.touch('a');
      }
      expect(ended).toEqual([]);
      await vi.advanceTimersByTimeAsync(1100);
      expect(ended).toEqual(['a']);
   });

   it('ends only the idle sessions and keeps the one that was touched', async () => {
      const { manager, ended } = makeManager();
      manager.add(fakeSession('idle'));
      manager.add(fakeSession('busy'));
      await vi.advanceTimersByTimeAsync(600);
      manager.touch('busy');
      await vi.advanceTimersByTimeAsync(600);
      expect(ended).toEqual(['idle']);
      expect(manager.get('busy')).toBeDefined();
      manager.dispose();
   });

   it('ignores a touch of an unknown session', () => {
      const { manager } = makeManager();
      expect(() => manager.touch('unknown')).not.toThrow();
   });

   it('expires after 30 minutes by default', async () => {
      const ended = [];
      const manager = createSessionManager({ onEnd: (id) => ended.push(id) });
      manager.add(fakeSession('a'));
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 61_000);
      expect(ended).toEqual([]);
      await vi.advanceTimersByTimeAsync(2 * 61_000);
      expect(ended).toEqual(['a']);
   });
});

describe('session manager: log lines', () => {
   it('writes one bounded line without control characters for a failing close or end hook', async () => {
      const hostile = new Error(`first line\nsecond line ${'y'.repeat(2000)}`);
      const { manager, logs } = makeManager({
         onEnd: () => {
            throw hostile;
         },
      });
      const failing = fakeSession('f');
      failing.close = vi.fn(async () => {
         throw hostile;
      });
      manager.add(failing);
      await manager.end('f');
      expect(logs).toHaveLength(2);
      for (const line of logs) {
         expect(line).not.toContain('\n');
         expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(300);
      }
      manager.dispose();
   });
});

describe('session manager: session cap', () => {
   it('refuses a session beyond the cap and ends no held session', async () => {
      const { manager, ended } = makeManager();
      const a = fakeSession('a');
      expect(manager.add(a)).toBe(true);
      expect(manager.add(fakeSession('b'))).toBe(true);
      expect(manager.add(fakeSession('c'))).toBe(true);
      manager.touch('a');
      const refused = fakeSession('d');
      expect(manager.add(refused)).toBe(false);
      expect(ended).toEqual([]);
      expect(manager.size()).toBe(3);
      expect(manager.get('a')).toBe(a);
      expect(manager.get('d')).toBeUndefined();
      // A refused session is left to the caller: the manager neither holds nor closes it.
      expect(refused.close).not.toHaveBeenCalled();
      manager.dispose();
   });

   it('holds the cap through a long run of additions without ending anything', () => {
      const { manager, ended } = makeManager({ maxSessions: 4 });
      let accepted = 0;
      for (let index = 0; index < 20; index += 1) {
         if (manager.add(fakeSession(`s${index}`))) {
            accepted += 1;
         }
         expect(manager.size()).toBeLessThanOrEqual(4);
      }
      expect(accepted).toBe(4);
      expect(ended).toEqual([]);
      manager.dispose();
   });

   it('uses the session cap budget by default', () => {
      const ended = [];
      const manager = createSessionManager({ onEnd: (id) => ended.push(id) });
      for (let index = 0; index < 33; index += 1) {
         manager.add(fakeSession(`s${index}`));
      }
      expect(manager.size()).toBe(32);
      expect(manager.get('s32')).toBeUndefined();
      expect(ended).toEqual([]);
      manager.dispose();
   });

   it('reports a full manager counting reserved slots', () => {
      const { manager } = makeManager({ maxSessions: 3 });
      manager.add(fakeSession('a'));
      expect(manager.isFull()).toBe(false);
      expect(manager.isFull(1)).toBe(false);
      expect(manager.isFull(2)).toBe(true);
      manager.add(fakeSession('b'));
      manager.add(fakeSession('c'));
      expect(manager.isFull()).toBe(true);
      manager.dispose();
   });

   it('frees a slot when an idle session expires', async () => {
      const { manager } = makeManager({
         maxSessions: 1,
         idleMs: 1000,
         sweepMs: 100,
      });
      manager.add(fakeSession('a'));
      expect(manager.add(fakeSession('b'))).toBe(false);
      await vi.advanceTimersByTimeAsync(1200);
      expect(manager.size()).toBe(0);
      expect(manager.add(fakeSession('b'))).toBe(true);
      manager.dispose();
   });
});

describe('session manager: timers', () => {
   it('starts no timer until a session exists and none once the last session ended', async () => {
      const { manager } = makeManager();
      expect(vi.getTimerCount()).toBe(0);
      manager.add(fakeSession('a'));
      expect(vi.getTimerCount()).toBe(1);
      await manager.end('a');
      expect(vi.getTimerCount()).toBe(0);
   });

   it('starts a single timer however many sessions are added', () => {
      const { manager } = makeManager({ maxSessions: 10 });
      for (let index = 0; index < 5; index += 1) {
         manager.add(fakeSession(`s${index}`));
      }
      expect(vi.getTimerCount()).toBe(1);
      manager.dispose();
      expect(vi.getTimerCount()).toBe(0);
   });

   it('ends every session on dispose, clears the timer and closes a session added afterwards', async () => {
      const { manager, ended } = makeManager();
      const a = fakeSession('a');
      const b = fakeSession('b');
      manager.add(a);
      manager.add(b);
      manager.dispose();
      expect(ended.sort()).toEqual([
         'a',
         'b',
      ]);
      expect(a.close).toHaveBeenCalledTimes(1);
      expect(b.close).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      const late = fakeSession('late');
      manager.add(late);
      expect(late.close).toHaveBeenCalledTimes(1);
      expect(manager.size()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
   });
});

describe('debouncer', () => {
   /**
    * Create a debouncer that counts its runs.
    * @param {object} [options] - Overrides.
    * @returns {{ debouncer: ReturnType<typeof createDebouncer>, run: import('vitest').Mock }} The debouncer and the
    * mock it runs.
    */
   function makeDebouncer(options = {}) {
      const run = vi.fn();
      return {
         debouncer: createDebouncer({
            quietMs: 200,
            maxWaitMs: 1000,
            run,
            ...options,
         }),
         run,
      };
   }

   it('runs once after the quiet period for a burst of triggers', async () => {
      const { debouncer, run } = makeDebouncer();
      for (let index = 0; index < 10; index += 1) {
         debouncer.trigger();
         await vi.advanceTimersByTimeAsync(50);
      }
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(149);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
   });

   it('runs once for triggers in the same tick', async () => {
      const { debouncer, run } = makeDebouncer();
      debouncer.trigger();
      debouncer.trigger();
      debouncer.trigger();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(run).toHaveBeenCalledTimes(1);
   });

   it('runs once per burst when bursts are separated by more than the quiet period', async () => {
      const { debouncer, run } = makeDebouncer();
      debouncer.trigger();
      await vi.advanceTimersByTimeAsync(300);
      debouncer.trigger();
      debouncer.trigger();
      await vi.advanceTimersByTimeAsync(300);
      expect(run).toHaveBeenCalledTimes(2);
   });

   it('runs by the maximum wait even when triggers never pause', async () => {
      const { debouncer, run } = makeDebouncer();
      for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
         debouncer.trigger();
         await vi.advanceTimersByTimeAsync(100);
      }
      expect(run).toHaveBeenCalledTimes(1);
   });

   it('cancels a pending run and leaves no timer', async () => {
      const { debouncer, run } = makeDebouncer();
      debouncer.trigger();
      debouncer.cancel();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(run).not.toHaveBeenCalled();
   });

   it('accepts a trigger made by the run itself as the start of the next burst', async () => {
      let count = 0;
      const run = vi.fn(() => {
         count += 1;
         if (count === 1) {
            debouncer.trigger();
         }
      });
      const debouncer = createDebouncer({
         quietMs: 200,
         maxWaitMs: 1000,
         run,
      });
      debouncer.trigger();
      await vi.advanceTimersByTimeAsync(200);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(run).toHaveBeenCalledTimes(2);
   });
});
