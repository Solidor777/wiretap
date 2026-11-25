import { describe, it, expect } from 'vitest';
import { compileSchema } from '$shared/schemaValidate.js';
import { definitionBytes, validateScriptDefinition } from '$shared/scripts.js';
import { createPackDefinition, deletePackDefinition } from '~/bridge/scripts/packDefinitions.js';

/**
 * Compile a definition's input schema and return its argument validator.
 * @param {import('$shared/scripts.js').ScriptDefinition} definition - The definition whose schema is compiled.
 * @returns {import('$shared/schemaValidate.js').ArgumentValidator} The validator of the compiled schema.
 */
function validatorOf(definition) {
   /** @type {ReturnType<typeof compileSchema>} The compiled schema. */
   const compiled = compileSchema(definition.inputSchema);
   expect(compiled.ok).toBe(true);
   return compiled.validate;
}

describe('pack tool definitions', () => {
   it('declares the pinned names, versions, flags and budgets', () => {
      expect(createPackDefinition).toMatchObject({
         name: 'create_pack',
         version: '1.0.0',
         requires: 'api',
         mutates: true,
      });
      expect(deletePackDefinition).toMatchObject({
         name: 'delete_pack',
         version: '1.0.0',
         requires: 'api',
         mutates: true,
      });
      for (const definition of [
         createPackDefinition,
         deletePackDefinition,
      ]) {
         expect(definition.result.budgetBytes).toBe(256);
         expect(Object.hasOwn(definition, 'gate')).toBe(false);
         expect(Object.hasOwn(definition, 'handleArgs')).toBe(false);
      }
   });

   it('carries requiresUserInteraction on delete_pack only', () => {
      expect(deletePackDefinition.requiresUserInteraction).toBe(true);
      expect(Object.hasOwn(createPackDefinition, 'requiresUserInteraction')).toBe(false);
   });

   it('passes the shared validator with no warning and keeps the flag', () => {
      for (const definition of [
         createPackDefinition,
         deletePackDefinition,
      ]) {
         /** @type {ReturnType<typeof validateScriptDefinition>} The validator's verdict. */
         const outcome = validateScriptDefinition(definition, 'shipped');
         expect(outcome.ok).toBe(true);
         expect(outcome.warnings).toEqual([]);
      }
      expect(validateScriptDefinition(deletePackDefinition, 'shipped').definition.requiresUserInteraction).toBe(true);
   });

   it('lists each definition within 800 bytes and 160 characters of description', () => {
      for (const definition of [
         createPackDefinition,
         deletePackDefinition,
      ]) {
         /** @type {ReturnType<typeof compileSchema>} The compiled schema. */
         const compiled = compileSchema(definition.inputSchema);
         expect(compiled.ok).toBe(true);
         expect(definitionBytes(definition.name, definition.description, compiled.listed)).toBeLessThanOrEqual(800);
         expect(definition.description.length).toBeLessThanOrEqual(160);
      }
   });

   it('names the gate and, for delete_pack, the irreversibility in the description', () => {
      expect(createPackDefinition.description).toContain('allowCompendiumWrites');
      expect(deletePackDefinition.description).toContain('allowPackDeletion');
      expect(deletePackDefinition.description).toMatch(/irreversible/i);
   });

   it('bounds the untrusted arguments in the schema', () => {
      /** @type {import('$shared/schemaValidate.js').ArgumentValidator} The create_pack validator. */
      const create = validatorOf(createPackDefinition);
      for (const refused of [
         {
            label: 'a'.repeat(129),
            type: 'Item',
         },
         {
            label: '',
            type: 'Item',
         },
         {
            label: 'Wiretap',
            type: 'Item',
            name: '',
         },
         {
            label: 'Wiretap',
            type: 'Item',
            extra: true,
         },
         { label: 'Wiretap' },
      ]) {
         expect(create(refused).ok).toBe(false);
      }
      expect(create({
         label: 'a'.repeat(128),
         type: 'Item',
         name: 'b'.repeat(1000),
         dryRun: true,
      }).ok).toBe(true);

      /** @type {import('$shared/schemaValidate.js').ArgumentValidator} The delete_pack validator. */
      const remove = validatorOf(deletePackDefinition);
      for (const refused of [
         { id: '' },
         {},
         {
            id: 'world.wiretap',
            extra: true,
         },
      ]) {
         expect(remove(refused).ok).toBe(false);
      }
      expect(remove({
         id: `world.${'a'.repeat(300)}`,
         dryRun: false,
      }).ok).toBe(true);
   });
});
