import * as pty from 'node-pty';
import type { Server, Socket } from 'socket.io';
import {
   TERMINAL_LAUNCH,
   TERMINAL_INPUT,
   TERMINAL_RESIZE,
   TERMINAL_CLOSE,
   TERMINAL_DATA,
   TERMINAL_STATE,
   TERMINAL_EXIT,
} from '../shared/protocol.js';
import { resolvePtyOptions } from './ptyOptions.ts';
import { resolveSpawn } from './spawnCommand.ts';
import { isSafeConfigPath, planMcpWiring, wireMcpConfig, type McpWiringPlan } from './mcpWiring.ts';
import { writeMcpConfig } from './mcpConfigFile.ts';

// Maximum bytes of recent PTY output retained for reattach replay.
const SCROLLBACK_LIMIT: number = 64 * 1024;

interface LaunchPayload {
   command?: string;
   cols: number;
   rows: number;
}

/** Options for the terminal manager. */
export interface TerminalManagerOptions {
   /** The MCP port to auto-wire into a launched `claude`; when unset, commands are spawned unchanged. */
   mcpPort?: number;
   /** Writes the MCP config file for a port under a root and returns its path; defaults to `writeMcpConfig`. */
   writeConfig?: (mcpPort: number, root?: string) => string;
   /** The directory containing `.wiretap/`; defaults to the module root. */
   configRoot?: string;
}

interface ResizePayload {
   cols: number;
   rows: number;
}

interface InputPayload {
   data: string;
}

/**
 * Create the single-PTY terminal manager bound to a Socket.IO server. Spawns at most one PTY, broadcasts
 * its output to all connected sockets, retains a scrollback buffer for reattach, and accepts input/resize/
 * close from any socket.
 * @param {Server} io - The Socket.IO server used to broadcast terminal events.
 * @param {typeof pty.spawn} [spawn] - The PTY spawner, injectable for testing; defaults to `pty.spawn`.
 * @param {TerminalManagerOptions} [options] - Optional MCP auto-wiring settings; a plain `claude` launch gets
 *        `--mcp-config` appended.
 * @returns {{ handleConnection: (socket: Socket) => void; dispose: () => void }} The manager with a per-socket
 *          connection handler and a dispose method.
 */
export function createTerminalManager(
   io: Server,
   spawn: typeof pty.spawn = pty.spawn,
   options: TerminalManagerOptions = {},
): { handleConnection: (socket: Socket) => void; dispose: () => void } {
   // The running PTY, or null when none is running.
   let term: pty.IPty | null = null;
   // Recent PTY output replayed to a reattaching client.
   let scrollback: string = '';
   // The last known terminal dimensions.
   let size: ResizePayload = { cols: 80, rows: 24 };
   /**
    * Auto-wire the MCP endpoint into an allowlisted `claude` command. The config file is (re)written on every
    * wired launch. Returns the command unchanged (and logs why when the cause is a skipped command line, an
    * unquotable config path or a failed config write) when no MCP port is configured, the command is not `claude`, or
    * the config file cannot be written.
    * @param {string} command - The command line requested for launch.
    * @returns {string} The command line to spawn.
    */
   function withMcpWiring(command: string): string {
      // The configured MCP port, if any.
      const mcpPort: number | undefined = options.mcpPort;
      if (mcpPort === undefined || mcpPort <= 0) {
         return command;
      }
      // The wiring decision for this command line.
      const plan: McpWiringPlan = planMcpWiring(command);
      if (plan.kind === 'not-claude') {
         return command;
      }
      if (plan.kind === 'skip') {
         console.warn(`Wiretap sidecar | MCP auto-wiring skipped: ${plan.reason}`);
         return command;
      }
      try {
         // The config writer; defaults to the module-local owner-only writer.
         const writeConfig: (port: number, root?: string) => string = options.writeConfig ?? writeMcpConfig;
         // The config file path, rewritten on every wired launch.
         const file: string = writeConfig(mcpPort, options.configRoot);
         if (!isSafeConfigPath(file)) {
            console.warn('Wiretap sidecar | MCP auto-wiring skipped: the config path cannot be safely quoted');
            return command;
         }
         return wireMcpConfig(command, file);
      } catch (error) {
         console.error('Wiretap sidecar | could not write the MCP config file; launching claude without it:', error);
         return command;
      }
   }

   /**
    * Append a chunk to the scrollback buffer, trimming to the byte cap.
    * @param {string} chunk - The output chunk to retain.
    */
   function appendScrollback(chunk: string): void {
      scrollback += chunk;
      if (scrollback.length > SCROLLBACK_LIMIT) {
         scrollback = scrollback.slice(scrollback.length - SCROLLBACK_LIMIT);
      }
   }

   /**
    * Spawn the PTY if none is running. A payload that is not an object, or whose `command` is neither absent nor a
    * string, launches nothing: the payload comes from an untrusted socket event.
    * @param {LaunchPayload} payload - The launch parameters.
    */
   function launch(payload: LaunchPayload): void {
      if (term) {
         return;
      }
      if (
         typeof payload !== 'object' ||
         payload === null ||
         (payload.command !== undefined && typeof payload.command !== 'string')
      ) {
         console.warn('Wiretap sidecar | terminal launch ignored: the payload command is not a string');
         return;
      }
      // The command line to spawn, with the MCP config wired in when applicable.
      const command: string = withMcpWiring(payload.command ?? 'claude');
      size = { cols: payload.cols, rows: payload.rows };
      scrollback = '';
      // The spawn executable and arguments for the host platform.
      const { file, args }: { file: string; args: string[] | string } = resolveSpawn(
         command,
         process.platform,
         process.env.ComSpec,
      );
      // The spawned PTY.
      const child: pty.IPty = spawn(file, args, {
         name: 'xterm-color',
         cols: size.cols,
         rows: size.rows,
         cwd: process.cwd(),
         env: process.env as { [key: string]: string },
         ...resolvePtyOptions(process.platform, process.env),
      });
      term = child;
      child.onData((chunk) => {
         appendScrollback(chunk);
         io.emit(TERMINAL_DATA, { chunk });
      });
      child.onExit(({ exitCode, signal }) => {
         term = null;
         scrollback = '';
         io.emit(TERMINAL_EXIT, { code: exitCode, signal: signal ? String(signal) : undefined });
         io.emit(TERMINAL_STATE, { running: false });
      });
      io.emit(TERMINAL_STATE, { running: true, cols: size.cols, rows: size.rows });
   }

   return {
      handleConnection(socket: Socket): void {
         // Report current state and replay scrollback so a fresh/reconnecting client reattaches.
         socket.emit(TERMINAL_STATE, { running: term !== null, cols: size.cols, rows: size.rows });
         if (term && scrollback) {
            socket.emit(TERMINAL_DATA, { chunk: scrollback });
         }
         socket.on(TERMINAL_LAUNCH, (payload: LaunchPayload) => launch(payload));
         socket.on(TERMINAL_INPUT, (payload: InputPayload) => term?.write(payload.data));
         socket.on(TERMINAL_RESIZE, (payload: ResizePayload) => {
            size = { cols: payload.cols, rows: payload.rows };
            term?.resize(payload.cols, payload.rows);
         });
         socket.on(TERMINAL_CLOSE, () => term?.kill());
      },

      /**
       * Tear down the manager: kill any running PTY and clear retained state. State is cleared even if the kill
       * throws (the kill error then propagates). Safe to call multiple times; a second call is a no-op. The MCP
       * config file is left in place.
       * @returns {void}
       */
      dispose(): void {
         try {
            term?.kill();
         } finally {
            term = null;
            scrollback = '';
         }
      },
   };
}
