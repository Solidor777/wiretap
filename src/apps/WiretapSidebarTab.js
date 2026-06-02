import { mount, unmount } from 'svelte';
import Wiretap from '~/components/Wiretap.svelte';

/**
 * The Wiretap sidebar tab. Extends Foundry's AbstractSidebarTab (an ApplicationV2) and mounts the
 * Wiretap Svelte component into its content. Pop-out behavior is inherited from AbstractSidebarTab.
 * @extends {foundry.applications.sidebar.AbstractSidebarTab}
 */
export default class WiretapSidebarTab extends foundry.applications.sidebar.AbstractSidebarTab {

   /**
    * Handle returned by Svelte's mount(), retained so _onClose can unmount the component.
    * @type {object}
    */
   #mount = {};

   /**
    * The base name identifying this tab in Sidebar.TABS and CONFIG.ui.
    * @type {string}
    */
   static tabName = 'wiretap';

   /**
    * Application options merged across the ApplicationV2 chain. `window.resizable` makes the popped-out
    * window user-resizable; the docked sidebar tab (frameless) ignores it.
    * @type {object}
    */
   static DEFAULT_OPTIONS = {
      window: {
         resizable: true,
      },
   };

   /**
    * Build the props object handed verbatim to _replaceHTML.
    * @param {object} context - The render context (unused; reserved for future reactive data).
    * @param {object} options - The render options bag.
    * @returns {Promise<{ foundryApp: WiretapSidebarTab }>} The props for the Svelte component.
    */
   async _renderHTML(context, options) {
      return { foundryApp: this };
   }

   /**
    * Mount the Svelte component into the tab content on the first render only.
    * @param {{ foundryApp: WiretapSidebarTab }} result - The value returned by _renderHTML.
    * @param {HTMLElement} content - The content element to mount into.
    * @param {{ isFirstRender: boolean }} options - The render options bag.
    * @returns {void}
    */
   _replaceHTML(result, content, options) {
      if (options.isFirstRender) {
         this.#mount = mount(Wiretap, { target: content, props: result });
      }
   }

   /**
    * Tear down the mounted component when the tab (or its popout) closes.
    * @param {object} options - The close options bag.
    * @returns {void}
    */
   _onClose(options) {
      super._onClose(options);
      unmount(this.#mount, { outro: true });
   }
}
