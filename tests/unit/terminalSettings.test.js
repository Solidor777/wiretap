import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerTerminalSettings } from '~/settings/terminalSettings.js';
import { connection } from '~/bridge/TerminalConnection.svelte.js';
import { TERMINAL_SCROLLBACK_DEFAULT } from '$shared/protocol.js';
import lang from '../../lang/en.json';

describe('registerTerminalSettings', () => {
   /** @type {Map<string, object>} Registered setting configs keyed by setting key. */
   let registered;
   /** @type {Map<string, unknown>} Stored setting values keyed by setting key. */
   let stored;

   beforeEach(() => {
      registered = new Map();
      stored = new Map();
      globalThis.game = {
         i18n: globalThis.game.i18n,
         settings: {
            register: (module, key, config) => {
               registered.set(key, config);
            },
            get: (module, key) => (stored.has(key) ? stored.get(key) : registered.get(key).default),
         },
      };
   });

   it('registers the scrollback as a GM-only world Number setting defaulting to 64 KB (65,536 characters)', () => {
      registerTerminalSettings();
      const config = registered.get('terminalScrollback');
      expect(config.scope).toBe('world');
      expect(config.restricted).toBe(true);
      expect(config.config).toBe(true);
      expect(config.type).toBe(Number);
      expect(config.default).toBe(TERMINAL_SCROLLBACK_DEFAULT);
      expect(TERMINAL_SCROLLBACK_DEFAULT).toBe(65_536);
   });

   it('has a non-empty Name and Hint in lang/en.json under the keys the setting names', () => {
      registerTerminalSettings();
      const config = registered.get('terminalScrollback');
      expect(config.name).toBe('WIRETAP.Settings.TerminalScrollback.Name');
      expect(config.hint).toBe('WIRETAP.Settings.TerminalScrollback.Hint');
      expect(lang.WIRETAP.Settings.TerminalScrollback.Name).toMatch(/characters/);
      expect(lang.WIRETAP.Settings.TerminalScrollback.Hint.length).toBeGreaterThan(0);
   });

   it('seeds the connection from the stored value and applies every change', () => {
      const spy = vi.spyOn(connection, 'setScrollback');
      stored.set('terminalScrollback', 2000);
      registerTerminalSettings();
      expect(spy).toHaveBeenLastCalledWith(2000);
      registered.get('terminalScrollback').onChange(500);
      expect(spy).toHaveBeenLastCalledWith(500);
      spy.mockRestore();
   });
});
