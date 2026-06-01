import type { Socket } from 'socket.io';
import { WIRETAP_MESSAGE } from '../shared/protocol.js';

/**
 * The payload sent by the tab on a WIRETAP_MESSAGE event.
 */
interface MessagePayload {
   text?: string;
}

/**
 * The ack reply sent back to the tab.
 */
interface EchoReply {
   text: string;
   receivedAt: string;
}

/**
 * Register the echo handler on a connected socket. On a WIRETAP_MESSAGE event, replies via the ack
 * callback with the original text and an ISO timestamp. This is the sub-project #1 placeholder for the
 * eventual Claude Code round-trip.
 * @param socket - The connected Socket.IO socket.
 */
export function registerEcho(socket: Socket): void {
   socket.on(
      WIRETAP_MESSAGE,
      (payload: MessagePayload, ack?: (reply: EchoReply) => void): void => {
         ack?.({ text: payload?.text ?? '', receivedAt: new Date().toISOString() });
      },
   );
}
