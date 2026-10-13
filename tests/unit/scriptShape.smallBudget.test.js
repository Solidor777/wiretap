import { describe, it, expect, vi } from 'vitest';

// The real budgets with a tiny compact-view budget, so the last steps of the fitting loop run.
vi.mock('$shared/budgets.js', async (importOriginal) => {
   /** @type {typeof import('$shared/budgets.js')} The real module. */
   const real = await importOriginal();
   return {
      ...real,
      getBudget: (name) => {
         return name === 'COMPACT_VIEW_MAX_BYTES' ? { ...real.getBudget(name), value: 60 } : real.getBudget(name);
      },
   };
});

const { shape } = await import('~/bridge/scripts/shape.js');

describe('shape.compact: a budget smaller than the header', () => {
   it('drops entries, then collections, then header fields, until the view fits', () => {
      const view = shape.compact({
         uuid: 'Actor.MOCKACTOR0000001',
         name: 'MOCK_Actor',
         type: 'character',
         system: { value: 1 },
         items: [{ _id: 'MOCKITEM00000001', name: 'MOCK_item', type: 'weapon' }],
      });
      expect(view.cut).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(view)).length).toBeLessThanOrEqual(60);
      expect(view.embedded).toBeUndefined();
      expect(view.fields).toBeUndefined();
   });

   it('returns only the cut marker when even the header cannot fit', () => {
      const view = shape.compact({
         uuid: 'Actor.MOCKACTOR0000001',
         name: 'MOCK_Actor',
         type: 'character',
      });
      expect(new TextEncoder().encode(JSON.stringify(view)).length).toBeLessThanOrEqual(60);
      expect(view.cut).toBe(true);
   });
});
