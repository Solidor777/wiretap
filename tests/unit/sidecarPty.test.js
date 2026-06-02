// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolvePtyOptions, DEFAULT_BACKEND } from '../../server/ptyOptions.ts';
import { resolveSpawn } from '../../server/spawnCommand.ts';

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
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'constructor' })).toEqual(expected);
   });
});

describe('resolveSpawn', () => {
   it('returns a verbatim command-line STRING on Windows (avoids node-pty arg re-escaping)', () => {
      expect(resolveSpawn('node -e "x"', 'win32', 'C:\\Windows\\System32\\cmd.exe'))
         .toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: '/c node -e "x"' });
   });

   it('defaults to cmd.exe when ComSpec is undefined', () => {
      expect(resolveSpawn('claude', 'win32', undefined)).toEqual({ file: 'cmd.exe', args: '/c claude' });
   });

   it('returns an argument ARRAY via /bin/sh on POSIX', () => {
      expect(resolveSpawn('node -e "x"', 'linux', undefined))
         .toEqual({ file: '/bin/sh', args: ['-c', 'node -e "x"'] });
   });
});
