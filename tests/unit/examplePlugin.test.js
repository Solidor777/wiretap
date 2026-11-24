// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { compileSchema } from '../../shared/schemaValidate.js';
import { definitionBytes, validateScriptDefinition } from '../../shared/scripts.js';
import { createSpellHandler, createSpellTool, mapSpell } from '../../examples/spell-text-plugin/spellTool.js';

/** @type {Record<string, unknown>} The example tool as Wiretap registers it: full name, module id and default result. */
const full = {
   ...createSpellTool,
   name: 'wiretap-example-spells__create_spell',
   moduleId: 'wiretap-example-spells',
   result: { budgetBytes: 2000 },
};

describe('the example spell-text plugin', () => {
   afterEach(() => {
      delete globalThis.Hooks;
      vi.resetModules();
      vi.restoreAllMocks();
   });

   it('follows every guideline: no warning on the plugin route', () => {
      /** @type {ReturnType<typeof validateScriptDefinition>} The validator outcome. */
      const validated = validateScriptDefinition(full, 'plugin');
      expect(validated.ok).toBe(true);
      expect(validated.warnings).toEqual([]);
      /** @type {ReturnType<typeof compileSchema>} The compile outcome. */
      const compiled = compileSchema(full.inputSchema, { source: 'plugin' });
      expect(compiled.warnings).toEqual([]);
      expect(definitionBytes(full.name, full.description, compiled.listed)).toBeLessThanOrEqual(800);
      expect(full.description.length).toBeLessThanOrEqual(160);
   });

   it('maps the parsed fields deterministically', () => {
      expect(
         mapSpell({
            name: 'MOCK Spark',
            itemType: 'spell',
            level: 1,
            school: 'MOCK school',
            components: [
               'V',
               'S',
            ],
            text: 'MOCK text.',
         }),
      ).toEqual({
         name: 'MOCK Spark',
         type: 'spell',
         system: {
            level: 1,
            school: 'MOCK school',
            components: [
               'V',
               'S',
            ],
            description: 'MOCK text.',
         },
      });
   });

   it('previews with dryRun first and creates only after the preview succeeds', async () => {
      /** @type {import('vitest').Mock} The core create, answering a preview row or a created row. */
      const createDocuments = vi.fn(async (params) => [
         {
            uuid: params.dryRun ? null : 'Item.MOCKITEM00000001',
            name: 'MOCK Spark',
            type: 'spell',
         },
      ]);
      /** @type {Record<string, unknown>} The parsed arguments. */
      const args = {
         name: 'MOCK Spark',
         itemType: 'spell',
         text: 'MOCK text.',
      };
      /** @type {unknown} The handler's answer. */
      const rows = await createSpellHandler(args, { core: { createDocuments } });
      expect(createDocuments.mock.calls).toEqual([
         [
            {
               documentName: 'Item',
               data: [mapSpell(args)],
               dryRun: true,
            },
         ],
         [
            {
               documentName: 'Item',
               data: [mapSpell(args)],
            },
         ],
      ]);
      expect(rows[0].uuid).toBe('Item.MOCKITEM00000001');
   });

   it('creates nothing when the preview fails', async () => {
      /** @type {import('vitest').Mock} The core create, refusing every call. */
      const createDocuments = vi.fn(async () => {
         throw new Error('MOCK refusal');
      });
      await expect(
         createSpellHandler(
            {
               name: 'x',
               itemType: 'spell',
               text: 'y',
            },
            { core: { createDocuments } },
         ),
      ).rejects.toThrow('MOCK refusal');
      expect(createDocuments).toHaveBeenCalledTimes(1);
   });

   it('registers create_spell through the hook when the API version is 1, and not otherwise', async () => {
      globalThis.Hooks = { once: vi.fn() };
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await import('../../examples/spell-text-plugin/index.js');
      // `vi.resetModules` gives each test a fresh module graph, so the handler is compared with the one `index.js` saw.
      /** @type {typeof import('../../examples/spell-text-plugin/spellTool.js')} The tool module `index.js` imported. */
      const loaded = await import('../../examples/spell-text-plugin/spellTool.js');
      expect(globalThis.Hooks.once).toHaveBeenCalledTimes(1);
      expect(globalThis.Hooks.once.mock.calls[0][0]).toBe('wiretap.registerTools');
      /** @type {Function} The registered hook callback. */
      const callback = globalThis.Hooks.once.mock.calls[0][1];
      /** @type {import('vitest').Mock} The registration call of a version 1 API. */
      const registerTool = vi.fn(() => ({
         ok: true,
         name: 'wiretap-example-spells__create_spell',
      }));
      callback({
         apiVersion: 1,
         registerTool,
      });
      expect(registerTool).toHaveBeenCalledTimes(1);
      expect(registerTool.mock.calls[0][0]).toMatchObject({
         moduleId: 'wiretap-example-spells',
         name: 'create_spell',
         handler: loaded.createSpellHandler,
      });
      /** @type {import('vitest').Mock} The registration call of an unknown API version. */
      const laterRegisterTool = vi.fn(() => ({ ok: true }));
      callback({
         apiVersion: 2,
         registerTool: laterRegisterTool,
      });
      expect(laterRegisterTool).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledTimes(1);
   });

   it('reports a refused registration with its reason', async () => {
      globalThis.Hooks = { once: vi.fn() };
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await import('../../examples/spell-text-plugin/index.js');
      /** @type {Function} The registered hook callback. */
      const callback = globalThis.Hooks.once.mock.calls[0][1];
      callback({
         apiVersion: 1,
         registerTool: () => ({
            ok: false,
            reason: 'MOCK reason',
         }),
      });
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.warn.mock.calls[0][0]).toContain('MOCK reason');
   });

   it('the guide skill names its tool', () => {
      /** @type {string} The guide skill text. */
      const text = readFileSync(
         new URL('../../examples/spell-text-plugin/skills/wiretap-example-spells/SKILL.md', import.meta.url),
         'utf8',
      );
      expect(text).toMatch(/^---\r?\nname: wiretap-example-spells\r?\ndescription: .+\r?\n---\r?\n/);
      expect(text).toContain('mcp__wiretap__wiretap-example-spells__create_spell');
      expect(text.split('\n').length).toBeLessThan(40);
   });
});
