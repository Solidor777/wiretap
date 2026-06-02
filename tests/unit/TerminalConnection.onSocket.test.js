import { describe, it, expect } from 'vitest';
import { TerminalConnection } from '~/bridge/TerminalConnection.svelte.js';

/**
 * Build a controllable fake Socket.IO socket.
 * @returns {{ socket: object, fire: (event: string, ...args: *[]) => void }} Test helpers.
 */
function makeFakeSocket() {
   const handlers = {};
   const socket = {
      connected: false,
      on(event, fn) { (handlers[event] ??= []).push(fn); },
      emit() {},
   };
   const fire = (event, ...args) => (handlers[event] ?? []).forEach((fn) => fn(...args));
   return { socket, fire };
}

describe('TerminalConnection.onSocket', () => {
   it('invokes the listener with the socket created by connect()', () => {
      const { socket } = makeFakeSocket();
      const conn = new TerminalConnection();
      let received = null;
      conn.onSocket((s) => { received = s; });
      conn.connect('http://localhost:31416', () => socket);
      expect(received).toBe(socket);
   });

   it('invokes a listener registered after connect with the existing socket', () => {
      const { socket } = makeFakeSocket();
      const conn = new TerminalConnection();
      conn.connect('http://localhost:31416', () => socket);
      let received = null;
      conn.onSocket((s) => { received = s; });
      expect(received).toBe(socket);
   });
});
