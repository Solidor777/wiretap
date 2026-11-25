/**
 * Result shaping of the write scripts. A write result is an acknowledgement: one row per document, each within
 * `ACK_MAX_BYTES`, all rows together within `ACK_BATCH_MAX_BYTES`. A row is built at the most detailed level that
 * fits, then at coarser levels (shorter names, shorter paths, a count instead of paths), and the last resort keeps
 * only the uuid and notes how many rows were left out. The preview of a delete dry run is bounded by the default
 * result cap.
 */

import { getBudget } from '$shared/budgets.js';
import { truncateUtf8, utf8Bytes } from '$shared/utf8.js';

/**
 * Longest name of an acknowledged document at each level, in UTF-8 bytes; 0 leaves the name out.
 * @type {readonly number[]}
 */
const NAME_CAPS = Object.freeze([
   80,
   40,
   24,
   12,
   6,
   0,
]);

/**
 * Longest type of an acknowledged document at each level, in UTF-8 bytes.
 * @type {readonly number[]}
 */
const TYPE_CAPS = Object.freeze([
   40,
   24,
   16,
   12,
   8,
   0,
]);

/**
 * Longest path of an acknowledged update at each level, in UTF-8 bytes; the level after the last lists a count.
 * @type {readonly number[]}
 */
const PATH_CAPS = Object.freeze([
   64,
   40,
   24,
   16,
]);

/**
 * Longest name of a delete preview row at each level, in UTF-8 bytes.
 * @type {readonly number[]}
 */
const PREVIEW_NAME_CAPS = Object.freeze([
   64,
   32,
   16,
   8,
]);

/**
 * Measure a value as serialized JSON.
 * @param {unknown} value - The text or value to shorten.
 * @returns {number} The UTF-8 bytes.
 */
function jsonBytes(value) {
   return utf8Bytes(JSON.stringify(value));
}

/**
 * Choose the most detailed level at which every row fits its bound and all rows fit the batch bound.
 * @param {unknown[]} entries - What to acknowledge.
 * @param {number} levels - How many levels `build` supports.
 * @param {(entry: unknown, level: number) => Record<string, unknown>} build - Builds the row of one entry at a level.
 * @returns {Record<string, unknown>[]} The rows; at the last resort the uuids only, cut to fit, with a final
 * `{ omitted }` row naming how many were left out.
 */
function fit(entries, levels, build) {
   /** @type {number} The most bytes one row may take. */
   const rowMax = getBudget('ACK_MAX_BYTES').value;
   /** @type {number} The most bytes all rows may take. */
   const batchMax = getBudget('ACK_BATCH_MAX_BYTES').value;
   for (let level = 0; level < levels; level += 1) {
      /** @type {Record<string, unknown>[]} The rows at this level. */
      const rows = entries.map((entry) => build(entry, level));
      if (rows.every((row) => jsonBytes(row) <= rowMax) && jsonBytes(rows) <= batchMax) {
         return rows;
      }
   }
   /** @type {Record<string, unknown>[]} The uuids alone. */
   const minimal = entries.map((entry) => ({ uuid: entry.uuid }));
   while (minimal.length > 1 && jsonBytes([
      ...minimal,
      { omitted: entries.length - minimal.length },
   ]) > batchMax) {
      minimal.pop();
   }
   if (minimal.length < entries.length) {
      minimal.push({ omitted: entries.length - minimal.length });
   }
   return minimal;
}

/**
 * Build the acknowledgement row of one created or deleted document at a level.
 * @param {{ uuid: string | null, name: string, type: string, dryRun?: boolean }} entry -
 * The created, deleted or previewed document.
 * @param {number} level - The detail level; 0 is the most detailed.
 * @returns {Record<string, unknown>} The uuid, name and type at the level, with `dryRun` when set.
 */
function documentRow(entry, level) {
   /** @type {Record<string, unknown>} The acknowledgement row built from the document. */
   const row = { uuid: entry.uuid };
   if (NAME_CAPS[level] > 0) {
      row.name = truncateUtf8(entry.name, NAME_CAPS[level]);
   }
   if (TYPE_CAPS[level] > 0) {
      row.type = truncateUtf8(entry.type, TYPE_CAPS[level]);
   }
   if (entry.dryRun === true) {
      row.dryRun = true;
   }
   return row;
}

/**
 * Build the acknowledgement row of one updated document at a level: as many paths as fit one row, the rest counted
 * in `more`; at the coarsest level only `changedCount`.
 * @param {{ uuid: string, changed: string[], dryRun?: boolean, dropped?: number }} entry - The updated document.
 * @param {number} level - The detail level; 0 is the most detailed.
 * @returns {Record<string, unknown>} The uuid and the paths at the level, with `dryRun` and `dropped` when set.
 */
function updateRow(entry, level) {
   /** @type {number} The most bytes one row may take. */
   const rowMax = getBudget('ACK_MAX_BYTES').value;
   /** @type {Record<string, unknown>} The acknowledgement row built from the document. */
   const row = { uuid: entry.uuid };
   if (level >= PATH_CAPS.length) {
      row.changedCount = entry.changed.length;
   } else {
      /** @type {string[]} The paths listed. */
      const listed = [];
      row.changed = listed;
      for (const path of entry.changed) {
         listed.push(truncateUtf8(path, PATH_CAPS[level]));
         if (jsonBytes({
            ...row,
            more: entry.changed.length
         }) > rowMax) {
            listed.pop();
            break;
         }
      }
      if (listed.length < entry.changed.length) {
         row.more = entry.changed.length - listed.length;
      }
   }
   if (entry.dryRun === true) {
      row.dryRun = true;
   }
   if (typeof entry.dropped === 'number') {
      row.dropped = entry.dropped;
   }
   return row;
}

/**
 * Build the acknowledgement rows of created or deleted documents: `{ uuid, name, type }`, with `dryRun: true` on a
 * dry run (the uuid is then null).
 * @param {Array<{ uuid: string | null, name: string, type: string, dryRun?: boolean }>} documents -
 * The rows of the documents to acknowledge.
 * @returns {Record<string, unknown>[]} The rows, within the ack budgets.
 */
export function ackDocuments(documents) {
   return fit(documents, NAME_CAPS.length, documentRow);
}

/**
 * Build the acknowledgement rows of updated documents: `{ uuid, changed }`, with `dryRun: true` on a dry run. A row
 * lists as many paths as fit its bound and counts the rest in `more`; at the coarsest level it carries only
 * `changedCount`.
 * @param {Array<{ uuid: string, changed: string[], dryRun?: boolean }>} updates - The updated documents.
 * @returns {Record<string, unknown>[]} The rows, within the ack budgets.
 */
export function ackUpdates(updates) {
   return fit(updates, PATH_CAPS.length + 1, updateRow);
}

/**
 * Build the acknowledgement of a replaced document: one `{ uuid, changed }` row, with the changed top-level fields
 * listed as far as the row bound allows and the rest counted in `more`.
 * @param {{ uuid: string, changed: string[], dryRun?: boolean }} replaced - The replaced document.
 * @returns {Record<string, unknown>[]} A list holding the one row, within the ack budgets.
 */
export function ackReplaced(replaced) {
   return ackUpdates([replaced]);
}

/**
 * Build the acknowledgement of a batch: the created, updated and deleted rows, all shaped together so the whole
 * result stays within `ACK_BATCH_MAX_BYTES`. At the last resort the rows keep only their uuids and `omitted` counts
 * the rows left out.
 * @param {{ created: object[], updated: object[], deleted: object[], dryRun?: true }} result - The rows by kind.
 * @returns {Record<string, unknown>} `{ created, updated, deleted }` (and `dryRun`, `omitted` when they apply).
 */
export function ackBatch(result) {
   /** @type {Array<{ kind: 'created' | 'updated' | 'deleted' }>} Every row with its kind, in result order. */
   const entries = [
      ...result.created.map((entry) => ({
         kind: 'created',
         ...entry
      })),
      ...result.updated.map((entry) => ({
         kind: 'updated',
         ...entry
      })),
      ...result.deleted.map((entry) => ({
         kind: 'deleted',
         ...entry
      })),
   ];
   /** @type {Record<string, unknown>[]} The rows shaped to fit. */
   const rows = fit(entries, NAME_CAPS.length, (entry, level) =>
      entry.kind === 'updated' ? updateRow(entry, Math.min(level, PATH_CAPS.length)) : documentRow(entry, level),
   );
   /** @type {Record<string, unknown>} The acknowledgement. */
   const ack = {
      ...(result.dryRun === true ? { dryRun: true } : {}),
      created: [],
      updated: [],
      deleted: [],
   };
   for (const [index, row] of rows.entries()) {
      if (row.omitted !== undefined) {
         ack.omitted = row.omitted;
      } else {
         ack[entries[index].kind].push(row);
      }
   }
   return ack;
}

/**
 * Add read-back values to acknowledgement rows while each row stays within `ACK_MAX_BYTES` and the batch within
 * `ACK_BATCH_MAX_BYTES`; a row whose values do not fit gets `cut: true` when that fits. A read-back whose export
 * left part of the document out adds `partial: true` to its row, values or not.
 * @param {Record<string, unknown>[]} rows - The rows from `ackDocuments` or `ackUpdates`, one per read-back.
 * @param {Array<{ values: Record<string, unknown>, missing: string[], partial?: true } | null>} readbacks - The
 * slices of each document, null for a document that could not be read back.
 * @returns {Record<string, unknown>[]} The rows with values added where they fit.
 */
export function attachReadback(rows, readbacks) {
   /** @type {number} The most bytes all rows may take. */
   const batchMax = getBudget('ACK_BATCH_MAX_BYTES').value;
   /** @type {number} The most bytes one row may take, read-back included. */
   const rowMax = getBudget('ACK_MAX_BYTES').value;
   /** @type {Record<string, unknown>[]} The rows with read-back. */
   const result = [...rows];
   /** @type {number} The bytes of all rows now. */
   let total = jsonBytes(result);
   for (const [index, readback] of readbacks.entries()) {
      if (readback === null || index >= result.length || result[index].omitted !== undefined) {
         continue;
      }
      /** @type {Record<string, unknown>} The row with its values. */
      const full = {
         ...result[index],
         values: readback.values,
         ...(readback.missing.length > 0 ? { missing: readback.missing } : {}),
         ...(readback.partial === true ? { partial: true } : {}),
      };
      /** @type {Record<string, unknown>} The row marked cut. */
      const cut = {
         ...result[index],
         cut: true,
         ...(readback.partial === true ? { partial: true } : {}),
      };
      for (const candidate of [
         full,
         cut,
      ]) {
         /** @type {number} The batch size with this candidate. */
         const next = total - jsonBytes(result[index]) + jsonBytes(candidate);
         if (next <= batchMax && jsonBytes(candidate) <= rowMax) {
            result[index] = candidate;
            total = next;
            break;
         }
      }
   }
   return result;
}

/**
 * Fit a delete preview into the default result cap: names are shortened level by level, then rows are dropped from
 * the end, and `cut` records any shortfall.
 * @param {{ dryRun: true, rows: Array<[string, string, string]>, total: number, cut?: boolean }} preview - The
 * preview from the core operation.
 * @returns {{ dryRun: true, rows: Array<[string, string, string]>, total: number, cut?: boolean }} The preview within
 * `RESULT_HARD_CAP_DEFAULT_BYTES`.
 */
export function fitPreview(preview) {
   /** @type {number} The result cap. */
   const max = getBudget('RESULT_HARD_CAP_DEFAULT_BYTES').value;
   /**
    * Build the preview with names cut to a bound.
    * @param {number} nameCap - The name bound in bytes.
    * @returns {typeof preview} The preview.
    */
   const build = (nameCap) => ({
      dryRun: true,
      rows: preview.rows.map(([uuid, name, type]) => [
         uuid,
         truncateUtf8(name, nameCap),
         type,
      ]),
      total: preview.total,
      ...(preview.cut === true ? { cut: true } : {}),
   });
   for (const nameCap of PREVIEW_NAME_CAPS) {
      /** @type {typeof preview} The preview at this level. */
      const candidate = build(nameCap);
      if (jsonBytes(candidate) <= max) {
         return candidate;
      }
   }
   /** @type {typeof preview} The preview with the shortest names, cut to fit. */
   const shortest = build(PREVIEW_NAME_CAPS.at(-1));
   while (shortest.rows.length > 1 && jsonBytes(shortest) > max) {
      shortest.rows.pop();
      shortest.cut = true;
   }
   return shortest;
}
