import { describe, it, expect, vi } from 'vitest';
import { exportForBackup } from '~/bridge/scripts/canonical.js';
import { mockDocument } from './mockDocuments.js';

describe('exportForBackup', () => {
   it('returns the canonical export without uuid and no secret paths for a plain document', () => {
      const actor = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000001',
            type: 'npc',
            source: { system: { hp: { value: 3 } } },
         },
         vi.fn,
      );
      const outcome = exportForBackup(actor);
      expect(actor.toCompendium).toHaveBeenCalledWith(null, {
         clearSource: false,
         keepId: true,
         clearSort: false,
         clearOwnership: false,
      });
      expect(outcome).toEqual({
         ok: true,
         data: {
            _id: 'MOCKACTOR0000001',
            name: 'MOCK_Actor',
            type: 'npc',
            system: { hp: { value: 3 } },
            _stats: { modifiedTime: null },
         },
         secretPaths: [],
      });
   });

   it('lists the path of each secret-named flag key the redaction dropped, embedded documents included', () => {
      const actor = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000001',
            source: {
               flags: {
                  world: {
                     apiKey: 'MOCK_KEY',
                     note: 'kept',
                  },
               },
               items: [{
                  _id: 'MOCKITEM00000001',
                  flags: {
                     mod: {
                        token: 'MOCK_TOKEN',
                        level: 2,
                     },
                  },
               }],
            },
         },
         vi.fn,
      );
      const outcome = exportForBackup(actor);
      expect(outcome.ok).toBe(true);
      expect(outcome.secretPaths).toEqual([
         [
            'flags',
            'world',
            'apiKey',
         ],
         [
            'items',
            0,
            'flags',
            'mod',
            'token',
         ],
      ]);
      expect(outcome.data.flags).toEqual({ world: { note: 'kept' } });
      expect(outcome.data.items).toEqual([{
         _id: 'MOCKITEM00000001',
         flags: { mod: { level: 2 } },
      }]);
      expect(outcome.data.uuid).toBeUndefined();
   });

   it('lists a JSON text in a flag whose redaction changed it', () => {
      const actor = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000001',
            source: { flags: { m: { cfg: '{"password":"x","a":1}' } } },
         },
         vi.fn,
      );
      const outcome = exportForBackup(actor);
      expect(outcome.secretPaths).toEqual([[
         'flags',
         'm',
         'cfg',
      ]]);
      expect(outcome.data.flags).toEqual({ m: { cfg: '{"a":1}' } });
   });

   it('refuses a document that cannot be exported, without throwing', () => {
      const actor = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000001',
         },
         vi.fn,
      );
      actor.toCompendium = vi.fn(() => {
         throw new Error('MOCK_FAILURE');
      });
      expect(exportForBackup(actor)).toEqual({
         ok: false,
         code: 'DOC_UNREADABLE',
         message: 'The document could not be exported.',
      });
   });
});
