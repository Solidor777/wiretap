import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import Wiretap from '~/components/Wiretap.svelte';

describe('Wiretap.svelte', () => {
   // The component must render its localized title header.
   it('renders the title header', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByRole('heading', { name: 'WIRETAP.Title' })).toBeTruthy();
   });

   // With no live connection, status shows 'disconnected' and the input + send are disabled.
   it('shows disconnected status and disables input when not connected', () => {
      render(Wiretap, { props: { foundryApp: {} } });
      expect(screen.getByText('disconnected')).toBeTruthy();
      expect(screen.getByPlaceholderText('Message the sidecar…').disabled).toBe(true);
      expect(screen.getByRole('button', { name: 'Send' }).disabled).toBe(true);
   });
});
