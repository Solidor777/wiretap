import { describe, it, expect } from 'vitest';
import {
   clampFontSize,
   terminalFontSize,
   FONT_SIZE_MIN,
   FONT_SIZE_MAX,
   FONT_SIZE_DEFAULT,
} from '~/components/terminalFontSize.svelte.js';

describe('terminalFontSize', () => {
   it('defaults to FONT_SIZE_DEFAULT', () => {
      expect(terminalFontSize.size).toBe(FONT_SIZE_DEFAULT);
   });

   it('clamps a too-small size up to FONT_SIZE_MIN', () => {
      expect(clampFontSize(FONT_SIZE_MIN - 4)).toBe(FONT_SIZE_MIN);
   });

   it('clamps a too-large size down to FONT_SIZE_MAX', () => {
      expect(clampFontSize(FONT_SIZE_MAX + 4)).toBe(FONT_SIZE_MAX);
   });

   it('leaves an in-range size unchanged', () => {
      expect(clampFontSize(18)).toBe(18);
   });
});
