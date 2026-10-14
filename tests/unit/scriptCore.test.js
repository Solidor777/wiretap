import { describe, it, expect } from 'vitest';
import { ERROR_MESSAGE_MAX_BYTES, scriptCore } from '~/bridge/scripts/core.js';

describe('scriptCore', () => {
   it('is a frozen table, so a script cannot replace an operation', () => {
      expect(Object.isFrozen(scriptCore)).toBe(true);
   });

   it('holds exactly the read and write operations', () => {
      expect(Object.keys(scriptCore).sort()).toEqual([
         'batchDocuments',
         'createDocuments',
         'deleteDocuments',
         'describeSchema',
         'documentTypes',
         'readDocument',
         'replaceDocument',
         'searchDocuments',
         'updateDocuments',
      ]);
   });

   it('bounds the error text a core operation builds to the ack budget', () => {
      expect(ERROR_MESSAGE_MAX_BYTES).toBe(256);
   });
});
