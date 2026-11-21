/**
 * Register the GM-only world setting that names the folder the sidecar writes document backups to. An empty value
 * means the sidecar's default folder. Must run during `init`.
 * @returns {void}
 */
export function registerBridgeSettings() {
   game.settings.register('wiretap', 'backupFolder', {
      name: 'WIRETAP.Settings.BackupFolder.Name',
      hint: 'WIRETAP.Settings.BackupFolder.Hint',
      scope: 'world',
      restricted: true,
      config: true,
      type: String,
      default: '',
   });
}
