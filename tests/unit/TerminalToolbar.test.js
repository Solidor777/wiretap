import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, afterEach } from 'vitest';
import TerminalToolbar from '~/components/TerminalToolbar.svelte';
import { connection } from '~/bridge/TerminalConnection.svelte.js';
import { terminalController } from '~/components/terminalController.js';
import { terminalFontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT } from '~/components/terminalFontSize.svelte.js';

describe('TerminalToolbar.svelte', () => {
   afterEach(() => {
      connection.running = false;
      terminalFontSize.size = FONT_SIZE_DEFAULT;
      vi.restoreAllMocks();
   });

   it('renders the five toolbar controls', () => {
      render(TerminalToolbar);
      const labels = [
         'WIRETAP.Toolbar.Clear',
         'WIRETAP.Toolbar.Copy',
         'WIRETAP.Toolbar.FontDecrease',
         'WIRETAP.Toolbar.FontIncrease',
         'WIRETAP.Toolbar.Restart',
      ];
      labels.forEach((label) => {
         expect(screen.getByRole('button', { name: label })).toBeTruthy();
      });
   });

   it('disables Clear, Copy, and Restart when the terminal is not running', () => {
      connection.running = false;
      render(TerminalToolbar);
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Clear' }).disabled).toBe(true);
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Copy' }).disabled).toBe(true);
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Restart' }).disabled).toBe(true);
   });

   it('enables Clear when the terminal is running', () => {
      connection.running = true;
      render(TerminalToolbar);
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Clear' }).disabled).toBe(false);
   });

   it('disables Font − at the minimum size', () => {
      terminalFontSize.size = FONT_SIZE_MIN;
      render(TerminalToolbar);
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.FontDecrease' }).disabled).toBe(true);
   });

   it('disables Font + at the maximum size', () => {
      terminalFontSize.size = FONT_SIZE_MAX;
      render(TerminalToolbar);
      expect(screen.getByRole('button', { name: 'WIRETAP.Toolbar.FontIncrease' }).disabled).toBe(true);
   });

   it('clicking Clear calls the controller', async () => {
      connection.running = true;
      const spy = vi.spyOn(terminalController, 'clear').mockImplementation(() => {});
      render(TerminalToolbar);
      await fireEvent.click(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Clear' }));
      expect(spy).toHaveBeenCalled();
   });

   it('clicking Restart calls connection.restart', async () => {
      connection.running = true;
      const spy = vi.spyOn(connection, 'restart').mockImplementation(() => {});
      render(TerminalToolbar);
      await fireEvent.click(screen.getByRole('button', { name: 'WIRETAP.Toolbar.Restart' }));
      expect(spy).toHaveBeenCalled();
   });

   it('clicking Font + persists an increased size', async () => {
      const spy = vi.spyOn(game.settings, 'set').mockImplementation(() => {});
      terminalFontSize.size = 16;
      render(TerminalToolbar);
      await fireEvent.click(screen.getByRole('button', { name: 'WIRETAP.Toolbar.FontIncrease' }));
      expect(spy).toHaveBeenCalledWith('wiretap', 'terminalFontSize', 18);
   });
});
