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

// Maximum bytes of recent PTY output retained for reattach replay.
const SCROLLBACK_LIMIT = 64 * 1024;

interface LaunchPayload {
   command?: string;
   cols: number;
   rows: number;
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
 * @param io - The Socket.IO server used to broadcast terminal events.
 * @returns The manager with a per-socket connection handler.
 */
export function createTerminalManager(io: Server): { handleConnection: (socket: Socket) => void } {
   let term: pty.IPty | null = null;
   let scrollback = '';
   let size = { cols: 80, rows: 24 };

   /**
    * Append a chunk to the scrollback buffer, trimming to the byte cap.
    * @param chunk - The output chunk to retain.
    */
   function appendScrollback(chunk: string): void {
      scrollback += chunk;
      if (scrollback.length > SCROLLBACK_LIMIT) {
         scrollback = scrollback.slice(scrollback.length - SCROLLBACK_LIMIT);
      }
   }

   /**
    * Spawn the PTY if none is running.
    * @param payload - The launch parameters.
    */
   function launch(payload: LaunchPayload): void {
      if (term) {
         return;
      }
      const command = payload.command ?? 'claude';
      size = { cols: payload.cols, rows: payload.rows };
      scrollback = '';
      const { file, args } = resolveSpawn(command, process.platform, process.env.ComSpec);
      const child = pty.spawn(file, args, {
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
   };
}
