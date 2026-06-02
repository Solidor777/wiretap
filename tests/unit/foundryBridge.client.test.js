import { describe, it, expect, afterEach } from 'vitest';
import { createActor } from '~/bridge/foundryBridge.js';

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

describe('createActor op handler', () => {
   it('defaults the type to the first concrete subtype when omitted', async () => {
      let received;
      installGlobals(['base', 'character', 'npc'], async (data) => {
         received = data;
         return { uuid: 'Actor.1', id: '1', name: data.name, type: data.type };
      });
      const result = await createActor({ name: 'Bob' });
      expect(received).toEqual({ name: 'Bob', type: 'character' });
      expect(result).toEqual({ uuid: 'Actor.1', id: '1', name: 'Bob', type: 'character' });
   });

   it('passes an explicit valid type through', async () => {
      let received;
      installGlobals(['base', 'character', 'npc'], async (data) => {
         received = data;
         return { uuid: 'Actor.2', id: '2', name: data.name, type: data.type };
      });
      const result = await createActor({ name: 'Goblin', type: 'npc' });
      expect(received.type).toBe('npc');
      expect(result.type).toBe('npc');
   });

   it('rejects an unknown type with the valid-types list', async () => {
      installGlobals(
         ['base', 'character', 'npc'],
         async () => { throw new Error('should not be called'); },
      );
      await expect(createActor({ name: 'X', type: 'wizard' })).rejects.toThrow(/Unknown actor type 'wizard'.*character.*npc/);
   });

   it('surfaces an error thrown by Actor.create', async () => {
      installGlobals(
         ['base', 'character'],
         async () => { throw new Error('permission denied'); },
      );
      await expect(createActor({ name: 'X' })).rejects.toThrow(/permission denied/);
   });

   it('rejects when the world has no concrete actor subtypes', async () => {
      installGlobals(['base'], async () => { throw new Error('should not be called'); });
      await expect(createActor({ name: 'X' })).rejects.toThrow(/No concrete Actor subtypes/);
   });
});
