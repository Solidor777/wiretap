import { describe, it, expect, vi } from 'vitest';
import { getBudget } from '$shared/budgets.js';
import { compileSchema } from '$shared/schemaValidate.js';
import { definitionBytes } from '$shared/scripts.js';
import { createScriptRegistry, registerScript, scriptRegistry, ScriptError } from '~/bridge/scripts/registry.js';
import { paddedSchema, script } from './scriptFixtures.js';

/**
 * Build a registry whose log lines are collected.
 * @returns {{ registry: ReturnType<typeof createScriptRegistry>, lines: string[] }} The registry and its log.
 */
function make() {
   /** @type {string[]} The log lines. */
   const lines = [];
   return {
      registry: createScriptRegistry({ log: (line) => lines.push(line) }),
      lines,
   };
}

/** @type {RegExp} C0 and C1 control characters and the Unicode line separators. */
const CONTROL_PATTERN = new RegExp(`[\u0000-\u001f\u007f-\u009f${String.fromCharCode(0x2028, 0x2029)}]`);

/**
 * A handler that does nothing, for definitions whose handler is not exercised.
 * @type {() => Promise<null>}
 */
const noop = async () => null;

describe('script registry: registration', () => {
   it('accepts a valid script and stores a normalized definition without the handler', () => {
      const { registry, lines } = make();
      const outcome = registry.register(script('alpha', { gate: 'allowUserWrites', extra: 'ignored' }), noop);
      expect(outcome).toEqual({
         ok: true,
         name: 'alpha',
      });
      expect(lines).toEqual([]);
      expect(registry.definitions()).toEqual([script('alpha', { gate: 'allowUserWrites' })]);
      expect(registry.get('alpha').handler).toBe(noop);
      expect(registry.get('alpha').definition.name).toBe('alpha');
   });

   it('keeps registration order in the definitions it lists', () => {
      const { registry } = make();
      registry.register(script('b_script'), noop);
      registry.register(script('a_script'), noop);
      expect(registry.definitions().map((definition) => definition.name)).toEqual([
         'b_script',
         'a_script',
      ]);
   });

   it('is not changed by a later change to the object it was given', () => {
      const { registry } = make();
      const given = script('alpha');
      registry.register(given, noop);
      given.inputSchema.properties.text.type = 'number';
      given.name = 'beta';
      expect(registry.definitions()[0].inputSchema.properties.text.type).toBe('string');
      expect(registry.definitions()[0].name).toBe('alpha');
      expect(registry.get('alpha').validate({ text: 'x' }).ok).toBe(true);
   });

   it('lists copies, so a caller cannot change the registry through them', () => {
      const { registry } = make();
      registry.register(script('alpha'), noop);
      registry.definitions()[0].inputSchema.properties.text.type = 'number';
      registry.definitions().pop();
      expect(registry.definitions()).toHaveLength(1);
      expect(registry.definitions()[0].inputSchema.properties.text.type).toBe('string');
   });

   it('accepts a script with a description over the target and logs the warning', () => {
      const { registry, lines } = make();
      const outcome = registry.register(script('alpha', { description: 'd'.repeat(200) }), noop);
      expect(outcome.ok).toBe(true);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/alpha/);
      expect(lines[0]).toMatch(/160/);
   });

   it('answers get for an unknown or inherited name with undefined', () => {
      const { registry } = make();
      registry.register(script('alpha'), noop);
      expect(registry.get('beta')).toBeUndefined();
      expect(registry.get('constructor')).toBeUndefined();
      expect(registry.get('__proto__')).toBeUndefined();
      expect(registry.get(undefined)).toBeUndefined();
   });
});

describe('script registry: refusals', () => {
   /** @type {Array<[string, unknown, RegExp]>} Label, definition and the expected reason. */
   const INVALID = [
      [
         'a name over 32 characters',
         script('a'.repeat(33)),
         /name/,
      ],
      [
         'a reserved name',
         script('read_handle'),
         /reserved/,
      ],
      [
         'a missing mutates',
         script('alpha', { mutates: undefined }),
         /mutates/,
      ],
      [
         'a bad version',
         script('alpha', { version: 'one' }),
         /version/,
      ],
      [
         'a result budget over the hard cap',
         script('alpha', { result: { budgetBytes: 16001 } }),
         /budgetBytes/,
      ],
      [
         'an unknown gate',
         script('alpha', { gate: 'allowEverything' }),
         /gate/,
      ],
      [
         'a plugin-only moduleId',
         script('alpha', { moduleId: 'some-module' }),
         /moduleId/,
      ],
      [
         'a definition over 800 bytes',
         script('alpha', { description: 'd'.repeat(240), inputSchema: bigSchema(900) }),
         /800/,
      ],
      [
         'a client-side requires none',
         script('alpha', { requires: 'none' }),
         /sidecar/,
      ],
      [
         'a schema construct the sidecar refuses',
         script('alpha', { inputSchema: { type: 'object', properties: { a: { type: 'string', pattern: '^a' } } } }),
         /pattern/,
      ],
      [
         'a non-object definition',
         'alpha',
         /object/,
      ],
      [
         'a null definition',
         null,
         /object/,
      ],
   ];

   it.each(INVALID)('refuses %s with a logged reason and no registration', (label, definition, reason) => {
      const { registry, lines } = make();
      const outcome = registry.register(definition, noop);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toMatch(reason);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('Wiretap | script registry refused');
      expect(lines[0]).toContain(outcome.reason);
      expect(registry.definitions()).toEqual([]);
   });

   it.each([
      undefined,
      null,
      'handler',
      {},
   ])('refuses a handler that is %j', (handler) => {
      const { registry, lines } = make();
      const outcome = registry.register(script('alpha'), handler);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toMatch(/handler/);
      expect(lines).toHaveLength(1);
      expect(registry.definitions()).toEqual([]);
   });

   it('refuses a repeated name and keeps the first script', () => {
      const { registry } = make();
      const first = async () => 'first';
      registry.register(script('alpha'), first);
      const outcome = registry.register(script('alpha', { version: '2.0.0' }), noop);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toMatch(/already registered/);
      expect(registry.get('alpha').handler).toBe(first);
      expect(registry.definitions()[0].version).toBe('1.0.0');
   });

   it('refuses the script past the always-listed tool budget, leaving room for the sidecar built-ins', () => {
      const { registry } = make();
      const room = getBudget('ALWAYS_LISTED_TOOLS_MAX').value - 1;
      for (let index = 0; index < room; index += 1) {
         expect(registry.register(script(`tool_${index}`), noop).ok).toBe(true);
      }
      const outcome = registry.register(script('one_too_many'), noop);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toMatch(/at most 29 scripts/);
      expect(registry.definitions()).toHaveLength(room);
   });

   it('refuses the script that would take all definitions, as listed, past the total budget', () => {
      const { registry } = make();
      /** @type {object} A schema whose listed definition is close to the definition budget. */
      const inputSchema = paddedSchema(790);
      /** @type {number} The listed size of each padded definition. */
      const each = definitionBytes('padded_script', 'd'.repeat(20), compileSchema(inputSchema).listed);
      expect(each).toBeGreaterThan(740);
      /** @type {number} How many fit beside the room kept for the sidecar built-ins. */
      const fits = Math.floor(
         (getBudget('ALL_DEFINITIONS_MAX_BYTES').value - getBudget('DEFINITION_MAX_BYTES').value) / each,
      );
      expect(fits).toBeLessThan(getBudget('ALWAYS_LISTED_TOOLS_MAX').value - 1);
      for (let index = 0; index < fits; index += 1) {
         const outcome = registry.register(
            script(`padded_script_${String(index).padStart(2, '0')}`, { description: 'd'.repeat(20), inputSchema }),
            noop,
         );
         expect(outcome.ok, `${index}: ${outcome.reason}`).toBe(true);
      }
      const outcome = registry.register(
         script(`padded_script_${fits}`, { description: 'd'.repeat(20), inputSchema }),
         noop,
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toMatch(/definitions/);
      expect(registry.definitions()).toHaveLength(fits);
   });

   it('refuses a definition that is within the budget as received but over it as listed', () => {
      const { registry, lines } = make();
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
      const base = definitionBytes('alpha', '', inputSchema);
      /** @type {string} A description that brings the received definition to 790 bytes. */
      const description = 'd'.repeat(790 - base);
      expect(definitionBytes('alpha', description, inputSchema)).toBe(790);
      const outcome = registry.register(script('alpha', { description, inputSchema }), noop);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toMatch(/listed definition is \d+ bytes, at most 800 bytes/);
      expect(lines).toHaveLength(1);
      expect(registry.definitions()).toEqual([]);
   });

   it('never throws for a hostile definition or a throwing log', () => {
      const registry = createScriptRegistry({
         log: () => {
            throw new Error('log failed');
         },
      });
      const hostile = {
         get name() {
            throw new Error('boom');
         },
      };
      expect(() => registry.register(hostile, noop)).not.toThrow();
      expect(registry.register(hostile, noop).ok).toBe(false);
      expect(() => registry.register(undefined, undefined)).not.toThrow();
      expect(() => registry.register(script('alpha', { inputSchema: { toJSON: 1 } }), noop)).not.toThrow();
      expect(registry.definitions()).toEqual([]);
   });

   it('cleans the name in a log line so a name cannot forge a line', () => {
      const { registry, lines } = make();
      registry.register(script('bad\nname'), noop);
      registry.register(script(`bad${String.fromCharCode(0x2028)}name${String.fromCharCode(0x85)}x`), noop);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
         expect(line).not.toMatch(CONTROL_PATTERN);
      }
   });

   it('bounds the log line even for an enormous name', () => {
      const { registry, lines } = make();
      registry.register(script('x'.repeat(100_000)), noop);
      expect(new TextEncoder().encode(lines[0]).length).toBeLessThan(512);
   });
});

describe('script registry: change notification', () => {
   it('notifies subscribers once per accepted script and never for a refusal', () => {
      const { registry } = make();
      const listener = vi.fn();
      registry.subscribe(listener);
      registry.register(script('alpha'), noop);
      expect(listener).toHaveBeenCalledTimes(1);
      registry.register(script('alpha'), noop);
      registry.register(script('bad name'), noop);
      registry.register(script('beta'), 'not a function');
      expect(listener).toHaveBeenCalledTimes(1);
      registry.register(script('gamma'), noop);
      expect(listener).toHaveBeenCalledTimes(2);
   });

   it('stops notifying a subscriber after its unsubscribe', () => {
      const { registry } = make();
      const listener = vi.fn();
      const unsubscribe = registry.subscribe(listener);
      unsubscribe();
      registry.register(script('alpha'), noop);
      expect(listener).not.toHaveBeenCalled();
   });

   it('keeps notifying the others when one subscriber throws, and still accepts the script', () => {
      const { registry, lines } = make();
      const after = vi.fn();
      registry.subscribe(() => {
         throw new Error('listener failed');
      });
      registry.subscribe(after);
      expect(registry.register(script('alpha'), noop).ok).toBe(true);
      expect(after).toHaveBeenCalledTimes(1);
      expect(lines.some((line) => line.includes('listener failed'))).toBe(true);
   });

   it('registers through the module-level registerScript on the shared registry', () => {
      const name = `shared_${Date.now()}`;
      const listener = vi.fn();
      const unsubscribe = scriptRegistry.subscribe(listener);
      try {
         expect(registerScript(script(name), noop).ok).toBe(true);
         expect(listener).toHaveBeenCalledTimes(1);
         expect(scriptRegistry.get(name)).toBeDefined();
      } finally {
         unsubscribe();
      }
   });
});

describe('ScriptError', () => {
   it('carries a code and a message', () => {
      const error = new ScriptError('SOME_CODE', 'something happened');
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('SOME_CODE');
      expect(error.message).toBe('something happened');
   });
});

/**
 * Build a valid argument schema so that `{name, description, inputSchema}` of a script named `padded_script` with a
 * 20-character description serializes to as close to, and never over, the given size.
 * @param {number} targetBytes - The wanted definition size in bytes.
 * @returns {object} The schema: string properties whose descriptions carry the padding.
 */
function bigSchema(targetBytes) {
   /** @type {object} The schema under construction. */
   const schema = {
      type: 'object',
      properties: {},
   };
   for (let index = 0; index < 64; index += 1) {
      /** @type {number} The longest description of the next property that keeps the definition within the target. */
      let fit = 0;
      for (let length = 1; length <= 240; length += 1) {
         const trial = structuredClone(schema);
         trial.properties[`p${index}`] = {
            type: 'string',
            description: 'd'.repeat(length),
         };
         if (definitionBytes('padded_script', 'd'.repeat(20), trial) <= targetBytes) {
            fit = length;
         }
      }
      if (fit === 0) {
         break;
      }
      schema.properties[`p${index}`] = {
         type: 'string',
         description: 'd'.repeat(fit),
      };
   }
   return schema;
}
