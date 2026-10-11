import { describe, it, expect } from 'vitest';
import {
   GATES,
   GATE_MODULES_MAX,
   GATE_MODULE_ID_MAX_CHARS,
   closedGateState,
   denyWiretapSettingWrite,
   gateDenial,
   isGateOpen,
   isModuleAllowed,
   isWiretapSettingKey,
   resolveSettingKey,
   sanitizeGateState,
} from '../../shared/gates.js';
import { GATE_DENIED } from '../../shared/protocol.js';

/** @type {string[]} The boolean gate names the registry must hold. */
const BOOLEAN_GATES = [
   'allowMacroExecution',
   'allowUserWrites',
   'allowSettingWrites',
   'allowFileUpload',
   'allowOwnershipWrites',
   'allowCompendiumWrites',
   'allowModuleConfigWrites',
   'allowAgentScripts',
];

describe('GATES registry', () => {
   it('holds exactly the eight boolean gates and the plugin module list', () => {
      expect(Object.keys(GATES).sort()).toEqual([...BOOLEAN_GATES, 'allowedPluginModules'].sort());
   });

   it('defaults every boolean gate to false and the module list to empty', () => {
      for (const name of BOOLEAN_GATES) {
         expect(GATES[name].type).toBe('boolean');
         expect(GATES[name].default).toBe(false);
      }
      expect(GATES.allowedPluginModules.type).toBe('moduleList');
      expect(GATES.allowedPluginModules.default).toEqual([]);
   });

   it('gives every entry a one-line unlocks description', () => {
      for (const entry of Object.values(GATES)) {
         expect(typeof entry.unlocks).toBe('string');
         expect(entry.unlocks.length).toBeGreaterThan(0);
         expect(entry.unlocks).not.toMatch(/\n/);
      }
   });

   it('is frozen at every level', () => {
      expect(Object.isFrozen(GATES)).toBe(true);
      for (const entry of Object.values(GATES)) {
         expect(Object.isFrozen(entry)).toBe(true);
      }
      expect(Object.isFrozen(GATES.allowedPluginModules.default)).toBe(true);
   });

   it('has no gate for delete or undo', () => {
      expect(GATES).not.toHaveProperty('allowDelete');
      expect(GATES).not.toHaveProperty('allowUndo');
   });
});

describe('closedGateState', () => {
   it('returns every gate at its default as a fresh object each call', () => {
      const first = closedGateState();
      expect(first).toEqual({
         allowMacroExecution: false,
         allowUserWrites: false,
         allowSettingWrites: false,
         allowFileUpload: false,
         allowOwnershipWrites: false,
         allowCompendiumWrites: false,
         allowModuleConfigWrites: false,
         allowAgentScripts: false,
         allowedPluginModules: [],
      });
      first.allowMacroExecution = true;
      first.allowedPluginModules.push('x');
      expect(closedGateState().allowMacroExecution).toBe(false);
      expect(closedGateState().allowedPluginModules).toEqual([]);
   });
});

describe('gateDenial and isGateOpen', () => {
   it('returns null for an open boolean gate', () => {
      const state = { ...closedGateState(), allowMacroExecution: true };
      expect(gateDenial(state, 'allowMacroExecution')).toBeNull();
      expect(isGateOpen(state, 'allowMacroExecution')).toBe(true);
   });

   it('denies a closed boolean gate with GATE_DENIED naming the gate and the GM-only rule', () => {
      const denial = gateDenial(closedGateState(), 'allowUserWrites');
      expect(denial.code).toBe(GATE_DENIED);
      expect(denial.message).toContain('allowUserWrites');
      expect(denial.message).toMatch(/only a GM/i);
      expect(denial.message).toMatch(/Wiretap module settings/);
      expect(isGateOpen(closedGateState(), 'allowUserWrites')).toBe(false);
   });

   it('keeps every denial message within 256 bytes', () => {
      for (const name of Object.keys(GATES)) {
         expect(Buffer.byteLength(gateDenial(closedGateState(), name).message, 'utf8')).toBeLessThanOrEqual(256);
      }
      expect(Buffer.byteLength(gateDenial(closedGateState(), 'x'.repeat(10_000)).message, 'utf8')).toBeLessThanOrEqual(
         256,
      );
   });

   it('denies when a boolean gate holds anything but true', () => {
      for (const value of [1, 'true', {}, [], null, undefined, 0, false]) {
         expect(gateDenial({ allowFileUpload: value }, 'allowFileUpload')).not.toBeNull();
      }
   });

   it('denies an unknown gate name, including inherited and non-string names', () => {
      const state = { ...closedGateState(), toString: true, constructor: true };
      for (const name of ['nope', 'toString', 'constructor', '__proto__', '', undefined, null, 5, {}]) {
         const denial = gateDenial(state, name);
         expect(denial?.code).toBe(GATE_DENIED);
         expect(denial.message).toMatch(/only a GM/i);
      }
   });

   it('denies when the state is missing or not an object', () => {
      for (const state of [undefined, null, 'open', 5, true]) {
         expect(gateDenial(state, 'allowMacroExecution')?.code).toBe(GATE_DENIED);
      }
   });

   it('reads only own properties of the state', () => {
      const inherited = Object.create({ allowMacroExecution: true });
      expect(gateDenial(inherited, 'allowMacroExecution')).not.toBeNull();
   });

   it('denies the plugin module gate without a module id, even when modules are listed', () => {
      const state = { ...closedGateState(), allowedPluginModules: ['my-module'] };
      expect(gateDenial(state, 'allowedPluginModules')?.code).toBe(GATE_DENIED);
      expect(isGateOpen(state, 'allowedPluginModules')).toBe(false);
   });

   it('opens the plugin module gate only for a listed module id', () => {
      const state = { ...closedGateState(), allowedPluginModules: ['my-module', 'other'] };
      expect(gateDenial(state, 'allowedPluginModules', 'my-module')).toBeNull();
      expect(isGateOpen(state, 'allowedPluginModules', 'other')).toBe(true);
      expect(isModuleAllowed(state, 'my-module')).toBe(true);
      expect(isModuleAllowed(state, 'unlisted')).toBe(false);
      const denial = gateDenial(state, 'allowedPluginModules', 'unlisted');
      expect(denial.code).toBe(GATE_DENIED);
      expect(denial.message).toContain('allowedPluginModules');
      expect(denial.message).toMatch(/only a GM/i);
      expect(Buffer.byteLength(denial.message, 'utf8')).toBeLessThanOrEqual(256);
   });

   it('denies a non-string module id, and ignores a module id given for a boolean gate', () => {
      const state = { ...closedGateState(), allowedPluginModules: ['my-module'], allowMacroExecution: true };
      for (const id of [undefined, null, 5, {}, ['my-module'], '']) {
         expect(isModuleAllowed(state, id)).toBe(false);
      }
      expect(gateDenial(state, 'allowMacroExecution', 'anything')).toBeNull();
   });

   it('sanitizes the state internally, so an unsanitized module list is never open', () => {
      for (const list of [['', 5], [5], Array.from({ length: 100 }, () => 'a'), ['Bad Id'], 'my-module', {}]) {
         const state = { ...closedGateState(), allowedPluginModules: list };
         expect(isModuleAllowed(state, 'a')).toBe(false);
         expect(isModuleAllowed(state, '')).toBe(false);
         expect(isGateOpen(state, 'allowedPluginModules', 5)).toBe(false);
      }
      expect(isModuleAllowed({ allowedPluginModules: ['a', 5] }, 'a')).toBe(true);
   });

   it('denies without throwing when reading the state throws', () => {
      const hostile = new Proxy(
         {},
         {
            getOwnPropertyDescriptor() {
               throw new Error('trap');
            },
         },
      );
      expect(gateDenial(hostile, 'allowMacroExecution')?.code).toBe(GATE_DENIED);
   });
});

describe('sanitizeGateState', () => {
   it('returns the closed state for missing or non-object input', () => {
      for (const input of [undefined, null, 'x', 5, true, []]) {
         expect(sanitizeGateState(input)).toEqual(closedGateState());
      }
   });

   it('keeps boolean gates that are exactly true or false', () => {
      const result = sanitizeGateState({ allowMacroExecution: true, allowUserWrites: false });
      expect(result.allowMacroExecution).toBe(true);
      expect(result.allowUserWrites).toBe(false);
   });

   it('closes a boolean gate that has the wrong type', () => {
      const result = sanitizeGateState({ allowMacroExecution: 'true', allowFileUpload: 1, allowAgentScripts: {} });
      expect(result.allowMacroExecution).toBe(false);
      expect(result.allowFileUpload).toBe(false);
      expect(result.allowAgentScripts).toBe(false);
   });

   it('drops unknown keys and returns only the registry keys', () => {
      const result = sanitizeGateState({ allowMacroExecution: true, allowDelete: true, extra: { a: 1 } });
      expect(Object.keys(result).sort()).toEqual(Object.keys(GATES).sort());
   });

   it('does not let __proto__ or inherited values through', () => {
      const hostile = JSON.parse('{"__proto__":{"allowMacroExecution":true},"allowMacroExecution":false}');
      const result = sanitizeGateState(hostile);
      expect(result.allowMacroExecution).toBe(false);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect({}.allowMacroExecution).toBeUndefined();
      expect(sanitizeGateState(Object.create({ allowMacroExecution: true })).allowMacroExecution).toBe(false);
   });

   it('keeps a valid module id list and drops invalid entries', () => {
      const result = sanitizeGateState({
         allowedPluginModules: ['good-module', 5, '', null, 'x'.repeat(GATE_MODULE_ID_MAX_CHARS + 1), 'ok_2', {}],
      });
      expect(result.allowedPluginModules).toEqual(['good-module', 'ok_2']);
   });

   it('keeps an id of exactly the maximum length and a list of exactly the maximum size', () => {
      const id = 'x'.repeat(GATE_MODULE_ID_MAX_CHARS);
      expect(sanitizeGateState({ allowedPluginModules: [id] }).allowedPluginModules).toEqual([id]);
      const full = Array.from({ length: GATE_MODULES_MAX }, (_, index) => `m${index}`);
      expect(sanitizeGateState({ allowedPluginModules: full }).allowedPluginModules).toEqual(full);
   });

   it('keeps only ids of lowercase letters, digits, underscore and hyphen that start with a letter or digit', () => {
      const result = sanitizeGateState({
         allowedPluginModules: ['a', '9x', 'a_b-c', 'Upper', '-lead', '_lead', 'has space', 'dot.ted', '\u00E9'],
      });
      expect(result.allowedPluginModules).toEqual(['a', '9x', 'a_b-c']);
   });

   it('removes duplicate module ids and keeps the first occurrence order', () => {
      expect(sanitizeGateState({ allowedPluginModules: ['b', 'a', 'b', 'a', 'c'] }).allowedPluginModules).toEqual([
         'b',
         'a',
         'c',
      ]);
   });

   it('treats a list over the maximum size as empty', () => {
      const hundred = Array.from({ length: 100 }, () => 'a');
      expect(sanitizeGateState({ allowedPluginModules: hundred }).allowedPluginModules).toEqual([]);
      const huge = Array.from({ length: GATE_MODULES_MAX + 1 }, (_, index) => `m${index}`);
      expect(sanitizeGateState({ allowedPluginModules: huge }).allowedPluginModules).toEqual([]);
      expect(sanitizeGateState({ allowedPluginModules: new Array(5_000_000).fill('a') }).allowedPluginModules).toEqual(
         [],
      );
   });

   it('treats a non-array module list as empty', () => {
      for (const value of ['mod', 5, {}, null, { length: 1, 0: 'mod' }]) {
         expect(sanitizeGateState({ allowedPluginModules: value }).allowedPluginModules).toEqual([]);
      }
   });

   it('returns the closed state when reading the input throws', () => {
      const hostile = new Proxy(
         {},
         {
            getOwnPropertyDescriptor() {
               throw new Error('trap');
            },
         },
      );
      expect(sanitizeGateState(hostile)).toEqual(closedGateState());
      const getter = {
         get allowMacroExecution() {
            throw new Error('boom');
         },
      };
      expect(sanitizeGateState(getter)).toEqual(closedGateState());
   });

   it('returns a fresh object whose list is not shared with the input', () => {
      const input = { allowedPluginModules: ['a'] };
      const result = sanitizeGateState(input);
      result.allowedPluginModules.push('b');
      expect(input.allowedPluginModules).toEqual(['a']);
   });
});

describe('isWiretapSettingKey', () => {
   it('matches the module namespace in every case', () => {
      for (const key of ['wiretap.allowMacroExecution', 'WIRETAP.x', 'WireTap.endpointKind', 'wiretap.a.b']) {
         expect(isWiretapSettingKey(key)).toBe(true);
      }
   });

   it('matches the bare namespace', () => {
      expect(isWiretapSettingKey('wiretap')).toBe(true);
      expect(isWiretapSettingKey('WIRETAP')).toBe(true);
   });

   it('matches through whitespace, control and zero-width characters', () => {
      for (const key of [
         '  wiretap.x',
         '\twiretap.x\n',
         'wiretap .x',
         'wiretap\u200B.x',
         'wire\u200Btap.x',
         '\uFEFFwiretap.x',
         'wiretap\u0000.x',
         '\u00A0wiretap.x',
         '\u2003wiretap.x',
      ]) {
         expect(isWiretapSettingKey(key)).toBe(true);
      }
   });

   it('matches through Unicode normalization forms', () => {
      for (const key of [
         'wiretap\u2024x',
         'wiretap\uFE52x',
         '\uFF57\uFF49\uFF52\uFF45\uFF54\uFF41\uFF50.x',
         'wiretap\uFF0Ex',
         '\u1D42iretap.x',
         '\uFF37\uFF29\uFF32\uFF25\uFF34\uFF21\uFF30.x',
      ]) {
         expect(isWiretapSettingKey(key)).toBe(true);
      }
   });

   it('does not match other namespaces or lookalike prefixes', () => {
      for (const key of ['core.rollMode', 'wiretapper.x', 'my-wiretap.x', 'wiretaps', 'xwiretap.y', '', '.wiretap']) {
         expect(isWiretapSettingKey(key)).toBe(false);
      }
   });

   it('does not match a non-string', () => {
      for (const key of [undefined, null, 5, {}, ['wiretap.x'], true]) {
         expect(isWiretapSettingKey(key)).toBe(false);
      }
   });
});

describe('denyWiretapSettingWrite', () => {
   it('returns null for a key outside the Wiretap namespace', () => {
      expect(denyWiretapSettingWrite('core.rollMode')).toBeNull();
      expect(denyWiretapSettingWrite({ key: 'dnd5e.metricWeightUnits', value: 1 })).toBeNull();
   });

   it('refuses a wiretap key given as a string with GATE_DENIED', () => {
      const denial = denyWiretapSettingWrite('wiretap.allowMacroExecution');
      expect(denial.code).toBe(GATE_DENIED);
      expect(denial.message).toMatch(/Wiretap settings/);
      expect(Buffer.byteLength(denial.message, 'utf8')).toBeLessThanOrEqual(256);
   });

   it('refuses a Setting document whose key is in the namespace', () => {
      expect(denyWiretapSettingWrite({ key: 'wiretap.allowUserWrites', value: true })?.code).toBe(GATE_DENIED);
      expect(denyWiretapSettingWrite({ key: ' WireTap.x ' })?.code).toBe(GATE_DENIED);
      expect(denyWiretapSettingWrite({ key: 'wiretap' })?.code).toBe(GATE_DENIED);
   });

   it('reads a key that is a getter on the document prototype', () => {
      class FakeSetting {
         get key() {
            return 'wiretap.allowFileUpload';
         }
      }
      expect(denyWiretapSettingWrite(new FakeSetting())?.code).toBe(GATE_DENIED);
   });

   it('refuses when the key cannot be read as a string (fail closed)', () => {
      for (const input of [undefined, null, 5, true, {}, { key: 5 }, { key: null }, [], ['wiretap.x']]) {
         expect(denyWiretapSettingWrite(input)?.code).toBe(GATE_DENIED);
      }
   });

   it('refuses a by-id update payload that carries no key', () => {
      expect(denyWiretapSettingWrite({ _id: 'abc123', value: 'x' })?.code).toBe(GATE_DENIED);
      expect(resolveSettingKey({ _id: 'abc123', value: 'x' })).toBeNull();
   });

   it('checks namespace and key as namespace.key', () => {
      expect(denyWiretapSettingWrite({ namespace: 'wiretap', key: 'allowMacroExecution' })?.code).toBe(GATE_DENIED);
      expect(denyWiretapSettingWrite({ namespace: ' WireTap ', key: 'x' })?.code).toBe(GATE_DENIED);
      expect(denyWiretapSettingWrite({ namespace: 'core', key: 'rollMode' })).toBeNull();
      expect(resolveSettingKey({ namespace: 'core', key: 'rollMode' })).toBe('core.rollMode');
      expect(denyWiretapSettingWrite({ namespace: 5, key: 'x' })?.code).toBe(GATE_DENIED);
      expect(denyWiretapSettingWrite({ namespace: 'core' })?.code).toBe(GATE_DENIED);
   });

   it('never throws: a throwing getter or a throwing Proxy is a denial', () => {
      const throwingGetter = {
         get key() {
            throw new Error('boom');
         },
      };
      const throwingProxy = new Proxy(
         {},
         {
            get() {
               throw new Error('trap');
            },
            getOwnPropertyDescriptor() {
               throw new Error('trap');
            },
         },
      );
      for (const input of [throwingGetter, throwingProxy]) {
         expect(() => denyWiretapSettingWrite(input)).not.toThrow();
         expect(denyWiretapSettingWrite(input)?.code).toBe(GATE_DENIED);
         expect(resolveSettingKey(input)).toBeNull();
      }
   });

   it('reads the key once, so a getter that changes between reads cannot split check from write', () => {
      let reads = 0;
      const shifting = {
         get key() {
            reads += 1;
            return reads === 1 ? 'core.rollMode' : 'wiretap.allowMacroExecution';
         },
      };
      expect(resolveSettingKey(shifting)).toBe('core.rollMode');
      expect(reads).toBe(1);
      reads = 0;
      expect(denyWiretapSettingWrite(shifting)).toBeNull();
      expect(reads).toBe(1);
   });
});

describe('resolveSettingKey', () => {
   it('returns a string key unchanged and a document key as the string that was read', () => {
      expect(resolveSettingKey('core.rollMode')).toBe('core.rollMode');
      expect(resolveSettingKey({ key: 'dnd5e.x' })).toBe('dnd5e.x');
   });

   it('returns null for anything that has no string key', () => {
      for (const input of [undefined, null, 5, true, {}, { key: 5 }, [], ['a']]) {
         expect(resolveSettingKey(input)).toBeNull();
      }
   });
});
