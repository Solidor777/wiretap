/**
 * The GM-client half of `restore_backup`: read the lines of a backup from the pieces the sidecar streams and put each
 * document back through the same code the write tools use. A document that still exists is replaced in restore mode
 * (`prepareReplace` / `runReplace` of `writeReplace.js`); a deleted one is created again with its id (`prepareCreate`
 * / `runCreate` of `writes.js` with `keepId`). Each document therefore meets every gate, the write guard and Foundry
 * validation that the same write through `replace_document` or `create_documents` meets, and a dry run runs the same
 * checks with the gates of a real run.
 *
 * Lines are applied in file order, one at a time as their bytes arrive, so memory holds about one piece. The backup
 * puts Folders first, parents first, so a Folder is created before the documents inside it. One document that fails
 * does not stop the others; its row says why. A restore is not atomic: one stopped by its time limit is partly
 * applied.
 */

import {
   BACKUP_INCOMPLETE,
   RESTORE_REASON_MAX_BYTES,
   RESTORE_ROWS_MAX,
} from '$shared/backup.js';
import { cleanForLog, describeCause } from '$shared/logText.js';
import { truncateUtf8 } from '$shared/utf8.js';
import { createLineReader } from '~/bridge/backup/lineReader.js';
import { carrySecrets } from '~/bridge/backup/secretCarry.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { isPlainObject } from '~/bridge/scripts/writeFields.js';
import { prepareReplace, runReplace, stripWiretapFlags } from '~/bridge/scripts/writeReplace.js';
import { prepareCreate, runCreate } from '~/bridge/scripts/writes.js';

/**
 * @typedef {object} RestoreParams
 * @property {import('$shared/backup.js').BackupHeader} header - The header of the backup file, read by the sidecar.
 * @property {string[]} [uuids] - Restore only the documents these uuids name (an embedded uuid names its document).
 * @property {boolean} [dryRun] - Run every check and report the planned state of each document; write nothing.
 * @property {number} timeoutMs - The time limit of the whole restore, in milliseconds.
 */

/**
 * The outcome of one document: `[uuid, state, reason]`, with state `replaced`, `created`, `skipped` or `failed`; the
 * reason is absent when there is none.
 * @typedef {[string, string, string?]} RestoreRow
 */

/**
 * @typedef {object} RestoreResult
 * @property {number} replaced - Documents replaced (planned, on a dry run).
 * @property {number} created - Documents created again (planned, on a dry run).
 * @property {number} skipped - Asked uuids no line of the backup matched.
 * @property {number} failed - Lines that could not be applied.
 * @property {RestoreRow[]} rows - At most `RESTORE_ROWS_MAX` rows: failed first, then skipped, created, replaced, each
 * in file order.
 * @property {number} secretLost - Documents whose left-out secret values have no live value to carry back.
 * @property {string[]} [differences] - The world fields that differ from the backup, `<field>: <backup> -> <current>`;
 * absent when none differ.
 * @property {true} [dryRun] - Present on a dry run.
 */

/**
 * @typedef {object} RestoreState
 * @property {boolean} dryRun - Whether nothing is written.
 * @property {Set<string>} plannedFolders - The Folder ids a dry run planned to create.
 * @property {number} secretLost - The documents counted in `RestoreResult.secretLost` so far.
 * @property {Record<'failed' | 'skipped' | 'created' | 'replaced', RestoreRow[]>} rows - The rows of each state.
 */

// The longest world field value shown in a difference or a message, in UTF-8 bytes.
const SHOWN_FIELD_BYTES = 64;

// The reason of a line that is not a backup entry.
const LINE_INVALID_REASON = 'LINE_INVALID: the line is not a backup entry.';

// The reason of a document restored with its folder cleared.
const FOLDER_GONE_REASON = 'FOLDER_GONE: restored outside its folder.';

// The reason of an asked uuid no line matched.
const NOT_IN_BACKUP_REASON = 'not in the backup';

/** @type {TextDecoder} Decodes one complete line; invalid UTF-8 throws, so such a line is not a backup entry. */
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Tell whether a value is one path of `BackupLine.secretPaths`: a non-empty array of strings and integers.
 * @param {unknown} path - The value to test.
 * @returns {boolean} True for a path.
 */
function isSecretPath(path) {
   return Array.isArray(path)
      && path.length > 0
      && path.every((segment) => typeof segment === 'string' || Number.isInteger(segment));
}

/**
 * Parse one line of a backup file.
 * @param {Uint8Array} bytes - The line, without its newline.
 * @returns {import('$shared/backup.js').BackupLine | null} The entry, or null when the line is not one.
 */
function parseLine(bytes) {
   /** @type {unknown} The parsed JSON. */
   let value;
   try {
      value = JSON.parse(decoder.decode(bytes));
   } catch {
      return null;
   }
   if (!isPlainObject(value)
      || typeof value.uuid !== 'string'
      || typeof value.documentName !== 'string'
      || !isPlainObject(value.data)
      || (value.pack !== undefined && typeof value.pack !== 'string')
      || (value.secretPaths !== undefined
         && !(Array.isArray(value.secretPaths) && value.secretPaths.every((path) => isSecretPath(path))))) {
      return null;
   }
   return /** @type {import('$shared/backup.js').BackupLine} */ (value);
}

/**
 * Build a row with its reason cut to `RESTORE_REASON_MAX_BYTES`.
 * @param {string} uuid - The document the row is about.
 * @param {string} state - `replaced`, `created`, `skipped` or `failed`.
 * @param {string} [reason] - Why, when there is something to say.
 * @returns {RestoreRow} The row, two or three entries long.
 */
function rowOf(uuid, state, reason) {
   return reason === undefined
      ? [
         uuid,
         state,
      ]
      : [
         uuid,
         state,
         truncateUtf8(reason, RESTORE_REASON_MAX_BYTES),
      ];
}

/**
 * List the world fields of the backup that differ from the running world.
 * @param {import('$shared/backup.js').BackupHeader} header - The backup header.
 * @returns {string[]} One `<field>: <backup> -> <current>` text per differing field.
 */
function differencesOf(header) {
   /** @type {Array<[string, string, string]>} Each field, its backup value and its current value. */
   const fields = [
      [
         'foundryVersion',
         header.foundryVersion,
         game.version,
      ],
      [
         'systemId',
         header.systemId,
         game.system.id,
      ],
      [
         'systemVersion',
         header.systemVersion,
         game.system.version,
      ],
   ];
   return fields
      .filter(([, backup, current]) => backup !== current)
      .map(([field, backup, current]) =>
         `${field}: ${cleanForLog(backup, SHOWN_FIELD_BYTES)} -> ${cleanForLog(current, SHOWN_FIELD_BYTES)}`);
}

/**
 * Tell whether a Folder id names a Folder a document can be restored into: one of the world, or of the line's pack,
 * or one this dry run planned to create.
 * @param {string} id - The id the document data names as its folder.
 * @param {import('$shared/backup.js').BackupLine} line - The line whose document names the folder.
 * @param {RestoreState} state - The restore state.
 * @returns {boolean} True when the Folder is there.
 */
function folderExists(id, line, state) {
   if (state.plannedFolders.has(id)) {
      return true;
   }
   /** @type {{ get: (id: string) => unknown } | undefined} The Folders the document's collection holds. */
   const folders = line.pack === undefined ? game.folders : game.packs.get(line.pack)?.folders;
   return folders?.get(id) !== undefined;
}

/**
 * Check that a line can land where it came from: its pack exists and is unlocked, its class and subtype exist.
 * @param {import('$shared/backup.js').BackupLine} line - The backup entry to check.
 * @returns {void}
 * @throws {ScriptError} `PACK_GONE`, `PACK_LOCKED` or `TYPE_GONE`.
 */
function checkTarget(line) {
   if (line.pack !== undefined) {
      /** @type {{ locked: boolean } | undefined} The compendium pack the document came from. */
      const pack = game.packs.get(line.pack);
      if (pack === undefined) {
         throw new ScriptError('PACK_GONE', 'the pack no longer exists.');
      }
      if (pack.locked) {
         throw new ScriptError('PACK_LOCKED', 'unlock the pack to restore into it.');
      }
   }
   if (CONFIG[line.documentName]?.documentClass === undefined) {
      throw new ScriptError('TYPE_GONE', 'the document type no longer exists.');
   }
   /** @type {unknown} The subtypes the class has now. */
   const types = game.documentTypes[line.documentName];
   /** @type {unknown} The subtype of the backed-up document. */
   const type = line.data.type;
   if (typeof type === 'string' && Array.isArray(types) && !types.includes(type)) {
      throw new ScriptError('TYPE_GONE', `subtype ${cleanForLog(type, SHOWN_FIELD_BYTES)} no longer exists.`);
   }
}

/**
 * Apply one backup entry: replace the live document, or create it again with its id.
 * @param {import('$shared/backup.js').BackupLine} line - The entry; its data is changed in place.
 * @param {RestoreState} state - The restore state; `secretLost` and `plannedFolders` are updated.
 * @returns {Promise<RestoreRow>} The row of the document.
 * @throws {ScriptError | Error} When a check or the write fails; the caller turns it into a failed row.
 */
async function applyLine(line, state) {
   checkTarget(line);
   /** @type {Record<string, unknown>} The data to write. */
   const data = line.data;
   /** @type {string | undefined} The reason the row carries. */
   let reason;
   if (typeof data.folder === 'string' && !folderExists(data.folder, line, state)) {
      data.folder = null;
      reason = FOLDER_GONE_REASON;
   }
   stripWiretapFlags(data);
   /** @type {{ toObject: () => Record<string, unknown> } | null} The live document, when it still exists. */
   const live = await fromUuid(line.uuid);
   // A dry run prepares with `dryRun: false`, so it meets every gate the real run would meet.
   if (live) {
      if (carrySecrets(data, live.toObject(), line.secretPaths ?? []) > 0) {
         state.secretLost += 1;
      }
      /** @type {Awaited<ReturnType<typeof prepareReplace>>} The checked replace. */
      const plan = await prepareReplace({
         uuid: line.uuid,
         data,
         dryRun: false,
         restore: true,
      });
      if (!state.dryRun) {
         await runReplace(plan);
      }
      return rowOf(line.uuid, 'replaced', reason);
   }
   if ((line.secretPaths ?? []).length > 0) {
      state.secretLost += 1;
   }
   /** @type {Awaited<ReturnType<typeof prepareCreate>>} The checked creation. */
   const plan = await prepareCreate({
      documentName: line.documentName,
      data: [data],
      pack: line.pack,
      keepId: true,
   });
   if (!state.dryRun) {
      await runCreate(plan);
   } else if (line.documentName === 'Folder' && typeof data._id === 'string') {
      state.plannedFolders.add(data._id);
   }
   return rowOf(line.uuid, 'created', reason);
}

/**
 * Turn what a line threw into its failed row.
 * @param {string} uuid - The document the line is about.
 * @param {unknown} error - The thrown value.
 * @returns {RestoreRow} The row in state failed, with the code and message as its reason.
 */
function failedRow(uuid, error) {
   return rowOf(
      uuid,
      'failed',
      error instanceof ScriptError ? `${error.code}: ${error.message}` : `FAILED: ${describeCause(error)}`,
   );
}

/**
 * Restore the documents of a backup. See the file header.
 * @param {RestoreParams} params - The header, the uuids to restore, `dryRun` and the time limit.
 * @param {{ requestId: string, pieces: { receive: (requestId: string) => object } }} invocation - The op invocation,
 * whose piece channel delivers the backup lines.
 * @returns {Promise<RestoreResult>} The counts and the rows.
 * @throws {ScriptError} `ARGS_INVALID` for a backup of another world, `BACKUP_INCOMPLETE` when the stream does not
 * match its end marker, `SCRIPT_TIMEOUT` at the time limit (the restore is then partly applied).
 */
export async function restoreBackup(params, invocation) {
   // Registered before any await, so a piece the sidecar sends right after the invoke has a receiver.
   /** @type {{ next: (waitMs: number) => Promise<object>, close: () => void }} The receiver of the backup lines. */
   const receiver = invocation.pieces.receive(invocation.requestId);
   try {
      /** @type {number} When the restore must stop. */
      const deadline = Date.now() + params.timeoutMs;
      const { header, uuids, dryRun = false } = params;
      if (header.worldId !== game.world.id) {
         throw new ScriptError(
            'ARGS_INVALID',
            `The backup is of world ${cleanForLog(header.worldId, SHOWN_FIELD_BYTES)}, not this world.`,
         );
      }
      /** @type {string[]} The world fields that differ. */
      const differences = differencesOf(header);
      /** @type {RestoreState} The restore state. */
      const state = {
         dryRun,
         plannedFolders: new Set(),
         secretLost: 0,
         rows: {
            failed: [],
            skipped: [],
            created: [],
            replaced: [],
         },
      };
      /** @type {Set<string>} The asked uuids a line matched. */
      const matched = new Set();
      /** @type {ReturnType<typeof createLineReader>} Splits the pieces into lines. */
      const reader = createLineReader();
      /** @type {number} The pieces received. */
      let pieceCount = 0;
      /** @type {number} The bytes received. */
      let byteCount = 0;
      /** @type {number} The lines read, the current one included. */
      let lineNumber = 0;
      for (;;) {
         /**
          * The next piece, or the end marker with the piece and byte counts the sidecar sent.
          * @type {{ data?: Uint8Array, end?: true, pieces?: number, bytes?: number, ack: Function }}
          */
         const piece = await receiver.next(Math.max(1, deadline - Date.now()));
         if (piece.end) {
            if (piece.pieces !== pieceCount || piece.bytes !== byteCount || reader.pending() > 0) {
               throw new ScriptError(
                  BACKUP_INCOMPLETE,
                  'The backup data ended early or did not match its end marker.',
               );
            }
            piece.ack();
            break;
         }
         pieceCount += 1;
         byteCount += piece.data.byteLength;
         for (const bytes of reader.push(piece.data)) {
            if (Date.now() > deadline) {
               /** @type {number} The documents written so far. */
               const applied = dryRun ? 0 : state.rows.created.length + state.rows.replaced.length;
               throw new ScriptError(
                  'SCRIPT_TIMEOUT',
                  `The restore stopped at its time limit after ${applied} documents; it is partly applied.`,
               );
            }
            lineNumber += 1;
            /** @type {import('$shared/backup.js').BackupLine | null} The entry. */
            const line = parseLine(bytes);
            if (line === null) {
               state.rows.failed.push(rowOf(`line ${lineNumber}`, 'failed', LINE_INVALID_REASON));
               continue;
            }
            if (uuids !== undefined) {
               /** @type {string[]} The asked uuids this line's document answers. */
               const asked = uuids.filter((uuid) => uuid === line.uuid || uuid.startsWith(`${line.uuid}.`));
               if (asked.length === 0) {
                  continue;
               }
               for (const uuid of asked) {
                  matched.add(uuid);
               }
            }
            try {
               /** @type {RestoreRow} The row of the applied document. */
               const row = await applyLine(line, state);
               state.rows[row[1]].push(row);
            } catch (error) {
               state.rows.failed.push(failedRow(line.uuid, error));
            }
         }
         piece.ack();
      }
      for (const uuid of uuids ?? []) {
         if (!matched.has(uuid)) {
            state.rows.skipped.push(rowOf(uuid, 'skipped', NOT_IN_BACKUP_REASON));
         }
      }
      return {
         replaced: state.rows.replaced.length,
         created: state.rows.created.length,
         skipped: state.rows.skipped.length,
         failed: state.rows.failed.length,
         rows: [
            ...state.rows.failed,
            ...state.rows.skipped,
            ...state.rows.created,
            ...state.rows.replaced,
         ].slice(0, RESTORE_ROWS_MAX),
         secretLost: state.secretLost,
         ...(differences.length > 0 ? { differences } : {}),
         ...(dryRun ? { dryRun: true } : {}),
      };
   } finally {
      receiver.close();
   }
}
