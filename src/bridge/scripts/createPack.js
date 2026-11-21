/**
 * The shipped `create_pack` script: creates a world compendium pack for one document type. It refuses, before calling
 * Foundry, every argument the Foundry server would refuse, so a refused call never shows an error on the GM screen. The
 * definition is in `packDefinitions.js`.
 */

import { cleanForLog } from '$shared/logText.js';
import { fitPackAck, requireOpenGate } from '~/bridge/scripts/packCommon.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/** @type {number} The most characters a pack name may hold; the name becomes a folder name on the Foundry server. */
const PACK_NAME_MAX_CHARS = 64;

/** @type {number} The most bytes of caller text echoed in a refusal message. */
const ECHO_MAX_BYTES = 64;

/**
 * The characters a pack name may hold. A copy of Foundry's `BasePackage.validateId` pattern
 * (`common/packages/base-package.mjs:583-590`), which is not exposed to modules.
 * @type {RegExp}
 */
const PACK_NAME_PATTERN = /^[A-Za-z0-9-_]+$/;

/**
 * The operating-system reserved names a pack name may not take. A copy of Foundry's `BasePackage.validateId`
 * prohibited pattern (`common/packages/base-package.mjs:583-590`).
 * @type {RegExp}
 */
const RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Check a pack name, given or derived from the label, against the rules the Foundry server applies.
 * @param {string} name - The pack name.
 * @returns {void}
 * @throws {ScriptError} `ARGS_INVALID` for an empty, long, malformed or reserved name.
 */
function checkName(name) {
   if (name.length === 0) {
      throw new ScriptError('ARGS_INVALID', 'label has no letters or digits to name the pack; give a name.');
   }
   if (name.length > PACK_NAME_MAX_CHARS) {
      throw new ScriptError('ARGS_INVALID', `name is over ${PACK_NAME_MAX_CHARS} characters.`);
   }
   if (!PACK_NAME_PATTERN.test(name)) {
      throw new ScriptError(
         'ARGS_INVALID',
         `name may hold only letters, digits, - and _; got '${cleanForLog(name, ECHO_MAX_BYTES)}'.`,
      );
   }
   if (RESERVED_NAME_PATTERN.test(name)) {
      throw new ScriptError('ARGS_INVALID', `name is a reserved name: '${cleanForLog(name, ECHO_MAX_BYTES)}'.`);
   }
}

/**
 * Create the pack, or preview it on a dry run. A real run checks `allowCompendiumWrites` first, so a closed gate
 * reveals nothing about the world's packs; a dry run skips the gate and creates nothing.
 * @param {{ label: string, type: string, name?: string, dryRun?: boolean }} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context (unused).
 * @returns {Promise<{ id: string, label: string, type: string } | { dryRun: true, id: string, label: string,
 * type: string }>} The ack of the new pack, or the preview of the pack a real run would create.
 * @throws {ScriptError} `GATE_DENIED` while the gate is closed on a real run; `ARGS_INVALID` for a blank label, a type
 * Foundry packs cannot hold, a bad name or a name a world pack already has.
 */
export async function createPackHandler(args, ctx) {
   /** @type {boolean} Whether the call only previews the pack. */
   const dryRun = args.dryRun === true;
   if (!dryRun) {
      requireOpenGate('allowCompendiumWrites');
   }
   /** @type {string} The pack title. */
   const label = args.label;
   if (label.trim() === '') {
      throw new ScriptError('ARGS_INVALID', 'label must not be blank.');
   }
   /** @type {readonly string[]} The document types a compendium pack may hold (`common/constants.mjs`). */
   const types = CONST.COMPENDIUM_DOCUMENT_TYPES;
   /** @type {string} The document type of the pack. */
   const type = args.type;
   if (!types.includes(type)) {
      throw new ScriptError(
         'ARGS_INVALID',
         `type must be one of ${types.join(', ')}; got '${cleanForLog(type, ECHO_MAX_BYTES)}'.`,
      );
   }
   // The Foundry server derives a missing name the same way (`label.slugify({ strict: true })`).
   /** @type {string} The bare pack name. */
   const name = args.name ?? label.slugify({ strict: true });
   checkName(name);
   /** @type {string} The id the pack has once created. */
   const id = `world.${name}`;
   // The server checks a collision only against world packs, so a system or module pack of the same bare name is free.
   if (game.packs.has(id)) {
      throw new ScriptError('ARGS_INVALID', `The pack ${id} already exists.`);
   }
   if (dryRun) {
      return /** @type {{ dryRun: true, id: string, label: string, type: string }} */ (
         fitPackAck({
            dryRun: true,
            id,
            label,
            type,
         })
      );
   }
   /** @type {{ collection: string, metadata: { label: string }, documentName: string }} The new pack. */
   const pack = await foundry.documents.collections.CompendiumCollection.createCompendium({
      label,
      type,
      name,
   });
   return /** @type {{ id: string, label: string, type: string }} */ (
      fitPackAck({
         id: pack.collection,
         label: pack.metadata.label,
         type: pack.documentName,
      })
   );
}
