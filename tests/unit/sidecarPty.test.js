// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolvePtyOptions, DEFAULT_BACKEND } from '../../server/ptyOptions.ts';

describe('resolvePtyOptions', () => {
   it('returns no backend options off Windows', () => {
      expect(resolvePtyOptions('linux', {})).toEqual({});
      expect(resolvePtyOptions('darwin', { WIRETAP_PTY_BACKEND: 'winpty' })).toEqual({});
   });

   it('maps each WIRETAP_PTY_BACKEND value to the right options on Windows', () => {
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'conpty' })).toEqual({});
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'conpty-dll' })).toEqual({ useConptyDll: true });
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'winpty' })).toEqual({ useConpty: false });
   });

   it('falls back to the default backend on an unset or unknown value', () => {
      const expected = resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: DEFAULT_BACKEND });
      expect(resolvePtyOptions('win32', {})).toEqual(expected);
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'bogus' })).toEqual(expected);
   });
});
