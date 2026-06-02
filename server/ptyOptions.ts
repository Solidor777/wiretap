/**
 * Selects the node-pty Windows backend. node-pty defaults to ConPTY on Win10+, which on this stack
 * intermittently severs long-lived PTYs (the ConPTY-only `conpty_console_list` agent crashes); winpty and the
 * bundled ConPTY DLL are alternatives. The default is chosen by measurement (see the PTY-hardening spec) and
 * overridable via WIRETAP_PTY_BACKEND for measurement and debugging. Pure (no node-pty import) so it is
 * unit-testable without loading the native addon.
 */

/**
 * The selectable Windows PTY backends.
 * @typedef {'conpty' | 'conpty-dll' | 'winpty'} PtyBackend
 */
export type PtyBackend = 'conpty' | 'conpty-dll' | 'winpty';

/**
 * The default Windows backend, set by measurement. 'conpty' is node-pty's own default (no extra options).
 */
export const DEFAULT_BACKEND: PtyBackend = 'conpty';

/**
 * node-pty spawn options per backend (Windows only).
 */
const BACKEND_OPTIONS: Record<PtyBackend, object> = {
   'conpty': {},
   'conpty-dll': { useConptyDll: true },
   'winpty': { useConpty: false },
};

/**
 * Resolve the node-pty Windows backend spawn options.
 * @param platform - The host platform (e.g. process.platform).
 * @param env - The process environment (read for WIRETAP_PTY_BACKEND).
 * @returns The backend spawn options to spread into pty.spawn; {} off Windows.
 */
export function resolvePtyOptions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): object {
   if (platform !== 'win32') {
      return {};
   }
   const requested = env.WIRETAP_PTY_BACKEND;
   const backend: PtyBackend = requested && Object.prototype.hasOwnProperty.call(BACKEND_OPTIONS, requested)
      ? (requested as PtyBackend)
      : DEFAULT_BACKEND;
   return BACKEND_OPTIONS[backend];
}
