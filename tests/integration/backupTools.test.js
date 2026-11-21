// @vitest-environment node
/**
 * The four backup tools through the real sidecar, Socket.IO and the MCP SDK client, with a fake GM client: pieces in
 * both directions, a lost piece, a refused restore piece, disconnects, the busy lock, the folder gate, the Backup folder
 * setting, the absence of document text in MCP messages, and the transport time of a 2,048,000-byte backup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startHarness } from '../unit/contextBudgetHarness.js';
import { fakeTrash, scratchRoot } from '../unit/backupTestHelpers.js';
import {
   BACKUP_FILE_PATTERN,
   BACKUP_PIECE_MAX_BYTES,
   HEADER_LINE_BYTES,
   parseHeaderLine,
} from '../../shared/backup.js';
import { BRIDGE_BACKUP_PIECE, BRIDGE_GATE_STATE, BRIDGE_RESTORE_PIECE } from '../../shared/protocol.js';

/** @typedef {import('../unit/contextBudgetHarness.js').GmAck} GmAck */
/** @typedef {import('../unit/contextBudgetHarness.js').GmHandler} GmHandler */
/** @typedef {import('socket.io-client').Socket} Socket */
/** @typedef {{ isError?: boolean, content: { type: string, text: string }[] }} ToolResult */

/** @type {string} The text every fake document line carries in its `data`; no MCP message may contain it. */
const MARKER = 'WIRETAP-MARKER-7f3a';

/** @type {string} The prefix of a refused restore pump's log line. */
const PUMP_STOPPED = 'restore pump of';

/**
 * Build the world description a fake GM reports with a backup.
 * @returns {{ worldId: string, foundryVersion: string, systemId: string, systemVersion: string }} The description.
 */
function mockWorld() {
   return {
      worldId: 'mock-world',
      foundryVersion: '14.364',
      systemId: 'mock-system',
      systemVersion: '1.0.0',
   };
}

/**
 * Build one document line of exactly `bytes` UTF-8 bytes, newline included, whose `data` carries the marker.
 * @param {number} bytes - The line length; at least the length of the line with an empty padding.
 * @param {number} index - Makes the uuid unique.
 * @returns {Buffer} The UTF-8 bytes of the document line.
 */
function documentLine(bytes, index) {
   /** @type {string} The line up to the padding. */
   const head = `{"uuid":"Actor.MOCKACTOR${String(index).padStart(7, '0')}","documentName":"Actor",`
      + `"data":{"name":"MOCK_ACTOR_${index}","notes":"${MARKER}`;
   /** @type {string} The line after the padding. */
   const tail = '"}}\n';
   return Buffer.from(`${head}${'x'.repeat(bytes - Buffer.byteLength(head) - Buffer.byteLength(tail))}${tail}`);
}

/**
 * Split bytes into pieces of at most `BACKUP_PIECE_MAX_BYTES`.
 * @param {Buffer} data - The bytes.
 * @returns {Buffer[]} The pieces, in order.
 */
function splitPieces(data) {
   /** @type {Buffer[]} The pieces so far. */
   const pieces = [];
   for (let offset = 0; offset < data.length; offset += BACKUP_PIECE_MAX_BYTES) {
      pieces.push(data.subarray(offset, offset + BACKUP_PIECE_MAX_BYTES));
   }
   return pieces;
}

/**
 * Build the successful ack of a backup export of the given lines.
 * @param {Buffer[]} lines - The streamed document lines.
 * @returns {GmAck} The ack the client export sends.
 */
function exportAck(lines) {
   return {
      ok: true,
      result: {
         documents: lines.length,
         bytes: HEADER_LINE_BYTES + Buffer.concat(lines).length,
         unreadable: 0,
         parents: 0,
         world: mockWorld(),
      },
   };
}

/**
 * Build a fake GM answer to a backup export: it streams the lines in pieces, then the end marker, then acks.
 * @param {Buffer[]} lines - The document lines.
 * @param {{ before?: () => Promise<void>, sent?: number[] }} [options] - `before` runs first and is awaited; `sent`
 * receives the byte length of every data piece sent.
 * @returns {GmHandler} Answers an export invocation once its stream is acked.
 */
function exportHandler(lines, { before, sent } = {}) {
   return async (request, gm) => {
      await before?.();
      /** @type {Buffer[]} The data pieces. */
      const pieces = splitPieces(Buffer.concat(lines));
      for (const [seq, data] of pieces.entries()) {
         await gm.emitWithAck(BRIDGE_BACKUP_PIECE, {
            requestId: request.requestId,
            seq,
            data,
         });
         sent?.push(data.length);
      }
      await gm.emitWithAck(BRIDGE_BACKUP_PIECE, {
         requestId: request.requestId,
         seq: pieces.length,
         end: true,
         pieces: pieces.length,
         bytes: Buffer.concat(lines).length,
      });
      return exportAck(lines);
   };
}

/**
 * Build the ack of a restore that replaced every document.
 * @param {number} documents - How many documents were replaced.
 * @returns {GmAck} An ok ack with nothing created, skipped or failed.
 */
function restoreAck(documents) {
   return {
      ok: true,
      result: {
         replaced: documents,
         created: 0,
         skipped: 0,
         failed: 0,
         secretLost: 0,
         rows: [],
      },
   };
}

/**
 * Build a fake GM answer to a restore: it acks every piece after `holdMs`, records them, and answers after the end
 * marker. It records a violation when a piece arrives while it still holds another.
 * @param {{ pieces: object[], violations: string[], holdMs?: number, before?: () => Promise<void>,
 * documents?: number }} record - Receives the pieces and violations; `before` is awaited before the answer.
 * @returns {GmHandler} Answers a restore invocation after its end marker.
 */
function restoreHandler(record) {
   return (request, gm) => new Promise((resolve) => {
      /** @type {number} Pieces received and not yet acked. */
      let held = 0;
      /**
       * Hold one piece, ack it, and answer the restore once the end marker is acked.
       * @param {{ requestId: string, seq: number, end?: true, data?: Uint8Array }} piece - A data piece or the end marker.
       * @param {(ack: { ok: true }) => void} reply - Acks the piece.
       * @returns {void}
       */
      const onPiece = (piece, reply) => {
         if (held > 0) {
            record.violations.push(`piece ${piece.seq} arrived while ${held} held`);
         }
         held += 1;
         record.pieces.push(piece);
         setTimeout(async () => {
            held -= 1;
            reply({ ok: true });
            if (piece.requestId === request.requestId && piece.end === true) {
               gm.off(BRIDGE_RESTORE_PIECE, onPiece);
               await record.before?.();
               resolve(restoreAck(record.documents ?? 1));
            }
         }, record.holdMs ?? 0);
      };
      gm.on(BRIDGE_RESTORE_PIECE, onPiece);
   });
}

/**
 * Read the text of a tool result.
 * @param {ToolResult} result - What the SDK client returned.
 * @returns {string} Its first text item.
 */
function textOf(result) {
   return result.content[0].text;
}

/**
 * Parse a successful tool result as JSON, failing with its text when it is an error.
 * @param {ToolResult} result - What the SDK client returned.
 * @returns {Record<string, unknown>} The parsed JSON of its first text item.
 */
function parsed(result) {
   expect(result.isError, textOf(result)).toBeFalsy();
   return JSON.parse(textOf(result));
}

/**
 * List the backup file names in a directory; a missing directory holds none.
 * @param {string} dir - The directory.
 * @returns {string[]} The file names that match the backup pattern.
 */
function backupNames(dir) {
   return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => BACKUP_FILE_PATTERN.test(name)) : [];
}

/**
 * Make a promise with its resolver outside.
 * @returns {{ promise: Promise<void>, resolve: () => void }} The promise and its resolver.
 */
function deferred() {
   return Promise.withResolvers();
}

describe('backup tools over a real socket', () => {
   /** @type {Awaited<ReturnType<typeof startHarness>>} The sidecar, fake GM client and SDK client. */
   let harness;
   /** @type {string} The scratch root holding `.wiretap/backups`. */
   let root;
   /** @type {string} The default backup folder. */
   let defaultFolder;
   /** @type {string} The recycle bin stand-in's directory. */
   let binDir;

   beforeEach(async () => {
      root = scratchRoot('backupTools');
      defaultFolder = path.join(root, '.wiretap', 'backups');
      binDir = path.join(root, 'bin');
      harness = await startHarness({
         backups: {
            root,
            trash: fakeTrash(binDir),
         },
      });
   });

   afterEach(async () => {
      vi.restoreAllMocks();
      await harness.close();
   });

   /**
    * Call a tool through the SDK client.
    * @param {string} name - The tool name.
    * @param {object} [args] - The arguments.
    * @returns {Promise<ToolResult>} The result.
    */
   function call(name, args = {}) {
      return harness.client.callTool({
         name,
         arguments: args,
      });
   }

   /**
    * Make a backup of the given lines with the fake GM's export answer.
    * @param {Buffer[]} lines - The document lines.
    * @param {object} [args] - Extra `backup_documents` arguments.
    * @returns {Promise<Record<string, unknown>>} The parsed result.
    */
   async function backup(lines, args = {}) {
      harness.setGmHandler(exportHandler(lines));
      return parsed(await call('backup_documents', {
         uuids: ['Actor.MOCKACTOR0000000'],
         ...args,
      }));
   }

   it('backs up in pieces: the file holds the header and every line, one line longer than a piece', async () => {
      /** @type {Buffer[]} One line over a piece and two short ones. */
      const lines = [
         documentLine(600000, 0),
         documentLine(200, 1),
         documentLine(300, 2),
      ];
      /** @type {number[]} The byte length of every data piece the fake GM sent. */
      const sent = [];
      harness.setGmHandler(exportHandler(lines, { sent }));
      /** @type {Record<string, unknown>} The parsed tool answer. */
      const result = parsed(await call('backup_documents', { uuids: ['Actor.MOCKACTOR0000000'] }));
      expect(sent).toEqual([
         BACKUP_PIECE_MAX_BYTES,
         600500 - BACKUP_PIECE_MAX_BYTES,
      ]);
      /** @type {Buffer} The written file. */
      const file = fs.readFileSync(path.join(defaultFolder, result.file));
      expect(file.subarray(HEADER_LINE_BYTES).equals(Buffer.concat(lines))).toBe(true);
      /** @type {import('../../shared/backup.js').BackupHeader | null} The parsed header. */
      const header = parseHeaderLine(file.subarray(0, HEADER_LINE_BYTES).toString('utf8'));
      expect(header).toMatchObject({
         documents: 3,
         bytes: file.length,
      });
      expect(result).toEqual({
         file: result.file,
         folder: 'default',
         documents: 3,
         bytes: file.length,
      });
   });

   it('restores in pieces: the client receives the file bytes after the header, in order, one piece at a time',
      async () => {
         /** @type {Buffer[]} One line over a piece and two short ones. */
         const lines = [
            documentLine(600000, 0),
            documentLine(200, 1),
            documentLine(300, 2),
         ];
         /** @type {Record<string, unknown>} The backup to restore. */
         const made = await backup(lines);
         /** @type {{ pieces: object[], violations: string[], holdMs: number, documents: number }} What the GM saw. */
         const record = {
            pieces: [],
            violations: [],
            holdMs: 20,
            documents: 3,
         };
         harness.setGmHandler(restoreHandler(record));
         /** @type {Record<string, unknown>} The parsed tool answer. */
         const result = parsed(await call('restore_backup', { file: made.file }));
         expect(result).toEqual({
            file: made.file,
            replaced: 3,
            created: 0,
            skipped: 0,
            failed: 0,
            secretLost: 0,
            rows: [],
         });
         expect(record.violations).toEqual([]);
         expect(record.pieces.map((piece) => piece.seq)).toEqual([
            0,
            1,
            2,
         ]);
         /** @type {Buffer} The file's document bytes. */
         const body = fs.readFileSync(path.join(defaultFolder, made.file)).subarray(HEADER_LINE_BYTES);
         /** @type {Buffer} The data pieces' bytes, in arrival order. */
         const received = Buffer.concat(record.pieces.slice(0, 2).map((piece) => Buffer.from(piece.data)));
         expect(received.equals(body)).toBe(true);
         expect(record.pieces[0].data.length).toBe(BACKUP_PIECE_MAX_BYTES);
         expect(record.pieces[2]).toMatchObject({
            end: true,
            pieces: 2,
            bytes: body.length,
         });
      });

   it('a lost piece fails the backup with BACKUP_INCOMPLETE and moves the partial file to the recycle bin', async () => {
      /** @type {Buffer[]} Lines spanning two pieces. */
      const lines = [
         documentLine(600000, 0),
         documentLine(200, 1),
      ];
      /** @type {Buffer[]} The two data pieces. */
      const pieces = splitPieces(Buffer.concat(lines));
      /** @type {unknown[]} The sidecar's acks of the two pieces. */
      const acks = [];
      harness.setGmHandler(async (request, gm) => {
         acks.push(await gm.emitWithAck(BRIDGE_BACKUP_PIECE, {
            requestId: request.requestId,
            seq: 0,
            data: pieces[0],
         }));
         acks.push(await gm.emitWithAck(BRIDGE_BACKUP_PIECE, {
            requestId: request.requestId,
            seq: 2,
            data: pieces[1],
         }));
         return exportAck(lines);
      });
      /** @type {ToolResult} What the call returned. */
      const result = await call('backup_documents', { uuids: ['Actor.MOCKACTOR0000000'] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('BACKUP_INCOMPLETE: A backup piece arrived out of order.');
      expect(acks[0]).toEqual({ ok: true });
      expect(acks[1]).toMatchObject({
         ok: false,
         error: { code: 'BACKUP_INCOMPLETE' },
      });
      expect(backupNames(defaultFolder)).toEqual([]);
      /** @type {string[]} The recycled files. */
      const recycled = backupNames(binDir);
      expect(recycled).toHaveLength(1);
      expect(fs.statSync(path.join(binDir, recycled[0])).size).toBe(HEADER_LINE_BYTES + BACKUP_PIECE_MAX_BYTES);
   });

   it('a restore piece the client refuses stops the pump', async () => {
      /** @type {Record<string, unknown>} A backup of two data pieces. */
      const made = await backup([
         documentLine(600000, 0),
         documentLine(200, 1),
      ]);
      /** @type {{ promise: Promise<void>, resolve: () => void }} Settles when the sidecar logs the stopped pump. */
      const stopped = deferred();
      /** @type {string[]} The sidecar log lines about the pump. */
      const pumpLines = [];
      vi.spyOn(console, 'log').mockImplementation((line) => {
         if (String(line).includes(PUMP_STOPPED)) {
            pumpLines.push(String(line));
            stopped.resolve();
         }
      });
      /** @type {object[]} The restore pieces the fake GM received. */
      const received = [];
      harness.setGmHandler((request, gm) => new Promise((resolve) => {
         gm.on(BRIDGE_RESTORE_PIECE, (piece, reply) => {
            received.push(piece);
            reply({
               ok: false,
               error: {
                  code: 'PIECE_REFUSED',
                  message: 'The restore piece was refused.',
               },
            });
            // The answer waits for the pump's stop, so any later piece would have arrived before the call ends.
            void stopped.promise.then(() => resolve({
               ok: false,
               error: {
                  code: 'PIECE_REFUSED',
                  message: 'The restore stopped at a refused piece.',
               },
            }));
         });
      }));
      /** @type {ToolResult} What the call returned. */
      const result = await call('restore_backup', { file: made.file });
      expect(result.isError).toBe(true);
      expect(received.map((piece) => piece.seq)).toEqual([0]);
      expect(pumpLines).toEqual([
         `Wiretap sidecar | restore pump of ${made.file} stopped at piece 0: PIECE_REFUSED `
            + 'The Foundry client refused a restore piece: PIECE_REFUSED.',
      ]);
   });

   it('a disconnect mid-backup fails ENDPOINT_GONE and moves the partial file to the recycle bin', async () => {
      /** @type {Buffer[]} The data pieces of a two-piece backup. */
      const pieces = splitPieces(Buffer.concat([
         documentLine(600000, 0),
         documentLine(200, 1),
      ]));
      harness.setGmHandler(async (request, gm) => {
         await gm.emitWithAck(BRIDGE_BACKUP_PIECE, {
            requestId: request.requestId,
            seq: 0,
            data: pieces[0],
         });
         gm.disconnect();
         return { ok: true };
      });
      /** @type {ToolResult} What the call returned. */
      const result = await call('backup_documents', { uuids: ['Actor.MOCKACTOR0000000'] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
         'ENDPOINT_GONE: The Foundry endpoint disconnected during the backup; nothing was saved.',
      );
      expect(backupNames(defaultFolder)).toEqual([]);
      expect(backupNames(binDir)).toHaveLength(1);
   });

   it('a disconnect mid-restore fails ENDPOINT_GONE saying the restore may be partly applied', async () => {
      /** @type {Record<string, unknown>} A backup of two data pieces. */
      const made = await backup([
         documentLine(600000, 0),
         documentLine(200, 1),
      ]);
      /** @type {object[]} The restore pieces the fake GM received. */
      const received = [];
      harness.setGmHandler((request, gm) => new Promise((resolve) => {
         gm.on(BRIDGE_RESTORE_PIECE, (piece) => {
            received.push(piece);
            gm.disconnect();
            resolve({ ok: true });
         });
      }));
      /** @type {ToolResult} What the call returned. */
      const result = await call('restore_backup', { file: made.file });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
         'ENDPOINT_GONE: The Foundry endpoint disconnected during the restore; the restore may be partly applied.',
      );
      expect(received).toHaveLength(1);
      expect(backupNames(defaultFolder)).toEqual([made.file]);
   });

   it('a second backup or restore while one runs is BACKUP_BUSY', async () => {
      /** @type {Buffer[]} One short line. */
      const lines = [documentLine(200, 0)];
      /** @type {Record<string, unknown>} A backup to restore. */
      const made = await backup(lines);
      /** @type {string} The refusal text of a busy call. */
      const busy = 'BACKUP_BUSY: A backup or restore is already running; retry when it ends.';

      /** @type {{ promise: Promise<void>, resolve: () => void }} Settles when the held backup reaches the GM. */
      const backupStarted = deferred();
      /** @type {{ promise: Promise<void>, resolve: () => void }} Releases the held backup. */
      const releaseBackup = deferred();
      harness.setGmHandler(exportHandler(lines, {
         before: () => {
            backupStarted.resolve();
            return releaseBackup.promise;
         },
      }));
      /** @type {Promise<ToolResult>} The running backup. */
      const running = call('backup_documents', { uuids: ['Actor.MOCKACTOR0000000'] });
      await backupStarted.promise;
      expect(textOf(await call('backup_documents', { uuids: ['Actor.MOCKACTOR0000000'] }))).toBe(busy);
      expect(textOf(await call('restore_backup', { file: made.file }))).toBe(busy);
      releaseBackup.resolve();
      parsed(await running);

      /** @type {{ promise: Promise<void>, resolve: () => void }} Settles when the held restore received its pieces. */
      const restoreHeld = deferred();
      /** @type {{ promise: Promise<void>, resolve: () => void }} Releases the held restore. */
      const releaseRestore = deferred();
      harness.setGmHandler(restoreHandler({
         pieces: [],
         violations: [],
         before: () => {
            restoreHeld.resolve();
            return releaseRestore.promise;
         },
      }));
      /** @type {Promise<ToolResult>} The running restore. */
      const restoring = call('restore_backup', { file: made.file });
      await restoreHeld.promise;
      expect(textOf(await call('backup_documents', { uuids: ['Actor.MOCKACTOR0000000'] }))).toBe(busy);
      expect(textOf(await call('restore_backup', { file: made.file }))).toBe(busy);
      releaseRestore.resolve();
      expect(parsed(await restoring)).toMatchObject({ replaced: 1 });
   });

   it('a folder outside the default and the setting needs allowBackupAnyFolder on the picked endpoint', async () => {
      /** @type {string} A folder that is neither the default nor the setting. */
      const named = scratchRoot('backupTools-named');
      /** @type {Buffer[]} One short line. */
      const lines = [documentLine(200, 0)];
      harness.setGmHandler(exportHandler(lines));
      /** @type {ToolResult} The refused call. */
      const refused = await call('backup_documents', {
         uuids: ['Actor.MOCKACTOR0000000'],
         folder: named,
      });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toMatch(/^GATE_DENIED: .*allowBackupAnyFolder/);
      expect(backupNames(named)).toEqual([]);

      expect(await harness.gm.emitWithAck(BRIDGE_GATE_STATE, {
         gateState: { allowBackupAnyFolder: true },
         settings: {},
      })).toEqual({ ok: true });
      /** @type {Record<string, unknown>} The same call, now allowed. */
      const result = parsed(await call('backup_documents', {
         uuids: ['Actor.MOCKACTOR0000000'],
         folder: named,
      }));
      expect(result).toMatchObject({
         folder: 'named',
         documents: 1,
      });
      expect(backupNames(named)).toEqual([result.file]);
      expect(backupNames(defaultFolder)).toEqual([]);
   });

   it('the backupFolder setting pushed by the GM chooses the folder', async () => {
      /** @type {string} The folder the setting names. */
      const settingFolder = scratchRoot('backupTools-setting');
      expect(await harness.gm.emitWithAck(BRIDGE_GATE_STATE, {
         gateState: {},
         settings: { backupFolder: settingFolder },
      })).toEqual({ ok: true });
      /** @type {Record<string, unknown>} The backup made with no folder argument. */
      const result = await backup([documentLine(200, 0)]);
      expect(result).toMatchObject({
         folder: 'setting',
         documents: 1,
      });
      expect(backupNames(settingFolder)).toEqual([result.file]);
      expect(backupNames(defaultFolder)).toEqual([]);
      expect(parsed(await call('list_backups'))).toMatchObject({
         folder: 'setting',
         total: 1,
      });
   });

   it('no document text appears in any MCP message of a backup or restore', async () => {
      /** @type {import('@modelcontextprotocol/sdk/shared/transport.js').Transport} The SDK client's transport. */
      const transport = harness.client.transport;
      /** @type {Function} The SDK's own message handler. */
      const original = transport.onmessage;
      /** @type {string[]} Every message the client received, as JSON. */
      const received = [];
      transport.onmessage = (message, extra) => {
         received.push(JSON.stringify(message));
         original(message, extra);
      };

      /** @type {Buffer[]} Lines carrying the marker, over two pieces. */
      const lines = [
         documentLine(600000, 0),
         documentLine(200, 1),
      ];
      /** @type {Record<string, unknown>} The backup. */
      const made = await backup(lines);
      expect(fs.readFileSync(path.join(defaultFolder, made.file), 'utf8')).toContain(MARKER);
      expect(parsed(await call('list_backups'))).toMatchObject({ total: 1 });
      /** @type {{ pieces: object[], violations: string[], documents: number }} What the GM saw. */
      const record = {
         pieces: [],
         violations: [],
         documents: 2,
      };
      harness.setGmHandler(restoreHandler(record));
      parsed(await call('restore_backup', { file: made.file }));
      expect(Buffer.from(record.pieces[0].data).toString('utf8')).toContain(MARKER);
      expect(parsed(await call('delete_backup', { file: made.file }))).toEqual({
         file: made.file,
         trashed: true,
      });

      /** @type {string[]} The received tool results. */
      const results = received.filter((message) => message.includes('"result"'));
      expect(results.length).toBeGreaterThanOrEqual(4);
      expect(received.filter((message) => message.includes(MARKER))).toEqual([]);
   });

   it('streams 2048000 bytes in 512000-byte pieces and records the duration', async () => {
      /** @type {Buffer[]} Four lines of exactly one piece each. */
      const lines = Array.from({ length: 4 }, (_, index) => documentLine(BACKUP_PIECE_MAX_BYTES, index));
      /** @type {number[]} The byte length of every data piece the fake GM sent. */
      const sent = [];
      harness.setGmHandler(exportHandler(lines, { sent }));
      /** @type {number} The clock before the call. */
      const start = performance.now();
      /** @type {Record<string, unknown>} The parsed tool answer. */
      const result = parsed(await call('backup_documents', { uuids: ['Actor.MOCKACTOR0000000'] }));
      /** @type {number} The call's duration in milliseconds. */
      const elapsed = performance.now() - start;
      expect(sent).toEqual(Array(4).fill(BACKUP_PIECE_MAX_BYTES));
      expect(result).toMatchObject({
         documents: 4,
         bytes: HEADER_LINE_BYTES + 2048000,
      });
      expect(fs.statSync(path.join(defaultFolder, result.file)).size).toBe(HEADER_LINE_BYTES + 2048000);
      console.info(`backup of 2048000 bytes in 4 pieces took ${elapsed.toFixed(1)} ms`);
   });
});
