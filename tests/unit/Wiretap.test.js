import { render, screen } from '@testing-library/svelte';
import { describe, it, expect, vi, afterEach } from 'vitest';
import Wiretap from '~/components/Wiretap.svelte';
import { popoutState } from '~/bridge/popoutState.svelte.js';
import { connection } from '~/bridge/TerminalConnection.svelte.js';

// xterm touches DOM APIs happy-dom lacks; stub it so TerminalView mounts in the unit test.
vi.mock('@xterm/xterm', () => ({
   Terminal: class {
      cols = 80;
      rows = 24;
      options = {};
      open() {}
      write() {}
      onData() {}
      onResize() {}
      loadAddon() {}
      dispose() {}
      reset() {}
   },
}));
vi.mock('@xterm/addon-fit', () => ({
   FitAddon: class {
      fit() {}
      activate() {}
      dispose() {}
   },
}));

describe('Wiretap.svelte', () => {
   afterEach(() => {
      popoutState.open = false;
      connection.status = 'disconnected';
   });

   it('renders the title header', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('heading', { name: 'WIRETAP.Title' })).toBeTruthy();
   });

   it('shows a Launch control when no terminal is running', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('button', { name: 'WIRETAP.Launch' })).toBeTruthy();
   });

   it('shows the popped-out placeholder in the docked tab while a pop-out is open', () => {
      popoutState.open = true;
      render(Wiretap, { props: { foundryApp: { isPopout: false } } });
      expect(screen.getByText('WIRETAP.PoppedOut')).toBeTruthy();
   });

   it('still shows the terminal in the pop-out itself even when a pop-out is open', () => {
      popoutState.open = true;
      connection.status = 'connected';
      const { container } = render(Wiretap, { props: { foundryApp: { isPopout: true } } });
      expect(container.querySelector('.wiretap__terminal')).toBeTruthy();
      expect(screen.queryByText('WIRETAP.PoppedOut')).toBeNull();
   });

   it('shows the offline panel (not the terminal) when the sidecar is disconnected', () => {
      connection.status = 'disconnected';
      const { container } = render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByText('WIRETAP.Sidecar.OfflineTitle')).toBeTruthy();
      expect(container.querySelector('.wiretap__terminal')).toBeNull();
   });

   it('shows the terminal (not the offline panel) when the sidecar is connected', () => {
      connection.status = 'connected';
      const { container } = render(Wiretap, { props: { foundryApp: {} } });
      expect(container.querySelector('.wiretap__terminal')).toBeTruthy();
      expect(screen.queryByText('WIRETAP.Sidecar.OfflineTitle')).toBeNull();
   });
});
