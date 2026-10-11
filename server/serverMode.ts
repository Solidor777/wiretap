/** Sidecar run mode: `full` serves terminal + MCP; `mcp-only` serves MCP and the Foundry bridge only. */
export type ServerMode = 'full' | 'mcp-only';

/**
 * Resolve the sidecar mode from the CLI arguments and environment. The `--mcp-only` argument wins over
 * `WIRETAP_MODE`; an unset `WIRETAP_MODE` means `full`.
 * @param {string[]} argv - The CLI arguments after the script name.
 * @param {Record<string, string | undefined>} env - The process environment.
 * @returns {ServerMode} The selected mode.
 * @throws {Error} When `WIRETAP_MODE` is set to an unknown value and no argument overrides it.
 */
export function resolveMode(argv: string[], env: Record<string, string | undefined>): ServerMode {
   if (argv.includes('--mcp-only')) {
      return 'mcp-only';
   }
   // The requested mode from the environment, if any.
   const value: string | undefined = env.WIRETAP_MODE;
   if (value === undefined || value === 'full') {
      return 'full';
   }
   if (value === 'mcp-only') {
      return 'mcp-only';
   }
   throw new Error(`Invalid WIRETAP_MODE "${value}": expected "mcp-only" or "full".`);
}
