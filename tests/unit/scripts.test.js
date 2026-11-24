// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { getBudget } from '../../shared/budgets.js';
import {
   RESERVED_SCRIPT_NAMES,
   SCRIPT_API_VERSION,
   SCRIPT_REQUIRES,
   SCRIPT_SOURCES,
   USER_INTERACTION_META_KEY,
   USER_INTERACTION_TOOLS,
   definitionBytes,
   parseRegistryPayload,
   validateScriptDefinition,
} from '../../shared/scripts.js';
import { script } from './scriptFixtures.js';

/**
 * Validate a definition as a shipped script and return the outcome.
 * @param {unknown} input - The candidate definition.
 * @returns {ReturnType<typeof validateScriptDefinition>} The outcome.
 */
function shipped(input) {
   return validateScriptDefinition(input, 'shipped');
}

/**
 * Build an object schema whose one property description is `extra` characters long, to size a definition exactly.
 * @param {number} extra - The description length.
 * @returns {object} The schema.
 */
function padded(extra) {
   return {
      type: 'object',
      properties: {
         a: {
            type: 'string',
            description: 'p'.repeat(extra),
         },
      },
   };
}

describe('script constants', () => {
   it('names the three sources, the three requirements and the api version', () => {
      expect(SCRIPT_SOURCES).toEqual([
         'shipped',
         'plugin',
         'agent',
      ]);
      expect(SCRIPT_REQUIRES).toEqual([
         'none',
         'api',
         'dom',
      ]);
      expect(SCRIPT_API_VERSION).toBe(1);
      expect(RESERVED_SCRIPT_NAMES).toEqual([
         'read_handle',
         'backup_documents',
         'list_backups',
         'restore_backup',
         'delete_backup',
      ]);
   });
});

describe('validateScriptDefinition: accepted shipped scripts', () => {
   it('accepts a complete definition and returns a fresh copy of the known fields only', () => {
      const input = script('get_thing', {
         extra: 'ignored',
         gate: 'allowUserWrites',
         mutates: true,
      });
      const outcome = shipped(input);
      expect(outcome).toEqual({
         ok: true,
         warnings: [],
         definition: {
            name: 'get_thing',
            version: '1.0.0',
            description: input.description,
            inputSchema: input.inputSchema,
            result: { budgetBytes: 2000 },
            requires: 'api',
            mutates: true,
            gate: 'allowUserWrites',
         },
      });
      expect(outcome.definition).not.toBe(input);
      expect(outcome.definition.result).not.toBe(input.result);
      expect(outcome.definition).not.toHaveProperty('extra');
   });

   it('omits gate and moduleId when the definition declares none', () => {
      const { definition } = shipped(script('plain'));
      expect(definition).not.toHaveProperty('gate');
      expect(definition).not.toHaveProperty('moduleId');
   });

   it('accepts each requires value', () => {
      for (const requires of SCRIPT_REQUIRES) {
         expect(shipped(script('any_tool', { requires })).ok).toBe(true);
      }
   });

   it('accepts both values of mutates', () => {
      expect(shipped(script('reader', { mutates: false })).definition.mutates).toBe(false);
      expect(shipped(script('writer', { mutates: true })).definition.mutates).toBe(true);
   });

   it('accepts a name of exactly the core budget and refuses one character more', () => {
      const limit = getBudget('CORE_TOOL_NAME_MAX_CHARS').value;
      expect(shipped(script('a'.repeat(limit))).ok).toBe(true);
      const refused = shipped(script('a'.repeat(limit + 1)));
      expect(refused.ok).toBe(false);
      expect(refused.reason).toContain('name');
   });

   it('accepts a description of exactly the hard maximum and refuses one character more', () => {
      const limit = getBudget('DESCRIPTION_MAX_CHARS').value;
      const small = { inputSchema: { type: 'object' } };
      expect(shipped(script('d_tool', {
         ...small,
         description: 'd'.repeat(limit),
      })).ok).toBe(true);
      const refused = shipped(script('d_tool', {
         ...small,
         description: 'd'.repeat(limit + 1),
      }));
      expect(refused.ok).toBe(false);
      expect(refused.reason).toContain('description');
   });

   it('warns, without refusing, when a description is over the target', () => {
      const target = getBudget('DESCRIPTION_TARGET_CHARS').value;
      const small = { inputSchema: { type: 'object' } };
      expect(shipped(script('d_tool', {
         ...small,
         description: 'd'.repeat(target),
      })).warnings).toEqual([]);
      const outcome = shipped(script('d_tool', {
         ...small,
         description: 'd'.repeat(target + 1),
      }));
      expect(outcome.ok).toBe(true);
      expect(outcome.warnings).toHaveLength(1);
      expect(outcome.warnings[0]).toContain(String(target));
   });

   it('accepts a definition of exactly the definition budget and refuses one byte more', () => {
      const limit = getBudget('DEFINITION_MAX_BYTES').value;
      const fixed = Buffer.byteLength(JSON.stringify({
         name: 'fat_tool',
         description: 'Synthetic.',
         inputSchema: padded(0),
      }));
      expect(shipped(script('fat_tool', {
         description: 'Synthetic.',
         inputSchema: padded(limit - fixed),
      })).ok).toBe(true);
      const refused = shipped(script('fat_tool', {
         description: 'Synthetic.',
         inputSchema: padded(limit - fixed + 1),
      }));
      expect(refused.ok).toBe(false);
      expect(refused.reason).toContain('definition');
   });

   it('counts the definition in UTF-8 bytes, not characters', () => {
      const limit = getBudget('DEFINITION_MAX_BYTES').value;
      const wide = {
         type: 'object',
         properties: {
            a: {
               type: 'string',
               description: '€'.repeat(Math.ceil(limit / 3)),
            },
         },
      };
      // 3 bytes per character: under the limit in characters, over it in bytes.
      const outcome = shipped(script('wide_tool', { inputSchema: wide }));
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('definition');
   });
});

describe('validateScriptDefinition: version', () => {
   it.each([
      '0.0.1',
      '1.2.3',
      '10.20.30',
      '1.0.0-rc.1',
      '1.0.0+build.5',
      '1.0.0-beta.2+exp.sha.5114f85',
   ])('accepts %s', (version) => {
      expect(shipped(script('versioned', { version })).ok).toBe(true);
   });

   it.each([
      [
         'a missing version',
         undefined,
      ],
      [
         'a number',
         1,
      ],
      [
         'an empty string',
         '',
      ],
      [
         'two parts',
         '1.0',
      ],
      [
         'four parts',
         '1.0.0.0',
      ],
      [
         'a leading v',
         'v1.0.0',
      ],
      [
         'a space',
         '1.0.0 beta',
      ],
      [
         'a trailing newline',
         '1.0.0\n',
      ],
   ])('refuses %s', (_label, version) => {
      const input = script('versioned');
      if (version === undefined) {
         delete input.version;
      } else {
         input.version = version;
      }
      const outcome = shipped(input);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('version');
   });

   it('accepts a version of exactly the budget and refuses one character more', () => {
      const limit = getBudget('SCRIPT_VERSION_MAX_CHARS').value;
      const prefix = '1.0.0-';
      expect(shipped(script('versioned', { version: prefix + 'a'.repeat(limit - prefix.length) })).ok).toBe(true);
      const refused = shipped(script('versioned', { version: prefix + 'a'.repeat(limit - prefix.length + 1) }));
      expect(refused.ok).toBe(false);
      expect(refused.reason).toContain('version');
   });
});

describe('validateScriptDefinition: mutates and requires are never defaulted', () => {
   it('refuses a definition with no mutates', () => {
      const input = script('no_mutates');
      delete input.mutates;
      const outcome = shipped(input);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('mutates');
   });

   it.each([
      'false',
      'true',
      0,
      1,
      null,
      [],
      {},
   ])('refuses mutates %j', (mutates) => {
      const outcome = shipped(script('bad_mutates', { mutates }));
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('mutates');
   });

   it('refuses a definition with no requires', () => {
      const input = script('no_requires');
      delete input.requires;
      const outcome = shipped(input);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('requires');
   });

   it.each([
      'browser',
      'API',
      '',
      7,
      null,
   ])('refuses requires %j', (requires) => {
      const outcome = shipped(script('bad_requires', { requires }));
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('requires');
   });
});

describe('validateScriptDefinition: name', () => {
   it.each([
      [
         'an empty name',
         '',
      ],
      [
         'an uppercase name',
         'Mock',
      ],
      [
         'a name starting with a digit',
         '1mock',
      ],
      [
         'a name with a space',
         'mock tool',
      ],
      [
         'a name with a path separator',
         'mock/tool',
      ],
      [
         'a non-string name',
         5,
      ],
   ])('refuses %s', (_label, name) => {
      const outcome = shipped(script('placeholder', { name }));
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('name');
   });

   it.each([
      'read_handle',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
   ])('refuses the reserved or inherited name %s', (name) => {
      const outcome = shipped(script('placeholder', { name }));
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('name');
   });

   it('does not reserve the names of the shipped write scripts', () => {
      expect(shipped(script('create_documents')).ok).toBe(true);
   });

   it.each([
      'my-mod__echo',
      'agent__saved',
      'a__',
   ])('refuses the shipped name %s, which holds the plugin and agent separator', (name) => {
      expect(shipped(script('placeholder', { name }))).toEqual({
         ok: false,
         reason: 'a shipped tool name may not contain "__"; that form is <moduleId>__<tool> for plugin tools',
      });
   });

   it('leaves "__" names to the plugin and agent rules on their routes', () => {
      expect(validateScriptDefinition(script('my-mod__echo', { moduleId: 'my-mod' }), 'plugin').ok).toBe(true);
      expect(validateScriptDefinition(script('agent__saved'), 'agent').reason).toContain(
         'agent scripts are not supported',
      );
   });
});

describe('validateScriptDefinition: result budget', () => {
   it('accepts 1 and the per-call maximum and refuses everything else', () => {
      const max = getBudget('RESULT_HARD_CAP_MAX_BYTES').value;
      expect(shipped(script('budgeted', { result: { budgetBytes: 1 } })).ok).toBe(true);
      expect(shipped(script('budgeted', { result: { budgetBytes: max } })).ok).toBe(true);
      for (const budgetBytes of [
         0,
         max + 1,
         1.5,
         '256',
         null,
         undefined,
      ]) {
         const outcome = shipped(script('budgeted', { result: { budgetBytes } }));
         expect(outcome.ok).toBe(false);
         expect(outcome.reason).toContain('budgetBytes');
      }
   });

   it.each([
      undefined,
      null,
      'x',
      [],
   ])('refuses a result of %j', (result) => {
      const input = script('budgeted');
      if (result === undefined) {
         delete input.result;
      } else {
         input.result = result;
      }
      const outcome = shipped(input);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('result');
   });
});

describe('validateScriptDefinition: gate and module id', () => {
   it('accepts a registered gate on a shipped script', () => {
      expect(shipped(script('gated', { gate: 'allowMacroExecution' })).definition.gate).toBe('allowMacroExecution');
   });

   it.each([
      'notAGate',
      'toString',
      5,
      null,
      'allowedPluginModules',
   ])('refuses the gate %j', (gate) => {
      const outcome = shipped(script('gated', { gate }));
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('gate');
   });

   it('refuses a moduleId on a shipped script', () => {
      const outcome = shipped(script('gated', { moduleId: 'some-module' }));
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('moduleId');
   });
});

describe('validateScriptDefinition: untrusted input', () => {
   it.each([
      undefined,
      null,
      'x',
      7,
      [],
   ])('refuses %j as a definition', (input) => {
      expect(shipped(input)).toEqual({
         ok: false,
         reason: 'the definition is not an object',
      });
   });

   it('refuses a schema that is not an object', () => {
      for (const inputSchema of [
         null,
         'x',
         [],
         undefined,
      ]) {
         const outcome = shipped(script('schema_tool', { inputSchema }));
         expect(outcome.ok).toBe(false);
         expect(outcome.reason).toContain('inputSchema');
      }
   });

   it('reads own properties only', () => {
      const inherited = Object.create(script('inherited'));
      const outcome = shipped(inherited);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('name');
   });

   it('refuses control characters in the description', () => {
      for (const description of [
         'a\nb',
         'a\u0000b',
         'a b',
         'a\u007fb',
      ]) {
         const outcome = shipped(script('ctl_tool', { description }));
         expect(outcome.ok).toBe(false);
         expect(outcome.reason).toContain('description');
      }
   });

   it('refuses an empty description', () => {
      expect(shipped(script('empty_desc', { description: '' })).ok).toBe(false);
   });

   it('refuses a schema that cannot be serialized instead of throwing', () => {
      const cyclic = { type: 'object' };
      cyclic.self = cyclic;
      const outcome = shipped(script('cyclic', { inputSchema: cyclic }));
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('inputSchema');
   });

   it('refuses a throwing property getter instead of throwing', () => {
      const hostile = script('hostile');
      Object.defineProperty(hostile, 'description', {
         enumerable: true,
         get() {
            throw new Error('boom');
         },
      });
      expect(shipped(hostile).ok).toBe(false);
   });
});

describe('validateScriptDefinition: source', () => {
   it('refuses an unknown source', () => {
      for (const source of [
         'other',
         undefined,
         'constructor',
         7,
      ]) {
         const outcome = validateScriptDefinition(script('any_tool'), source);
         expect(outcome.ok).toBe(false);
         expect(outcome.reason).toContain('source');
      }
   });

   it('validates an agent script by the agent rules and then refuses it as not supported', () => {
      const outcome = validateScriptDefinition(script('agent__saved'), 'agent');
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('agent scripts are not supported');
      const unprefixed = validateScriptDefinition(script('saved'), 'agent');
      expect(unprefixed.reason).toContain('name');
      expect(unprefixed.reason).not.toContain('not supported');
      const withModule = validateScriptDefinition(script('agent__saved', { moduleId: 'my-module' }), 'agent');
      expect(withModule.reason).toContain('moduleId');
   });
});

describe('validateScriptDefinition: plugin route', () => {
   /**
    * Validate a definition owned by `my-module` as a plugin script.
    * @param {string} name - The tool name the script registers as.
    * @param {object} [overrides] - Fields replacing the defaults.
    * @returns {ReturnType<typeof validateScriptDefinition>} The outcome.
    */
   const plugin = (name, overrides = {}) => validateScriptDefinition(
      script(name, {
         moduleId: 'my-module',
         ...overrides,
      }),
      'plugin',
   );

   it('accepts a valid plugin script and keeps its moduleId', () => {
      const outcome = plugin('my-module__tool');
      expect(outcome.ok).toBe(true);
      expect(outcome.definition.moduleId).toBe('my-module');
      expect(outcome.definition.name).toBe('my-module__tool');
      expect(outcome.warnings).toEqual([]);
   });

   it('accepts a plugin name of 50 characters and refuses 51 with the prefix explained', () => {
      expect(plugin(`my-module__${'a'.repeat(39)}`).ok).toBe(true); // 50 characters
      expect(plugin(`my-module__${'a'.repeat(40)}`).reason).toBe( // 51 characters
         'name is 51 characters; Claude Code lists it as mcp__wiretap__<name> and the API accepts at most 64, so ' +
            '<moduleId>__<tool> may be at most 50 characters',
      );
   });

   it('warns for a plugin description over 240 characters with the 240 line only; refuses it when shipped', () => {
      expect(plugin('my-module__tool', { description: 'd'.repeat(300) }).warnings).toEqual([
         'description is 300 characters, over the 240-character guideline',
      ]);
      expect(validateScriptDefinition(script('tool', { description: 'd'.repeat(300) }), 'shipped').ok).toBe(false);
   });

   it('keeps the 160-character target warning for both sources', () => {
      expect(plugin('my-module__tool', { description: 'd'.repeat(200) }).warnings).toEqual([
         'description is 200 characters, over the 160-character target',
      ]);
   });

   it('clamps a plugin result budget over the hard cap to the cap with a warning; refuses it when shipped', () => {
      const outcome = plugin('my-module__tool', { result: { budgetBytes: 50000 } });
      expect(outcome.definition.result).toEqual({ budgetBytes: 16000 });
      expect(outcome.warnings).toEqual([
         'result.budgetBytes is 50000, over the 16000-byte result cap; the cap applies',
      ]);
      expect(validateScriptDefinition(script('tool', { result: { budgetBytes: 50000 } }), 'shipped').ok).toBe(false);
   });

   it('warns once for a plugin version over 32 characters and not at 32; refuses it when shipped', () => {
      /** @type {string} A valid version of exactly 32 characters. */
      const atLimit = `1.0.0-${'a'.repeat(26)}`;
      /** @type {string} A valid version of 33 characters. */
      const overLimit = `${atLimit}b`;
      expect(plugin('my-module__tool', { version: atLimit }).warnings).toEqual([]);
      /** @type {ReturnType<typeof validateScriptDefinition>} The outcome past the best practice. */
      const outcome = plugin('my-module__tool', { version: overLimit });
      expect(outcome.ok).toBe(true);
      expect(outcome.definition.version).toBe(overLimit);
      expect(outcome.warnings).toEqual([
         'version is 33 characters, over the 32-character best practice',
      ]);
      expect(validateScriptDefinition(script('tool', { version: overLimit }), 'shipped').reason).toContain('version');
   });

   it('refuses a plugin version that is not semver-like at any length', () => {
      expect(plugin('my-module__tool', { version: `v${'1'.repeat(40)}` }).ok).toBe(false);
   });

   /** @type {string[]} Five text argument names, one past the four-name best practice. */
   const FIVE_NAMES = [
      'a',
      'b',
      'c',
      'd',
      'e',
   ];

   /** @type {object} An argument schema declaring each of `FIVE_NAMES` as a text property. */
   const fiveTexts = {
      type: 'object',
      properties: Object.fromEntries(FIVE_NAMES.map((key) => [
         key,
         { type: 'string' },
      ])),
   };

   it('warns once for more than four plugin handleArgs names and not at four; refuses them when shipped', () => {
      expect(plugin('my-module__tool', {
         inputSchema: fiveTexts,
         handleArgs: FIVE_NAMES.slice(0, 4),
      }).warnings).toEqual([]);
      /** @type {ReturnType<typeof validateScriptDefinition>} The outcome past the best practice. */
      const outcome = plugin('my-module__tool', {
         inputSchema: fiveTexts,
         handleArgs: FIVE_NAMES,
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.definition.handleArgs).toEqual(FIVE_NAMES);
      expect(outcome.warnings).toEqual([
         'handleArgs lists 5 names, over the 4-name best practice',
      ]);
      expect(validateScriptDefinition(script('tool', {
         inputSchema: fiveTexts,
         handleArgs: FIVE_NAMES,
      }), 'shipped').reason).toBe('handleArgs must list 1 to 4 argument names');
   });

   it('refuses an empty, repeated or undeclared plugin handleArgs list whatever its length', () => {
      for (const handleArgs of [
         [],
         [
            ...FIVE_NAMES.slice(0, 4),
            'a',
         ],
         [
            ...FIVE_NAMES.slice(0, 4),
            'nope',
         ],
      ]) {
         expect(plugin('my-module__tool', {
            inputSchema: fiveTexts,
            handleArgs,
         }).ok, JSON.stringify(handleArgs)).toBe(false);
      }
   });

   it('does not refuse or warn for a plugin definition over 800 raw bytes; refuses it for a shipped script', () => {
      const inputSchema = {
         type: 'object',
         properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
            `p${index}`,
            {
               type: 'string',
               description: 'd'.repeat(60),
            },
         ])),
      };
      expect(plugin('my-module__tool', { inputSchema }).warnings).toEqual([]);
      expect(validateScriptDefinition(script('tool', { inputSchema }), 'shipped').reason).toContain('definition is');
   });

   it('names what to change when a plugin moduleId is not a module id', () => {
      /** @type {string} The refusal every invalid module id gets. */
      const reason = 'moduleId must be your module\'s id from module.json: one or more of A-Z, a-z, 0-9, _ and - '
         + '(no dots or spaces)';
      expect(plugin('my.module__tool', { moduleId: 'my.module' }).reason).toBe(reason);
      expect(plugin('my module__tool', { moduleId: 'my module' }).reason).toBe(reason);
      expect(plugin('__tool', { moduleId: '' }).reason).toBe(reason);
      expect(plugin('my-module__tool', { moduleId: undefined }).reason).toBe(reason);
   });

   it('accepts every module id Foundry accepts: capitals, a leading _ and a leading -', () => {
      for (const moduleId of [
         'MyMod',
         '_lead',
         '-lead',
      ]) {
         /** @type {ReturnType<typeof validateScriptDefinition>} The outcome for a tool of this module. */
         const outcome = plugin(`${moduleId}__Tool-1`, { moduleId });
         expect(outcome.ok, moduleId).toBe(true);
         expect(outcome.definition.moduleId).toBe(moduleId);
         expect(outcome.definition.name).toBe(`${moduleId}__Tool-1`);
      }
   });

   it('matches the module prefix exactly, so a name of another case is refused', () => {
      expect(plugin('mymod__tool', { moduleId: 'MyMod' }).reason).toBe(
         'name must be <moduleId>__<tool>, where <tool> uses only A-Z, a-z, 0-9, _ and -',
      );
   });

   it('bounds a long module id by the 50-character name limit', () => {
      /** @type {string} A module id of 65 characters, which Foundry accepts. */
      const moduleId = 'm'.repeat(65);
      expect(plugin(`${moduleId}__tool`, { moduleId }).reason).toMatch(/^name is 71 characters;/);
   });

   it('names the <moduleId>__<tool> form when a plugin name breaks it', () => {
      for (const name of [
         'other__tool',
         'my-module__',
         'my-module__a.b',
         'my-module__a b',
      ]) {
         expect(plugin(name).reason, name).toBe(
            'name must be <moduleId>__<tool>, where <tool> uses only A-Z, a-z, 0-9, _ and -',
         );
      }
   });

   it.each([
      { version: undefined },
      { version: '1.0' },
      { description: '' },
      { description: 'a\nb' },
      { inputSchema: 'x' },
      { result: undefined },
      { result: { budgetBytes: 0 } },
      { result: { budgetBytes: 1.5 } },
      { requires: 'everywhere' },
      { mutates: undefined },
      { mutates: 'no' },
      { gate: 'allowedPluginModules' },
      { gate: 'noSuchGate' },
      { handleArgs: ['missing'] },
      { strictNested: false },
      { requiresUserInteraction: false },
   ])('refuses each needed-to-work rule for both sources: %j', (overrides) => {
      expect(validateScriptDefinition(script('tool', overrides), 'shipped').ok).toBe(false);
      expect(plugin('my-module__tool', overrides).ok).toBe(false);
   });
});

describe('parseRegistryPayload', () => {
   it('returns the scripts of a payload with the current api version', () => {
      const scripts = [script('one')];
      expect(parseRegistryPayload({
         apiVersion: SCRIPT_API_VERSION,
         scripts,
      })).toEqual({
         ok: true,
         scripts,
      });
   });

   it('accepts an empty script list', () => {
      expect(parseRegistryPayload({
         apiVersion: SCRIPT_API_VERSION,
         scripts: [],
      })).toEqual({
         ok: true,
         scripts: [],
      });
   });

   it.each([
      [
         'undefined',
         undefined,
      ],
      [
         'null',
         null,
      ],
      [
         'a string',
         'x',
      ],
      [
         'a number',
         5,
      ],
      [
         'a plain array of definitions',
         [script('one')],
      ],
      [
         'an object with the old tools key',
         { tools: [script('one')] },
      ],
      [
         'no api version',
         { scripts: [] },
      ],
      [
         'a string api version',
         {
            apiVersion: '1',
            scripts: [],
         },
      ],
      [
         'another api version',
         {
            apiVersion: SCRIPT_API_VERSION + 1,
            scripts: [],
         },
      ],
      [
         'scripts that is not an array',
         {
            apiVersion: SCRIPT_API_VERSION,
            scripts: {},
         },
      ],
      [
         'no scripts',
         { apiVersion: SCRIPT_API_VERSION },
      ],
   ])('refuses %s', (_label, payload) => {
      const outcome = parseRegistryPayload(payload);
      expect(outcome.ok).toBe(false);
      expect(typeof outcome.reason).toBe('string');
   });

   it('reads own properties only', () => {
      const inherited = Object.create({
         apiVersion: SCRIPT_API_VERSION,
         scripts: [],
      });
      expect(parseRegistryPayload(inherited).ok).toBe(false);
   });

   it('names apiVersion in the reason for a wrong version', () => {
      const outcome = parseRegistryPayload({
         apiVersion: 99,
         scripts: [],
      });
      expect(outcome.reason).toContain('apiVersion');
   });
});

describe('validateScriptDefinition: handleArgs', () => {
   /**
    * A valid definition that takes a text and a list of texts.
    * @param {unknown} handleArgs - The `handleArgs` to try.
    * @returns {object} The definition.
    */
   function withHandleArgs(handleArgs) {
      return {
         name: 'mock_tool',
         version: '1.0.0',
         description: 'A synthetic tool.',
         inputSchema: {
            type: 'object',
            properties: {
               text: { type: 'string' },
               count: { type: 'integer' },
               texts: {
                  type: 'array',
                  maxItems: 5,
                  items: { type: 'string' },
               },
               numbers: {
                  type: 'array',
                  maxItems: 5,
                  items: { type: 'integer' },
               },
            },
         },
         result: { budgetBytes: 1000 },
         requires: 'api',
         mutates: false,
         handleArgs,
      };
   }

   it('keeps the names of text and text-list properties', () => {
      const outcome = validateScriptDefinition(withHandleArgs([
         'text',
         'texts',
      ]), 'shipped');
      expect(outcome.ok, outcome.reason).toBe(true);
      expect(outcome.definition.handleArgs).toEqual([
         'text',
         'texts',
      ]);
   });

   it('leaves the field out when the definition has none', () => {
      const outcome = validateScriptDefinition(withHandleArgs(undefined), 'shipped');
      expect(outcome.ok).toBe(true);
      expect(outcome.definition).not.toHaveProperty('handleArgs');
   });

   it.each([
      ['not a list', 'text'],
      ['an unknown property', ['nope']],
      ['a number property', ['count']],
      ['a list of numbers', ['numbers']],
      ['a duplicate', ['text', 'text']],
      ['a name that is not text', [1]],
      ['more than four names', ['a', 'b', 'c', 'd', 'e']],
      ['an empty list', []],
      ['an inherited name', ['constructor']],
   ])('refuses %s', (label, handleArgs) => {
      const outcome = validateScriptDefinition(withHandleArgs(handleArgs), 'shipped');
      expect(outcome.ok, label).toBe(false);
      expect(outcome.reason).toMatch(/handleArgs/);
   });
});

describe('validateScriptDefinition: requiresUserInteraction', () => {
   it('keeps requiresUserInteraction: true in the normalized definition and omits it otherwise', () => {
      const flagged = shipped(script('x', { requiresUserInteraction: true }));
      expect(flagged.ok).toBe(true);
      expect(flagged.definition.requiresUserInteraction).toBe(true);
      const plain = shipped(script('x'));
      expect(plain.ok).toBe(true);
      expect(Object.hasOwn(plain.definition, 'requiresUserInteraction')).toBe(false);
   });

   it.each([
      false,
      'true',
      1,
      null,
      {},
   ])('refuses requiresUserInteraction %j', (value) => {
      const outcome = shipped(script('x', { requiresUserInteraction: value }));
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toBe('requiresUserInteraction may only be true');
   });

   it('does not count the flag in the definition size', () => {
      const limit = getBudget('DEFINITION_MAX_BYTES').value;
      const fixed = Buffer.byteLength(JSON.stringify({
         name: 'fat_tool',
         description: 'Synthetic.',
         inputSchema: padded(0),
      }));
      const schema = padded(limit - 1 - fixed);
      expect(definitionBytes('fat_tool', 'Synthetic.', schema)).toBe(limit - 1);
      const plain = script('fat_tool', {
         description: 'Synthetic.',
         inputSchema: schema,
      });
      const flagged = {
         ...plain,
         requiresUserInteraction: true,
      };
      expect(shipped(flagged).ok).toBe(true);
      /** @type {object} The argument schema that puts the listed definition one byte over the limit. */
      const overSchema = padded(limit + 1 - fixed);
      const overPlain = shipped(script('fat_tool', {
         description: 'Synthetic.',
         inputSchema: overSchema,
      }));
      const overFlagged = shipped(script('fat_tool', {
         description: 'Synthetic.',
         inputSchema: overSchema,
         requiresUserInteraction: true,
      }));
      expect(overPlain.reason).toBe(`definition is ${limit + 1} bytes, at most ${limit} bytes`);
      expect(overFlagged.ok).toBe(false);
      expect(overFlagged.reason).toBe(overPlain.reason);
   });

   it('exports the meta key and the forced tool names', () => {
      expect(USER_INTERACTION_META_KEY).toBe('anthropic/requiresUserInteraction');
      expect(USER_INTERACTION_TOOLS).toEqual(['delete_pack']);
      expect(Object.isFrozen(USER_INTERACTION_TOOLS)).toBe(true);
   });

   it.each([
      [
         'plugin',
         { moduleId: 'my-module' },
         'name must be <moduleId>__<tool>, where <tool> uses only A-Z, a-z, 0-9, _ and -',
      ],
      [
         'agent',
         {},
         'name must be agent__<name>',
      ],
   ])('refuses a %s definition named delete_pack whatever flag it carries', (source, owner, reason) => {
      for (const flag of [
         { requiresUserInteraction: true },
         {},
      ]) {
         const outcome = validateScriptDefinition(script('delete_pack', {
            ...owner,
            ...flag,
         }), source);
         expect(outcome.ok).toBe(false);
         expect(outcome.reason).toBe(reason);
      }
   });
});
