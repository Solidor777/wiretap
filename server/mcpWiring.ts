/**
 * Pure helpers that auto-wire Wiretap's MCP endpoint into a terminal-launched `claude` command. No fs and no
 * node-pty import, so they are unit-testable without touching the disk or loading the native addon.
 * Flag and schema source: `claude --help` (`--mcp-config <configs...>` loads MCP servers from JSON files) and
 * `claude mcp add --help` (`--transport http` is the HTTP transport type).
 */

// Matches an `--mcp-config` argument in either the space-separated or `=` form.
const MCP_CONFIG_FLAG: RegExp = /(?:^|\s)--mcp-config(?:\s|=|$)/;

// The executable must be exactly `claude`: followed by whitespace or the end of the command line.
const CLAUDE_EXECUTABLE: RegExp = /^claude(?=\s|$)/;

// Allowlist of a wireable command line: `claude` followed by space/tab-separated tokens made solely of these
// characters. cmd.exe and sh disagree about quoting and about which characters are special, so the rule names what is
// provably inert in both shells instead of enumerating what is dangerous. Quoted arguments are therefore not wired.
const ALLOWLISTED_COMMAND: RegExp = /^claude(?:[ \t]+[A-Za-z0-9._:=/@+,-]+)*$/;

// A standalone `--` argument ends option parsing, so an appended `--mcp-config` would become a positional argument.
const STANDALONE_DOUBLE_DASH: RegExp = /(?:^|\s)--(?:\s|$)/;

// Characters that cannot be safely placed inside the double-quoted config path on any platform: `"` closes the
// quote, `%` is expanded by cmd.exe even inside quotes.
const UNSAFE_PATH_ANY: RegExp = /["%]/;

// Characters additionally special to `sh` inside double quotes: `$` and the backtick expand, and a backslash escapes
// the following character, so a path containing one would not reach `claude` verbatim.
const UNSAFE_PATH_POSIX: RegExp = /[$`\\]/;

/** The decision for one command line: wire it, skip it for a stated reason, or leave a non-`claude` command alone. */
export type McpWiringPlan = { kind: 'wire' } | { kind: 'skip'; reason: string } | { kind: 'not-claude' };

/**
 * Build the JSON text of an MCP config file registering the Wiretap HTTP endpoint.
 * @param {number} mcpPort - The loopback port the Wiretap MCP server listens on.
 * @returns {string} The JSON config text.
 */
export function buildMcpConfig(mcpPort: number): string {
   return JSON.stringify({
      mcpServers: {
         wiretap: {
            type: 'http',
            url: `http://127.0.0.1:${mcpPort}/mcp`,
         },
      },
   });
}

/**
 * Derive the config file name from the MCP port so concurrent sidecars on different ports do not collide.
 * @param {number} mcpPort - The loopback port the Wiretap MCP server listens on.
 * @returns {string} The file name (no directory).
 */
export function mcpConfigFileName(mcpPort: number): string {
   return `mcp-${mcpPort}.json`;
}

/**
 * Classify a command line for MCP auto-wiring. This is the single place the command line is judged: only the bare
 * `claude` executable followed by allowlisted tokens (`[A-Za-z0-9._:=/@+,-]`) is wired. A standalone `--` and an
 * existing `--mcp-config` are skipped because an appended flag would be ignored or conflict.
 * @param {string} command - The command line to launch.
 * @returns {McpWiringPlan} `wire`, `skip` with the reason, or `not-claude` for any other executable.
 */
export function planMcpWiring(command: string): McpWiringPlan {
   // The command without surrounding whitespace.
   const trimmed: string = command.trim();
   if (!CLAUDE_EXECUTABLE.test(trimmed)) {
      return { kind: 'not-claude' };
   }
   if (!ALLOWLISTED_COMMAND.test(trimmed)) {
      return {
         kind: 'skip',
         reason:
            'the command line has characters outside the allowlist [A-Za-z0-9._:=/@+,-] ' +
            '(quotes and shell metacharacters are never wired)',
      };
   }
   if (STANDALONE_DOUBLE_DASH.test(trimmed)) {
      return { kind: 'skip', reason: 'the command contains a standalone -- argument' };
   }
   if (MCP_CONFIG_FLAG.test(trimmed)) {
      return { kind: 'skip', reason: 'the command already passes --mcp-config' };
   }
   return { kind: 'wire' };
}

/**
 * Report whether a config path can be placed inside double quotes in the platform's shell without being altered:
 * rejects `"` and `%` everywhere and, on POSIX, `$`, the backtick and the backslash. This is the only path-safety
 * check.
 * @param {string} configPath - The absolute path of the MCP config file.
 * @param {NodeJS.Platform} [platform] - The host platform; defaults to `process.platform`.
 * @returns {boolean} True when the quoted path reaches `claude` verbatim.
 */
export function isSafeConfigPath(configPath: string, platform: NodeJS.Platform = process.platform): boolean {
   if (UNSAFE_PATH_ANY.test(configPath)) {
      return false;
   }
   return platform === 'win32' || !UNSAFE_PATH_POSIX.test(configPath);
}

/**
 * Append `--mcp-config "<configPath>"` to a command line. The path is double-quoted so a path containing
 * spaces survives the verbatim Windows command line built by `resolveSpawn` and the POSIX `sh -c` string. Performs no
 * checks: the caller must have received `wire` from `planMcpWiring` and a true `isSafeConfigPath`.
 * @param {string} command - The allowlisted `claude` command line.
 * @param {string} configPath - The absolute, safely quotable path of the MCP config file.
 * @returns {string} The command line to spawn.
 */
export function wireMcpConfig(command: string, configPath: string): string {
   return `${command.trim()} --mcp-config "${configPath}"`;
}
