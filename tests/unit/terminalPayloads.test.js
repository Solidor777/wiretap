// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTerminalManager } from '../../server/terminal.ts';
import { TERMINAL_LAUNCH, TERMINAL_INPUT, TERMINAL_RESIZE, TERMINAL_STATE } from '$shared/protocol.js';

/** @type {unknown[]} Payloads that are not objects. */
const NON_OBJECTS = [undefined, null, 'text', 42, true, ['a'], [80, 24]];

/** @type {unknown[]} Sizes that are not finite positive integers within 1..1000. */
const BAD_SIZES = [0, -1, 1.5, NaN, Infinity, -Infinity, 1001, 1e9, '80', null, true, {}, [80]];

describe('terminal socket payload validation', () => {
   /** @type {import('vitest').MockInstance} Silences and records console.warn output. */
   let warnSpy;

   beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
   });

   afterEach(() => {
      vi.restoreAllMocks();
   });

   /**
    * Create a manager with a fake spawner and a connected fake socket.
    * @returns {{ spawn: Function, handlers: object, child: object, socket: object }} The spies and handlers.
    */
   function createManager() {
      const child = { onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
      const spawn = vi.fn(() => child);
      const handlers = {};
      const socket = {
         emit: vi.fn(),
         on: (event, fn) => {
            handlers[event] = fn;
         },
      };
      createTerminalManager({ emit: vi.fn() }, spawn).handleConnection(socket);
      return { spawn, handlers, child, socket };
   }

   describe('input', () => {
      it.each(NON_OBJECTS.map((payload) => [payload]))('ignores payload %j without throwing', (payload) => {
         const { handlers, child } = createManager();
         handlers[TERMINAL_LAUNCH]({ command: 'x', cols: 80, rows: 24 });
         expect(() => handlers[TERMINAL_INPUT](payload)).not.toThrow();
         expect(child.write).not.toHaveBeenCalled();
         expect(warnSpy).toHaveBeenCalledTimes(1);
      });

      it.each([[undefined], [null], [42], [['a']], [{ a: 1 }]])('ignores a non-string data %j', (data) => {
         const { handlers, child } = createManager();
         handlers[TERMINAL_LAUNCH]({ command: 'x', cols: 80, rows: 24 });
         expect(() => handlers[TERMINAL_INPUT]({ data })).not.toThrow();
         expect(child.write).not.toHaveBeenCalled();
         expect(warnSpy).toHaveBeenCalledTimes(1);
      });

      it('writes a string to the PTY', () => {
         const { handlers, child } = createManager();
         handlers[TERMINAL_LAUNCH]({ command: 'x', cols: 80, rows: 24 });
         handlers[TERMINAL_INPUT]({ data: 'ls\r' });
         expect(child.write).toHaveBeenCalledWith('ls\r');
         expect(warnSpy).not.toHaveBeenCalled();
      });

      it('logs a fixed message that carries no payload text', () => {
         const { handlers } = createManager();
         handlers[TERMINAL_INPUT]('ATTACKER-TEXT');
         expect(warnSpy).toHaveBeenCalledTimes(1);
         expect(String(warnSpy.mock.calls[0])).not.toContain('ATTACKER-TEXT');
      });
   });

   describe('resize', () => {
      it.each(NON_OBJECTS.map((payload) => [payload]))('ignores payload %j without throwing', (payload) => {
         const { handlers, child } = createManager();
         handlers[TERMINAL_LAUNCH]({ command: 'x', cols: 80, rows: 24 });
         expect(() => handlers[TERMINAL_RESIZE](payload)).not.toThrow();
         expect(child.resize).not.toHaveBeenCalled();
         expect(warnSpy).toHaveBeenCalledTimes(1);
      });

      it.each(BAD_SIZES.map((size) => [size]))('ignores an invalid cols or rows %j', (bad) => {
         const { handlers, child } = createManager();
         handlers[TERMINAL_LAUNCH]({ command: 'x', cols: 80, rows: 24 });
         expect(() => handlers[TERMINAL_RESIZE]({ cols: bad, rows: 24 })).not.toThrow();
         expect(() => handlers[TERMINAL_RESIZE]({ cols: 80, rows: bad })).not.toThrow();
         expect(child.resize).not.toHaveBeenCalled();
         expect(warnSpy).toHaveBeenCalledTimes(2);
      });

      it('keeps the stored size when a resize is invalid', () => {
         const child = { onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
         const manager = createTerminalManager({ emit: vi.fn() }, vi.fn(() => child));
         const handlers = {};
         manager.handleConnection({
            emit: vi.fn(),
            on: (event, fn) => {
               handlers[event] = fn;
            },
         });
         handlers[TERMINAL_LAUNCH]({ command: 'x', cols: 100, rows: 30 });
         handlers[TERMINAL_RESIZE]({ cols: NaN, rows: 5 });
         handlers[TERMINAL_RESIZE](undefined);
         // The state emitted to a new connection carries the stored size.
         const fresh = { emit: vi.fn(), on: vi.fn() };
         manager.handleConnection(fresh);
         expect(fresh.emit).toHaveBeenCalledWith(TERMINAL_STATE, expect.objectContaining({ cols: 100, rows: 30 }));
      });

      it('applies and stores a valid resize, including the 1 and 1000 bounds', () => {
         const { handlers, child } = createManager();
         handlers[TERMINAL_LAUNCH]({ command: 'x', cols: 80, rows: 24 });
         handlers[TERMINAL_RESIZE]({ cols: 1, rows: 1000 });
         expect(child.resize).toHaveBeenCalledWith(1, 1000);
         expect(warnSpy).not.toHaveBeenCalled();
      });
   });

   describe('launch size', () => {
      it.each(BAD_SIZES.map((size) => [size]))('launches nothing for an invalid cols or rows %j', (bad) => {
         const { handlers, spawn } = createManager();
         expect(() => handlers[TERMINAL_LAUNCH]({ command: 'x', cols: bad, rows: 24 })).not.toThrow();
         expect(() => handlers[TERMINAL_LAUNCH]({ command: 'x', cols: 80, rows: bad })).not.toThrow();
         expect(spawn).not.toHaveBeenCalled();
         expect(warnSpy).toHaveBeenCalledTimes(2);
      });

      it('launches with the stored size when cols and rows are absent', () => {
         const { handlers, spawn } = createManager();
         handlers[TERMINAL_LAUNCH]({ command: 'x' });
         expect(spawn).toHaveBeenCalledTimes(1);
         expect(spawn.mock.calls[0][2]).toMatchObject({ cols: 80, rows: 24 });
         expect(warnSpy).not.toHaveBeenCalled();
      });
   });
});
