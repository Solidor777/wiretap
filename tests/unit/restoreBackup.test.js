import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BACKUP_INCOMPLETE } from '$shared/backup.js';
import { GATE_DENIED } from '$shared/protocol.js';
import { restoreBackup } from '~/bridge/backup/restoreBackup.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {TextEncoder} Encodes the piece text as UTF-8 bytes. */
const encoder = new TextEncoder();

/** @type {string} The request id of every fake invocation. */
const REQUEST_ID = 'MOCKREQUEST00001';

beforeEach(() => {
   world = installWriteWorld(vi.fn, {
      userId: 'MOCKGM0000000001',
      packs: {
         'mock.locked': {
            documentName: 'Actor',
            locked: true,
            folders: new Map(),
         },
      },
      documentTypes: {
         Actor: [
            'npc',
            'character',
         ],
      },
   });
   gates = {
      allowDelete: true,
      allowReplace: true,
   };
   globalThis.game.settings.get = (module, key) => gates[key];
});

afterEach(() => {
   vi.restoreAllMocks();
   for (const name of [
      'CONST',
      'CONFIG',
      'fromUuid',
      'game',
   ]) {
      delete globalThis[name];
   }
});

/**
 * Build the header of a backup of the mocked world.
 * @param {Record<string, unknown>} [extra] - Fields that replace the defaults.
 * @returns {import('$shared/backup.js').BackupHeader} A header of the mocked world.
 */
function headerOf(extra = {}) {
   return {
      wiretapBackup: 1,
      created: '2026-11-21T00:00:00.000Z',
      worldId: 'MOCKWORLD',
      foundryVersion: '14.364',
      systemId: 'mocksystem',
      systemVersion: '1.0.0',
      note: '',
      documents: 0,
      bytes: 2048,
      ...extra,
   };
}

/**
 * Build the backup line of an actor.
 * @param {string} id - The id of the actor the line holds.
 * @param {Record<string, unknown>} [extra] - Data fields that replace or add to the defaults.
 * @param {Record<string, unknown>} [lineExtra] - Line fields that replace or add to the defaults.
 * @returns {Record<string, unknown>} The backup entry of the actor.
 */
function actorLine(id, extra = {}, lineExtra = {}) {
   return {
      uuid: `Actor.${id}`,
      documentName: 'Actor',
      data: {
         _id: id,
         name: `MOCK_${id}`,
         type: 'npc',
         ...extra,
      },
      ...lineExtra,
   };
}

/**
 * Build a fake invocation whose receiver yields the given texts as pieces, then an end marker.
 * @param {string[]} texts - The text of each piece.
 * @param {{ pieces?: number, bytes?: number }} [endPatch] - End marker counts that replace the true ones.
 * @param {() => void} [onNext] - Called each time the receiver hands out a piece.
 * @returns {{ invocation: object, receiver: object, acks: Array<[number, unknown]> }} The invocation, its receiver
 * and the acks it saw (`[seq, refusal]`).
 */
function invocationOf(texts, endPatch = {}, onNext = () => undefined) {
   /** @type {Uint8Array[]} The piece data. */
   const datas = texts.map((text) => encoder.encode(text));
   /** @type {Array<[number, unknown]>} The acks seen. */
   const acks = [];
   /** @type {number} The next piece to hand out. */
   let index = 0;
   /** @type {object} The fake receiver. */
   const receiver = {
      next: vi.fn(async () => {
         onNext();
         /** @type {number} The sequence number of this piece. */
         const seq = index;
         index += 1;
         /**
          * Record the ack of this piece.
          * @param {unknown} [refusal] - The refusal, when the piece is refused.
          * @returns {void}
          */
         const ack = (refusal) => acks.push([
            seq,
            refusal,
         ]);
         if (seq < datas.length) {
            return {
               seq,
               data: datas[seq],
               ack,
            };
         }
         return {
            seq,
            end: true,
            pieces: endPatch.pieces ?? datas.length,
            bytes: endPatch.bytes ?? datas.reduce((total, data) => total + data.byteLength, 0),
            ack,
         };
      }),
      close: vi.fn(),
   };
   return {
      invocation: {
         requestId: REQUEST_ID,
         pieces: { receive: vi.fn(() => receiver) },
      },
      receiver,
      acks,
   };
}

/**
 * Turn lines into piece texts, one line per piece.
 * @param {unknown[]} lines - The lines; a string is sent as it is, anything else as its JSON.
 * @returns {string[]} The piece texts.
 */
function piecesOf(lines) {
   return lines.map((line) => `${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
}

/**
 * Restore the given lines with the default header.
 * @param {unknown[]} lines - The backup lines.
 * @param {Partial<import('~/bridge/backup/restoreBackup.js').RestoreParams>} [params] - Parameters that replace the
 * defaults.
 * @returns {Promise<import('~/bridge/backup/restoreBackup.js').RestoreResult>} The result.
 */
function restoreLines(lines, params = {}) {
   const { invocation } = invocationOf(piecesOf(lines));
   return restoreBackup({
      header: headerOf(),
      timeoutMs: 120_000,
      ...params,
   }, invocation);
}

/**
 * Run a call and return what it threw.
 * @param {() => Promise<unknown>} call - The call to run.
 * @returns {Promise<Error>} The error.
 */
async function failure(call) {
   try {
      await call();
   } catch (error) {
      return error;
   }
   throw new Error('the call did not throw');
}

describe('restoreBackup: the stream', () => {
   it('registers the receiver before its first await', async () => {
      world.add('Actor', {
         _id: 'MOCKACTOR0000001',
         name: 'MOCK_live',
         type: 'npc',
      });
      const { invocation, receiver, acks } = invocationOf(piecesOf([actorLine('MOCKACTOR0000001')]));
      const pending = restoreBackup({
         header: headerOf(),
         timeoutMs: 120_000,
      }, invocation);
      expect(invocation.pieces.receive).toHaveBeenCalledWith(REQUEST_ID);
      await pending;
      expect(acks).toEqual([
         [
            0,
            undefined,
         ],
         [
            1,
            undefined,
         ],
      ]);
      expect(receiver.close).toHaveBeenCalledTimes(1);
   });

   it('refuses a backup of another world with ARGS_INVALID', async () => {
      const { invocation, receiver } = invocationOf(piecesOf([actorLine('MOCKACTOR0000001')]));
      const error = await failure(() => restoreBackup({
         header: headerOf({ worldId: 'MOCKOTHERWORLD' }),
         timeoutMs: 120_000,
      }, invocation));
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toBe('The backup is of world MOCKOTHERWORLD, not this world.');
      expect(receiver.close).toHaveBeenCalledTimes(1);
      expect(world.calls).toEqual([]);
   });

   it('throws BACKUP_INCOMPLETE when the end marker counts do not match', async () => {
      for (const endPatch of [
         { pieces: 2 },
         { bytes: 1 },
      ]) {
         const { invocation, receiver } = invocationOf(piecesOf([actorLine('MOCKACTOR0000001')]), endPatch);
         const error = await failure(() => restoreBackup({
            header: headerOf(),
            timeoutMs: 120_000,
         }, invocation));
         expect(error.code).toBe(BACKUP_INCOMPLETE);
         expect(error.message).toBe('The backup data ended early or did not match its end marker.');
         expect(receiver.close).toHaveBeenCalledTimes(1);
      }
      // A last line with no newline is pending at the end marker.
      const { invocation } = invocationOf([JSON.stringify(actorLine('MOCKACTOR0000002'))]);
      const pending = await failure(() => restoreBackup({
         header: headerOf(),
         timeoutMs: 120_000,
      }, invocation));
      expect(pending.code).toBe(BACKUP_INCOMPLETE);
   });

   it('rebuilds a line split across pieces', async () => {
      /** @type {string} The whole line. */
      const text = `${JSON.stringify(actorLine('MOCKACTOR0000003'))}\n`;
      const { invocation } = invocationOf([
         text.slice(0, 10),
         text.slice(10),
      ]);
      const result = await restoreBackup({
         header: headerOf(),
         timeoutMs: 120_000,
      }, invocation);
      expect(result.created).toBe(1);
   });

   it('stops with SCRIPT_TIMEOUT once the deadline passes, naming how many documents applied', async () => {
      /** @type {number} The mocked clock. */
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      /** @type {number} How many pieces were handed out. */
      let handed = 0;
      const { invocation, receiver } = invocationOf(
         piecesOf([
            actorLine('MOCKACTOR0000001'),
            actorLine('MOCKACTOR0000002'),
         ]),
         {},
         () => {
            handed += 1;
            if (handed === 2) {
               now += 2_000;
            }
         },
      );
      const error = await failure(() => restoreBackup({
         header: headerOf(),
         timeoutMs: 1_000,
      }, invocation));
      expect(error.code).toBe('SCRIPT_TIMEOUT');
      expect(error.message).toBe('The restore stopped at its time limit after 1 documents; it is partly applied.');
      expect(receiver.close).toHaveBeenCalledTimes(1);
   });
});

describe('restoreBackup: applying lines', () => {
   it('replaces an existing document and re-creates a deleted one with its id', async () => {
      const live = world.add('Actor', {
         _id: 'MOCKACTOR0000001',
         name: 'MOCK_live',
         type: 'npc',
      });
      const result = await restoreLines([
         actorLine('MOCKACTOR0000001'),
         actorLine('MOCKDELETED00001'),
      ]);
      expect(result.replaced).toBe(1);
      expect(result.created).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.secretLost).toBe(0);
      expect(result.differences).toBeUndefined();
      expect(result.dryRun).toBeUndefined();
      expect(live.update).toHaveBeenCalledTimes(1);
      expect(world.byUuid.get('Actor.MOCKDELETED00001')?.id).toBe('MOCKDELETED00001');
      expect(result.rows).toEqual([
         [
            'Actor.MOCKDELETED00001',
            'created',
         ],
         [
            'Actor.MOCKACTOR0000001',
            'replaced',
         ],
      ]);
   });

   it('re-creates a deleted Folder before the document inside it', async () => {
      const result = await restoreLines([
         {
            uuid: 'Folder.MOCKFOLDER000001',
            documentName: 'Folder',
            data: {
               _id: 'MOCKFOLDER000001',
               name: 'MOCK_folder',
               type: 'Actor',
            },
         },
         actorLine('MOCKDELETED00001', { folder: 'MOCKFOLDER000001' }),
      ]);
      expect(result.created).toBe(2);
      expect(world.calls).toEqual([
         'Folder.createDocuments',
         'Actor.createDocuments',
      ]);
      expect(world.byUuid.get('Actor.MOCKDELETED00001')._source.folder).toBe('MOCKFOLDER000001');
      expect(result.rows.every((row) => row.length === 2)).toBe(true);
   });

   it('restores a document whose folder is gone and not in the backup outside any folder, reason FOLDER_GONE',
      async () => {
         const result = await restoreLines([actorLine('MOCKDELETED00001', { folder: 'MOCKGONEFOLDER01' })]);
         expect(result.created).toBe(1);
         expect(world.byUuid.get('Actor.MOCKDELETED00001')._source.folder).toBeNull();
         expect(result.rows).toEqual([
            [
               'Actor.MOCKDELETED00001',
               'created',
               'FOLDER_GONE: restored outside its folder.',
            ],
         ]);
      });

   it('fails a document whose pack is gone or locked, or whose type or subtype is gone', async () => {
      const result = await restoreLines([
         actorLine('MOCKPACKGONE0001', {}, {
            uuid: 'Compendium.mock.gone.Actor.MOCKPACKGONE0001',
            pack: 'mock.gone',
         }),
         actorLine('MOCKPACKLOCKED01', {}, {
            uuid: 'Compendium.mock.locked.Actor.MOCKPACKLOCKED01',
            pack: 'mock.locked',
         }),
         actorLine('MOCKTYPEGONE0001', {}, { documentName: 'MockGadget' }),
         actorLine('MOCKSUBTYPEGONE1', { type: 'mockoldtype' }),
      ]);
      expect(result.failed).toBe(4);
      expect(result.rows).toEqual([
         [
            'Compendium.mock.gone.Actor.MOCKPACKGONE0001',
            'failed',
            'PACK_GONE: the pack no longer exists.',
         ],
         [
            'Compendium.mock.locked.Actor.MOCKPACKLOCKED01',
            'failed',
            'PACK_LOCKED: unlock the pack to restore into it.',
         ],
         [
            'Actor.MOCKTYPEGONE0001',
            'failed',
            'TYPE_GONE: the document type no longer exists.',
         ],
         [
            'Actor.MOCKSUBTYPEGONE1',
            'failed',
            'TYPE_GONE: subtype mockoldtype no longer exists.',
         ],
      ]);
      expect(world.calls).toEqual([]);
   });

   it('fails one document denied by a gate with the gate named, and applies the others', async () => {
      gates.allowReplace = false;
      world.add('Actor', {
         _id: 'MOCKACTOR0000001',
         name: 'MOCK_live',
         type: 'npc',
      });
      const result = await restoreLines([
         actorLine('MOCKACTOR0000001'),
         actorLine('MOCKDELETED00001'),
      ]);
      expect(result.replaced).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.created).toBe(1);
      expect(result.rows[0][0]).toBe('Actor.MOCKACTOR0000001');
      expect(result.rows[0][1]).toBe('failed');
      expect(result.rows[0][2]).toContain(GATE_DENIED);
      expect(result.rows[0][2]).toContain('allowReplace');
      expect(Buffer.byteLength(result.rows[0][2])).toBeLessThanOrEqual(160);
   });

   it('a dry run writes nothing and reports the gate denials the real run would meet', async () => {
      gates.allowReplace = false;
      world.add('Actor', {
         _id: 'MOCKACTOR0000001',
         name: 'MOCK_live',
         type: 'npc',
      });
      const result = await restoreLines([
         actorLine('MOCKACTOR0000001'),
         {
            uuid: 'Folder.MOCKFOLDER000001',
            documentName: 'Folder',
            data: {
               _id: 'MOCKFOLDER000001',
               name: 'MOCK_folder',
               type: 'Actor',
            },
         },
         actorLine('MOCKDELETED00001', { folder: 'MOCKFOLDER000001' }),
      ], { dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.failed).toBe(1);
      expect(result.created).toBe(2);
      expect(result.rows[0][2]).toContain('allowReplace');
      // The planned Folder counts as present, so the actor keeps its folder.
      expect(result.rows.slice(1)).toEqual([
         [
            'Folder.MOCKFOLDER000001',
            'created',
         ],
         [
            'Actor.MOCKDELETED00001',
            'created',
         ],
      ]);
      expect(world.calls).toEqual([]);
   });

   it('carries a live secret flag into the replaced document and counts a lost one', async () => {
      const live = world.add('Actor', {
         _id: 'MOCKACTOR0000001',
         name: 'MOCK_live',
         type: 'npc',
         flags: { mockmodule: { apiKey: 'MOCK_KEY_0000' } },
      });
      world.add('Actor', {
         _id: 'MOCKACTOR0000002',
         name: 'MOCK_live_two',
         type: 'npc',
      });
      /** @type {Array<Array<string | number>>} The redacted path of every line. */
      const secretPaths = [
         [
            'flags',
            'mockmodule',
            'apiKey',
         ],
      ];
      const result = await restoreLines([
         actorLine('MOCKACTOR0000001', { flags: { mockmodule: {} } }, { secretPaths }),
         actorLine('MOCKACTOR0000002', { flags: { mockmodule: {} } }, { secretPaths }),
         actorLine('MOCKDELETED00001', { flags: { mockmodule: {} } }, { secretPaths }),
      ]);
      expect(result.replaced).toBe(2);
      expect(result.created).toBe(1);
      expect(result.secretLost).toBe(2);
      expect(live.update.mock.calls[0][0].flags).toEqual({ mockmodule: { apiKey: 'MOCK_KEY_0000' } });
   });

   it('applies only the asked uuids, maps an embedded uuid to its line, and skips the ones not in the backup',
      async () => {
         const live = world.add('Actor', {
            _id: 'MOCKACTOR0000001',
            name: 'MOCK_live',
            type: 'npc',
         });
         world.addChild(live, 'Item', {
            _id: 'MOCKITEM00000001',
            name: 'MOCK_item',
         });
         const result = await restoreLines([
            actorLine('MOCKACTOR0000001', {
               items: [
                  {
                     _id: 'MOCKITEM00000001',
                     name: 'MOCK_item',
                  },
               ],
            }),
            actorLine('MOCKDELETED00001'),
         ], {
            uuids: [
               'Actor.MOCKACTOR0000001.Item.MOCKITEM00000001',
               'Actor.MOCKNOTBACKEDUP',
            ],
         });
         expect(result.replaced).toBe(1);
         expect(result.created).toBe(0);
         expect(result.skipped).toBe(1);
         expect(result.rows).toEqual([
            [
               'Actor.MOCKNOTBACKEDUP',
               'skipped',
               'not in the backup',
            ],
            [
               'Actor.MOCKACTOR0000001',
               'replaced',
            ],
         ]);
         expect(world.byUuid.has('Actor.MOCKDELETED00001')).toBe(false);
      });

   it('fails an unparsable line as line <n> and goes on', async () => {
      const result = await restoreLines([
         'not json',
         { uuid: 'Actor.MOCKNODATA00001' },
         actorLine('MOCKDELETED00001'),
      ]);
      expect(result.failed).toBe(2);
      expect(result.created).toBe(1);
      expect(result.rows.slice(0, 2)).toEqual([
         [
            'line 1',
            'failed',
            'LINE_INVALID: the line is not a backup entry.',
         ],
         [
            'line 2',
            'failed',
            'LINE_INVALID: the line is not a backup entry.',
         ],
      ]);
   });

   it('names the version differences', async () => {
      globalThis.game.system.version = '2.0.0';
      const result = await restoreLines([actorLine('MOCKDELETED00001')]);
      expect(result.differences).toEqual(['systemVersion: 1.0.0 -> 2.0.0']);
   });

   it('orders at most 20 rows: failed, skipped, created, replaced', async () => {
      /** @type {Record<string, unknown>[]} Thirty lines: replaced, created and failed in turn. */
      const lines = [];
      for (let index = 0; index < 30; index += 1) {
         /** @type {string} The actor id of this line. */
         const id = `MOCKMIXED${String(index).padStart(7, '0')}`;
         if (index % 3 === 0) {
            world.add('Actor', {
               _id: id,
               name: `MOCK_${id}`,
               type: 'npc',
            });
            lines.push(actorLine(id));
         } else if (index % 3 === 1) {
            lines.push(actorLine(id));
         } else {
            lines.push(actorLine(id, { type: 'mockoldtype' }));
         }
      }
      const result = await restoreLines(lines, {
         uuids: [
            ...lines.map((line) => line.uuid),
            'Actor.MOCKMISSING00001',
            'Actor.MOCKMISSING00002',
            'Actor.MOCKMISSING00003',
         ],
      });
      expect(result.replaced).toBe(10);
      expect(result.created).toBe(10);
      expect(result.failed).toBe(10);
      expect(result.skipped).toBe(3);
      expect(result.rows).toHaveLength(20);
      expect(result.rows.map((row) => row[1])).toEqual([
         ...Array(10).fill('failed'),
         ...Array(3).fill('skipped'),
         ...Array(7).fill('created'),
      ]);
      // Each state keeps file order.
      expect(result.rows.slice(0, 10).map((row) => row[0])).toEqual(
         lines.filter((line, index) => index % 3 === 2).map((line) => line.uuid),
      );
      expect(result.rows.slice(13).map((row) => row[0])).toEqual(
         lines.filter((line, index) => index % 3 === 1).slice(0, 7).map((line) => line.uuid),
      );
   });
});
