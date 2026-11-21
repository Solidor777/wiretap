import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { utf8Bytes } from '$shared/utf8.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { drawTableHandler } from '~/bridge/scripts/drawTable.js';

/** @type {string} The uuid of the mocked RollTable. */
const TABLE_UUID = 'RollTable.MOCKTABLE0000001';

/** @type {string} The uuid of the mocked Item. */
const ITEM_UUID = 'Item.MOCKITEM00000001';

/**
 * @typedef {object} MockResult
 * @property {string} name - The result name.
 * @property {string} description - The result description (HTML).
 * @property {string} [documentUuid] - The uuid of the document the result names.
 */

/** @type {MockResult[]} The results the next draw returns. */
let drawn;

/** @type {{ documentName: string, draw: import('vitest').Mock }} The mocked RollTable. */
let table;

/** @type {object} The call context the handler receives; the dice scripts use none of it. */
const ctx = {};

beforeEach(() => {
   drawn = [
      {
         name: 'MOCK_result',
         description: '',
      },
   ];
   table = {
      documentName: 'RollTable',
      draw: vi.fn(async () => ({
         roll: { total: 7 },
         results: drawn,
      })),
   };
   /** @type {Map<string, object>} The documents `fromUuid` resolves. */
   const documents = new Map([
      [
         TABLE_UUID,
         table,
      ],
      [
         ITEM_UUID,
         {
            documentName: 'Item',
            uuid: ITEM_UUID,
         },
      ],
   ]);
   globalThis.fromUuid = vi.fn(async (value) => documents.get(value) ?? null);
});

afterEach(() => {
   delete globalThis.fromUuid;
});

/**
 * Run the handler and return what it threw.
 * @param {Record<string, unknown>} args - The arguments.
 * @returns {Promise<unknown>} The thrown value.
 */
async function refusal(args) {
   return drawTableHandler(args, ctx).then(
      () => {
         throw new Error('the handler did not refuse');
      },
      (error) => error,
   );
}

describe('drawTableHandler', () => {
   it('draws with displayChat false by default and returns the rows', async () => {
      expect(await drawTableHandler({ uuid: TABLE_UUID }, ctx)).toEqual({
         total: 7,
         results: [{ name: 'MOCK_result' }],
         count: 1,
      });
      expect(table.draw).toHaveBeenCalledWith({ displayChat: false });
   });

   it('passes displayChat true when toChat is true', async () => {
      await drawTableHandler(
         {
            uuid: TABLE_UUID,
            toChat: true,
         },
         ctx,
      );
      expect(table.draw).toHaveBeenCalledWith({ displayChat: true });
   });

   it('gives a text result its plain text and a document result its uuid', async () => {
      drawn = [
         {
            name: 'MOCK_text',
            description: '<p>A <b>red</b>\n  door</p>',
         },
         {
            name: 'MOCK_document',
            description: '',
            documentUuid: ITEM_UUID,
         },
      ];
      expect((await drawTableHandler({ uuid: TABLE_UUID }, ctx)).results).toEqual([
         {
            name: 'MOCK_text',
            text: 'A red door',
         },
         {
            name: 'MOCK_document',
            uuid: ITEM_UUID,
         },
      ]);
   });

   it('shows character references in the text as the characters they stand for', async () => {
      drawn = [
         {
            name: 'MOCK_entities',
            description: '<p>Salt&nbsp;&amp; pepper &lt;b&gt; &quot;hot&quot; &#39;mild&#39; &#233;&#x00E9;</p>',
         },
      ];
      expect((await drawTableHandler({ uuid: TABLE_UUID }, ctx)).results[0].text).toBe(
         'Salt & pepper <b> "hot" \'mild\' éé',
      );
   });

   it('reports a null total when the draw has no roll', async () => {
      table.draw = vi.fn(async () => ({
         roll: undefined,
         results: drawn,
      }));
      expect((await drawTableHandler({ uuid: TABLE_UUID }, ctx)).total).toBeNull();
   });

   it('reports TABLE_EMPTY when nothing is drawn', async () => {
      drawn = [];
      /** @type {unknown} The refusal. */
      const error = await refusal({ uuid: TABLE_UUID });
      expect(error).toBeInstanceOf(ScriptError);
      expect(error.code).toBe('TABLE_EMPTY');
      expect(error.message).toBe(
         "Nothing could be drawn: every result is drawn (reset the table) or none is in the formula's range.",
      );
   });

   it('refuses a document that is not a RollTable with ARGS_INVALID', async () => {
      /** @type {unknown} The refusal. */
      const error = await refusal({ uuid: ITEM_UUID });
      expect(error).toBeInstanceOf(ScriptError);
      expect(error.code).toBe('ARGS_INVALID');
      expect(table.draw).not.toHaveBeenCalled();
   });

   it('stays within 1000 bytes for 20 results with 2000-character descriptions and reports cut', async () => {
      drawn = Array.from({ length: 20 }, (_, index) => ({
         name: `MOCK_result_${index}_${'n'.repeat(80)}`,
         description: `<p>${'d'.repeat(2000)}</p>`,
      }));
      const result = await drawTableHandler({ uuid: TABLE_UUID }, ctx);
      expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(1000);
      expect(result.cut).toBe(true);
      expect(result.count).toBe(20);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.length).toBeLessThan(20);
      expect(utf8Bytes(result.results[0].name)).toBeLessThanOrEqual(64);
      expect(utf8Bytes(result.results[0].text)).toBeLessThanOrEqual(200);
   });
});
