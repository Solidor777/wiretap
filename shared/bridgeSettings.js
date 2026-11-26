/**
 * The bridge settings a GM client reports to the sidecar beside its risk-gate snapshot: world settings the sidecar
 * needs to act on, as opposed to gates, which only open or close a class of operation. Plain JS so the Foundry client
 * and the sidecar both import it.
 */

import { utf8Bytes } from './utf8.js';

// Longest `backupFolder` value, in UTF-8 bytes; a longer value is treated as unset.
export const BACKUP_FOLDER_MAX_BYTES = 1024;

/**
 * The names of every bridge setting; a `BridgeSettings` has exactly these keys.
 * @type {readonly string[]}
 */
export const BRIDGE_SETTING_KEYS = Object.freeze(['backupFolder']);

/**
 * @typedef {{ backupFolder: string }} BridgeSettings
 * `backupFolder` is the absolute path of the folder backups are written to; empty means the sidecar's default folder.
 */

// A control character; none is allowed in a folder path.
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * @typedef {'tooLong' | 'control'} BackupFolderProblem
 * Why a `backupFolder` string is treated as unset: `tooLong` past `BACKUP_FOLDER_MAX_BYTES`, `control` for a control
 * character.
 */

/**
 * Name what makes a `backupFolder` string unusable, so the sanitizer and the client notice judge it by one rule.
 * @param {string} folder - The stored folder path.
 * @returns {BackupFolderProblem | null} The problem, or null when the value is usable.
 */
export function backupFolderProblem(folder) {
   if (utf8Bytes(folder) > BACKUP_FOLDER_MAX_BYTES) {
      return 'tooLong';
   }
   if (CONTROL_CHARACTER.test(folder)) {
      return 'control';
   }
   return null;
}

/**
 * Build the default bridge settings.
 * @returns {BridgeSettings} A fresh object with every setting unset.
 */
export function defaultBridgeSettings() {
   return { backupFolder: '' };
}

/**
 * Build complete bridge settings from an untrusted value. Only own properties are read; a value that is not a string
 * of at most `BACKUP_FOLDER_MAX_BYTES` UTF-8 bytes without control characters is treated as unset.
 * @param {unknown} input - The untrusted settings object.
 * @returns {BridgeSettings} A fresh, complete settings object; the defaults when the input cannot be read.
 */
export function sanitizeBridgeSettings(input) {
   /** @type {BridgeSettings} The settings under construction. */
   const settings = defaultBridgeSettings();
   if (input === null || typeof input !== 'object') {
      return settings;
   }
   try {
      /** @type {PropertyDescriptor | undefined} The own `backupFolder` property, when there is one. */
      const descriptor = Object.getOwnPropertyDescriptor(input, 'backupFolder');
      /** @type {unknown} Its value; a getter is called once. */
      const folder = descriptor === undefined
         ? undefined
         : /** @type {Record<string, unknown>} */ (input).backupFolder;
      if (typeof folder === 'string' && backupFolderProblem(folder) === null) {
         settings.backupFolder = folder;
      }
   } catch {
      return defaultBridgeSettings();
   }
   return settings;
}
