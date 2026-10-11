import { describe, it, expect, beforeEach } from 'vitest';
import { GATES } from '$shared/gates.js';
import { registerGateSettings, gateLangKey } from '~/settings/gates.js';
import lang from '../../lang/en.json';

/**
 * Resolve a dotted localization key against the nested en.json object.
 * @param {string} key - The dotted key, for example `WIRETAP.Settings.Gates.AllowUserWrites.Name`.
 * @returns {unknown} The value at the key, or undefined when any segment is missing.
 */
function resolveLang(key) {
   return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), lang);
}

/** @type {Map<string, object>} Registered setting configs keyed by `<module>.<key>`. */
let registered;

beforeEach(() => {
   registered = new Map();
   globalThis.game = {
      settings: {
         register: (module, key, config) => {
            registered.set(`${module}.${key}`, config);
         },
      },
   };
});

describe('gate settings registration', () => {
   it('registers exactly one wiretap setting per GATES entry, iterating the table', () => {
      registerGateSettings();
      expect([...registered.keys()].sort()).toEqual(Object.keys(GATES).map((name) => `wiretap.${name}`).sort());
   });

   it.each(Object.entries(GATES))('registers %s as a world-scope restricted config setting', (name, gate) => {
      registerGateSettings();
      const config = registered.get(`wiretap.${name}`);
      expect(config.scope).toBe('world');
      expect(config.restricted).toBe(true);
      expect(config.config).toBe(true);
      expect(config.type).toBe(gate.type === 'boolean' ? Boolean : String);
   });

   it.each(Object.entries(GATES))('defaults %s closed', (name, gate) => {
      registerGateSettings();
      const config = registered.get(`wiretap.${name}`);
      expect(config.default).toBe(gate.type === 'boolean' ? false : '');
   });

   it('uses the derived localization keys for name and hint', () => {
      registerGateSettings();
      for (const name of Object.keys(GATES)) {
         const config = registered.get(`wiretap.${name}`);
         expect(config.name).toBe(gateLangKey(name, 'Name'));
         expect(config.hint).toBe(gateLangKey(name, 'Hint'));
      }
   });
});

describe('gate localization', () => {
   it.each(Object.keys(GATES))('has a non-empty Name and Hint for %s in lang/en.json', (name) => {
      for (const part of [
         'Name',
         'Hint',
      ]) {
         const text = resolveLang(gateLangKey(name, part));
         expect(typeof text, `${gateLangKey(name, part)} must exist`).toBe('string');
         expect(text.length).toBeGreaterThan(0);
      }
   });

   it.each([
      'allowMacroExecution',
      'allowAgentScripts',
      'allowedPluginModules',
   ])(
      'states the arbitrary-code caveat in the hint of %s',
      (name) => {
         const hint = resolveLang(gateLangKey(name, 'Hint'));
         expect(hint).toMatch(/arbitrary code/i);
         expect(hint).toMatch(/game\.settings\.set/);
      },
   );

   it('holds no localization entry for a gate that is not in GATES', () => {
      const gateLang = resolveLang('WIRETAP.Settings.Gates');
      const known = new Set(Object.keys(GATES).map((name) => gateLangKey(name, 'Name').split('.')[3]));
      expect(Object.keys(gateLang).filter((key) => !known.has(key))).toEqual([]);
   });
});
