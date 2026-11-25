/**
 * The four backup tools: `backup_documents`, `list_backups`, `restore_backup` and `delete_backup`. They run in the
 * sidecar behind the result enforcer. The folder choice and its `allowBackupAnyFolder` gate are judged on the picked
 * GM endpoint's own snapshot; one busy lock shared by every session lets one backup or restore run at a time. Pieces
 * and results a GM client sends are untrusted (any local process can connect and identify), so their shapes are
 * checked against the pieces actually received before a file is finished or a result is returned.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
   BACKUP_BUSY,
   BACKUP_BYTES_GUIDELINE,
   BACKUP_DOCUMENTS_GUIDELINE,
   BACKUP_INCOMPLETE,
   BACKUP_NOTE_GUIDELINE_BYTES,
   BACKUP_NOTE_MAX_JSON_BYTES,
   BACKUP_TIMEOUT_DEFAULT_MS,
   BACKUP_TIMEOUT_GUIDELINE_MS,
   BACKUP_UUIDS_GUIDELINE,
   BACKUP_WRITE_FAILED,
   LIST_LIMIT_DEFAULT,
   LIST_LIMIT_GUIDELINE,
   LIST_NOTE_MAX_BYTES,
   BACKUP_PIECE_MAX_BYTES,
   RESTORE_ROWS_MAX,
   isBackupNote,
   isWorldField,
   type WorldDescription,
} from '../shared/backup.js';
import { getBudget } from '../shared/budgets.js';
import { defaultBridgeSettings, type BridgeSettings } from '../shared/bridgeSettings.js';
import { closedGateState, gateDenial, type GateState } from '../shared/gates.js';
import { ENDPOINT_GONE, GATE_DENIED, OP_BACKUP_EXPORT, OP_BACKUP_RESTORE } from '../shared/protocol.js';
import { utf8Bytes } from '../shared/utf8.js';
import {
   namePartialFile,
   type BackupFileReader,
   type BackupFileWriter,
   type BackupListing,
   type BackupStore,
   type ResolvedFolder,
} from './backups.ts';
import {
   BridgeError,
   type Endpoint,
   type EndpointKind,
   type EndpointSnapshot,
   type InvokeOptions,
} from './endpoints.ts';
import type { IncomingPiece, OutgoingPiece, PieceSink } from './foundryBridge.ts';
import { describeCause } from './logText.ts';
import type { ToolRegistration } from './mcp.ts';
import { truncateUtf8 } from './utf8.ts';

/** The slice of the Foundry bridge the backup tools use. */
export interface BackupBridge {
   invoke(op: string, params: object, options?: InvokeOptions): Promise<unknown>;
   snapshot(options?: InvokeOptions): EndpointSnapshot | undefined;
   expectPieces(socketId: string, requestId: string, sink: PieceSink): () => void;
   sendPiece(socketId: string, piece: OutgoingPiece, timeoutMs: number): Promise<void>;
}

/** The dependencies of the backup tools. */
export interface BackupToolsDeps {
   bridge: BackupBridge;
   store: BackupStore;
   // Receives one sidecar log line (default: `console.log`).
   log?: (line: string) => void;
   // The clock in milliseconds that bounds a restore's piece acks (default: `Date.now`).
   now?: () => number;
}

/** The piece sink of one backup: it writes the data pieces in order and records the stream's first failure. */
export interface BackupSink extends PieceSink {
   // The first failure the sink recorded, if any.
   failure(): BridgeError | undefined;
   // The file writer, once the first data piece created the file.
   writer(): BackupFileWriter | undefined;
   // What the sink accepted: data pieces, data bytes, newline bytes, and whether the end marker arrived.
   counts(): { pieces: number; bytes: number; lines: number; ended: boolean };
}

/** The arguments of `backup_documents`. */
interface BackupArgs {
   uuids?: string[];
   folderUuid?: string;
   documentName?: string;
   pack?: string;
   folder?: string;
   note?: string;
   dryRun?: boolean;
   timeoutMs?: number;
}

/** The arguments of `list_backups`. */
interface ListArgs {
   folder?: string;
   limit?: number;
}

/** The arguments of `restore_backup`. */
interface RestoreArgs {
   file: string;
   folder?: string;
   uuids?: string[];
   dryRun?: boolean;
   timeoutMs?: number;
}

/** The arguments of `delete_backup`. */
interface DeleteArgs {
   file: string;
   folder?: string;
}

// Milliseconds the sidecar waits for a backup or restore reply beyond the call's own `timeoutMs`, so the client's own
// time-limit failure arrives before the sidecar gives up.
const REPLY_GRACE_MS: number = 2000;

// The longest delay a timer holds: Node and browsers store it as a signed 32-bit integer of milliseconds, and a longer
// one fires at once (Node `setTimeout` docs; MDN, "setTimeout(): Maximum delay value").
const TIMER_DELAY_MAX_MS: number = 2 ** 31 - 1;

// The largest `timeoutMs` of a backup or restore call: the sidecar's reply timer runs `timeoutMs` + `REPLY_GRACE_MS`,
// which must still fit a timer. The smallest is 1 ms: a time limit of 0 or less has passed before the call starts.
const TIMEOUT_MAX_MS: number = TIMER_DELAY_MAX_MS - REPLY_GRACE_MS;

// Longest string a restore result may carry in a field or after the uuid of a row, in UTF-8 bytes.
const RESTORE_STRING_MAX_BYTES: number = 256;

// The count fields of a restore result; the client restore always sends each.
const RESTORE_COUNT_KEYS: readonly string[] = [
   'replaced',
   'created',
   'skipped',
   'failed',
   'secretLost',
];

// Most entries of a restore result's `differences`: the client compares three world fields (`foundryVersion`,
// `systemId`, `systemVersion`), one entry each; a fourth means the result did not come from the client restore.
const RESTORE_DIFFERENCES_MAX: number = 3;

// The newline byte that ends every document line of a backup.
const NEWLINE: number = 0x0a;

// The refusal of a backup call that names no selector or more than one.
const SELECTOR_MESSAGE: string = 'Give exactly one of uuids, folderUuid, documentName or pack.';

// The refusal of a client result that does not match the pieces the client sent.
const MISMATCH_MESSAGE: string = 'The Foundry client sent a result that does not match the pieces it sent.';

// The refusal of a restore result the client restore cannot have built; the client applies documents before it answers.
const RESTORE_MISMATCH_MESSAGE: string = 'The Foundry client sent a restore result of an unexpected shape; its '
   + 'documents may already be applied.';

// The refusal of a call made while a backup or restore runs.
const BUSY_MESSAGE: string = 'A backup or restore is already running; retry when it ends.';

/**
 * Build the `BACKUP_INCOMPLETE` error for a client result that does not match its pieces.
 * @returns {BridgeError} The error.
 */
function mismatch(): BridgeError {
   return new BridgeError(BACKUP_INCOMPLETE, MISMATCH_MESSAGE);
}

/**
 * Build the `BACKUP_INCOMPLETE` error for a restore result of an unexpected shape.
 * @returns {BridgeError} The error.
 */
function restoreMismatch(): BridgeError {
   return new BridgeError(BACKUP_INCOMPLETE, RESTORE_MISMATCH_MESSAGE);
}

/**
 * Check that a value is a non-negative integer.
 * @param {unknown} value - The untrusted value.
 * @returns {boolean} Whether it is an integer of 0 or more.
 */
function isCount(value: unknown): value is number {
   return Number.isInteger(value) && (value as number) >= 0;
}

/**
 * Check that a value is a string of at most `RESTORE_STRING_MAX_BYTES` UTF-8 bytes.
 * @param {unknown} value - The untrusted value.
 * @returns {boolean} Whether it is such a string.
 */
function isShortString(value: unknown): value is string {
   return typeof value === 'string' && utf8Bytes(value) <= RESTORE_STRING_MAX_BYTES;
}

/**
 * Count the newline bytes of a piece; each ends one document line.
 * @param {Buffer} data - The piece.
 * @returns {number} The newline count.
 */
function countNewlines(data: Buffer): number {
   // Newlines found so far.
   let count: number = 0;
   // The index of the next newline, or -1 when none is left.
   let index: number = data.indexOf(NEWLINE);
   while (index !== -1) {
      count += 1;
      index = data.indexOf(NEWLINE, index + 1);
   }
   return count;
}

/**
 * Wrap a result object as a tool result of one JSON text item.
 * @param {object} value - The result.
 * @returns {CallToolResult} The tool result.
 */
function jsonResult(value: object): CallToolResult {
   return {
      content: [
         {
            type: 'text',
            text: JSON.stringify(value),
         },
      ],
   };
}

/**
 * Drop rows from the end of a result's `rows` until its JSON fits, setting `cut: true` when any was dropped.
 * @param {object} result - The result; its `rows` array is copied, never changed.
 * @param {number} maxBytes - The JSON size limit in UTF-8 bytes.
 * @returns {object} The result unchanged when it fits or has no rows; otherwise a copy with fewer rows and `cut`.
 */
function fitRows(result: object, maxBytes: number): object {
   // The result viewed as a field map.
   const fields: Record<string, unknown> = result as Record<string, unknown>;
   if (utf8Bytes(JSON.stringify(result)) <= maxBytes || !Array.isArray(fields.rows)) {
      return result;
   }
   // The rows kept so far; the copy below holds this array.
   const rows: unknown[] = [...fields.rows];
   // The copy with the cut marker.
   const fitted: Record<string, unknown> = {
      ...fields,
      rows,
      cut: true,
   };
   while (rows.length > 0 && utf8Bytes(JSON.stringify(fitted)) > maxBytes) {
      rows.pop();
   }
   return fitted;
}

/**
 * Fit a `list_backups` result to a byte budget by dropping rows from the end.
 * @param {object} result - The listing `{ folder, rows, total, invalid? }`.
 * @param {number} maxBytes - The JSON size limit in UTF-8 bytes.
 * @returns {object} The result, with fewer rows and `cut: true` when any was dropped.
 */
export function fitListResult(result: object, maxBytes: number): object {
   return fitRows(result, maxBytes);
}

/**
 * Fit a `restore_backup` result to a byte budget by dropping rows from the end.
 * @param {object} result - The checked restore result, `file` first.
 * @param {number} maxBytes - The JSON size limit in UTF-8 bytes.
 * @returns {object} The result, with fewer rows and `cut: true` when any was dropped.
 */
export function fitRestoreResult(result: object, maxBytes: number): object {
   return fitRows(result, maxBytes);
}

/**
 * Create the sink of one backup stream. Data pieces must arrive with `seq` 0, 1, 2, …; the end marker must name the
 * data piece count and byte total and follow a newline, so the file holds only complete document lines. The first
 * failure is kept, refuses every later piece, and is what `failure()` returns.
 * @param {() => Promise<BackupFileWriter>} openWriter - Creates the backup file; runs on the first data piece.
 * @returns {BackupSink} The sink.
 */
export function createBackupSink(openWriter: () => Promise<BackupFileWriter>): BackupSink {
   // The first failure, if any.
   let failure: BridgeError | undefined;
   // The file writer, once created.
   let writer: BackupFileWriter | undefined;
   // Data pieces accepted.
   let pieces: number = 0;
   // Data bytes accepted.
   let bytes: number = 0;
   // Newline bytes accepted.
   let lines: number = 0;
   // The last data byte accepted, or undefined before the first.
   let lastByte: number | undefined;
   // Whether the end marker was accepted.
   let ended: boolean = false;

   /**
    * Record a failure unless one is already kept, and throw the kept one.
    * @param {BridgeError} error - The failure.
    * @returns {never} Always throws.
    * @throws {BridgeError} The first failure.
    */
   function fail(error: BridgeError): never {
      failure ??= error;
      throw failure;
   }

   return {
      async piece(piece: IncomingPiece): Promise<void> {
         if (failure !== undefined) {
            throw failure;
         }
         if (ended || piece.seq !== pieces) {
            fail(new BridgeError(BACKUP_INCOMPLETE, 'A backup piece arrived out of order.'));
         }
         if (piece.end === true) {
            if (piece.pieces !== pieces || piece.bytes !== bytes) {
               fail(new BridgeError(
                  BACKUP_INCOMPLETE,
                  'The backup stream ended with a piece count or size that does not match the pieces received.',
               ));
            }
            if (lastByte !== undefined && lastByte !== NEWLINE) {
               fail(new BridgeError(BACKUP_INCOMPLETE, 'The backup stream ended inside a document line.'));
            }
            ended = true;
            return;
         }
         // The data piece; the bridge gives every data piece its bytes.
         const data: Buffer = piece.data as Buffer;
         try {
            writer ??= await openWriter();
            writer.append(data);
         } catch (error) {
            fail(error instanceof BridgeError
               ? error
               : new BridgeError(BACKUP_WRITE_FAILED, 'The backup file could not be written.'));
         }
         pieces += 1;
         bytes += data.length;
         lines += countNewlines(data);
         lastByte = data.at(-1) ?? lastByte;
      },

      gone(): void {
         failure ??= new BridgeError(
            ENDPOINT_GONE,
            'The Foundry endpoint disconnected during the backup; nothing was saved.',
         );
      },

      failure: () => failure,

      writer: () => writer,

      counts: () => ({
         pieces,
         bytes,
         lines,
         ended,
      }),
   };
}

/**
 * Resolve a call's folder against the endpoint's Backup folder setting and judge `allowBackupAnyFolder` for a folder
 * the caller named.
 * @param {BackupStore} store - The store.
 * @param {string | undefined} folder - The caller's folder.
 * @param {GateState} gateState - The endpoint's gate snapshot.
 * @param {BridgeSettings} settings - The endpoint's bridge settings.
 * @returns {ResolvedFolder} The resolved folder.
 * @throws {BridgeError} `BACKUP_FOLDER_INVALID` from the store, or `GATE_DENIED` for a named folder with the gate
 *         closed.
 */
function chooseFolder(
   store: BackupStore,
   folder: string | undefined,
   gateState: GateState,
   settings: BridgeSettings,
): ResolvedFolder {
   // The resolved folder.
   const resolved: ResolvedFolder = store.resolveFolder(folder, settings.backupFolder);
   if (resolved.kind === 'named') {
      // The gate's denial, or null when it is open.
      const denial: { code: string; message: string } | null = gateDenial(gateState, 'allowBackupAnyFolder');
      if (denial !== null) {
         throw new BridgeError(GATE_DENIED, denial.message);
      }
   }
   return resolved;
}

/**
 * Check that a value is an array of `min` to `max` strings of at most `RESTORE_STRING_MAX_BYTES` bytes each.
 * @param {unknown} value - The untrusted value.
 * @param {number} min - The fewest entries.
 * @param {number} max - The most entries.
 * @returns {boolean} Whether it is such an array.
 */
function isShortStringArray(value: unknown, min: number, max: number): value is string[] {
   return Array.isArray(value) && value.length >= min && value.length <= max && value.every(isShortString);
}

/**
 * Check that a value is a restore row `[uuid, state, reason?]`: a uuid string, then one or two strings of at most
 * `RESTORE_STRING_MAX_BYTES` bytes. The uuid has no length bound: no tool caps the length of a uuid (a skipped row
 * echoes an asked uuid, the others carry the uuid of a backed-up document, whose pack id may be of any length), and the
 * Socket.IO message bound (`maxHttpBufferSize`, 1,000,000 bytes) bounds the whole result the client sends.
 * @param {unknown} value - The untrusted value.
 * @returns {boolean} Whether it is such a row.
 */
function isRestoreRow(value: unknown): boolean {
   return Array.isArray(value)
      && typeof value[0] === 'string'
      && isShortStringArray(value.slice(1), 1, 2);
}

/**
 * Check a restore result a GM client sent against the `RestoreResult` the client restore builds
 * (`src/bridge/backup/restoreBackup.js`): the counts `replaced`, `created`, `skipped`, `failed` and `secretLost` as
 * non-negative integers; `rows`, at most `RESTORE_ROWS_MAX` rows that pass `isRestoreRow`; `differences`, when
 * present, one to `RESTORE_DIFFERENCES_MAX` strings of at most `RESTORE_STRING_MAX_BYTES` bytes; `dryRun`, when
 * present, `true`; no other field.
 * @param {unknown} value - The untrusted result.
 * @returns {Record<string, unknown>} A copy of the fields.
 * @throws {BridgeError} `BACKUP_INCOMPLETE` for any other shape.
 */
function checkRestoreResult(value: unknown): Record<string, unknown> {
   if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw restoreMismatch();
   }
   // The fields, each checked below.
   const entries: Array<[string, unknown]> = Object.entries(value);
   // The result viewed as a field map.
   const fields: Record<string, unknown> = Object.fromEntries(entries);
   // Every key the client restore can send.
   const known: string[] = [
      ...RESTORE_COUNT_KEYS,
      'rows',
      'differences',
      'dryRun',
   ];
   if (
      !entries.every(([key]) => known.includes(key)) ||
      !RESTORE_COUNT_KEYS.every((key) => isCount(fields[key])) ||
      !Array.isArray(fields.rows) ||
      fields.rows.length > RESTORE_ROWS_MAX ||
      !fields.rows.every(isRestoreRow) ||
      (fields.differences !== undefined && !isShortStringArray(fields.differences, 1, RESTORE_DIFFERENCES_MAX)) ||
      (fields.dryRun !== undefined && fields.dryRun !== true)
   ) {
      throw restoreMismatch();
   }
   // `Object.fromEntries` defines own data properties, so a `__proto__` key cannot change the prototype.
   return fields;
}

/**
 * Create the backup tools. One busy lock is shared by every session the returned function builds tools for.
 * @param {BackupToolsDeps} deps - The bridge, the store, the logger and the clock.
 * @returns {(endpoint: EndpointKind | undefined) => ToolRegistration[]} Builds the four registrations for a session
 *          that routes to `endpoint` (undefined for no restriction).
 */
export function createBackupTools(deps: BackupToolsDeps): (endpoint: EndpointKind | undefined) => ToolRegistration[] {
   // The Foundry bridge and the backup file store.
   const { bridge, store }: BackupToolsDeps = deps;
   // The sidecar log.
   const log: (line: string) => void = deps.log ?? ((line: string) => console.log(line));
   // The clock.
   const now: () => number = deps.now ?? Date.now;
   // Whether a backup or restore is running.
   let busy: boolean = false;

   /**
    * Log one warning line when a measure of a call is over its guideline; nothing is refused.
    * @param {string} tool - The tool's name.
    * @param {string} measure - What was measured.
    * @param {number} value - The measured value.
    * @param {number} guideline - The guideline value.
    * @returns {void}
    */
   function warnPast(tool: string, measure: string, value: number, guideline: number): void {
      if (value > guideline) {
         log(`Wiretap sidecar | ${tool} warning: ${measure} ${value} is over the ${guideline} guideline`);
      }
   }

   /**
    * Log the warnings for the arguments a backup or restore call shares: its uuid count and its time limit.
    * @param {string} tool - The tool's name.
    * @param {{ uuids?: string[], timeoutMs?: number }} args - The validated arguments.
    * @returns {void}
    */
   function warnSharedArgs(tool: string, args: { uuids?: string[]; timeoutMs?: number }): void {
      warnPast(tool, 'uuids', args.uuids?.length ?? 0, BACKUP_UUIDS_GUIDELINE);
      warnPast(tool, 'timeoutMs', args.timeoutMs ?? BACKUP_TIMEOUT_DEFAULT_MS, BACKUP_TIMEOUT_GUIDELINE_MS);
   }

   /**
    * Refuse a call while a backup or restore runs.
    * @returns {void}
    * @throws {BridgeError} `BACKUP_BUSY`.
    */
   function refuseWhileBusy(): void {
      if (busy) {
         throw new BridgeError(BACKUP_BUSY, BUSY_MESSAGE);
      }
   }

   /**
    * Resolve and gate-check a folder for a tool that runs in the sidecar, on the snapshot of the endpoint a call would
    * reach; with no endpoint, every gate is closed and the settings are the defaults.
    * @param {InvokeOptions} routing - The session's routing options.
    * @param {string | undefined} folder - The caller's folder.
    * @returns {ResolvedFolder} The folder.
    * @throws {BridgeError} `BACKUP_FOLDER_INVALID` or `GATE_DENIED`.
    */
   function sidecarFolder(routing: InvokeOptions, folder: string | undefined): ResolvedFolder {
      // The endpoint's routing state, or undefined when none is connected.
      const snapshot: EndpointSnapshot | undefined = bridge.snapshot(routing);
      return chooseFolder(
         store,
         folder,
         snapshot?.gateState ?? closedGateState(),
         snapshot?.settings ?? defaultBridgeSettings(),
      );
   }

   /**
    * Close a partial backup file and move it to the recycle bin, also when closing it fails; when the recycle bin
    * refuses it, name the file in the failure.
    * @param {BackupFileWriter} writer - The partial file.
    * @param {unknown} error - The failure of the backup.
    * @returns {Promise<unknown>} The failure to throw.
    */
   async function discardPartial(writer: BackupFileWriter, error: unknown): Promise<unknown> {
      try {
         writer.close();
      } catch (cause) {
         log(`Wiretap sidecar | partial backup ${writer.file} not closed: ${describeCause(cause)}`);
      }
      try {
         await store.trashPath(writer.filePath);
         return error;
      } catch (cause) {
         log(`Wiretap sidecar | partial backup ${writer.file} not recycled: ${describeCause(cause)}`);
         return error instanceof BridgeError ? namePartialFile(error, writer.file) : error;
      }
   }

   /**
    * Run `backup_documents`.
    * @param {BackupArgs} args - The validated arguments.
    * @param {InvokeOptions} routing - The session's routing options.
    * @returns {Promise<CallToolResult>} The result.
    */
   async function backupDocuments(args: BackupArgs, routing: InvokeOptions): Promise<CallToolResult> {
      // How many selectors the call names.
      const selectors: number = [args.uuids, args.folderUuid, args.documentName, args.pack]
         .filter((value) => value !== undefined).length;
      if (selectors !== 1) {
         throw new BridgeError('ARGS_INVALID', SELECTOR_MESSAGE);
      }
      if (args.note !== undefined && !isBackupNote(args.note)) {
         throw new BridgeError(
            'ARGS_INVALID',
            `note must have no control characters and take at most ${BACKUP_NOTE_MAX_JSON_BYTES} bytes in the backup `
               + 'header.',
         );
      }
      refuseWhileBusy();
      warnSharedArgs('backup_documents', args);
      warnPast('backup_documents', 'note bytes', utf8Bytes(args.note ?? ''), BACKUP_NOTE_GUIDELINE_BYTES);
      busy = true;
      try {
         return await runBackup(args, routing);
      } finally {
         busy = false;
      }
   }

   /**
    * Invoke the client export, write the streamed file, and check the client's result against the pieces.
    * @param {BackupArgs} args - The validated arguments.
    * @param {InvokeOptions} routing - The session's routing options.
    * @returns {Promise<CallToolResult>} The result.
    */
   async function runBackup(args: BackupArgs, routing: InvokeOptions): Promise<CallToolResult> {
      // Whether the call only measures.
      const dryRun: boolean = args.dryRun === true;
      // The client's time limit.
      const timeoutMs: number = args.timeoutMs ?? BACKUP_TIMEOUT_DEFAULT_MS;
      // The folder, once `prepare` resolved it.
      let folder: ResolvedFolder | undefined;
      // The sink, when one was registered.
      let sink: BackupSink | undefined;
      // Removes the sink from the bridge.
      let removeSink: (() => void) | undefined;
      // The client's result.
      let result: unknown;
      // The invoke's failure, if any.
      let invokeError: unknown;
      try {
         result = await bridge.invoke(OP_BACKUP_EXPORT, {}, {
            ...routing,
            replyWaitMs: timeoutMs + REPLY_GRACE_MS,
            prepare: (endpoint: Endpoint, requestId: string): object => {
               // The resolved, gate-checked folder.
               const chosen: ResolvedFolder = chooseFolder(store, args.folder, endpoint.gateState, endpoint.settings);
               folder = chosen;
               store.checkFolder(chosen, !dryRun);
               if (!dryRun) {
                  sink = createBackupSink(() => store.createFile(chosen));
                  removeSink = bridge.expectPieces(endpoint.socketId, requestId, sink);
               }
               return {
                  ...(args.uuids === undefined ? {} : { uuids: args.uuids }),
                  ...(args.folderUuid === undefined ? {} : { folderUuid: args.folderUuid }),
                  ...(args.documentName === undefined ? {} : { documentName: args.documentName }),
                  ...(args.pack === undefined ? {} : { pack: args.pack }),
                  ...(dryRun ? { dryRun: true } : {}),
                  timeoutMs,
               };
            },
         });
      } catch (error) {
         invokeError = error;
      } finally {
         removeSink?.();
      }
      if (sink === undefined) {
         if (invokeError !== undefined) {
            throw invokeError;
         }
         return jsonResult(measurement(result, (folder as ResolvedFolder).kind));
      }
      // The partial or finished file, once the first piece created it.
      const writer: BackupFileWriter | undefined = sink.writer();
      try {
         // The first failure: the sink's, then the invoke's.
         const failure: unknown = sink.failure() ?? invokeError;
         if (failure !== undefined) {
            throw failure;
         }
         return jsonResult(finishBackup(result, sink, args.note ?? '', (folder as ResolvedFolder).kind));
      } catch (error) {
         throw writer === undefined ? error : await discardPartial(writer, error);
      }
   }

   /**
    * Log the warnings for a backup's size: its document count and its file bytes.
    * @param {number} documents - The documents in the backup.
    * @param {number} bytes - The file bytes, header included.
    * @returns {void}
    */
   function warnSize(documents: number, bytes: number): void {
      warnPast('backup_documents', 'documents', documents, BACKUP_DOCUMENTS_GUIDELINE);
      warnPast('backup_documents', 'bytes', bytes, BACKUP_BYTES_GUIDELINE);
   }

   /**
    * Build a dry run's result from the client's measurement.
    * @param {unknown} value - The untrusted client result.
    * @param {ResolvedFolder['kind']} kind - The folder kind.
    * @returns {object} `{ dryRun: true, folder, documents, bytes }` plus `unreadable` and `parents` when above 0.
    * @throws {BridgeError} `BACKUP_INCOMPLETE` when a count is not a non-negative integer.
    */
   function measurement(value: unknown, kind: ResolvedFolder['kind']): object {
      // The client result viewed as a field map.
      const fields: Record<string, unknown> = (value ?? {}) as Record<string, unknown>;
      // The client's counts, each checked below.
      const { documents, bytes, unreadable, parents }: Record<string, unknown> = fields;
      if (!isCount(documents) || !isCount(bytes) || !isCount(unreadable) || !isCount(parents)) {
         throw mismatch();
      }
      warnSize(documents, bytes);
      return {
         dryRun: true,
         folder: kind,
         documents,
         bytes,
         ...(unreadable > 0 ? { unreadable } : {}),
         ...(parents > 0 ? { parents } : {}),
      };
   }

   /**
    * Check the client's result against the pieces the sink accepted and finish the file's header.
    * @param {unknown} value - The untrusted client result.
    * @param {BackupSink} sink - The sink of the stream.
    * @param {string} note - The caller's note.
    * @param {ResolvedFolder['kind']} kind - The folder kind.
    * @returns {object} `{ file, folder, documents, bytes }` plus `unreadable` and `parents` when above 0.
    * @throws {BridgeError} `BACKUP_INCOMPLETE` on a mismatch; `BACKUP_WRITE_FAILED` when the header cannot be written.
    */
   function finishBackup(value: unknown, sink: BackupSink, note: string, kind: ResolvedFolder['kind']): object {
      // What the sink accepted.
      const counts: { pieces: number; bytes: number; lines: number; ended: boolean } = sink.counts();
      // The file, present once a data piece arrived.
      const writer: BackupFileWriter | undefined = sink.writer();
      // The client result viewed as a field map.
      const fields: Record<string, unknown> = (value ?? {}) as Record<string, unknown>;
      // The client's counts, each checked below.
      const { documents, bytes, unreadable, parents }: Record<string, unknown> = fields;
      // The world description viewed as a field map.
      const world: Record<string, unknown> = (typeof fields.world === 'object' && fields.world !== null
         ? fields.world
         : {}) as Record<string, unknown>;
      if (
         !counts.ended ||
         writer === undefined ||
         !isCount(documents) ||
         documents < 1 ||
         documents !== counts.lines ||
         bytes !== writer.size() ||
         !isCount(unreadable) ||
         !isCount(parents) ||
         !isWorldField(world.worldId) ||
         !isWorldField(world.foundryVersion) ||
         !isWorldField(world.systemId) ||
         !isWorldField(world.systemVersion)
      ) {
         throw mismatch();
      }
      // The checked world description.
      const checked: WorldDescription = world as unknown as WorldDescription;
      // The header as written.
      const header: { bytes: number } = writer.finish({
         worldId: checked.worldId,
         foundryVersion: checked.foundryVersion,
         systemId: checked.systemId,
         systemVersion: checked.systemVersion,
         note,
         documents,
      });
      warnSize(documents, header.bytes);
      return {
         file: writer.file,
         folder: kind,
         documents,
         bytes: header.bytes,
         ...(unreadable > 0 ? { unreadable } : {}),
         ...(parents > 0 ? { parents } : {}),
      };
   }

   /**
    * Send a backup file's document bytes to a GM client in pieces, then the end marker. A failure is logged and stops
    * the pump; the invoke's outcome decides the call. Never rejects.
    * @param {BackupFileReader} reader - The open file.
    * @param {string} socketId - The endpoint's socket id.
    * @param {string} requestId - The invocation's requestId.
    * @param {number} deadline - The clock time after which no ack is awaited.
    * @returns {Promise<void>} Resolves once the pump ends.
    */
   async function pump(reader: BackupFileReader, socketId: string, requestId: string, deadline: number): Promise<void> {
      // The next piece's seq.
      let seq: number = 0;
      // Data bytes sent.
      let bytes: number = 0;
      try {
         // The next piece, or null at the end of the file.
         let data: Buffer | null = reader.readPiece(BACKUP_PIECE_MAX_BYTES);
         while (data !== null) {
            await bridge.sendPiece(socketId, {
               requestId,
               seq,
               data,
            }, deadline - now());
            seq += 1;
            bytes += data.length;
            data = reader.readPiece(BACKUP_PIECE_MAX_BYTES);
         }
         await bridge.sendPiece(socketId, {
            requestId,
            seq,
            end: true,
            pieces: seq,
            bytes,
         }, deadline - now());
      } catch (error) {
         // The failure's code when it is a BridgeError, which `describeCause` leaves out.
         const code: string = error instanceof BridgeError ? `${error.code} ` : '';
         log(
            `Wiretap sidecar | restore pump of ${reader.file} stopped at piece ${seq}: ${code}${describeCause(error)}`,
         );
      }
   }

   /**
    * Run `restore_backup`.
    * @param {RestoreArgs} args - The validated arguments.
    * @param {InvokeOptions} routing - The session's routing options.
    * @returns {Promise<CallToolResult>} The result.
    */
   async function restoreBackup(args: RestoreArgs, routing: InvokeOptions): Promise<CallToolResult> {
      refuseWhileBusy();
      warnSharedArgs('restore_backup', args);
      busy = true;
      // The client's time limit.
      const timeoutMs: number = args.timeoutMs ?? BACKUP_TIMEOUT_DEFAULT_MS;
      // The clock time the reply wait ends; the pump awaits no ack past it.
      const deadline: number = now() + timeoutMs + REPLY_GRACE_MS;
      // The open file, once `prepare` opened it.
      let reader: BackupFileReader | undefined;
      // The endpoint's socket id and the requestId, once `prepare` ran.
      let target: { socketId: string; requestId: string } | undefined;
      // The running pump; resolved when none started.
      let pumping: Promise<void> = Promise.resolve();
      // The client's result.
      let result: unknown;
      try {
         result = await bridge.invoke(OP_BACKUP_RESTORE, {}, {
            ...routing,
            replyWaitMs: timeoutMs + REPLY_GRACE_MS,
            prepare: (endpoint: Endpoint, requestId: string): object => {
               // The resolved, gate-checked folder.
               const folder: ResolvedFolder = chooseFolder(store, args.folder, endpoint.gateState, endpoint.settings);
               store.checkFolder(folder, false);
               reader = store.openFile(folder, args.file);
               warnPast('restore_backup', 'documents', reader.header.documents, BACKUP_DOCUMENTS_GUIDELINE);
               warnPast('restore_backup', 'bytes', reader.header.bytes, BACKUP_BYTES_GUIDELINE);
               target = {
                  socketId: endpoint.socketId,
                  requestId,
               };
               return {
                  header: reader.header,
                  ...(args.uuids === undefined ? {} : { uuids: args.uuids }),
                  ...(args.dryRun === true ? { dryRun: true } : {}),
                  timeoutMs,
               };
            },
            onSent: (): void => {
               // `prepare` set both before the send.
               const sent: { socketId: string; requestId: string } = target as { socketId: string; requestId: string };
               pumping = pump(reader as BackupFileReader, sent.socketId, sent.requestId, deadline);
            },
         });
      } catch (error) {
         if (error instanceof BridgeError && error.code === ENDPOINT_GONE) {
            throw new BridgeError(
               ENDPOINT_GONE,
               'The Foundry endpoint disconnected during the restore; the restore may be partly applied.',
            );
         }
         throw error;
      } finally {
         // The file opened by `prepare`; the lock is held until the pump has ended and the file is closed, so no
         // delete or second restore reaches a file the pump may still hold open.
         const opened: BackupFileReader | undefined = reader;
         if (opened === undefined) {
            busy = false;
         } else {
            void pumping.then(() => {
               try {
                  opened.close();
               } catch (cause) {
                  log(`Wiretap sidecar | backup ${opened.file} could not be closed: ${describeCause(cause)}`);
               } finally {
                  busy = false;
               }
            });
         }
      }
      // The checked result with the sidecar's file name first; the check refuses a `file` field.
      const checked: Record<string, unknown> = {
         file: args.file,
         ...checkRestoreResult(result),
      };
      // The result fitted to the budget.
      const fitted: object = fitRestoreResult(checked, getBudget('RESTORE_RESULT_MAX_BYTES').value);
      if (utf8Bytes(JSON.stringify(fitted)) > getBudget('RESTORE_RESULT_MAX_BYTES').value) {
         throw restoreMismatch();
      }
      return jsonResult(fitted);
   }

   /**
    * Run `list_backups`.
    * @param {ListArgs} args - The validated arguments.
    * @param {InvokeOptions} routing - The session's routing options.
    * @returns {Promise<CallToolResult>} The listing.
    */
   async function listBackups(args: ListArgs, routing: InvokeOptions): Promise<CallToolResult> {
      // The folder; `store.list` checks it.
      const folder: ResolvedFolder = sidecarFolder(routing, args.folder);
      // The rows asked for.
      const limit: number = args.limit ?? LIST_LIMIT_DEFAULT;
      warnPast('list_backups', 'limit', limit, LIST_LIMIT_GUIDELINE);
      // The folder's backups, newest first, with full notes.
      const { rows, total, invalid }: BackupListing = store.list(folder, limit);
      return jsonResult(fitListResult({
         folder: folder.kind,
         rows: rows.map(([file, created, documents, note]) => [
            file,
            created,
            documents,
            truncateUtf8(note, LIST_NOTE_MAX_BYTES),
         ]),
         total,
         ...(invalid > 0 ? { invalid } : {}),
      }, getBudget('BACKUP_LIST_MAX_BYTES').value));
   }

   /**
    * Run `delete_backup`.
    * @param {DeleteArgs} args - The validated arguments.
    * @param {InvokeOptions} routing - The session's routing options.
    * @returns {Promise<CallToolResult>} `{ file, trashed: true }`.
    */
   async function deleteBackup(args: DeleteArgs, routing: InvokeOptions): Promise<CallToolResult> {
      refuseWhileBusy();
      // The folder.
      const folder: ResolvedFolder = sidecarFolder(routing, args.folder);
      store.checkFolder(folder, false);
      await store.trashFile(folder, args.file);
      return jsonResult({
         file: args.file,
         trashed: true,
      });
   }

   return (endpoint: EndpointKind | undefined): ToolRegistration[] => {
      // The session's routing options.
      const routing: InvokeOptions = endpoint === undefined ? {} : { endpoint };
      // An argument has a `.describe` only where its name and type do not say what it is and what it accepts: each
      // listed definition must fit DEFINITION_MAX_BYTES (800 bytes), which `tests/unit/backupTools.test.js` measures.
      // The shared `folder` argument.
      const folderArg: z.ZodOptional<z.ZodString> = z
         .string()
         .max(1024)
         .optional()
         .describe('Absolute; default the backup folder.');
      // The shared `timeoutMs` argument.
      const timeoutArg: z.ZodOptional<z.ZodNumber> = z
         .number()
         .int()
         .min(1)
         .max(TIMEOUT_MAX_MS)
         .optional();
      // The shared `uuids` argument.
      const uuidsArg: z.ZodOptional<z.ZodArray<z.ZodString>> = z
         .array(z.string())
         .min(1)
         .optional();
      return [
         {
            name: 'backup_documents',
            description: 'Save documents (uuids, or one folderUuid, documentName or pack) to a new sidecar backup '
               + 'file. Use or offer before bulk or risky changes.',
            inputSchema: {
               uuids: uuidsArg,
               folderUuid: z.string().optional(),
               documentName: z.string().max(32).optional(),
               pack: z.string().optional(),
               folder: folderArg,
               note: z.string().optional().describe('Short note.'),
               dryRun: z.boolean().optional().describe('Measure only.'),
               timeoutMs: timeoutArg,
            },
            handler: (args: BackupArgs) => backupDocuments(args, routing),
            budgetBytes: getBudget('BACKUP_RESULT_MAX_BYTES').value,
         },
         {
            name: 'list_backups',
            description: 'List the backup files of a folder, newest first, as [file, created, documents, note] rows.',
            inputSchema: {
               folder: folderArg,
               limit: z.number().int().min(1).optional(),
            },
            handler: (args: ListArgs) => listBackups(args, routing),
            budgetBytes: getBudget('BACKUP_LIST_MAX_BYTES').value,
         },
         {
            name: 'restore_backup',
            description: 'Restore documents from a backup file through the write gates. Not atomic: documents apply '
               + 'one by one and hooks run. dryRun plans it.',
            inputSchema: {
               file: z.string().max(64).describe('Backup file name.'),
               folder: folderArg,
               uuids: uuidsArg.describe('Only these documents.'),
               dryRun: z.boolean().optional().describe('Plan only; write nothing.'),
               timeoutMs: timeoutArg,
            },
            handler: (args: RestoreArgs) => restoreBackup(args, routing),
            budgetBytes: getBudget('RESTORE_RESULT_MAX_BYTES').value,
         },
         {
            name: 'delete_backup',
            description: 'Move a backup file to the recycle bin.',
            inputSchema: {
               file: z.string().max(64).describe('Backup file name.'),
               folder: folderArg,
            },
            handler: (args: DeleteArgs) => deleteBackup(args, routing),
            budgetBytes: getBudget('BACKUP_DELETE_MAX_BYTES').value,
         },
      ];
   };
}
