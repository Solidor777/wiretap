import type { Socket } from 'socket.io';
import { BRIDGE_IDENTIFY, BRIDGE_INVOKE } from '../shared/protocol.js';

// Milliseconds to wait for a Foundry client to ack a bridge invocation before failing.
const INVOKE_TIMEOUT_MS = 10_000;

interface IdentifyPayload {
   userId: string;
   userName: string;
   isGM: boolean;
}

interface BridgeAck {
   ok: boolean;
   result?: unknown;
   error?: string;
}

/**
 * Create the Foundry bridge: a registry of GM-identified Socket.IO sockets plus a generic
 * request/response pipe (`invokeOnGM`) that forwards an operation to a GM client and awaits its ack.
 * Knows nothing about which operations exist — callers pass an op name and params.
 * @returns The bridge with a per-socket connection handler and an `invokeOnGM` method.
 */
export function createFoundryBridge(): {
   handleConnection: (socket: Socket) => void;
   invokeOnGM: (op: string, params: object) => Promise<unknown>;
} {
   // Sockets that have identified as a GM Foundry client, keyed by socket id.
   const gmSockets = new Map<string, Socket>();

   return {
      /**
       * Register per-socket bridge handlers: track the socket as a GM endpoint on identify, and drop
       * it from the registry on disconnect.
       * @param socket - The connected Socket.IO socket.
       * @returns Nothing.
       */
      handleConnection(socket: Socket): void {
         socket.on(BRIDGE_IDENTIFY, (payload: IdentifyPayload) => {
            if (payload?.isGM) {
               gmSockets.set(socket.id, socket);
            }
         });
         socket.on('disconnect', () => {
            gmSockets.delete(socket.id);
         });
      },

      /**
       * Forward an operation to a registered GM client and await its ack.
       * @param op - The operation name.
       * @param params - The operation parameters.
       * @returns A promise resolving with the operation result; rejects when no GM is registered, on
       *          ack timeout, or when the client reports failure.
       */
      invokeOnGM(op: string, params: object): Promise<unknown> {
         return new Promise((resolve, reject) => {
            const socket = gmSockets.values().next().value as Socket | undefined;
            if (!socket) {
               reject(new Error('No Foundry GM client connected — open Foundry as a GM with Wiretap enabled.'));
               return;
            }
            socket.timeout(INVOKE_TIMEOUT_MS).emit(BRIDGE_INVOKE, { op, params }, (err: unknown, ack: BridgeAck) => {
               if (err) {
                  reject(new Error('Foundry did not respond in time.'));
                  return;
               }
               if (ack?.ok) {
                  resolve(ack.result);
               } else {
                  reject(new Error(ack?.error ?? 'Foundry operation failed.'));
               }
            });
         });
      },
   };
}
