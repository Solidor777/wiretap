/**
 * The shipped `delete_pack` script: deletes an unlocked world compendium pack, or with `dryRun` previews it. Deletion
 * is irreversible; the Foundry server removes the pack's files (`dist/database/backend/server-compendium.mjs`), so
 * Wiretap removes none. The definition is in `packDefinitions.js`.
 */

import { cleanForLog } from '$shared/logText.js';
import { fitPackAck, requireOpenGate } from '~/bridge/scripts/packCommon.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * Most bytes of a caller's pack id echoed in a refusal.
 * @type {number}
 */
const ID_ECHO_MAX_BYTES = 64;

/**
 * @typedef {object} DeletePackPreview
 * @property {true} dryRun - Marks the row as a preview.
 * @property {string} id - The pack id, `world.<name>`.
 * @property {string} label - The pack title, cut to fit the ack budget.
 * @property {string} type - The document type the pack holds.
 * @property {number} documents - How many documents the pack's index lists.
 */

/**
 * Delete a world pack, or preview the deletion.
 * The order is fixed: a real run checks its gate before any pack lookup, so a closed gate reveals nothing about the
 * world's packs; the pack must exist, be a world pack, and be unlocked, and a dry run checks the same three.
 * @param {{ id: string, dryRun?: boolean }} args - The validated arguments: the pack id (`world.<name>`) and the flag.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context (unused).
 * @returns {Promise<DeletePackPreview | { id: string, deleted: true }>} The preview row, or the deletion ack.
 * @throws {ScriptError} `GATE_DENIED`, `PACK_NOT_FOUND`, `ARGS_INVALID` or `PACK_LOCKED`.
 */
export async function deletePackHandler(args, ctx) {
   if (args.dryRun !== true) {
      requireOpenGate('allowPackDeletion');
   }
   /** @type {object | undefined} The pack with that id. */
   const pack = game.packs.get(args.id);
   if (pack === undefined) {
      throw new ScriptError('PACK_NOT_FOUND', `No pack with that id. Id: '${cleanForLog(args.id, ID_ECHO_MAX_BYTES)}'.`);
   }
   // `deleteCompendium` sends the bare pack name and the server rebuilds `world.<name>`
   // (`client/documents/collections/compendium-collection.mjs:806-815`), so only a world pack can be deleted.
   if (pack.metadata.packageType !== 'world') {
      throw new ScriptError('ARGS_INVALID', 'Only world packs can be deleted.');
   }
   // For a world pack the `locked` getter is true only when the GM locked it (`compendium-collection.mjs:225-227`).
   if (pack.locked) {
      throw new ScriptError('PACK_LOCKED', 'The pack is locked; unlock it in Foundry first.');
   }
   if (args.dryRun === true) {
      return /** @type {DeletePackPreview} */ (fitPackAck({
         dryRun: true,
         id: pack.collection,
         label: pack.title,
         type: pack.documentName,
         documents: pack.index.size,
      }));
   }
   await pack.deleteCompendium();
   return {
      id: args.id,
      deleted: true,
   };
}
