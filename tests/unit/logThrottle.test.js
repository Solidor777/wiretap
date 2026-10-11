// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createLogThrottle } from '../../server/logThrottle.ts';

/**
 * Build a throttle over a recording log sink and a controllable clock.
 * @param {number} [limit] - Lines allowed per window.
 * @returns {{ write: (line: string) => void, lines: string[], advance: (ms: number) => void }} The throttle harness.
 */
function setup(limit = 10) {
   /** @type {string[]} The lines that reached the sink. */
   const lines = [];
   /** @type {number} The injected clock reading in milliseconds. */
   let clock = 1_000_000;
   const write = createLogThrottle({
      log: (line) => lines.push(line),
      now: () => clock,
      limit,
      windowMs: 60_000,
      noun: 'refusals',
   });
   return { write, lines, advance: (ms) => (clock += ms) };
}

describe('createLogThrottle', () => {
   it('writes the first `limit` lines of a window and drops the rest', () => {
      const { write, lines } = setup(3);
      for (let i = 0; i < 8; i++) {
         write(`line ${i}`);
      }
      expect(lines).toEqual(['line 0', 'line 1', 'line 2']);
   });

   it('writes exactly one "N further refusals suppressed" line when the window rolls over', () => {
      const { write, lines, advance } = setup(3);
      for (let i = 0; i < 8; i++) {
         write(`line ${i}`);
      }
      advance(59_000);
      write('still in window');
      expect(lines).toHaveLength(3);
      advance(2_000);
      write('next window');
      expect(lines).toEqual([
         'line 0',
         'line 1',
         'line 2',
         'Wiretap sidecar | 6 further refusals suppressed',
         'next window',
      ]);
   });

   it('writes no summary for a window in which nothing was suppressed', () => {
      const { write, lines, advance } = setup(3);
      write('a');
      advance(61_000);
      write('b');
      expect(lines).toEqual(['a', 'b']);
   });

   it('writes no second summary for a window that ended long ago', () => {
      const { write, lines, advance } = setup(1);
      write('a');
      write('b');
      advance(600_000);
      write('c');
      write('d');
      advance(600_000);
      write('e');
      expect(lines.filter((line) => line.includes('suppressed'))).toEqual([
         'Wiretap sidecar | 1 further refusals suppressed',
         'Wiretap sidecar | 1 further refusals suppressed',
      ]);
   });
});
