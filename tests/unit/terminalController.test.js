import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { terminalController } from '~/components/terminalController.js';

/**
 * Build a fake xterm terminal whose getSelection returns the current selection, or the whole buffer after
 * selectAll() has been called.
 * @param {string} selection - The text returned by getSelection before selectAll.
 * @returns {object} A fake terminal with sp-able clear/selection methods.
 */
function makeFakeTerm(selection = '') {
   return {
      _selection: selection,
      _all: 'full buffer',
      selectedAll: false,
      cleared: false,
      clear() {
         this.cleared = true;
      },
      getSelection() {
         return this.selectedAll ? this._all : this._selection;
      },
      selectAll() {
         this.selectedAll = true;
      },
      clearSelection() {
         this.selectedAll = false;
      },
   };
}

describe('terminalController', () => {
   beforeEach(() => {
      terminalController.term = null;
      vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
   });

   afterEach(() => {
      vi.unstubAllGlobals();
   });

   it('clear() clears the active terminal', () => {
      const term = makeFakeTerm();
      terminalController.term = term;
      terminalController.clear();
      expect(term.cleared).toBe(true);
   });

   it('clear() is a no-op when no terminal is registered', () => {
      terminalController.term = null;
      expect(() => terminalController.clear()).not.toThrow();
   });

   it('copy() writes the current selection to the clipboard', async () => {
      terminalController.term = makeFakeTerm('selected text');
      await terminalController.copy();
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text');
   });

   it('copy() falls back to the whole buffer when nothing is selected', async () => {
      terminalController.term = makeFakeTerm('');
      await terminalController.copy();
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('full buffer');
   });
});
