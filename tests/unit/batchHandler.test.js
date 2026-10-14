import { describe, it, expect, vi } from 'vitest';
import { batchHandler } from '~/bridge/scripts/batch.js';
import { batchDefinition } from '~/bridge/scripts/definitions.js';
import { compileSchema } from '$shared/schemaValidate.js';
import { getBudget } from '$shared/budgets.js';

/**
 * Build a context whose `batchDocuments` records its call and answers an empty result.
 * @returns {{ ctx: object, core: ReturnType<typeof vi.fn> }} The context and the recording function.
 */
function makeContext() {
   /** @type {ReturnType<typeof vi.fn>} Records the call to the core operation. */
   const core = vi.fn(async () => ({
      created: [],
      updated: [],
      deleted: [],
   }));
   return {
      ctx: { core: { batchDocuments: core } },
      core,
   };
}

/**
 * Run the handler and return what it threw.
 * @param {object} args - The arguments.
 * @returns {Promise<Error>} The error.
 */
async function failure(args) {
   try {
      await batchHandler(args, makeContext().ctx);
   } catch (error) {
      return error;
   }
   throw new Error('batchHandler did not throw');
}

describe('batchHandler', () => {
   it('groups creates by class and parent, keeps parentUuid, and passes the flags on', async () => {
      const { ctx, core } = makeContext();
      await batchHandler(
         {
            creates: [
               {
                  documentName: 'Item',
                  data: '{"name":"MOCK_a"}',
                  parentUuid: 'Actor.MOCKACTOR0000001',
               },
               {
                  documentName: 'Item',
                  data: '{"name":"MOCK_b"}',
                  parentUuid: 'Actor.MOCKACTOR0000001',
               },
               {
                  documentName: 'Actor',
                  data: '{"name":"MOCK_c"}',
               },
            ],
            deletes: ['Actor.MOCKACTOR0000002'],
            dryRun: true,
            actAs: 'MOCKUSER00000001',
         },
         ctx,
      );
      expect(core).toHaveBeenCalledWith({
         creates: [
            {
               documentName: 'Item',
               data: [
                  { name: 'MOCK_a' },
                  { name: 'MOCK_b' },
               ],
               parentUuid: 'Actor.MOCKACTOR0000001',
            },
            {
               documentName: 'Actor',
               data: [{ name: 'MOCK_c' }],
            },
         ],
         updates: [],
         deletes: ['Actor.MOCKACTOR0000002'],
         dryRun: true,
         actAs: 'MOCKUSER00000001',
      });
   });

   it('groups update entries by uuid and parses each value', async () => {
      const { ctx, core } = makeContext();
      await batchHandler(
         {
            updates: [
               {
                  uuid: 'Actor.MOCKACTOR0000001',
                  path: 'name',
                  value: '"MOCK_x"',
               },
               {
                  uuid: 'Actor.MOCKACTOR0000001',
                  path: 'flags.other',
                  op: 'delete',
               },
            ],
         },
         ctx,
      );
      expect(core.mock.calls[0][0].updates).toEqual([
         {
            uuid: 'Actor.MOCKACTOR0000001',
            patches: [
               {
                  path: 'name',
                  value: 'MOCK_x',
               },
               {
                  path: 'flags.other',
                  op: 'delete',
               },
            ],
         },
      ]);
      expect(core.mock.calls[0][0].dryRun).toBe(false);
   });

   it('refuses entries without documentName or data, non-object data and a value with op delete', async () => {
      for (const args of [
         { creates: [{ data: '{}' }] },
         { creates: [{ documentName: 'Actor' }] },
         { creates: [{ documentName: 'Actor', data: '[1]' }] },
         { creates: [{ documentName: 'Actor', data: 'nope' }] },
         {
            updates: [{
               uuid: 'Actor.MOCKACTOR0000001',
               path: 'name',
               op: 'delete',
               value: '1',
            }],
         },
      ]) {
         const error = await failure(args);
         expect(error.code, JSON.stringify(args)).toBe('ARGS_INVALID');
      }
   });

   it('bounds the creates and the update values as one total', async () => {
      /** @type {number} Half of the data bound plus a margin. */
      const half = Math.floor(getBudget('WRITE_DATA_MAX_BYTES').value / 2) + 100;
      const error = await failure({
         creates: [{
            documentName: 'Actor',
            data: JSON.stringify({ name: 'x'.repeat(half) }),
         }],
         updates: [{
            uuid: 'Actor.MOCKACTOR0000001',
            path: 'name',
            value: JSON.stringify('y'.repeat(half)),
         }],
      });
      expect(error.code).toBe('ARGS_INVALID');
   });
});

describe('the batch definition', () => {
   /** @type {ReturnType<typeof compileSchema>} The compiled schema, nested objects strict. */
   const compiled = compileSchema(batchDefinition.inputSchema, { strictNested: batchDefinition.strictNested === true });

   it('asks for strict entries, which is not listed', () => {
      expect(batchDefinition.strictNested).toBe(true);
      expect(JSON.stringify(compiled.listed).match(/additionalProperties/g)).toHaveLength(1);
   });

   it('refuses an undeclared key in every kind of entry and at the root', () => {
      for (const args of [
         { creates: [{ documentName: 'Item', data: '{}', parent: 'Actor.X' }] },
         { creates: [{ documentName: 'Item', data: '{}', pack: 'a.b' }] },
         { creates: [{ documentName: 'Item', data: '{}', keepId: true }] },
         { updates: [{ uuid: 'Actor.X', path: 'name', vlaue: '1' }] },
         { dryrun: true },
      ]) {
         expect(compiled.validate(args).ok, JSON.stringify(args)).toBe(false);
      }
   });

   it('accepts the declared keys', () => {
      expect(
         compiled.validate({
            creates: [{ documentName: 'Item', data: '{}', parentUuid: 'Actor.X' }],
            updates: [{ uuid: 'Actor.X', path: 'name', value: '1', op: 'set' }],
            deletes: ['Actor.Y'],
            dryRun: true,
            actAs: 'U',
         }).ok,
      ).toBe(true);
   });
});
