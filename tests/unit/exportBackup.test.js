import { describe, it, expect, afterEach, vi } from 'vitest';
import { exportBackup } from '~/bridge/backup/exportBackup.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { installBackupWorld, removeBackupWorld } from './mockBackupWorld.js';

afterEach(() => {
   removeBackupWorld();
   vi.restoreAllMocks();
});

/**
 * Build a fake invocation that records every piece and the end marker.
 * @returns {{ requestId: string, pieces: { send: import('vitest').Mock, end: import('vitest').Mock }, received: () =>
 * string }} The invocation, plus the streamed text decoded.
 */
function fakeInvocation() {
   /** @type {Uint8Array[]} Every piece sent, in order. */
   const sent = [];
   return {
      requestId: 'MOCK_REQUEST',
      pieces: {
         send: vi.fn(async (requestId, seq, piece) => {
            sent.push(Uint8Array.from(piece));
         }),
         end: vi.fn(async () => {}),
      },
      received: () => new TextDecoder().decode(Buffer.concat(sent)),
   };
}

describe('exportBackup', () => {
   it('streams one line per document in the planned order, then the end marker with the counts', async () => {
      const { docs } = installBackupWorld(vi.fn);
      const invocation = fakeInvocation();
      const result = await exportBackup(
         {
            uuids: [
               docs.item1.uuid,
               docs.journal.uuid,
               docs.packItem2.uuid,
            ],
            timeoutMs: 60_000,
         },
         invocation,
      );
      const text = invocation.received();
      const lines = text.split('\n');
      expect(lines.pop()).toBe('');
      const parsed = lines.map((line) => JSON.parse(line));
      expect(parsed).toEqual([
         {
            uuid: docs.actor1.uuid,
            documentName: 'Actor',
            data: docs.actor1.toCompendium(null, { keepId: true }),
         },
         {
            uuid: docs.journal.uuid,
            documentName: 'JournalEntry',
            data: docs.journal.toCompendium(null, { keepId: true }),
         },
         {
            uuid: docs.packItem2.uuid,
            documentName: 'Item',
            pack: 'world.mock-items',
            data: docs.packItem2.toCompendium(null, { keepId: true }),
         },
      ]);
      const streamed = new TextEncoder().encode(text).length;
      expect(invocation.pieces.send).toHaveBeenCalledTimes(1);
      expect(invocation.pieces.send.mock.calls[0][0]).toBe('MOCK_REQUEST');
      expect(invocation.pieces.send.mock.calls[0][1]).toBe(0);
      expect(invocation.pieces.end).toHaveBeenCalledTimes(1);
      expect(invocation.pieces.end.mock.calls[0].slice(0, 4)).toEqual([
         'MOCK_REQUEST',
         1,
         1,
         streamed,
      ]);
      expect(invocation.pieces.end.mock.calls[0][4]).toBeGreaterThan(0);
      expect(result).toEqual({
         documents: 3,
         bytes: 2048 + streamed,
         unreadable: 0,
         parents: 1,
         world: {
            worldId: 'mock-world',
            foundryVersion: '14.364',
            systemId: 'mock-system',
            systemVersion: '1.2.3',
         },
      });
   });

   it('writes secretPaths into a line when the redaction removed something', async () => {
      const { docs } = installBackupWorld(vi.fn);
      docs.actor3.toCompendium = vi.fn(() => ({
         _id: docs.actor3.id,
         flags: { world: { secret: 'MOCK_SECRET' } },
      }));
      const invocation = fakeInvocation();
      await exportBackup(
         {
            uuids: [docs.actor3.uuid],
            timeoutMs: 60_000,
         },
         invocation,
      );
      expect(JSON.parse(invocation.received())).toEqual({
         uuid: docs.actor3.uuid,
         documentName: 'Actor',
         data: {
            _id: docs.actor3.id,
            flags: { world: {} },
         },
         secretPaths: [[
            'flags',
            'world',
            'secret',
         ]],
      });
   });

   it('a dry run measures the same bytes and sends nothing', async () => {
      installBackupWorld(vi.fn);
      const params = {
         documentName: 'Actor',
         timeoutMs: 60_000,
      };
      const dryInvocation = fakeInvocation();
      const dry = await exportBackup(
         {
            ...params,
            dryRun: true,
         },
         dryInvocation,
      );
      expect(dryInvocation.pieces.send).not.toHaveBeenCalled();
      expect(dryInvocation.pieces.end).not.toHaveBeenCalled();
      const real = await exportBackup(params, fakeInvocation());
      expect(dry).toEqual({
         documents: 6,
         bytes: real.bytes,
         unreadable: 0,
         parents: 0,
      });
   });

   // The backup holds any number of documents and bytes; the cases are the smallest past the 10000-document and
   // 64000000-byte guidelines, which the sidecar warns about. The 64000000-byte case is a dry run, so the test does not
   // hold the streamed bytes. Measured: about 2 s alone and up to 5.1 s in a full default-worker run, past the 5 s
   // default limit. The limit is about three times the worst full run.
   it('exports more than 10000 documents and measures more than 64000000 bytes', {
      timeout: 15000,
   }, async () => {
      installBackupWorld(vi.fn, { extraActors: 10_001 - 6 });
      const invocation = fakeInvocation();
      /** @type {Awaited<ReturnType<typeof exportBackup>>} The export of 10001 actors. */
      const many = await exportBackup(
         {
            documentName: 'Actor',
            timeoutMs: 60_000,
         },
         invocation,
      );
      expect(many.documents).toBe(10_001);
      expect(invocation.received().split('\n')).toHaveLength(10_002);
      removeBackupWorld();

      const { docs } = installBackupWorld(vi.fn);
      docs.actor3.toCompendium = vi.fn(() => ({ blob: 'x'.repeat(64_000_000) }));
      /** @type {number} The size of the one line: its JSON, the newline, and the header line. */
      const expected = 2048 + JSON.stringify({
         uuid: docs.actor3.uuid,
         documentName: 'Actor',
         data: { blob: '' },
      }).length + 64_000_000 + 1;
      await expect(exportBackup(
         {
            uuids: [docs.actor3.uuid],
            dryRun: true,
            timeoutMs: 60_000,
         },
         fakeInvocation(),
      )).resolves.toEqual({
         documents: 1,
         bytes: expected,
         unreadable: 0,
         parents: 0,
      });
   });

   it('counts unreadable documents and refuses a selection with none readable as BACKUP_EMPTY', async () => {
      const { docs } = installBackupWorld(vi.fn);
      docs.actor1.toCompendium = vi.fn(() => {
         throw new Error('MOCK_FAILURE');
      });
      const result = await exportBackup(
         {
            uuids: [
               docs.actor1.uuid,
               docs.actor2.uuid,
            ],
            dryRun: true,
            timeoutMs: 60_000,
         },
         fakeInvocation(),
      );
      expect(result).toMatchObject({
         documents: 1,
         unreadable: 1,
      });
      const invocation = fakeInvocation();
      await expect(exportBackup(
         {
            uuids: [docs.actor1.uuid],
            timeoutMs: 60_000,
         },
         invocation,
      )).rejects.toMatchObject({
         code: 'BACKUP_EMPTY',
         message: 'Nothing to back up: the selection holds no readable document.',
      });
      expect(invocation.pieces.send).not.toHaveBeenCalled();
   });

   it('stops with SCRIPT_TIMEOUT once the deadline passes', async () => {
      const { docs } = installBackupWorld(vi.fn);
      /** @type {number} The mocked clock. */
      let now = 1_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      docs.actor1.toCompendium = vi.fn(() => {
         now += 5_000;
         return { _id: docs.actor1.id };
      });
      const invocation = fakeInvocation();
      await expect(exportBackup(
         {
            uuids: [
               docs.actor1.uuid,
               docs.actor2.uuid,
            ],
            timeoutMs: 2_000,
         },
         invocation,
      )).rejects.toMatchObject({
         code: 'SCRIPT_TIMEOUT',
         message: 'The backup stopped at its time limit; nothing was saved.',
      });
      expect(invocation.pieces.send).not.toHaveBeenCalled();
   });

   it('yields to the event loop once a run of export work reaches 50 ms', async () => {
      installBackupWorld(vi.fn);
      /** @type {number} The mocked clock; each reading moves it on 60 ms, so every document ends a slice. */
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
         now += 60;
         return now;
      });
      /** @type {boolean} Whether the export has settled. */
      let settled = false;
      /** @type {Promise<import('~/bridge/backup/exportBackup.js').ExportResult>} The running dry run. */
      const running = exportBackup(
         {
            documentName: 'Actor',
            dryRun: true,
            timeoutMs: 1_000_000_000,
         },
         fakeInvocation(),
      ).finally(() => {
         settled = true;
      });
      // A dry run that only awaits microtasks settles well within this many microtask turns.
      for (let turn = 0; turn < 1_000; turn += 1) {
         await Promise.resolve();
      }
      expect(settled).toBe(false);
      await expect(running).resolves.toMatchObject({ documents: 6 });
   });

   it('passes a refused piece on as the error', async () => {
      const { docs } = installBackupWorld(vi.fn);
      const invocation = fakeInvocation();
      const refusal = new ScriptError('PIECE_REFUSED', 'MOCK refusal.');
      invocation.pieces.send.mockRejectedValue(refusal);
      await expect(exportBackup(
         {
            uuids: [docs.actor1.uuid],
            timeoutMs: 60_000,
         },
         invocation,
      )).rejects.toBe(refusal);
      expect(invocation.pieces.end).not.toHaveBeenCalled();
   });
});
