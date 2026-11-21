/**
 * The GM-client half of a backup: plan the selection, measure it against the backup bounds, then export every
 * document again and stream the lines to the sidecar in pieces. The documents never pass through the agent's context;
 * the sidecar writes the header and the file.
 */

import {
   BACKUP_EMPTY,
   BACKUP_MAX_BYTES,
   BACKUP_MAX_DOCUMENTS,
   BACKUP_TOO_LARGE,
   HEADER_LINE_BYTES,
} from '$shared/backup.js';
import { utf8Bytes } from '$shared/utf8.js';
import { exportForBackup } from '~/bridge/scripts/canonical.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { yieldToEventLoop } from '~/bridge/scripts/search.js';
import { createPieceWriter } from './pieceWriter.js';
import { loadEntries, planSelection } from './selection.js';

/**
 * Longest run of export work between two yields to the event loop, in milliseconds. A task of 50 ms or more is a long
 * task that delays input (Long Tasks API, https://wicg.github.io/longtasks/), so the export lets the browser paint
 * and handle input at least that often.
 * @type {number}
 */
const SLICE_MS = 50;

/**
 * @typedef {object} ExportParams
 * @property {string[]} [uuids] - The documents to back up; an embedded uuid backs up its primary parent.
 * @property {string} [folderUuid] - A Folder whose subfolders and contents are backed up with it.
 * @property {string} [documentName] - A world document type whose Folders and documents are backed up.
 * @property {string} [pack] - A compendium pack whose Folders and documents are backed up.
 * @property {boolean} [dryRun] - Measure only; nothing is sent.
 * @property {number} timeoutMs - The time limit of the whole export, in milliseconds.
 */

/**
 * @typedef {object} ExportResult
 * @property {number} documents - The documents exported.
 * @property {number} bytes - The size of the backup file, header line included.
 * @property {number} unreadable - The selected documents that could not be read or were gone.
 * @property {number} parents - The embedded uuids replaced by their primary parent.
 * @property {import('$shared/backup.js').WorldDescription} [world] - The world the documents came from; absent for a
 * dry run.
 */

/**
 * The part of an op invocation the export uses: its request id and the channel that carries the backup pieces.
 * @typedef {object} ExportInvocation
 * @property {string} requestId - The id of the invocation the pieces belong to.
 * @property {{ send: (requestId: string, seq: number, bytes: Uint8Array, waitMs: number) => Promise<void>, end:
 * (requestId: string, seq: number, pieces: number, bytes: number, waitMs: number) => Promise<void> }} pieces - Sends
 * one data piece, or the end marker, and resolves on the sidecar's ack.
 */

/**
 * Build the backup line of one exported document.
 * @param {import('./selection.js').SelectionEntry} entry - The selection entry.
 * @param {{ data: Record<string, unknown>, secretPaths: Array<Array<string | number>> }} outcome - The export.
 * @returns {string} The `BackupLine` as JSON, with its newline.
 */
function backupLine(entry, outcome) {
   /** @type {import('$shared/backup.js').BackupLine} The document with its address and secret paths. */
   const line = {
      uuid: entry.uuid,
      documentName: entry.documentName,
      ...(entry.pack === null ? {} : { pack: entry.pack }),
      data: outcome.data,
      ...(outcome.secretPaths.length === 0 ? {} : { secretPaths: outcome.secretPaths }),
   };
   return `${JSON.stringify(line)}\n`;
}

/**
 * Export the planned entries in order, calling `onLine` for each readable document. World documents load without an
 * await that leaves the microtask queue, so the loop yields to the event loop once a run of work reaches `SLICE_MS`.
 * @param {import('./selection.js').SelectionEntry[]} entries - The planned entries.
 * @param {number} deadline - The time (`Date.now()` scale) after which the export stops.
 * @param {(line: string) => Promise<void> | void} onLine - Receives each line.
 * @returns {Promise<{ documents: number, unreadable: number }>} The readable and unreadable counts.
 * @throws {ScriptError} `SCRIPT_TIMEOUT` when a document is reached after the deadline.
 */
async function exportLines(entries, deadline, onLine) {
   /** @type {number} The readable documents. */
   let documents = 0;
   /** @type {number} The documents that were gone or could not be exported. */
   let unreadable = 0;
   /** @type {number} When the current run of work began. */
   let sliceStart = Date.now();
   for await (const { entry, document } of loadEntries(entries)) {
      if (Date.now() - sliceStart >= SLICE_MS) {
         await yieldToEventLoop();
         sliceStart = Date.now();
      }
      if (Date.now() > deadline) {
         throw new ScriptError('SCRIPT_TIMEOUT', 'The backup stopped at its time limit; nothing was saved.');
      }
      /** @type {ReturnType<typeof exportForBackup> | null} The export, or null for a document that is gone. */
      const outcome = document === null ? null : exportForBackup(document);
      if (outcome === null || !outcome.ok) {
         unreadable += 1;
         continue;
      }
      documents += 1;
      await onLine(backupLine(entry, outcome));
   }
   return {
      documents,
      unreadable,
   };
}

/**
 * Back up a selection: plan it, measure it, refuse it when it is empty or over the bounds, and unless `dryRun` export
 * it again and stream the lines to the sidecar.
 * @param {ExportParams} params - The selection, the dry-run flag and the time limit.
 * @param {ExportInvocation} invocation - The op invocation whose piece channel carries the stream.
 * @returns {Promise<ExportResult>} The counts and the file size; the world description unless a dry run.
 * @throws {ScriptError} `DOC_NOT_FOUND` or `ARGS_INVALID` for the selection, `BACKUP_TOO_LARGE`, `BACKUP_EMPTY`,
 * `SCRIPT_TIMEOUT`, or the error of a refused piece.
 */
export async function exportBackup(params, invocation) {
   /** @type {number} The time after which the export stops. */
   const deadline = Date.now() + params.timeoutMs;
   /** @type {import('./selection.js').SelectionPlan} The selection. */
   const plan = await planSelection(params);
   if (plan.entries.length > BACKUP_MAX_DOCUMENTS) {
      throw new ScriptError(
         BACKUP_TOO_LARGE,
         `The selection holds ${plan.entries.length} documents; a backup holds at most ${BACKUP_MAX_DOCUMENTS}.`,
      );
   }

   /** @type {number} The measured bytes of the document lines. */
   let measured = 0;
   /** @type {{ documents: number, unreadable: number }} The counts of the measuring pass. */
   const counts = await exportLines(plan.entries, deadline, (line) => {
      measured += utf8Bytes(line);
   });
   if (counts.documents === 0) {
      throw new ScriptError(BACKUP_EMPTY, 'Nothing to back up: the selection holds no readable document.');
   }
   if (HEADER_LINE_BYTES + measured > BACKUP_MAX_BYTES) {
      throw new ScriptError(
         BACKUP_TOO_LARGE,
         `The backup would be ${HEADER_LINE_BYTES + measured} bytes; a backup holds at most ${BACKUP_MAX_BYTES}.`,
      );
   }
   if (params.dryRun === true) {
      return {
         documents: counts.documents,
         bytes: HEADER_LINE_BYTES + measured,
         unreadable: counts.unreadable,
         parents: plan.parents,
      };
   }

   /**
    * The time left before the deadline, handed to the channel as its wait for each ack.
    * @returns {number} Milliseconds.
    */
   const remaining = () => deadline - Date.now();
   /** @type {import('./pieceWriter.js').PieceWriter} The writer that cuts the stream into pieces. */
   const writer = createPieceWriter(
      (seq, bytes) => invocation.pieces.send(invocation.requestId, seq, bytes, remaining()),
   );
   /** @type {{ documents: number, unreadable: number }} The counts of the streaming pass. */
   const streamedCounts = await exportLines(plan.entries, deadline, (line) => writer.write(line));
   /** @type {{ pieces: number, bytes: number }} What the writer sent. */
   const streamed = await writer.finish();
   await invocation.pieces.end(invocation.requestId, streamed.pieces, streamed.pieces, streamed.bytes, remaining());
   return {
      documents: streamedCounts.documents,
      bytes: HEADER_LINE_BYTES + streamed.bytes,
      unreadable: streamedCounts.unreadable,
      parents: plan.parents,
      world: {
         worldId: game.world.id,
         foundryVersion: game.version,
         systemId: game.system.id,
         systemVersion: game.system.version,
      },
   };
}
