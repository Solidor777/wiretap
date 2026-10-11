// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ALLOWED_ORIGINS, isMcpHostAllowed, isOriginAllowed } from '../../server/origins.ts';

describe('ALLOWED_ORIGINS', () => {
   it('lists the Foundry page origins and the Vite dev-server page origins', () => {
      expect(ALLOWED_ORIGINS).toEqual([
         'http://localhost:30000',
         'http://127.0.0.1:30000',
         'http://localhost:30001',
         'http://127.0.0.1:30001',
      ]);
   });
});

describe('isOriginAllowed', () => {
   it('allows a request with no Origin header', () => {
      expect(isOriginAllowed(undefined)).toBe(true);
   });

   it.each(ALLOWED_ORIGINS)('allows the listed origin %s', (origin) => {
      expect(isOriginAllowed(origin)).toBe(true);
   });

   it.each([
      'http://evil.example',
      'https://localhost:30000',
      'http://localhost:30002',
      'https://127.0.0.1:30001',
      'http://localhost:30000.evil.example',
      'null',
      '',
      'http://localhost:30000, http://evil.example',
   ])('refuses the origin %j', (origin) => {
      expect(isOriginAllowed(origin)).toBe(false);
   });
});

describe('isMcpHostAllowed', () => {
   it('compares against the port it is given, including an ephemeral port', () => {
      expect(isMcpHostAllowed('127.0.0.1:54321', 54321)).toBe(true);
      expect(isMcpHostAllowed('127.0.0.1:54321', 0)).toBe(false);
   });

   it.each(['127.0.0.1:31417', 'localhost:31417', 'LOCALHOST:31417'])('allows the Host %s', (host) => {
      expect(isMcpHostAllowed(host, 31417)).toBe(true);
   });

   it.each([
      undefined,
      '',
      'evil.example',
      'evil.example:31417',
      '127.0.0.1',
      '127.0.0.1:31418',
      'localhost.evil.example:31417',
   ])('refuses the Host %j', (host) => {
      expect(isMcpHostAllowed(host, 31417)).toBe(false);
   });
});
