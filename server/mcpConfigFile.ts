import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMcpConfig, mcpConfigFileName } from './mcpWiring.ts';

// Name of the module-local directory holding the MCP config file, relative to the config root.
const CONFIG_DIR_NAME: string = '.wiretap';

/**
 * Resolve the module root, the parent of `server/`, from this file's own URL. It never depends on the working
 * directory, so the config lands in the module regardless of where the sidecar is started.
 * @returns {string} The absolute path of the module root.
 */
export function defaultConfigRoot(): string {
   return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Throw when a path is a symbolic link; a missing path (ENOENT) is accepted.
 * @param {string} target - The path to inspect with `lstat` (the link itself, never its destination).
 * @returns {void}
 * @throws {Error} When the path is a symbolic link, or `lstat` fails for a reason other than ENOENT.
 */
function refuseSymbolicLink(target: string): void {
   try {
      if (fs.lstatSync(target).isSymbolicLink()) {
         throw new Error(`refusing to write the MCP config: ${target} is a symbolic link`);
      }
   } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
         throw error;
      }
   }
}

/**
 * Write the Wiretap MCP config file for the given port to `<root>/.wiretap/mcp-<port>.json` and return its path.
 * The directory is created recursively with mode 0o700 and the file is written with mode 0o600 and overwritten on
 * every call (Windows ignores POSIX modes and relies on the module directory ACL). The modes apply only when the
 * directory or file is created; an existing directory or file keeps its mode. The `.wiretap` directory and the file
 * path are each checked with `lstat` and refused when they are symbolic links. Residual risk: the check and the
 * write are separate calls (time-of-check to time-of-use), so a link swapped in between is not caught; no
 * `O_NOFOLLOW` open is used. Nothing is ever removed.
 * @param {number} mcpPort - The loopback port the Wiretap MCP server listens on.
 * @param {string} [root] - The directory that contains `.wiretap/`; defaults to the module root.
 * @returns {string} The absolute path of the written config file.
 * @throws {Error} When `.wiretap` or the file path is a symbolic link, or the directory cannot be created or the file
 *         written.
 */
export function writeMcpConfig(mcpPort: number, root: string = defaultConfigRoot()): string {
   // The directory that holds the config file.
   const dir: string = path.join(root, CONFIG_DIR_NAME);
   fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
   refuseSymbolicLink(dir);
   // The config file path.
   const file: string = path.join(dir, mcpConfigFileName(mcpPort));
   refuseSymbolicLink(file);
   fs.writeFileSync(file, buildMcpConfig(mcpPort), { mode: 0o600 });
   return file;
}
