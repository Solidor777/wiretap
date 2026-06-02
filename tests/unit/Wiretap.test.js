import { render, screen } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import Wiretap from '~/components/Wiretap.svelte';

// xterm touches DOM APIs happy-dom lacks; stub it so the component mounts in the unit test.
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
   it('renders the title header', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('heading', { name: 'WIRETAP.Title' })).toBeTruthy();
   });

   it('shows a Launch control when no terminal is running', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('button', { name: 'WIRETAP.Launch' })).toBeTruthy();
   });
});
