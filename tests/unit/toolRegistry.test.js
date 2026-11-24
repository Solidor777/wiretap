// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { getBudget } from '../../shared/budgets.js';
import { compileSchema } from '../../shared/schemaValidate.js';
import { RESERVED_SCRIPT_NAMES, SCRIPT_API_VERSION, definitionBytes } from '../../shared/scripts.js';
import { jsonSchemaToZodShape, sanitizeRegistry } from '../../server/toolRegistry.ts';
import { paddedSchema, registryPayload, script } from './scriptFixtures.js';

/**
 * Build a valid script definition named `mock_tool`; fields in `overrides` replace the defaults.
 * @param {object} [overrides] - Fields to set on the definition.
 * @returns {object} A definition that passes every budget.
 */
function entry(overrides = {}) {
   return script('mock_tool', {
      description: 'A synthetic tool.',
      ...overrides,
   });
}

/**
 * Sanitize a payload as received and collect the log lines.
 * @param {unknown} payload - The registry payload exactly as the socket delivered it.
 * @returns {{ outcome: ReturnType<typeof sanitizeRegistry>, lines: string[] }} The outcome and the log lines.
 */
function runRaw(payload) {
   /** @type {string[]} The log lines written during the call. */
   const lines = [];
   return {
      outcome: sanitizeRegistry(payload, (line) => lines.push(line)),
      lines,
   };
}

/**
 * Sanitize a list of script definitions sent in a well-formed registry payload and collect the log lines.
 * @param {unknown[]} scripts - The definitions.
 * @returns {{ outcome: ReturnType<typeof sanitizeRegistry>, lines: string[] }} The outcome and the log lines.
 */
function run(scripts) {
   return runRaw(registryPayload(scripts));
}

describe('sanitizeRegistry: accepted tools', () => {
   it('accepts a valid tool and keeps only the known fields', () => {
      const { outcome, lines } = run([entry({
         extra: 'ignored',
         result: { budgetBytes: 4000 },
         mutates: true,
         requires: 'dom',
         gate: 'allowUserWrites',
      })]);
      expect(outcome.ok).toBe(true);
      expect(outcome.refused).toBe(0);
      expect(outcome.tools).toHaveLength(1);
      const [tool] = outcome.tools;
      expect(tool.name).toBe('mock_tool');
      expect(tool.version).toBe('1.0.0');
      expect(tool.description).toBe('A synthetic tool.');
      expect(tool.budgetBytes).toBe(4000);
      expect(tool.requires).toBe('dom');
      expect(tool.mutates).toBe(true);
      expect(tool.gates).toEqual([{ gate: 'allowUserWrites' }]);
      expect(Object.keys(tool.shape)).toEqual(['text']);
      expect(tool).not.toHaveProperty('extra');
      expect(lines).toEqual([]);
   });

   it('keeps handleArgs, and a tool that names a handle argument differs in both signatures', () => {
      const plain = run([entry()]).outcome.tools[0];
      const withHandle = run([entry({ handleArgs: ['text'] })]).outcome.tools[0];
      expect(plain.handleArgs).toEqual([]);
      expect(withHandle.handleArgs).toEqual(['text']);
      expect(withHandle.signature).not.toBe(plain.signature);
      expect(withHandle.schemaSignature).not.toBe(plain.schemaSignature);
   });

   it('marks a tool whose definition declares requiresUserInteraction', () => {
      const { outcome } = run([entry({ requiresUserInteraction: true })]);
      expect(outcome.tools[0].requiresUserInteraction).toBe(true);
   });

   it('marks delete_pack although its definition omits the flag', () => {
      const { outcome } = run([entry({ name: 'delete_pack' })]);
      expect(outcome.tools[0].requiresUserInteraction).toBe(true);
   });

   it('leaves every other tool unmarked', () => {
      const { outcome } = run([entry()]);
      expect(outcome.tools[0].requiresUserInteraction).toBe(false);
   });

   it('changes signature but not schemaSignature when the flag differs', () => {
      const plain = run([entry()]).outcome.tools[0];
      const flagged = run([entry({ requiresUserInteraction: true })]).outcome.tools[0];
      expect(flagged.signature).not.toBe(plain.signature);
      expect(flagged.schemaSignature).toBe(plain.schemaSignature);
   });

   it('does not reserve create_documents: it is a script like any other', () => {
      expect(run([entry({ name: 'create_documents' })]).outcome.tools.map((tool) => tool.name)).toEqual([
         'create_documents',
      ]);
   });

   it('logs a description over the target as a warning and still accepts the tool', () => {
      const { outcome, lines } = run([entry({
         description: 'd'.repeat(getBudget('DESCRIPTION_TARGET_CHARS').value + 1),
         inputSchema: { type: 'object' },
      })]);
      expect(outcome.tools).toHaveLength(1);
      expect(outcome.refused).toBe(0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('registry warning for tool "mock_tool"');
   });

   it('accepts an empty registry, which clears the tools', () => {
      const { outcome } = run([]);
      expect(outcome).toEqual({
         ok: true,
         tools: [],
         refused: 0,
      });
   });

   it('accepts a name of exactly the core name budget and refuses one character more', () => {
      const limit = getBudget('CORE_TOOL_NAME_MAX_CHARS').value;
      expect(run([entry({ name: 'a'.repeat(limit) })]).outcome.tools).toHaveLength(1);
      const { outcome, lines } = run([entry({ name: 'a'.repeat(limit + 1) })]);
      expect(outcome.tools).toEqual([]);
      expect(outcome.refused).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('name');
   });

   it('accepts a description of exactly the hard maximum and refuses one character more', () => {
      const limit = getBudget('DESCRIPTION_MAX_CHARS').value;
      /** @type {object} The smallest schema, so only the description length decides. */
      const inputSchema = { type: 'object' };
      expect(run([entry({
         description: 'd'.repeat(limit),
         inputSchema,
      })]).outcome.tools).toHaveLength(1);
      const { outcome, lines } = run([entry({
         description: 'd'.repeat(limit + 1),
         inputSchema,
      })]);
      expect(outcome.tools).toEqual([]);
      expect(lines[0]).toContain('description');
   });
});

describe('sanitizeRegistry: refused tools', () => {
   it('refuses a payload that is not a registry object without throwing', () => {
      for (const payload of [
         undefined,
         null,
         'x',
         7,
         {},
         { tools: [] },
         [entry()],
         { scripts: [entry()] },
         registryPayload([entry()], { apiVersion: SCRIPT_API_VERSION + 1 }),
         registryPayload({}),
      ]) {
         const { outcome } = runRaw(payload);
         expect(outcome.ok).toBe(false);
         expect(typeof outcome.reason).toBe('string');
      }
   });

   it('names the shape a plain array of definitions should have', () => {
      expect(runRaw([entry()]).outcome.reason).toContain('apiVersion');
   });

   it.each([
      [
         'an empty name',
         { name: '' },
         'name',
      ],
      [
         'an uppercase name',
         { name: 'Mock' },
         'name',
      ],
      [
         'a name starting with a digit',
         { name: '1mock' },
         'name',
      ],
      [
         'a name with a space',
         { name: 'mock tool' },
         'name',
      ],
      [
         'a name with a path separator',
         { name: 'mock/tool' },
         'name',
      ],
      [
         'a non-string name',
         { name: 5 },
         'name',
      ],
      [
         'the __proto__ name',
         { name: '__proto__' },
         'name',
      ],
      [
         'the constructor name',
         { name: 'constructor' },
         'reserved',
      ],
      [
         'the read_handle name',
         { name: 'read_handle' },
         'reserved',
      ],
      [
         'an empty description',
         { description: '' },
         'description',
      ],
      [
         'a non-string description',
         { description: 12 },
         'description',
      ],
      [
         'a description with a line break',
         { description: 'one\ntwo' },
         'description',
      ],
      [
         'a description over the hard maximum',
         { description: 'd'.repeat(241) },
         'description',
      ],
      [
         'a missing schema',
         { inputSchema: undefined },
         'inputSchema',
      ],
      [
         'a schema that is an array',
         { inputSchema: [] },
         'inputSchema',
      ],
      [
         'a missing result budget',
         { result: {} },
         'budgetBytes',
      ],
      [
         'a zero byte budget',
         { result: { budgetBytes: 0 } },
         'budgetBytes',
      ],
      [
         'a fractional byte budget',
         { result: { budgetBytes: 1.5 } },
         'budgetBytes',
      ],
      [
         'a string byte budget',
         { result: { budgetBytes: '500' } },
         'budgetBytes',
      ],
      [
         'a byte budget over the per-call maximum',
         { result: { budgetBytes: 16001 } },
         'budgetBytes',
      ],
      [
         'a missing version',
         { version: undefined },
         'version',
      ],
      [
         'a malformed version',
         { version: 'one' },
         'version',
      ],
      [
         'a missing mutates',
         { mutates: undefined },
         'mutates',
      ],
      [
         'a mutates that is not a boolean',
         { mutates: 'false' },
         'mutates',
      ],
      [
         'a missing requires',
         { requires: undefined },
         'requires',
      ],
      [
         'an unknown requires',
         { requires: 'browser' },
         'requires',
      ],
      [
         'requires none, which only the sidecar runs',
         { requires: 'none' },
         'sidecar',
      ],
      [
         'an unknown gate',
         { gate: 'allowEverything' },
         'gate',
      ],
      [
         'an inherited gate name',
         { gate: 'constructor' },
         'gate',
      ],
      [
         'the plugin module list as a gate',
         { gate: 'allowedPluginModules' },
         'gate',
      ],
      [
         'a module id whose name is not in its module',
         { moduleId: 'some-module' },
         'name must be <moduleId>__<tool>',
      ],
   ])('refuses %s and logs the reason', (_label, overrides, word) => {
      const { outcome, lines } = run([entry(overrides)]);
      expect(outcome).toEqual({
         ok: true,
         tools: [],
         refused: 1,
      });
      expect(lines).toHaveLength(1);
      expect(lines[0].startsWith('Wiretap sidecar | registry refused tool ')).toBe(true);
      expect(lines[0]).toContain(word);
   });

   it('refuses an entry that is not an object, null or an array', () => {
      const { outcome, lines } = run([
         null,
         'tool',
         7,
         [],
         entry(),
      ]);
      expect(outcome.tools.map((tool) => tool.name)).toEqual(['mock_tool']);
      expect(outcome.refused).toBe(4);
      expect(lines).toHaveLength(4);
   });

   it('refuses the second of two tools with the same name', () => {
      const { outcome, lines } = run([
         entry(),
         entry({ description: 'Another.' }),
      ]);
      expect(outcome.tools).toHaveLength(1);
      expect(outcome.tools[0].description).toBe('A synthetic tool.');
      expect(outcome.refused).toBe(1);
      expect(lines[0]).toContain('duplicate');
   });

   it('keeps the valid tools of a payload that also holds refused ones', () => {
      const { outcome } = run([
         entry({ name: 'first' }),
         entry({ name: 'BAD' }),
         entry({ name: 'third' }),
      ]);
      expect(outcome.tools.map((tool) => tool.name)).toEqual([
         'first',
         'third',
      ]);
      expect(outcome.refused).toBe(1);
   });

   it('refuses the names the sidecar registers itself', () => {
      for (const name of RESERVED_SCRIPT_NAMES) {
         const { outcome, lines } = run([entry({ name })]);
         expect(outcome.tools).toEqual([]);
         expect(lines[0]).toContain('reserved');
      }
   });

   it('judges an entry whose moduleId is undefined by the shipped rules', () => {
      const { outcome, lines } = run([
         entry({
            name: 'x'.repeat(40),
            moduleId: undefined,
         }),
         entry({ moduleId: undefined }),
      ]);
      expect(outcome.tools.map((tool) => tool.gates)).toEqual([[]]);
      expect(outcome.refused).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('1 to 32 characters');
   });

   it('refuses a "__" name without a moduleId instead of listing it as a shipped tool', () => {
      const { outcome, lines } = run([entry({ name: 'my-mod__echo' })]);
      expect(outcome.tools).toEqual([]);
      expect(outcome.refused).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('a shipped tool name may not contain "__"');
   });

   it('replaces control characters and cuts a hostile name in the log line', () => {
      const { lines } = run([entry({ name: `evil\n${'x'.repeat(200)}\u2028forged line` })]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toMatch(/[\n\r\u2028]/);
      expect(Buffer.byteLength(lines[0])).toBeLessThan(300);
   });
});

describe('sanitizeRegistry: definition budget', () => {
   it('refuses a schema whose received definition is over the definition budget', () => {
      const properties = Object.fromEntries(
         Array.from({ length: 12 }, (_, index) => [
            `field${index}`,
            {
               type: 'string',
               description: 'x'.repeat(40),
            },
         ]),
      );
      const { outcome, lines } = run([entry({ inputSchema: {
         type: 'object',
         properties,
      } })]);
      expect(outcome.tools).toEqual([]);
      expect(lines[0]).toMatch(/definition is \d+ bytes, at most 800 bytes/);
   });

   it('measures the definition as the client will list it, not as it was received', () => {
      /** @type {object} A schema that is within the budget as received. */
      const inputSchema = {
         type: 'object',
         properties: Object.fromEntries(
            ['alpha', 'beta', 'gamma'].map((key) => [
               key,
               {
                  type: 'string',
                  description: 'p'.repeat(150),
               },
            ]),
         ),
         required: ['alpha'],
      };
      /** @type {number} The bytes of the name, an empty description and the schema as received. */
      const base = Buffer.byteLength(JSON.stringify({
         name: 'mock_tool',
         description: '',
         inputSchema,
      }));
      // 790 received bytes: within the 800 byte budget as received, over it once listed with its `$schema` key.
      const description = 'd'.repeat(790 - base);
      expect(description.length).toBeGreaterThan(0);
      const { outcome, lines } = run([entry({ description, inputSchema })]);
      expect(outcome.tools).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/listed definition is \d+ bytes, at most 800 bytes/);
   });

   it('accepts a definition that is within the budget as listed', () => {
      expect(run([entry({ description: 'd'.repeat(100) })]).outcome.tools).toHaveLength(1);
   });
});

describe('sanitizeRegistry: plugin entries', () => {
   it('validates an entry that carries moduleId by the plugin rules and gates it by its module first', () => {
      const { outcome } = run([entry({
         name: 'my-mod__echo',
         moduleId: 'my-mod',
         gate: 'allowDelete',
      })]);
      expect(outcome.tools[0].gates).toEqual([
         {
            gate: 'allowedPluginModules',
            moduleId: 'my-mod',
         },
         { gate: 'allowDelete' },
      ]);
   });

   it('gates a plugin entry that declares no gate by its module only', () => {
      const { outcome } = run([entry({
         name: 'my-mod__echo',
         moduleId: 'my-mod',
      })]);
      expect(outcome.tools[0].gates).toEqual([
         {
            gate: 'allowedPluginModules',
            moduleId: 'my-mod',
         },
      ]);
   });

   it('lists a shipped gate as a one-entry list and no gate as an empty list', () => {
      expect(run([entry({ gate: 'allowUserWrites' })]).outcome.tools[0].gates).toEqual([{ gate: 'allowUserWrites' }]);
      expect(run([entry()]).outcome.tools[0].gates).toEqual([]);
   });

   it('gives two tools that differ only in their module gate different signatures', () => {
      const first = run([entry({
         name: 'my-mod__echo',
         moduleId: 'my-mod',
      })]).outcome.tools[0];
      const second = run([entry({
         name: 'my-mod__echo',
         moduleId: 'my-mod',
         gate: 'allowDelete',
      })]).outcome.tools[0];
      expect(second.signature).not.toBe(first.signature);
   });

   it('accepts a plugin entry over the per-tool guidelines and logs one warning line for each', () => {
      const { outcome, lines } = run([entry({
         name: 'my-mod__big',
         moduleId: 'my-mod',
         description: 'd'.repeat(200),
         inputSchema: paddedSchema(1500),
      })]);
      expect(outcome.tools).toHaveLength(1);
      expect(lines).toEqual([
         'Wiretap sidecar | registry warning for tool "my-mod__big": description is 200 characters, over the ' +
            '160-character target',
         expect.stringMatching(
            /^Wiretap sidecar \| registry warning for tool "my-mod__big": listed definition is \d+ bytes, over the 800-byte guideline$/,
         ),
      ]);
   });

   it('logs the schema guideline warnings after the definition warnings and before the listed-size one', () => {
      const { outcome, lines } = run([entry({
         name: 'my-mod__list',
         moduleId: 'my-mod',
         description: 'd'.repeat(300),
         inputSchema: {
            type: 'object',
            properties: {
               ids: {
                  type: 'array',
                  items: { type: 'string' },
               },
            },
         },
      })]);
      expect(outcome.tools).toHaveLength(1);
      expect(lines).toEqual([
         'Wiretap sidecar | registry warning for tool "my-mod__list": description is 300 characters, over the ' +
            '240-character guideline',
         'Wiretap sidecar | registry warning for tool "my-mod__list": an array schema declares no maxItems; the ' +
            'guideline is a maxItems of at most 1000',
      ]);
   });

   it('uses the hard cap as the budget of a plugin tool that declares more', () => {
      const { outcome } = run([entry({
         name: 'my-mod__echo',
         moduleId: 'my-mod',
         result: { budgetBytes: 50000 },
      })]);
      expect(outcome.tools[0].budgetBytes).toBe(16000);
   });

   it('refuses an entry whose moduleId is not a module id, naming what to change', () => {
      const { outcome, lines } = run([entry({
         name: 'x__echo',
         moduleId: 5,
      })]);
      expect(outcome.tools).toEqual([]);
      expect(lines[0]).toContain('moduleId must be your module');
   });

   it('accepts the module ids Foundry accepts and refuses a dot or a space, as the shared plugin route does', () => {
      const { outcome, lines } = run([
         entry({
            name: 'MyMod__echo',
            moduleId: 'MyMod',
         }),
         entry({
            name: '_lead__echo',
            moduleId: '_lead',
         }),
         entry({
            name: '-lead__echo',
            moduleId: '-lead',
         }),
         entry({
            name: 'my.mod__echo',
            moduleId: 'my.mod',
         }),
         entry({
            name: 'my mod__echo',
            moduleId: 'my mod',
         }),
      ]);
      expect(outcome.tools.map((tool) => tool.name)).toEqual([
         'MyMod__echo',
         '_lead__echo',
         '-lead__echo',
      ]);
      expect(outcome.tools.map((tool) => tool.gates[0].moduleId)).toEqual([
         'MyMod',
         '_lead',
         '-lead',
      ]);
      expect(outcome.refused).toBe(2);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
         expect(line).toContain('moduleId must be your module\'s id from module.json: one or more of A-Z');
      }
   });

   it('refuses a plugin entry that requires none', () => {
      const { outcome, lines } = run([entry({
         name: 'my-mod__echo',
         moduleId: 'my-mod',
         requires: 'none',
      })]);
      expect(outcome.tools).toEqual([]);
      expect(outcome.refused).toBe(1);
      expect(lines[0]).toContain('requires none scripts run on the sidecar');
   });

   it('refuses a plugin schema that the converter does not support', () => {
      const { outcome, lines } = run([entry({
         name: 'my-mod__echo',
         moduleId: 'my-mod',
         inputSchema: {
            type: 'object',
            properties: {
               a: {
                  type: 'string',
                  pattern: '(a+)+$',
               },
            },
         },
      })]);
      expect(outcome.tools).toEqual([]);
      expect(lines).toEqual([
         'Wiretap sidecar | registry refused tool "my-mod__echo": unsupported schema keyword "pattern"',
      ]);
   });
});

describe('sanitizeRegistry: no count or total bound', () => {
   it('accepts every entry of a large registry', () => {
      const { outcome, lines } = run(Array.from({ length: 200 }, (_, index) => entry({ name: `tool_${index}` })));
      expect(outcome.tools).toHaveLength(200);
      expect(outcome.refused).toBe(0);
      expect(lines).toEqual([]);
   });

   it('accepts definitions whose listed sizes add up past 16,000 bytes', () => {
      /** @type {object} A schema whose listed definition is close to the definition budget. */
      const inputSchema = paddedSchema(790);
      const { outcome } = run(Array.from({ length: 29 }, (_, index) => entry({
         name: `padded_script_${String(index).padStart(2, '0')}`,
         description: 'd'.repeat(20),
         inputSchema,
      })));
      /** @type {number} The listed size of each definition. */
      const each = definitionBytes('padded_script_00', 'd'.repeat(20), compileSchema(inputSchema).listed);
      // 16000 bytes: a total listed size of all definitions together that a total-size bound would refuse.
      expect(29 * each).toBeGreaterThan(16000);
      expect(outcome.tools).toHaveLength(29);
   });

   it('judges every entry of an enormous payload', () => {
      const { outcome } = run(Array.from({ length: 50_000 }, () => null));
      expect(outcome.tools).toEqual([]);
      expect(outcome.refused).toBe(50_000);
   });
});

describe('sanitizeRegistry: hostile payloads', () => {
   it('does not pollute Object.prototype from an own __proto__ key in a parsed entry', () => {
      /** @type {string} A complete entry serialized with a __proto__ key added. */
      const text = JSON.stringify(entry()).replace('{', '{"__proto__":{"polluted":true},');
      const { outcome } = run(JSON.parse(`[${text}]`));
      expect({}.polluted).toBeUndefined();
      expect(outcome.tools).toHaveLength(1);
      expect(outcome.tools[0].polluted).toBeUndefined();
   });

   it('refuses a schema with an own __proto__ keyword without changing any prototype', () => {
      /** @type {string} A complete entry serialized with a __proto__ key inside the schema. */
      const text = JSON.stringify(entry({ inputSchema: { type: 'object' } })).replace(
         '"inputSchema":{',
         '"inputSchema":{"__proto__":{"polluted":true},',
      );
      const { outcome, lines } = run(JSON.parse(`[${text}]`));
      expect({}.polluted).toBeUndefined();
      expect(outcome.tools).toEqual([]);
      expect(lines[0]).toContain('keyword');
   });

   it('refuses a schema property named __proto__ without changing any prototype', () => {
      /** @type {string} A complete entry serialized with a __proto__ schema property. */
      const text = JSON.stringify(entry({ inputSchema: { type: 'object' } })).replace(
         '"inputSchema":{',
         '"inputSchema":{"properties":{"__proto__":{"type":"string"}},',
      );
      const { outcome, lines } = run(JSON.parse(`[${text}]`));
      expect(outcome.tools).toEqual([]);
      expect(lines[0]).toContain('property name');
      expect({}.type).toBeUndefined();
   });

   it('refuses a property named after an Object.prototype member', () => {
      for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
         const result = jsonSchemaToZodShape({
            type: 'object',
            properties: { [name]: { type: 'string' } },
         });
         expect(result.ok).toBe(false);
      }
   });

   it('refuses an entry whose property reads throw, without throwing', () => {
      const hostile = new Proxy(
         {},
         {
            get() {
               throw new Error('hostile getter');
            },
            ownKeys() {
               throw new Error('hostile keys');
            },
            has() {
               throw new Error('hostile has');
            },
            getOwnPropertyDescriptor() {
               throw new Error('hostile descriptor');
            },
         },
      );
      const { outcome, lines } = run([
         hostile,
         entry(),
      ]);
      expect(outcome.tools.map((tool) => tool.name)).toEqual(['mock_tool']);
      expect(outcome.refused).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('unreadable');
   });

   it('does not read inherited fields', () => {
      Object.prototype.name = 'inherited_name';
      try {
         const { name: _own, ...nameless } = entry();
         const { outcome } = run([nameless]);
         expect(outcome.tools).toEqual([]);
         expect(outcome.refused).toBe(1);
      } finally {
         delete Object.prototype.name;
      }
   });
});

describe('jsonSchemaToZodShape: supported constructs', () => {
   /**
    * Convert a schema and fail the test when it is refused.
    * @param {unknown} schema - The JSON Schema.
    * @returns {import('zod').ZodObject} An object schema over the shape.
    */
   function objectOf(schema) {
      const result = jsonSchemaToZodShape(schema);
      expect(result.ok).toBe(true);
      return z.object(result.shape);
   }

   it('converts an empty object schema to an empty shape', () => {
      expect(jsonSchemaToZodShape({ type: 'object' })).toEqual({
         ok: true,
         shape: {},
         strict: false,
         warnings: [],
      });
   });

   it('makes a property required only when it is listed in required', () => {
      const schema = objectOf({
         type: 'object',
         properties: {
            a: { type: 'string' },
            b: { type: 'string' },
         },
         required: ['a'],
      });
      expect(schema.safeParse({ a: 'x' }).success).toBe(true);
      expect(schema.safeParse({ b: 'x' }).success).toBe(false);
   });

   it('converts strings with length bounds and enums', () => {
      const schema = objectOf({
         type: 'object',
         properties: {
            word: {
               type: 'string',
               minLength: 2,
               maxLength: 4,
            },
            kind: {
               type: 'string',
               enum: [
                  'npc',
                  'pc',
               ],
            },
         },
      });
      expect(schema.safeParse({ word: 'ab' }).success).toBe(true);
      expect(schema.safeParse({ word: 'a' }).success).toBe(false);
      expect(schema.safeParse({ word: 'abcde' }).success).toBe(false);
      expect(schema.safeParse({ kind: 'npc' }).success).toBe(true);
      expect(schema.safeParse({ kind: 'dragon' }).success).toBe(false);
   });

   it('converts numbers, integers and booleans with bounds', () => {
      const schema = objectOf({
         type: 'object',
         properties: {
            ratio: {
               type: 'number',
               minimum: 0,
               maximum: 1,
            },
            count: {
               type: 'integer',
               minimum: 1,
               maximum: 5,
            },
            flag: { type: 'boolean' },
         },
      });
      expect(schema.safeParse({
         ratio: 0.5,
         count: 2,
         flag: true,
      }).success).toBe(true);
      expect(schema.safeParse({ ratio: 2 }).success).toBe(false);
      expect(schema.safeParse({ count: 2.5 }).success).toBe(false);
      expect(schema.safeParse({ count: 6 }).success).toBe(false);
      expect(schema.safeParse({ flag: 'yes' }).success).toBe(false);
   });

   it('converts arrays with item schemas and size bounds, and nested objects', () => {
      const schema = objectOf({
         type: 'object',
         properties: {
            ids: {
               type: 'array',
               items: { type: 'string' },
               minItems: 1,
               maxItems: 2,
            },
            inner: {
               type: 'object',
               properties: { n: { type: 'integer' } },
               required: ['n'],
            },
         },
      });
      expect(schema.safeParse({ ids: ['a'] }).success).toBe(true);
      expect(schema.safeParse({ ids: [] }).success).toBe(false);
      expect(schema.safeParse({ ids: [
         'a',
         'b',
         'c',
      ] }).success).toBe(false);
      expect(schema.safeParse({ ids: [1] }).success).toBe(false);
      expect(schema.safeParse({ inner: { n: 1 } }).success).toBe(true);
      expect(schema.safeParse({ inner: {} }).success).toBe(false);
   });

   it('keeps a property description', () => {
      const result = jsonSchemaToZodShape({
         type: 'object',
         properties: { a: {
            type: 'string',
            description: 'The a.',
         } },
      });
      expect(result.ok).toBe(true);
      expect(result.shape.a.description).toBe('The a.');
   });

   it('accepts additionalProperties: false', () => {
      expect(jsonSchemaToZodShape({
         type: 'object',
         additionalProperties: false,
      }).ok).toBe(true);
   });
});

describe('jsonSchemaToZodShape: refused constructs', () => {
   it.each([
      [
         'a root that is not an object schema',
         { type: 'string' },
      ],
      [
         'a root with no type',
         {},
      ],
      [
         'a $ref',
         {
            type: 'object',
            properties: { a: { $ref: '#/definitions/a' } },
         },
      ],
      [
         'a $schema keyword',
         {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
         },
      ],
      [
         'oneOf',
         {
            type: 'object',
            properties: { a: { oneOf: [
               { type: 'string' },
               { type: 'number' },
            ] } },
         },
      ],
      [
         'anyOf',
         {
            type: 'object',
            properties: { a: { anyOf: [{ type: 'string' }] } },
         },
      ],
      [
         'allOf',
         {
            type: 'object',
            properties: { a: { allOf: [{ type: 'string' }] } },
         },
      ],
      [
         'a not',
         {
            type: 'object',
            properties: { a: { not: { type: 'string' } } },
         },
      ],
      [
         'a type list',
         {
            type: 'object',
            properties: { a: { type: [
               'string',
               'null',
            ] } },
         },
      ],
      [
         'the null type',
         {
            type: 'object',
            properties: { a: { type: 'null' } },
         },
      ],
      [
         'a regular expression pattern',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               pattern: '(a+)+$',
            } },
         },
      ],
      [
         'a format',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               format: 'uri',
            } },
         },
      ],
      [
         'a default',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               default: 'x',
            } },
         },
      ],
      [
         'a const',
         {
            type: 'object',
            properties: { a: { const: 'x' } },
         },
      ],
      [
         'additionalProperties true',
         {
            type: 'object',
            additionalProperties: true,
         },
      ],
      [
         'additionalProperties as a schema',
         {
            type: 'object',
            additionalProperties: { type: 'string' },
         },
      ],
      [
         'patternProperties',
         {
            type: 'object',
            patternProperties: { '^a': { type: 'string' } },
         },
      ],
      [
         'an array with no items',
         {
            type: 'object',
            properties: { a: { type: 'array' } },
         },
      ],
      [
         'an enum of non-strings',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               enum: [
                  1,
                  2,
               ],
            } },
         },
      ],
      [
         'an empty enum',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               enum: [],
            } },
         },
      ],
      [
         'a required name that is not a property',
         {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['b'],
         },
      ],
      [
         'a non-array required',
         {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: 'a',
         },
      ],
      [
         'a non-finite bound',
         {
            type: 'object',
            properties: { a: {
               type: 'number',
               minimum: 'zero',
            } },
         },
      ],
      [
         'a negative length bound',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               maxLength: -1,
            } },
         },
      ],
      [
         'properties that are not an object',
         {
            type: 'object',
            properties: [],
         },
      ],
      [
         'a property schema that is not an object',
         {
            type: 'object',
            properties: { a: 'string' },
         },
      ],
      [
         'an unknown keyword',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               madeUp: 1,
            } },
         },
      ],
      [
         'a non-string description',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               description: 5,
            } },
         },
      ],
      [
         'a property name with a space',
         {
            type: 'object',
            properties: { 'a b': { type: 'string' } },
         },
      ],
   ])('refuses %s with a reason', (_label, schema) => {
      const result = jsonSchemaToZodShape(schema);
      expect(result.ok).toBe(false);
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason.length).toBeLessThan(200);
   });

   it('refuses nesting deeper than four levels and accepts four', () => {
      /**
       * Wrap a leaf schema in object levels.
       * @param {number} levels - How many object levels.
       * @returns {object} The nested schema.
       */
      function nest(levels) {
         let node = { type: 'string' };
         for (let level = 0; level < levels; level += 1) {
            node = {
               type: 'object',
               properties: { a: node },
            };
         }
         return node;
      }
      expect(jsonSchemaToZodShape(nest(4)).ok).toBe(true);
      expect(jsonSchemaToZodShape(nest(5)).ok).toBe(false);
   });

   it('refuses a schema with more properties than the node budget', () => {
      const properties = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
         `p${index}`,
         { type: 'string' },
      ]));
      expect(jsonSchemaToZodShape({
         type: 'object',
         properties,
      }).ok).toBe(false);
   });

   it('refuses a self-referencing structure instead of looping', () => {
      /** @type {Record<string, unknown>} A schema that contains itself. */
      const loop = {
         type: 'object',
         properties: {},
      };
      loop.properties.again = loop;
      expect(jsonSchemaToZodShape(loop).ok).toBe(false);
   });
});
