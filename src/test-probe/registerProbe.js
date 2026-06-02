import { connection } from '~/bridge/TerminalConnection.svelte.js';

/**
 * Install the test-only probe API on the module's public API object. Only imported when the bundle is
 * built with `--mode e2e` (gated by `__WIRETAP_PROBE__`). Lets e2e specs assert tab registration and
 * drive the tab without relying on private internals.
 * @param {object} api - The module API object (`game.modules.get('wiretap').api`) to extend.
 * @returns {void}
 */
export default function registerProbe(api) {
   api._probe = {
      /**
       * Whether the Wiretap sidebar tab is registered and instantiated.
       * @returns {boolean} True when CONFIG.ui.wiretap and ui.wiretap both exist.
       */
      tabRegistered() {
         return !!CONFIG.ui.wiretap && !!ui.wiretap;
      },

      /**
       * Activate the Wiretap tab in the sidebar.
       * @returns {void}
       */
      open() {
         ui.wiretap?.activate();
      },

      /**
       * Pop the Wiretap tab out into its own window.
       * @returns {Promise<foundry.applications.sidebar.AbstractSidebarTab>|void} The popout render.
       */
      popout() {
         return ui.wiretap?.renderPopout();
      },

      /**
       * Close the Wiretap pop-out window if one is open. Reads the live pop-out reference that
       * `AbstractSidebarTab` tracks on `ui.wiretap.popout`, so no app needs to be remembered locally.
       * @returns {Promise<foundry.applications.sidebar.AbstractSidebarTab>|void} The popout close, if any.
       */
      closePopout() {
         return ui.wiretap?.popout?.close();
      },

      /**
       * Terminal controls for e2e setup/teardown without UI interaction.
       */
      terminal: {
         /**
          * Whether a PTY session is currently running.
          * @returns {boolean} True when a session is active.
          */
         running() {
            return connection.running;
         },

         /**
          * Close any running PTY session.
          * @returns {void}
          */
         close() {
            connection.close();
         },
      },
   };
}
