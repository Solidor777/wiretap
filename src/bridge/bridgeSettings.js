import {
   BACKUP_FOLDER_MAX_BYTES,
   BRIDGE_SETTING_KEYS,
   backupFolderProblem,
   defaultBridgeSettings,
   sanitizeBridgeSettings,
} from '$shared/bridgeSettings.js';

/**
 * The full Setting document keys of every bridge setting, such as `wiretap.backupFolder`.
 * @type {ReadonlySet<string>}
 */
const BRIDGE_SETTING_DOCUMENT_KEYS = new Set(BRIDGE_SETTING_KEYS.map((name) => `wiretap.${name}`));

/**
 * The notice text of each reason the Backup folder setting is treated as unset.
 * @type {Readonly<Record<import('$shared/bridgeSettings.js').BackupFolderProblem, string>>}
 */
const FOLDER_PROBLEM_TEXT = Object.freeze({
   tooLong: `is over ${BACKUP_FOLDER_MAX_BYTES} bytes`,
   control: 'holds a control character',
});

/**
 * The stored Backup folder value last judged, so each unusable value is logged once and not on every read.
 * @type {string | null}
 */
let lastJudgedFolder = null;

/**
 * Log, once per stored value, that the Backup folder setting is treated as unset and which folder backups use
 * instead. The GM is the only one who can fix the setting, so the notice is a log line, not part of any tool reply.
 * @param {unknown} folder - The stored Backup folder value.
 * @returns {void}
 */
function noticeUnusableFolder(folder) {
   if (typeof folder !== 'string' || folder === lastJudgedFolder) {
      return;
   }
   lastJudgedFolder = folder;
   /** @type {import('$shared/bridgeSettings.js').BackupFolderProblem | null} Why the value is unusable, if it is. */
   const problem = backupFolderProblem(folder);
   if (problem !== null) {
      console.warn(
         `Wiretap | The Backup folder setting ${FOLDER_PROBLEM_TEXT[problem]}, so backups use the default folder `
            + '(.wiretap/backups in the module folder) instead.',
      );
   }
}

/**
 * Read the bridge settings from this client's world settings into a sanitized snapshot for the sidecar. A Backup
 * folder value the sanitizer treats as unset is logged (see `noticeUnusableFolder`).
 * @returns {import('$shared/bridgeSettings.js').BridgeSettings} A fresh, complete settings object; the defaults when
 * a read throws.
 */
export function readBridgeSettings() {
   try {
      /** @type {unknown} The stored Backup folder value. */
      const folder = game.settings.get('wiretap', 'backupFolder');
      noticeUnusableFolder(folder);
      return sanitizeBridgeSettings({ backupFolder: folder });
   } catch {
      return defaultBridgeSettings();
   }
}

/**
 * Tell whether a Setting key holds a bridge setting.
 * @param {unknown} key - A Setting document key such as `wiretap.backupFolder`.
 * @returns {boolean} True when the key is the `wiretap.` key of a bridge setting.
 */
export function isBridgeSettingKey(key) {
   return typeof key === 'string' && BRIDGE_SETTING_DOCUMENT_KEYS.has(key);
}
