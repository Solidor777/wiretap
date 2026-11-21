import { describe, it, expect, vi } from 'vitest';
import {
   exportDocument,
   exportForBackup,
   REDACT_MAX_DEPTH,
   REDACT_MAX_NODES,
   REDACT_MAX_STRING_NESTING,
} from '~/bridge/scripts/canonical.js';
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

   /**
    * Build a mocked Actor with the given stored data, and check that the backup export refuses it as cut short while
    * the canonical export still reads it.
    * @param {Record<string, unknown>} source - The stored data of the Actor.
    * @returns {void}
    */
   function expectCutRefused(source) {
      const actor = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000001',
            source,
         },
         vi.fn,
      );
      expect(exportForBackup(actor)).toEqual({
         ok: false,
         code: 'DOC_UNREADABLE',
         message: 'The document is too large or too deeply nested to export whole.',
      });
      expect(exportDocument(actor, {}).ok).toBe(true);
   }

   it('refuses a document with more objects than the walk visits', () => {
      expectCutRefused({ system: { list: Array.from({ length: REDACT_MAX_NODES + 1 }, () => ({})) } });
   });

   it('refuses a document nested deeper than the walk enters', () => {
      /** @type {Record<string, unknown>} The innermost object, below the depth limit. */
      let nested = { leaf: 1 };
      for (let level = 0; level <= REDACT_MAX_DEPTH; level += 1) {
         nested = { next: nested };
      }
      expectCutRefused({ system: nested });
   });

   it('refuses a document whose flag text nests JSON deeper than the walk opens', () => {
      /** @type {string} JSON text wrapped in JSON strings one level more than the walk opens. */
      let text = '{"a":1}';
      for (let level = 0; level < REDACT_MAX_STRING_NESTING; level += 1) {
         text = JSON.stringify(text);
      }
      expectCutRefused({ flags: { m: { cfg: text } } });
   });
});
