import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getBudget } from '$shared/budgets.js';
import { definitionBytes, validateScriptDefinition } from '$shared/scripts.js';
import { createCallTool } from '~/bridge/scripts/callTool.js';
import { listDocumentTypesDefinition } from '~/bridge/scripts/definitions.js';
import { registerShippedScripts } from '~/bridge/scripts/index.js';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';
import { installWorld, removeWorld } from './mockDocuments.js';

/** @type {(params: unknown) => Promise<unknown>} The callTool handler over a registry of the shipped scripts. */
let callTool;

beforeEach(() => {
   const registry = createScriptRegistry({ log: () => {} });
   registerShippedScripts(registry);
   callTool = createCallTool({ registry });
   installWorld(
      {
         documentTypes: {
            Actor: [
               'base',
               'player',
               'npc',
            ],
            Item: [
               'base',
               'weapon',
            ],
            Scene: ['base'],
            Setting: ['base'],
            User: ['base'],
            ActiveEffect: [
               'base',
               'effect',
            ],
         },
      },
      vi.fn,
   );
});

afterEach(() => {
   removeWorld();
});

describe('list_document_types definition', () => {
   it('is a read-only api script within the definition and description budgets', () => {
      const outcome = validateScriptDefinition(listDocumentTypesDefinition, 'shipped');
      expect(outcome.ok).toBe(true);
      expect(outcome.warnings).toEqual([]);
      expect(listDocumentTypesDefinition.mutates).toBe(false);
      expect(listDocumentTypesDefinition.requires).toBe('api');
      expect(listDocumentTypesDefinition.gate).toBeUndefined();
      /** @type {import('$shared/scripts.js').ScriptDefinition} The definition under test. */
      const { name, description, inputSchema } = listDocumentTypesDefinition;
      expect(definitionBytes(name, description, inputSchema)).toBeLessThanOrEqual(
         getBudget('DEFINITION_MAX_BYTES').value,
      );
      expect(description.length).toBeLessThanOrEqual(getBudget('DESCRIPTION_TARGET_CHARS').value);
   });

   it('accepts no argument', async () => {
      await expect(callTool({
         name: 'list_document_types',
         arguments: { extra: 1 },
      })).resolves.toBeTypeOf('object');
   });
});

describe('list_document_types', () => {
   it('lists the system, the world and embedded document names and the subtypes without the base type', async () => {
      const result = await callTool({ name: 'list_document_types' });
      expect(result).toEqual({
         system: 'mock-system',
         world: [
            'Actor',
            'Item',
            'Scene',
            'Setting',
            'User',
         ],
         embedded: ['ActiveEffect'],
         subtypes: {
            Actor: [
               'player',
               'npc',
            ],
            Item: ['weapon'],
            ActiveEffect: ['effect'],
         },
      });
   });

   it('holds the result to its budget by leaving out the largest subtype lists and naming them', async () => {
      const many = {
         Actor: [
            'base',
            'player',
         ],
      };
      for (const [name, count] of [
         [
            'Item',
            400,
         ],
         [
            'ActiveEffect',
            300,
         ],
         [
            'Scene',
            2,
         ],
      ]) {
         many[name] = [
            'base',
            ...Array.from({ length: count }, (_, index) => `mock_type_${index}`),
         ];
      }
      installWorld({ documentTypes: many }, vi.fn);
      const result = await callTool({ name: 'list_document_types' });
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(
         listDocumentTypesDefinition.result.budgetBytes,
      );
      expect(result.omitted).toEqual([
         'Item',
         'ActiveEffect',
      ]);
      expect(result.subtypes.Item).toBeUndefined();
      expect(result.subtypes.Actor).toEqual(['player']);
      expect(result.subtypes.Scene).toHaveLength(2);
   });

   it('reports no omitted key when everything fits', async () => {
      const result = await callTool({ name: 'list_document_types' });
      expect(Object.hasOwn(result, 'omitted')).toBe(false);
   });
});
