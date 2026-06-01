import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import Wiretap from '~/components/Wiretap.svelte';

describe('Wiretap.svelte', () => {
   // The component must render its localized title header.
   it('renders the title header', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('heading', { name: 'WIRETAP.Title' })).toBeTruthy();
   });

   // The counter button must increment on click, proving runes reactivity in the mount.
   it('increments the counter when clicked', async () => {
      render(Wiretap, { props: { foundryApp: {} } });
      const button = screen.getByRole('button');
      expect(button.textContent).toContain('0');
      await fireEvent.click(button);
      expect(button.textContent).toContain('1');
   });
});
