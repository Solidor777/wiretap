import { describe, it, expect } from 'vitest';
import { WiretapConnection } from '~/bridge/WiretapConnection.svelte.js';

/**
 * Build a controllable fake Socket.IO socket for injection.
 * @returns {{ socket: object, fire: (event: string, ...args: *[]) => void, sent: object[] }} Test helpers.
 */
function makeFakeSocket() {
   const handlers = {};
   const sent = [];
   const socket = {
      on(event, fn) {
         (handlers[event] ??= []).push(fn);
      },
      emit(event, payload, ack) {
         sent.push({ event, payload, ack });
      },
   };
   const fire = (event, ...args) => {
      (handlers[event] ?? []).forEach((fn) => fn(...args));
   };
   return { socket, fire, sent };
}

describe('WiretapConnection', () => {
   // Status must track the socket lifecycle events.
   it('transitions status on connect and disconnect', () => {
      const { socket, fire } = makeFakeSocket();
      const conn = new WiretapConnection();
      conn.connect('http://localhost:31416', () => socket);
      expect(conn.status).toBe('connecting');
      fire('connect');
      expect(conn.status).toBe('connected');
      fire('disconnect');
      expect(conn.status).toBe('disconnected');
   });

   // send() records the outbound message and, on ack, the echoed reply.
   it('records sent message and echoed reply', () => {
      const { socket, fire, sent } = makeFakeSocket();
      const conn = new WiretapConnection();
      conn.connect('http://localhost:31416', () => socket);
      fire('connect');
      conn.send('ping');
      expect(conn.messages).toHaveLength(1);
      expect(conn.messages[0]).toMatchObject({ direction: 'out', text: 'ping' });
      sent[0].ack({ text: 'ping', receivedAt: '2026-06-01T00:00:00.000Z' });
      expect(conn.messages).toHaveLength(2);
      expect(conn.messages[1]).toMatchObject({ direction: 'in', text: 'ping' });
   });
});
