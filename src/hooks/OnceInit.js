import WiretapSidebarTab from '~/apps/WiretapSidebarTab.js';
import { TERMINAL_THEME_CHOICES, terminalTheme } from '~/components/terminalThemes.svelte.js';

/**
 * Foundry `init` handler. Registers the Wiretap sidebar tab, exposes the module API, and installs the
 * test-only probe when built for e2e. Runs before the sidebar renders so the tab is available in time.
 * @returns {void}
 */
export default function onceInit() {
   // The v14 sidebar namespace; guard against a version where it is unavailable.
   const sidebar = foundry.applications.sidebar;
   if (!sidebar?.AbstractSidebarTab || !sidebar?.Sidebar) {
      console.error('Wiretap | AbstractSidebarTab unavailable; sidebar tab not registered.');
      return;
   }

   // Register the tab application class so the Sidebar instantiates ui.wiretap from it.
   CONFIG.ui.wiretap = WiretapSidebarTab;

   // Add the sidebar navigation button (icon + tooltip) for the Wiretap tab.
   sidebar.Sidebar.TABS.wiretap = {
      tooltip: 'WIRETAP.SidebarTab',
      icon: 'fa-solid fa-user-secret',
   };

   // The sidecar URL is per-client (each GM's machine runs its own sidecar), so the setting is client-scoped.
   game.settings.register('wiretap', 'serverUrl', {
      name: 'WIRETAP.Settings.ServerUrl.Name',
      hint: 'WIRETAP.Settings.ServerUrl.Hint',
      scope: 'client',
      config: true,
      type: String,
      default: 'http://localhost:31416',
   });

   // The command launched in the PTY when the user clicks Launch (per-client; default `claude`).
   game.settings.register('wiretap', 'terminalCommand', {
      name: 'WIRETAP.Settings.TerminalCommand.Name',
      hint: 'WIRETAP.Settings.TerminalCommand.Hint',
      scope: 'client',
      config: true,
      type: String,
      default: 'claude',
   });

   // Color theme for the embedded terminal; Foundry renders `choices` as a dropdown. Applied live via the
   // reactive `terminalTheme` store that the tab component observes.
   game.settings.register('wiretap', 'terminalTheme', {
      name: 'WIRETAP.Settings.TerminalTheme.Name',
      hint: 'WIRETAP.Settings.TerminalTheme.Hint',
      scope: 'client',
      config: true,
      type: String,
      choices: TERMINAL_THEME_CHOICES,
      default: 'tokyo-night',
      onChange: (id) => {
         terminalTheme.id = id;
      },
   });

   // Seed the reactive store from the stored value (covers a non-default saved choice on load).
   terminalTheme.id = game.settings.get('wiretap', 'terminalTheme');

   // The module entry, used to expose a public API object for downstream features and the e2e probe.
   const module = game.modules.get('wiretap');
   module.api = {};

   // Install the test-only probe harness when built for e2e. `__WIRETAP_PROBE__` is a Vite compile-time
   // constant (true only under `--mode e2e`); the production build sets it false so terser
   // dead-code-eliminates this branch and the dynamic import is never bundled.
   /* global __WIRETAP_PROBE__ */
   if (__WIRETAP_PROBE__) {
      import('~/test-probe/registerProbe.js').then((probe) => {
         probe.default(module.api);
      });
   }
}
