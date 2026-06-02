import { describe, it, expect } from 'vitest';
import { TERMINAL_THEMES, TERMINAL_THEME_CHOICES, terminalTheme } from '~/components/terminalThemes.svelte.js';

const IDS = ['tokyo-night', 'tokyo-night-deep', 'wiretap-contrast', 'one-dark', 'dracula'];

describe('terminalThemes', () => {
   it('defines all five themes with a label and a background/foreground', () => {
      expect(Object.keys(TERMINAL_THEMES).sort()).toEqual([...IDS].sort());
      for (const id of IDS) {
         const entry = TERMINAL_THEMES[id];
         expect(entry.label, `${id} label`).toBeTruthy();
         expect(entry.theme.background, `${id} background`).toMatch(/^#/);
         expect(entry.theme.foreground, `${id} foreground`).toMatch(/^#/);
      }
   });

   it('derives a choices map of id -> label', () => {
      expect(Object.keys(TERMINAL_THEME_CHOICES).sort()).toEqual([...IDS].sort());
      for (const id of IDS) {
         expect(TERMINAL_THEME_CHOICES[id]).toBe(TERMINAL_THEMES[id].label);
      }
   });

   it('exposes a reactive store defaulting to tokyo-night', () => {
      expect(terminalTheme.id).toBe('tokyo-night');
   });
});
