import { describe, it, expect, afterEach } from 'vitest';
import { ERROR_MESSAGE_MAX_BYTES, scriptCore } from '~/bridge/scripts/core.js';

/**
 * Install fake Foundry globals for an actor-creation test.
 * @param {string[]} types - The values of game.documentTypes.Actor.
 * @param {Function} createImpl - The implementation of Actor.create.
 * @returns {void}
 */
function installGlobals(types, createImpl) {
   globalThis.CONST = { BASE_DOCUMENT_TYPE: 'base' };
   globalThis.game = { documentTypes: { Actor: types } };
   globalThis.Actor = { create: createImpl };
}

afterEach(() => {
   delete globalThis.CONST;
   delete globalThis.game;
   delete globalThis.Actor;
});

describe('core.createActor', () => {
   it('defaults the type to the first concrete subtype when omitted', async () => {
      let received;
      installGlobals(['base', 'character', 'npc'], async (data) => {
         received = data;
         return { uuid: 'Actor.1', id: '1', name: data.name, type: data.type };
      });
      const result = await scriptCore.createActor({ name: 'Bob' });
      expect(received).toEqual({ name: 'Bob', type: 'character' });
      expect(result).toEqual({ uuid: 'Actor.1', id: '1', name: 'Bob', type: 'character' });
   });

   it('passes an explicit valid type through', async () => {
      let received;
      installGlobals(['base', 'character', 'npc'], async (data) => {
         received = data;
         return { uuid: 'Actor.2', id: '2', name: data.name, type: data.type };
      });
      const result = await scriptCore.createActor({ name: 'Goblin', type: 'npc' });
      expect(received.type).toBe('npc');
      expect(result.type).toBe('npc');
   });

   it('rejects an unknown type with the valid-types list', async () => {
      installGlobals(['base', 'character', 'npc'], async () => {
         throw new Error('should not be called');
      });
      await expect(scriptCore.createActor({ name: 'X', type: 'wizard' })).rejects.toThrow(
         /Unknown actor type 'wizard'.*character.*npc/,
      );
   });

   it('reports a creation cancelled by a hook as a clear error', async () => {
      installGlobals(['base', 'character'], async () => undefined);
      await expect(scriptCore.createActor({ name: 'X' })).rejects.toThrow('Actor creation was cancelled');
   });

   it('keeps the unknown-type message within the ack budget, listing whole types and counting the rest', async () => {
      /** @type {string[]} Fifty type names, far more than fit in one ack. */
      const types = Array.from({ length: 50 }, (_, index) => `subtype_number_${index}`);
      installGlobals(['base', ...types], async () => {
         throw new Error('should not be called');
      });
      const error = await scriptCore.createActor({ name: 'X', type: 'wizard' }).catch((thrown) => thrown);
      expect(new TextEncoder().encode(error.message).length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_BYTES);
      const match = error.message.match(/Valid types: (.*) \(\+(\d+) more\)$/);
      expect(match).not.toBeNull();
      const listed = match[1].split(', ');
      expect(listed.every((name) => types.includes(name))).toBe(true);
      expect(listed.length + Number(match[2])).toBe(types.length);
   });

   it('echoes a long or control-character type name bounded and on one line', async () => {
      installGlobals(['base', 'character'], async () => {
         throw new Error('should not be called');
      });
      const error = await scriptCore.createActor({ name: 'X', type: `bad\n${'t'.repeat(500)}` }).catch((e) => e);
      expect(error.message).not.toMatch(/\n/);
      expect(new TextEncoder().encode(error.message).length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_BYTES);
      expect(error.message).toMatch(/Valid types: character$/);
   });

   it('surfaces an error thrown by Actor.create', async () => {
      installGlobals(['base', 'character'], async () => {
         throw new Error('permission denied');
      });
      await expect(scriptCore.createActor({ name: 'X' })).rejects.toThrow(/permission denied/);
   });

   it('rejects when the world has no concrete actor subtypes', async () => {
      installGlobals(['base'], async () => {
         throw new Error('should not be called');
      });
      await expect(scriptCore.createActor({ name: 'X' })).rejects.toThrow(/No concrete Actor subtypes/);
   });

   it('is a frozen table, so a script cannot replace an operation', () => {
      expect(Object.isFrozen(scriptCore)).toBe(true);
   });
});
