import { BRIDGE_SETTING_KEYS, defaultBridgeSettings, sanitizeBridgeSettings } from '$shared/bridgeSettings.js';

/**
 * The full Setting document keys of every bridge setting, such as `wiretap.backupFolder`.
 * @type {ReadonlySet<string>}
 */
const BRIDGE_SETTING_DOCUMENT_KEYS = new Set(BRIDGE_SETTING_KEYS.map((name) => `wiretap.${name}`));

/**
 * Read the bridge settings from this client's world settings into a sanitized snapshot for the sidecar.
 * @returns {import('$shared/bridgeSettings.js').BridgeSettings} A fresh, complete settings object; the defaults when
 * a read throws.
 */
export function readBridgeSettings() {
   try {
      return sanitizeBridgeSettings({ backupFolder: game.settings.get('wiretap', 'backupFolder') });
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
