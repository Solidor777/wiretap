// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
   BACKUP_FOLDER_MAX_BYTES,
   BRIDGE_SETTING_KEYS,
   defaultBridgeSettings,
   sanitizeBridgeSettings,
} from '../../shared/bridgeSettings.js';

describe('bridge settings', () => {
   it('defaults backupFolder to the empty string, a fresh object each call', () => {
      expect(defaultBridgeSettings()).toEqual({ backupFolder: '' });
      expect(defaultBridgeSettings()).not.toBe(defaultBridgeSettings());
      expect(BRIDGE_SETTING_KEYS).toEqual(['backupFolder']);
      expect(Object.isFrozen(BRIDGE_SETTING_KEYS)).toBe(true);
   });

   it('keeps a folder of exactly 1024 bytes and refuses 1025 bytes, a control character and a non-string', () => {
      expect(BACKUP_FOLDER_MAX_BYTES).toBe(1024);
      /** @type {string} A folder path of exactly 1024 UTF-8 bytes (a two-byte character, then ASCII). */
      const longest = `C:\\é${'a'.repeat(1019)}`;
      expect(Buffer.byteLength(longest)).toBe(1024);
      expect(sanitizeBridgeSettings({ backupFolder: longest })).toEqual({ backupFolder: longest });
      expect(sanitizeBridgeSettings({ backupFolder: `${longest}a` })).toEqual({ backupFolder: '' });
      expect(sanitizeBridgeSettings({ backupFolder: 'C:\\backups\nx' })).toEqual({ backupFolder: '' });
      expect(sanitizeBridgeSettings({ backupFolder: 5 })).toEqual({ backupFolder: '' });
      expect(sanitizeBridgeSettings('C:\\backups')).toEqual({ backupFolder: '' });
      expect(sanitizeBridgeSettings(null)).toEqual({ backupFolder: '' });
   });

   it('ignores inherited and unknown keys and never throws on a throwing getter', () => {
      /** @type {object} An input whose folder is inherited, not its own. */
      const inherited = Object.create({ backupFolder: 'C:\\inherited' });
      expect(sanitizeBridgeSettings(inherited)).toEqual({ backupFolder: '' });
      /** @type {Record<string, unknown>} The sanitized result of an input with an unknown key. */
      const sanitized = sanitizeBridgeSettings({
         backupFolder: 'C:\\backups',
         other: 'x',
      });
      expect(sanitized).toEqual({ backupFolder: 'C:\\backups' });
      /** @type {object} An input whose folder getter throws. */
      const throwing = {
         get backupFolder() {
            throw new Error('boom');
         },
      };
      expect(sanitizeBridgeSettings(throwing)).toEqual({ backupFolder: '' });
      /** @type {object} A proxy whose every trap throws. */
      const hostile = new Proxy({}, {
         getOwnPropertyDescriptor() {
            throw new Error('boom');
         },
         get() {
            throw new Error('boom');
         },
      });
      expect(sanitizeBridgeSettings(hostile)).toEqual({ backupFolder: '' });
   });
});
