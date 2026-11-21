import { describe, it, expect, afterEach } from 'vitest';
import { registerBridgeSettings } from '~/settings/bridgeSettings.js';
import { isBridgeSettingKey, readBridgeSettings } from '~/bridge/bridgeSettings.js';
import { defaultBridgeSettings } from '$shared/bridgeSettings.js';

afterEach(() => {
   delete globalThis.game;
});

describe('bridge settings on the client', () => {
   it('registers backupFolder as a world-scope restricted config String setting defaulting to empty', () => {
      /** @type {Map<string, object>} Registered setting configs keyed by `<module>.<key>`. */
      const registered = new Map();
      globalThis.game = {
         settings: {
            register: (module, key, config) => {
               registered.set(`${module}.${key}`, config);
            },
         },
      };
      registerBridgeSettings();
      expect([...registered.keys()]).toEqual(['wiretap.backupFolder']);
      expect(registered.get('wiretap.backupFolder')).toEqual({
         name: 'WIRETAP.Settings.BackupFolder.Name',
         hint: 'WIRETAP.Settings.BackupFolder.Hint',
         scope: 'world',
         restricted: true,
         config: true,
         type: String,
         default: '',
      });
   });

   it('reads the sanitized backupFolder, and the defaults when the read throws', () => {
      /** @type {unknown} The stored value the fake settings return. */
      let stored = 'C:\\backups';
      globalThis.game = {
         settings: {
            get: (module, key) => (module === 'wiretap' && key === 'backupFolder' ? stored : undefined),
         },
      };
      expect(readBridgeSettings()).toEqual({ backupFolder: 'C:\\backups' });
      stored = 'C:\\bad\nfolder';
      expect(readBridgeSettings()).toEqual(defaultBridgeSettings());
      stored = 42;
      expect(readBridgeSettings()).toEqual(defaultBridgeSettings());
      globalThis.game.settings.get = () => {
         throw new Error('not registered');
      };
      expect(readBridgeSettings()).toEqual(defaultBridgeSettings());
   });

   it('recognises only wiretap.backupFolder as a bridge setting key', () => {
      expect(isBridgeSettingKey('wiretap.backupFolder')).toBe(true);
      for (const key of [
         'wiretap.allowDelete',
         'wiretap.allowBackupAnyFolder',
         'wiretap.terminalTheme',
         'core.backupFolder',
         'backupFolder',
         'wiretap.',
         undefined,
         null,
         5,
      ]) {
         expect(isBridgeSettingKey(key), String(key)).toBe(false);
      }
   });
});
