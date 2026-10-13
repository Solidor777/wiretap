import { connection } from '~/bridge/TerminalConnection.svelte.js';
import { registerScript } from '~/bridge/scripts/registry.js';

/**
 * The e2e-only script definitions. They exist only in the e2e build, which is the only build that loads this module.
 * @type {ReadonlyArray<{ definition: import('$shared/scripts.js').ScriptDefinition, handler: Function }>}
 */
const E2E_SCRIPTS = [
   {
      definition: {
         name: 'e2e_gated',
         version: '1.0.0',
         description: 'E2E probe script behind the allowMacroExecution gate.',
         inputSchema: {
            type: 'object',
            properties: {},
         },
         result: { budgetBytes: 256 },
         requires: 'api',
         mutates: false,
         gate: 'allowMacroExecution',
      },
      handler: async () => ({ ran: true }),
   },
   {
      definition: {
         name: 'e2e_matrix',
         version: '1.0.0',
         description: 'E2E probe script whose arguments the sidecar accepts but the client value bound refuses.',
         inputSchema: {
            type: 'object',
            properties: {
               rows: {
                  type: 'array',
                  maxItems: 1000,
                  items: {
                     type: 'array',
                     maxItems: 1000,
                     items: { type: 'boolean' },
                  },
               },
            },
            required: ['rows'],
         },
         result: { budgetBytes: 256 },
         requires: 'api',
         mutates: false,
      },
      handler: async (args) => ({ rows: args.rows.length }),
   },
];

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
       * Script registry controls for the e2e specs.
       */
      scripts: {
         /**
          * Register the e2e-only scripts on the client registry, which pushes the new list to the sidecar.
          * @returns {Array<{ ok: boolean, name?: string, reason?: string }>} The outcome of each registration.
          */
         registerE2e() {
            return E2E_SCRIPTS.map(({ definition, handler }) => registerScript(definition, handler));
         },
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
