// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolveMode } from '../../server/serverMode.ts';

describe('resolveMode', () => {
   it('defaults to full', () => {
      expect(resolveMode([], {})).toBe('full');
   });

   it('selects mcp-only from the --mcp-only argument', () => {
      expect(resolveMode(['--mcp-only'], {})).toBe('mcp-only');
   });

   it('selects the mode from WIRETAP_MODE', () => {
      expect(resolveMode([], { WIRETAP_MODE: 'mcp-only' })).toBe('mcp-only');
      expect(resolveMode([], { WIRETAP_MODE: 'full' })).toBe('full');
   });

   it('lets the argument win over WIRETAP_MODE', () => {
      expect(resolveMode(['--mcp-only'], { WIRETAP_MODE: 'full' })).toBe('mcp-only');
   });

   it('throws a clear error on an unknown WIRETAP_MODE', () => {
      expect(() => resolveMode([], { WIRETAP_MODE: 'bogus' })).toThrow(/WIRETAP_MODE.*bogus.*mcp-only.*full/);
   });

   it('does not validate WIRETAP_MODE when the argument is present', () => {
      expect(resolveMode(['--mcp-only'], { WIRETAP_MODE: 'bogus' })).toBe('mcp-only');
   });
});
