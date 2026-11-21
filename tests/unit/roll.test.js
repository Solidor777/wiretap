import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { utf8Bytes } from '$shared/utf8.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { rollHandler } from '~/bridge/scripts/roll.js';

/**
 * @typedef {object} MockOutcome
 * @property {number} [total] - The total the evaluated roll reports.
 * @property {Array<{ faces: number, results: Array<{ result: number, active: boolean }> }>} [dice] - The die terms.
 * @property {Error} [error] - The error `evaluate` throws instead.
 */

/** @type {Map<string, MockOutcome>} The outcome of each formula the mocked `Roll` knows. */
let outcomes;

/** @type {import('vitest').Mock} The mocked `Roll#evaluate`, shared by every instance. */
let evaluate;

/** @type {import('vitest').Mock} The mocked `Roll#toMessage`, shared by every instance. */
let toMessage;

/** @type {object} The call context the handler receives; the dice scripts use none of it. */
const ctx = {};

/**
 * Build the results of one die term, every one active.
 * @param {number[]} values - The face values rolled.
 * @returns {Array<{ result: number, active: boolean }>} The term results.
 */
function active(values) {
   return values.map((value) => ({
      result: value,
      active: true,
   }));
}

/**
 * A stand-in for `foundry.dice.Roll`: the formula's outcome is looked up in `outcomes` when it is evaluated.
 */
class MockRoll {
   /**
    * Whether a formula parses; every formula but `bad` does.
    * @param {string} formula - The dice expression to check.
    * @returns {boolean} Whether it is valid.
    */
   static validate(formula) {
      return formula !== 'bad';
   }

   /**
    * Build an unevaluated roll.
    * @param {string} formula - The dice expression to roll.
    */
   constructor(formula) {
      /** @type {string} The formula as Foundry normalizes it. */
      this.formula = formula;
      /** @type {number} The total, set by evaluation. */
      this.total = 0;
      /** @type {object[]} The die terms, set by evaluation. */
      this.dice = [];
   }

   /**
    * Evaluate the roll from its outcome.
    * @param {object} options - The evaluation options.
    * @returns {Promise<MockRoll>} This roll.
    */
   async evaluate(options) {
      evaluate(options);
      /** @type {MockOutcome} The outcome of this formula. */
      const outcome = outcomes.get(this.formula);
      if (outcome.error !== undefined) {
         throw outcome.error;
      }
      this.total = outcome.total;
      this.dice = outcome.dice;
      return this;
   }

   /**
    * Post the roll to chat.
    * @returns {Promise<object>} The created message.
    */
   async toMessage() {
      return toMessage();
   }
}

beforeEach(() => {
   outcomes = new Map([
      [
         '2d6',
         {
            total: 9,
            dice: [
               {
                  faces: 6,
                  results: active([
                     4,
                     5,
                  ]),
               },
            ],
         },
      ],
      [
         '4d6kh3',
         {
            total: 15,
            dice: [
               {
                  faces: 6,
                  results: [
                     {
                        result: 6,
                        active: true,
                     },
                     {
                        result: 1,
                        active: false,
                     },
                     {
                        result: 5,
                        active: true,
                     },
                     {
                        result: 4,
                        active: true,
                     },
                  ],
               },
            ],
         },
      ],
      [
         '1000d6',
         { error: new Error('You may not evaluate a DiceTerm with more than 999 requested results') },
      ],
      [
         '999d1000',
         {
            total: 999000,
            dice: [
               {
                  faces: 1000,
                  results: active(Array.from({ length: 999 }, () => 1000)),
               },
            ],
         },
      ],
   ]);
   evaluate = vi.fn();
   toMessage = vi.fn(async () => ({}));
   globalThis.foundry = { dice: { Roll: MockRoll } };
   globalThis.Roll = MockRoll;
});

afterEach(() => {
   delete globalThis.foundry;
   delete globalThis.Roll;
});

/**
 * Run the handler and return what it threw.
 * @param {Record<string, unknown>} args - The arguments.
 * @returns {Promise<unknown>} The thrown value.
 */
async function refusal(args) {
   return rollHandler(args, ctx).then(
      () => {
         throw new Error('the handler did not refuse');
      },
      (error) => error,
   );
}

describe('rollHandler', () => {
   it('returns the total, the formula and each die term as [faces, results]', async () => {
      expect(await rollHandler({ formula: '2d6' }, ctx)).toEqual({
         total: 9,
         formula: '2d6',
         dice: [
            [
               6,
               [
                  4,
                  5,
               ],
            ],
         ],
      });
   });

   it('lists inactive results as a third entry', async () => {
      expect((await rollHandler({ formula: '4d6kh3' }, ctx)).dice).toEqual([
         [
            6,
            [
               6,
               5,
               4,
            ],
            [1],
         ],
      ]);
   });

   it('evaluates without interactive prompts', async () => {
      await rollHandler({ formula: '2d6' }, ctx);
      expect(evaluate).toHaveBeenCalledWith({ allowInteractive: false });
   });

   it('posts to chat only when toChat is true', async () => {
      await rollHandler({ formula: '2d6' }, ctx);
      await rollHandler(
         {
            formula: '2d6',
            toChat: false,
         },
         ctx,
      );
      expect(toMessage).toHaveBeenCalledTimes(0);
      await rollHandler(
         {
            formula: '2d6',
            toChat: true,
         },
         ctx,
      );
      expect(toMessage).toHaveBeenCalledTimes(1);
   });

   it('refuses a formula with @ references with ARGS_INVALID', async () => {
      /** @type {unknown} The refusal. */
      const error = await refusal({ formula: '1d20+@abilities.str.mod' });
      expect(error).toBeInstanceOf(ScriptError);
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toBe('roll has no data source: write numbers instead of @references.');
      expect(evaluate).not.toHaveBeenCalled();
   });

   it('refuses an invalid formula with ARGS_INVALID', async () => {
      /** @type {unknown} The refusal. */
      const error = await refusal({ formula: 'bad' });
      expect(error).toBeInstanceOf(ScriptError);
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain("'bad'");
      expect(evaluate).not.toHaveBeenCalled();
   });

   it("turns Foundry's 999-results refusal into ARGS_INVALID", async () => {
      /** @type {unknown} The refusal. */
      const error = await refusal({ formula: '1000d6' });
      expect(error).toBeInstanceOf(ScriptError);
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('You may not evaluate a DiceTerm with more than 999 requested results');
      expect(utf8Bytes(error.message)).toBeLessThanOrEqual(256);
   });

   it('stays within 512 bytes for 999 results of a d1000 and reports cut', async () => {
      const result = await rollHandler({ formula: '999d1000' }, ctx);
      expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(512);
      expect(result.cut).toBe(true);
      expect(result.total).toBe(999000);
      expect(result.dice[0][0]).toBe(1000);
      // Listing stops only when one more result would not fit.
      /** @type {object} The result with one more die result listed. */
      const longer = structuredClone(result);
      longer.dice[0][1].push(1000);
      expect(utf8Bytes(JSON.stringify(longer))).toBeGreaterThan(512);
   });

   it('stays within 512 bytes when the last terms roll no dice', async () => {
      // Fifty-five 1d6 terms fit the cut result; a 0d6 term evaluates to a term with no results.
      /** @type {object[]} Fifty-five 1d6 terms, then ten 0d6 terms. */
      const dice = [
         ...Array.from({ length: 55 }, () => ({
            faces: 6,
            results: active([3]),
         })),
         ...Array.from({ length: 10 }, () => ({
            faces: 6,
            results: [],
         })),
      ];
      outcomes.set('many', {
         total: 165,
         dice,
      });
      const result = await rollHandler({ formula: 'many' }, ctx);
      expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(512);
      expect(result.cut).toBe(true);
      // Listing stops only when one more term would not fit.
      /** @type {object} The result with one more empty term listed. */
      const longer = structuredClone(result);
      longer.dice.push([
         6,
         [],
      ]);
      expect(utf8Bytes(JSON.stringify(longer))).toBeGreaterThan(512);
   });

   it('bounds the formula to 128 bytes', async () => {
      /** @type {string} A long formula of constant terms. */
      const formula = Array.from({ length: 80 }, () => '1').join('+');
      outcomes.set(formula, {
         total: 80,
         dice: [],
      });
      const result = await rollHandler({ formula }, ctx);
      expect(utf8Bytes(result.formula)).toBeLessThanOrEqual(128);
      expect(result.cut).toBeUndefined();
   });
});
