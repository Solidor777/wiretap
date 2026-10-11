// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { shutdown } from '../../server/shutdown.ts';

describe('shutdown', () => {
   afterEach(() => {
      vi.restoreAllMocks();
   });

   it('disposes and then exits with code 0', () => {
      /** @type {string[]} The order in which the steps ran. */
      const order = [];
      shutdown(
         () => order.push('dispose'),
         () => order.push('exit'),
      );
      expect(order).toEqual(['dispose', 'exit']);
   });

   it('logs the error and still exits with code 0 when dispose throws', () => {
      /** @type {import('vitest').MockInstance} Silences and records console.error output. */
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      /** @type {import('vitest').Mock} The exit function. */
      const exit = vi.fn();
      shutdown(() => {
         throw new Error('dispose failed');
      }, exit);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
   });
});
