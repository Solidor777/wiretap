import { describe, it, expect } from 'vitest';
import { createPieceWriter } from '~/bridge/backup/pieceWriter.js';

/**
 * Build a send function that records every piece it is given.
 * @returns {{ send: (seq: number, bytes: Uint8Array) => Promise<void>, pieces: Array<{ seq: number, bytes: number[]
 * }> }} The send function and the list it fills.
 */
function recorder() {
   /** @type {Array<{ seq: number, bytes: number[] }>} The pieces sent, copied. */
   const pieces = [];
   return {
      pieces,
      send: async (seq, bytes) => {
         pieces.push({
            seq,
            bytes: Array.from(bytes),
         });
      },
   };
}

describe('createPieceWriter', () => {
   it('sends nothing until a piece is full, then exactly maxBytes per piece', async () => {
      const { send, pieces } = recorder();
      const writer = createPieceWriter(send, 10);
      await writer.write('abcd');
      await writer.write('efgh');
      expect(pieces).toEqual([]);
      await writer.write('ijklmnopqrstu');
      expect(pieces.map((piece) => piece.seq)).toEqual([
         0,
         1,
      ]);
      expect(pieces.map((piece) => piece.bytes.length)).toEqual([
         10,
         10,
      ]);
      expect(new TextDecoder().decode(Uint8Array.from(pieces.flatMap((piece) => piece.bytes))))
         .toBe('abcdefghijklmnopqrst');
   });

   it('splits one line longer than a piece across pieces, byte for byte', async () => {
      const { send, pieces } = recorder();
      const writer = createPieceWriter(send, 10);
      // Nine ASCII bytes, a 3-byte character at offsets 9 to 11, then 13 ASCII bytes: 25 bytes.
      const line = `123456789€abcdefghijkl\n`;
      expect(new TextEncoder().encode(line)).toHaveLength(25);
      await writer.write(line);
      await writer.finish();
      expect(pieces.map((piece) => piece.bytes.length)).toEqual([
         10,
         10,
         5,
      ]);
      expect(new TextDecoder().decode(Uint8Array.from(pieces.flatMap((piece) => piece.bytes)))).toBe(line);
   });

   it('finish sends the remainder and reports pieces and bytes', async () => {
      const { send, pieces } = recorder();
      const writer = createPieceWriter(send, 10);
      await writer.write('0123456789');
      await writer.write('abc');
      await expect(writer.finish()).resolves.toEqual({
         pieces: 2,
         bytes: 13,
      });
      expect(pieces).toEqual([
         {
            seq: 0,
            bytes: Array.from(new TextEncoder().encode('0123456789')),
         },
         {
            seq: 1,
            bytes: Array.from(new TextEncoder().encode('abc')),
         },
      ]);
   });

   it('never sends an empty piece: not for an exact multiple, an empty write or an empty stream', async () => {
      const { send, pieces } = recorder();
      const writer = createPieceWriter(send, 10);
      await writer.write('01234567890123456789');
      await writer.write('');
      await expect(writer.finish()).resolves.toEqual({
         pieces: 2,
         bytes: 20,
      });
      expect(pieces.map((piece) => piece.bytes.length)).toEqual([
         10,
         10,
      ]);
      const empty = recorder();
      await expect(createPieceWriter(empty.send, 10).finish()).resolves.toEqual({
         pieces: 0,
         bytes: 0,
      });
      expect(empty.pieces).toEqual([]);
   });
});
