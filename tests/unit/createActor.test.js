import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getBudget } from '$shared/budgets.js';
import { definitionBytes, validateScriptDefinition } from '$shared/scripts.js';
import { createCallTool } from '~/bridge/scripts/callTool.js';
import { createActorDefinition } from '~/bridge/scripts/createActor.js';
import { registerShippedScripts, SHIPPED_SCRIPTS } from '~/bridge/scripts/index.js';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';

/** @type {ReturnType<typeof createScriptRegistry>} A registry holding the shipped scripts. */
let registry;

/** @type {(params: unknown) => Promise<unknown>} The callTool handler over that registry. */
let callTool;

/** @type {import('vitest').Mock} The fake Actor.create. */
let create;

beforeEach(() => {
   registry = createScriptRegistry({ log: () => {} });
   registerShippedScripts(registry);
   callTool = createCallTool({ registry });
   create = vi.fn(async (data) => ({
      uuid: `Actor.${data.name}`,
      id: 'ID',
      name: data.name,
      type: data.type,
   }));
   globalThis.CONST = { BASE_DOCUMENT_TYPE: 'base' };
   globalThis.game = {
      documentTypes: {
         Actor: [
            'base',
            'character',
            'npc',
         ],
      },
      settings: { get: () => false },
   };
   globalThis.Actor = { create };
});

afterEach(() => {
   delete globalThis.CONST;
   delete globalThis.game;
   delete globalThis.Actor;
});

describe('shipped scripts', () => {
   it('registers every shipped script without a refusal', () => {
      const fresh = createScriptRegistry({ log: () => {} });
      const outcomes = registerShippedScripts(fresh);
      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      expect(fresh.definitions().map((definition) => definition.name)).toEqual(
         SHIPPED_SCRIPTS.map((entry) => entry.definition.name),
      );
   });

   it('lists create_actor as a mutating api script with a 256-byte result budget', () => {
      const [definition] = registry.definitions();
      expect(definition.name).toBe('create_actor');
      expect(definition.requires).toBe('api');
      expect(definition.mutates).toBe(true);
      expect(definition.result.budgetBytes).toBe(getBudget('ACK_MAX_BYTES').value);
      expect(definition.gate).toBeUndefined();
   });

   it('passes the shared validator with no warning and fits the definition budgets', () => {
      const outcome = validateScriptDefinition(createActorDefinition, 'shipped');
      expect(outcome.ok).toBe(true);
      expect(outcome.warnings).toEqual([]);
      const { name, description, inputSchema } = createActorDefinition;
      expect(definitionBytes(name, description, inputSchema)).toBeLessThanOrEqual(
         getBudget('DEFINITION_MAX_BYTES').value,
      );
      expect(createActorDefinition.description.length).toBeLessThanOrEqual(getBudget('DESCRIPTION_TARGET_CHARS').value);
   });
});

describe('create_actor', () => {
   it('creates the actor and acks uuid, name and type', async () => {
      await expect(callTool({ name: 'create_actor', arguments: { name: 'Bob', type: 'npc' } })).resolves.toEqual({
         uuid: 'Actor.Bob',
         name: 'Bob',
         type: 'npc',
      });
      expect(create).toHaveBeenCalledWith({
         name: 'Bob',
         type: 'npc',
      });
   });

   it('defaults the type to the first concrete subtype', async () => {
      await expect(callTool({ name: 'create_actor', arguments: { name: 'Bob' } })).resolves.toMatchObject({
         type: 'character',
      });
   });

   it('passes only name and type to the world, never any other argument', async () => {
      await callTool({
         name: 'create_actor',
         arguments: {
            name: 'X',
            key: 'wiretap.allowMacroExecution',
            value: true,
            ownership: { default: 3 },
         },
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith({
         name: 'X',
         type: 'character',
      });
   });

   it('refuses a missing, empty or over-long name, and a bad type, before creating anything', async () => {
      for (const args of [
         {},
         { name: '' },
         { name: 'n'.repeat(129) },
         { name: 5 },
         {
            name: 'ok',
            type: '',
         },
         {
            name: 'ok',
            type: 't'.repeat(65),
         },
         {
            name: 'ok',
            type: 7,
         },
      ]) {
         await expect(callTool({ name: 'create_actor', arguments: args })).rejects.toMatchObject({
            code: 'ARGS_INVALID',
         });
      }
      expect(create).not.toHaveBeenCalled();
   });

   it('accepts a name of 128 characters and acks within 256 bytes even at the longest name and type', async () => {
      const result = await callTool({
         name: 'create_actor',
         arguments: {
            name: 'N'.repeat(128),
            type: 'npc',
         },
      });
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(256);
   });

   it('acks within 256 bytes for the worst case of a multi-byte name and a long uuid', async () => {
      create.mockImplementation(async (data) => ({
         uuid: `Compendium.${'p'.repeat(200)}.Actor.${'i'.repeat(16)}`,
         id: 'ID',
         name: data.name,
         type: data.type,
      }));
      const result = await callTool({
         name: 'create_actor',
         arguments: { name: '😀'.repeat(64) },
      });
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(256);
   });

   it('fails with the world error when Actor.create rejects', async () => {
      create.mockRejectedValue(new Error('permission denied'));
      await expect(callTool({ name: 'create_actor', arguments: { name: 'Bob' } })).rejects.toThrow('permission denied');
   });

   it('fails with the valid-types list for an unknown type', async () => {
      await expect(callTool({ name: 'create_actor', arguments: { name: 'Bob', type: 'wizard' } })).rejects.toThrow(
         /Unknown actor type 'wizard'.*character.*npc/,
      );
      expect(create).not.toHaveBeenCalled();
   });
});
