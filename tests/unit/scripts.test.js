// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { getBudget } from '../../shared/budgets.js';
import {
   RESERVED_SCRIPT_NAMES,
   SCRIPT_API_VERSION,
   SCRIPT_REQUIRES,
   SCRIPT_SOURCES,
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
      expect(RESERVED_SCRIPT_NAMES).toEqual(['read_handle']);
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

   it('does not reserve create_actor', () => {
      expect(shipped(script('create_actor')).ok).toBe(true);
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

   it('validates a plugin script by the plugin rules and then refuses it as not supported', () => {
      const plugin = script('my-module__tool', { moduleId: 'my-module' });
      const outcome = validateScriptDefinition(plugin, 'plugin');
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain('plugin scripts are not supported');
   });

   it('applies the plugin name budget to a plugin script', () => {
      const moduleId = 'my-module';
      const longest = `${moduleId}__${'a'.repeat(getBudget('PLUGIN_TOOL_NAME_MAX_CHARS').value - moduleId.length - 2)}`;
      expect(longest).toHaveLength(64);
      const fits = validateScriptDefinition(script(longest, { moduleId }), 'plugin');
      expect(fits.reason).toContain('not supported');
      const over = validateScriptDefinition(script(`${longest}a`, { moduleId }), 'plugin');
      expect(over.reason).toContain('name');
      expect(over.reason).not.toContain('not supported');
   });

   it('requires a plugin script to carry its module id and to be named from it', () => {
      const missing = validateScriptDefinition(script('my-module__tool'), 'plugin');
      expect(missing.reason).toContain('moduleId');
      const unrelated = validateScriptDefinition(script('other__tool', { moduleId: 'my-module' }), 'plugin');
      expect(unrelated.reason).toContain('name');
      const bare = validateScriptDefinition(script('my-module__', { moduleId: 'my-module' }), 'plugin');
      expect(bare.reason).toContain('name');
      const badId = validateScriptDefinition(script('bad__tool', { moduleId: 'Bad Id' }), 'plugin');
      expect(badId.reason).toContain('moduleId');
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
