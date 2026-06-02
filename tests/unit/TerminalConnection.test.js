import { describe, it, expect } from 'vitest';
import { TerminalConnection } from '~/bridge/TerminalConnection.svelte.js';
import {
   TERMINAL_LAUNCH,
   TERMINAL_INPUT,
   TERMINAL_CLOSE,
} from '$shared/protocol.js';

/**
 * Build a controllable fake Socket.IO socket.
 * @returns {{ socket: object, fire: (event: string, ...args: *[]) => void, sent: object[] }} Test helpers.
 */
function makeFakeSocket() {
   const handlers = {};
   const sent = [];
   const socket = {
      on(event, fn) {
         (handlers[event] ??= []).push(fn);
      },
      emit(event, payload) {
         sent.push({ event, payload });
      },
   };
   const fire = (event, ...args) => {
      (handlers[event] ?? []).forEach((fn) => fn(...args));
   };
   return { socket, fire, sent };
}

describe('TerminalConnection', () => {
   it('tracks running state from TERMINAL_STATE and TERMINAL_EXIT', () => {
      const { socket, fire } = makeFakeSocket();
      const conn = new TerminalConnection();
      conn.connect('http://localhost:31416', () => socket);
      fire('connect');
      expect(conn.status).toBe('connected');
      expect(conn.running).toBe(false);
      fire('terminal:state', { running: true, cols: 80, rows: 24 });
      expect(conn.running).toBe(true);
      fire('terminal:exit', { code: 0 });
      expect(conn.running).toBe(false);
   });

   it('buffers output and replays it to a newly attached sink', () => {
      const { socket, fire } = makeFakeSocket();
      const conn = new TerminalConnection();
      conn.connect('http://localhost:31416', () => socket);
      fire('connect');
      fire('terminal:data', { chunk: 'abc' });
      const writes = [];
      conn.attach((chunk) => writes.push(chunk));
      expect(writes.join('')).toBe('abc');
      fire('terminal:data', { chunk: 'de' });
      expect(writes.join('')).toBe('abcde');
   });

   it('emits launch / input / close events', () => {
      const { socket, fire, sent } = makeFakeSocket();
      const conn = new TerminalConnection();
      conn.connect('http://localhost:31416', () => socket);
      fire('connect');
      conn.launch('claude');
      conn.sendInput('x');
      conn.close();
      const events = sent.map((s) => s.event);
      expect(events).toContain(TERMINAL_LAUNCH);
      expect(events).toContain(TERMINAL_INPUT);
      expect(events).toContain(TERMINAL_CLOSE);
   });

   it('fans out output to multiple attached sinks (docked + popout)', () => {
      const { socket, fire } = makeFakeSocket();
      const conn = new TerminalConnection();
      conn.connect('http://localhost:31416', () => socket);
      fire('connect');
      const a = [];
      const b = [];
      conn.attach((chunk) => a.push(chunk));
      conn.attach((chunk) => b.push(chunk));
      fire('terminal:data', { chunk: 'hello' });
      expect(a.join('')).toBe('hello');
      expect(b.join('')).toBe('hello');
   });
});
