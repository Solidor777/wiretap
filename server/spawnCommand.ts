/**
 * Resolves a user command string into a PTY spawn file + args. On Windows the args are returned as a single
 * command-line STRING (not an array) so node-pty passes them to the command processor verbatim — node-pty's
 * array-to-command-line escaping mangles embedded quotes (e.g. `node -e "..."`), which truncated such
 * commands. POSIX returns an array (node-pty hands it straight to execvp, so there is no escaping issue).
 * Pure (no node-pty import) so it is unit-testable without loading the native addon.
 */

/**
 * Resolve a command line into a PTY spawn file + args.
 * @param command - The command line to run.
 * @param platform - The host platform (e.g. process.platform).
 * @param comspec - The Windows command processor path (e.g. process.env.ComSpec); defaults to cmd.exe.
 * @returns The spawn file and args — a verbatim command-line string on Windows, an argument array on POSIX.
 */
export function resolveSpawn(
   command: string,
   platform: NodeJS.Platform,
   comspec: string | undefined,
): { file: string; args: string[] | string } {
   if (platform === 'win32') {
      return { file: comspec ?? 'cmd.exe', args: `/c ${command}` };
   }
   return { file: '/bin/sh', args: ['-c', command] };
}
