/**
 * Run a sidecar teardown and then exit. The exit always happens, even when the teardown throws, so a signal can never
 * leave the process alive with a half-closed server.
 * @param {() => void} dispose - The teardown to run.
 * @param {(code: number) => void} exit - Terminates the process with the given code.
 * @returns {void}
 */
export function shutdown(dispose: () => void, exit: (code: number) => void): void {
   try {
      dispose();
   } catch (error) {
      console.error('Wiretap sidecar | error while shutting down:', error);
   } finally {
      exit(0);
   }
}

/**
 * Wait for a sidecar to finish binding its ports. On success `onReady` runs; on failure the cause is logged with the
 * Wiretap prefix, the sidecar is disposed (a dispose error is logged, not rethrown) and the process exits with code 1.
 * @param {{ ready: Promise<void>; dispose: () => void }} server - The started sidecar.
 * @param {() => void} onReady - Runs only after every port is bound.
 * @param {(code: number) => void} exit - Terminates the process with the given code.
 * @returns {Promise<void>} Resolves after `onReady` ran, or after `exit` was called on failure.
 */
export async function awaitStartup(
   server: { ready: Promise<void>; dispose: () => void },
   onReady: () => void,
   exit: (code: number) => void,
): Promise<void> {
   try {
      await server.ready;
   } catch (error) {
      console.error(`Wiretap sidecar | failed to start: ${(error as Error).message}`);
      try {
         server.dispose();
      } catch (disposeError) {
         console.error('Wiretap sidecar | error while releasing ports after a failed start:', disposeError);
      } finally {
         exit(1);
      }
      return;
   }
   onReady();
}
