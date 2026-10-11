/** The configuration of a log throttle. */
export interface LogThrottleOptions {
   // Receives each line that is allowed through, and each summary line.
   log: (line: string) => void;
   // The clock, in epoch milliseconds.
   now: () => number;
   // Maximum lines written per window.
   limit: number;
   // Length of one window in milliseconds.
   windowMs: number;
   // Plural noun naming what the suppressed lines reported, used in the summary line.
   noun: string;
}

/**
 * Create a fixed-window log throttle for lines an unauthenticated caller can trigger, so that caller cannot write
 * unbounded log output. The first `limit` lines of a window are written; later ones are counted. The summary
 * `Wiretap sidecar | <N> further <noun> suppressed` is written once, by the first call after the window ended (no
 * timer is used, so a window with no later call writes no summary).
 * @param {LogThrottleOptions} options - The sink, clock, limits and noun.
 * @returns {(line: string) => void} A function that writes a line subject to the throttle.
 */
export function createLogThrottle(options: LogThrottleOptions): (line: string) => void {
   // Start time of the current window, in epoch milliseconds; null before the first line.
   let windowStart: number | null = null;
   // Lines written in the current window.
   let written: number = 0;
   // Lines dropped in the current window.
   let suppressed: number = 0;
   return (line: string): void => {
      // The current clock reading.
      const time: number = options.now();
      if (windowStart === null || time - windowStart >= options.windowMs) {
         if (suppressed > 0) {
            options.log(`Wiretap sidecar | ${suppressed} further ${options.noun} suppressed`);
         }
         windowStart = time;
         written = 0;
         suppressed = 0;
      }
      if (written < options.limit) {
         written++;
         options.log(line);
      } else {
         suppressed++;
      }
   };
}
