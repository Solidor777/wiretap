/**
 * Holds the active xterm terminal instance so toolbar controls (Clear, Copy) can act on whichever terminal
 * view is currently mounted. Pop-out-takeover guarantees only one terminal view is mounted at a time, so at
 * most one terminal is registered. Exported as a shared singleton.
 */
class TerminalController {

   /**
    * The active xterm Terminal, or null when no terminal view is mounted.
    * @type {object | null}
    */
   term = null;

   /**
    * Clear the on-screen terminal display. The server scrollback is untouched.
    * @returns {void}
    */
   clear() {
      this.term?.clear();
   }

   /**
    * Copy the current selection to the clipboard, or the whole buffer when nothing is selected.
    * @returns {Promise<void>} Resolves once the copy attempt completes.
    */
   async copy() {
      const term = this.term;
      if (!term) {
         return;
      }
      let text = term.getSelection();
      if (!text) {
         term.selectAll();
         text = term.getSelection();
         term.clearSelection();
      }
      if (!text) {
         return;
      }
      try {
         await navigator.clipboard.writeText(text);
         ui.notifications?.info(game.i18n.localize('WIRETAP.Copied'));
      } catch {
         ui.notifications?.warn(game.i18n.localize('WIRETAP.CopyFailed'));
      }
   }
}

/**
 * Shared singleton: the terminal view registers its term here; the toolbar acts on it.
 * @type {TerminalController}
 */
export const terminalController = new TerminalController();
