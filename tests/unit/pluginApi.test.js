import { describe, it, expect, beforeEach } from 'vitest';
import { SCRIPT_API_VERSION } from '$shared/scripts.js';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';
import { createPluginApi } from '~/bridge/pluginApi.js';

/** @type {string[]} The registry's log lines. */
let lines;

/** @type {Set<string>} The ids of the modules active in the test world. */
let active;

/** @type {ReturnType<typeof createScriptRegistry>} The registry the API registers on. */
let registry;

/** @type {ReturnType<typeof createPluginApi>} The API under test. */
let api;

/**
 * Build a valid plugin tool input with the given fields replaced.
 * @param {Record<string, unknown>} [overrides] - The fields to set or replace.
 * @returns {Record<string, unknown>} A fresh input.
 */
function tool(overrides = {}) {
   return {
      moduleId: 'my-mod',
      name: 'echo',
      version: '1.0.0',
      description: 'Echo a text.',
      inputSchema: {
         type: 'object',
         properties: {
            text: {
               type: 'string',
            },
         },
      },
      handler: () => null,
      mutates: false,
      requires: 'api',
      ...overrides,
   };
}

beforeEach(() => {
   lines = [];
   active = new Set([
      'my-mod',
      'foo',
      'foo__bar',
   ]);
   registry = createScriptRegistry({ log: (line) => lines.push(line) });
   api = createPluginApi({
      registry,
      isModuleActive: (id) => active.has(id),
   });
});

describe('plugin API', () => {
   it('exposes the script API version on a frozen object', () => {
      expect(api.apiVersion).toBe(SCRIPT_API_VERSION);
      expect(api.apiVersion).toBe(1);
      expect(Object.isFrozen(api)).toBe(true);
   });

   it('registers <moduleId>__<name> as a plugin script and fills the 2000-byte result default', () => {
      expect(api.registerTool(tool())).toEqual({
         ok: true,
         name: 'my-mod__echo',
      });
      const { definition } = registry.get('my-mod__echo');
      expect(definition.result).toEqual({ budgetBytes: 2000 });
      expect(definition.moduleId).toBe('my-mod');
   });

   it('keeps a declared result budget and passes the optional fields through', () => {
      api.registerTool(
         tool({
            result: { budgetBytes: 500 },
            gate: 'allowDelete',
            strictNested: true,
            requiresUserInteraction: true,
            handleArgs: ['text'],
         }),
      );
      expect(registry.get('my-mod__echo').definition).toMatchObject({
         result: { budgetBytes: 500 },
         gate: 'allowDelete',
         strictNested: true,
         requiresUserInteraction: true,
         handleArgs: ['text'],
      });
   });

   it('refuses a module that is not active in this world', () => {
      expect(api.registerTool(tool({ moduleId: 'sleeper' }))).toEqual({
         ok: false,
         reason: 'moduleId "sleeper" is not an active module in this world: pass your own module\'s id and enable ' +
            'the module',
      });
      expect(lines.join('\n')).toContain('sleeper');
   });

   it('refuses a malformed module id with the validator\'s message', () => {
      expect(api.registerTool(tool({ moduleId: 'My.Mod' })).reason).toBe(
         'moduleId must be your module\'s id from module.json: 1 to 64 characters of a-z, 0-9, _ or - (no dots or ' +
            'capitals), starting with a letter or digit',
      );
   });

   it('refuses a built name two modules collide on, keeping the first module\'s gate', () => {
      expect(api.registerTool(tool({
         moduleId: 'foo',
         name: 'bar__baz',
      })).ok).toBe(true);
      expect(api.registerTool(tool({
         moduleId: 'foo__bar',
         name: 'baz',
      }))).toEqual({
         ok: false,
         reason: 'name "foo__bar__baz" is already registered: choose another tool name',
      });
      expect(registry.get('foo__bar__baz').definition.moduleId).toBe('foo');
   });

   it('never throws', () => {
      expect(api.registerTool(null)).toEqual({
         ok: false,
         reason: 'registerTool takes one object: { moduleId, name, version, description, inputSchema, handler, ' +
            'mutates, requires }',
      });
      const hostile = {
         get moduleId() {
            throw new Error('boom');
         },
      };
      expect(api.registerTool(hostile)).toEqual({
         ok: false,
         reason: 'the registration could not be processed',
      });
   });

   it('refuses a tool that leaves out requires or mutates', () => {
      expect(api.registerTool(tool({ mutates: undefined })).reason).toContain('mutates');
      expect(api.registerTool(tool({ requires: undefined })).reason).toContain('requires');
   });
});
