import { describe, it, expect, beforeEach } from 'vitest';
import { GATES, closedGateState, GATE_MODULES_MAX } from '$shared/gates.js';
import { GATE_DENIED } from '$shared/protocol.js';
import { readGateState, requireGate, gateNameFromSettingKey } from '~/bridge/gates.js';

/** @type {Record<string, unknown>} Stored world setting values keyed by gate name; a missing key reads undefined. */
let stored;

/** @type {number} Number of `game.settings.get` calls, to prove each check reads the settings. */
let reads;

beforeEach(() => {
   stored = {};
   reads = 0;
   globalThis.game = {
      settings: {
         get: (module, key) => {
            reads += 1;
            expect(module).toBe('wiretap');
            if (stored[key] instanceof Error) {
               throw stored[key];
            }
            return stored[key];
         },
      },
   };
});

describe('readGateState', () => {
   it('returns the all-closed snapshot when every gate holds its default', () => {
      for (const [name, gate] of Object.entries(GATES)) {
         stored[name] = gate.type === 'boolean' ? false : '';
      }
      expect(readGateState()).toEqual(closedGateState());
   });

   it('reads every registry gate, opening only the gates that hold true', () => {
      stored.allowUserWrites = true;
      stored.allowedPluginModules = 'mod-a, mod-b';
      const state = readGateState();
      expect(state.allowUserWrites).toBe(true);
      expect(state.allowMacroExecution).toBe(false);
      expect(state.allowedPluginModules).toEqual([
         'mod-a',
         'mod-b',
      ]);
   });

   it('closes a boolean gate whose stored value is not the boolean true', () => {
      for (const hostile of [
         'true',
         1,
         'yes',
         {},
         [],
         null,
         undefined,
      ]) {
         stored.allowMacroExecution = hostile;
         expect(readGateState().allowMacroExecution, String(hostile)).toBe(false);
      }
   });

   it('drops invalid, oversized, padded and duplicate module ids from the stored string', () => {
      stored.allowedPluginModules = ` good-mod ,Bad Mod,../x,,good-mod,UPPER,ok_2,${'a'.repeat(65)}`;
      expect(readGateState().allowedPluginModules).toEqual([
         'good-mod',
         'ok_2',
      ]);
   });

   it('treats a non-string module list and a list over the entry limit as empty', () => {
      stored.allowedPluginModules = { toString: () => 'evil' };
      expect(readGateState().allowedPluginModules).toEqual([]);
      stored.allowedPluginModules = Array.from({ length: GATE_MODULES_MAX + 1 }, (_, i) => `m${i}`).join(',');
      expect(readGateState().allowedPluginModules).toEqual([]);
   });

   it('closes a gate whose read throws and keeps reading the others', () => {
      stored.allowMacroExecution = new Error('not registered');
      stored.allowUserWrites = true;
      const state = readGateState();
      expect(state.allowMacroExecution).toBe(false);
      expect(state.allowUserWrites).toBe(true);
   });

   it('returns a fresh object on every call', () => {
      expect(readGateState()).not.toBe(readGateState());
   });
});

describe('requireGate', () => {
   it('returns null for an open gate, reading the settings at call time', () => {
      stored.allowFileUpload = true;
      expect(requireGate('allowFileUpload')).toBeNull();
      stored.allowFileUpload = false;
      expect(requireGate('allowFileUpload')).not.toBeNull();
      expect(reads).toBeGreaterThan(0);
   });

   it('returns a GATE_DENIED denial of at most 256 bytes that names the gate and says only a GM can enable it', () => {
      const denial = requireGate('allowMacroExecution');
      expect(denial.code).toBe(GATE_DENIED);
      expect(denial.message).toContain('allowMacroExecution');
      expect(denial.message).toMatch(/only a GM/);
      expect(new TextEncoder().encode(denial.message).length).toBeLessThanOrEqual(256);
   });

   it('opens the plugin gate only for a listed module id', () => {
      stored.allowedPluginModules = 'mod-a';
      expect(requireGate('allowedPluginModules', 'mod-a')).toBeNull();
      expect(requireGate('allowedPluginModules', 'mod-b')).not.toBeNull();
      expect(requireGate('allowedPluginModules')).not.toBeNull();
   });

   it('denies an unknown gate name', () => {
      expect(requireGate('allowEverything').code).toBe(GATE_DENIED);
      expect(requireGate('constructor').code).toBe(GATE_DENIED);
   });
});

describe('gateNameFromSettingKey', () => {
   it('returns the gate name for a wiretap gate setting key', () => {
      expect(gateNameFromSettingKey('wiretap.allowMacroExecution')).toBe('allowMacroExecution');
      expect(gateNameFromSettingKey('wiretap.allowedPluginModules')).toBe('allowedPluginModules');
   });

   it('returns null for other wiretap keys, other namespaces, inherited names and non-strings', () => {
      const keys = [
         'wiretap.terminalTheme',
         'core.allowMacroExecution',
         'wiretap.constructor',
         'wiretap.',
         '',
         null,
         5,
      ];
      for (const key of keys) {
         expect(gateNameFromSettingKey(key), String(key)).toBeNull();
      }
   });
});
