import { describe, it, expect } from 'vitest';
import { contentVersion, hashText, stableStringify } from '~/bridge/scripts/contentHash.js';
import { requestHash } from '~/bridge/scripts/writeIdempotency.js';

describe('contentHash', () => {
   it('hashText returns 14 lowercase hex digits and is deterministic', () => {
      expect(hashText('MOCK_a')).toMatch(/^[0-9a-f]{14}$/);
      expect(hashText('MOCK_a')).toBe(hashText('MOCK_a'));
      expect(hashText('MOCK_a')).not.toBe(hashText('MOCK_b'));
   });

   it('requestHash is hashText of the JSON text', () => {
      /** @type {unknown[]} A create request description. */
      const request = [
         'Actor',
         null,
         false,
         [{ name: 'MOCK_a' }],
      ];
      expect(requestHash(request)).toBe(hashText(JSON.stringify(request)));
   });

   it('stableStringify sorts keys at every level and keeps array order', () => {
      expect(
         stableStringify({
            b: {
               d: 1,
               c: 2,
            },
            a: [
               3,
               1,
            ],
         }),
      ).toBe('{"a":[3,1],"b":{"c":2,"d":1}}');
   });

   it('contentVersion is equal for a reordered export and differs for a changed value or a reordered array', () => {
      /** @type {string} The version of the reference export. */
      const version = contentVersion({
         name: 'MOCK_a',
         system: {
            hp: 3,
            mp: 4,
         },
         items: [
            { _id: 'MOCKITEM00000001' },
            { _id: 'MOCKITEM00000002' },
         ],
      });
      expect(
         contentVersion({
            items: [
               { _id: 'MOCKITEM00000001' },
               { _id: 'MOCKITEM00000002' },
            ],
            system: {
               mp: 4,
               hp: 3,
            },
            name: 'MOCK_a',
         }),
      ).toBe(version);
      expect(
         contentVersion({
            name: 'MOCK_a',
            system: {
               hp: 5,
               mp: 4,
            },
            items: [
               { _id: 'MOCKITEM00000001' },
               { _id: 'MOCKITEM00000002' },
            ],
         }),
      ).not.toBe(version);
      expect(
         contentVersion({
            name: 'MOCK_a',
            system: {
               hp: 3,
               mp: 4,
            },
            items: [
               { _id: 'MOCKITEM00000002' },
               { _id: 'MOCKITEM00000001' },
            ],
         }),
      ).not.toBe(version);
   });

   it('contentVersion keeps an own __proto__ key in the text', () => {
      /** @type {Record<string, unknown>} An export with an own `__proto__` key. */
      const withProto = JSON.parse('{"__proto__":{"x":1},"a":1}');
      expect(stableStringify(withProto)).toBe('{"__proto__":{"x":1},"a":1}');
      expect(contentVersion(withProto)).not.toBe(contentVersion({ a: 1 }));
   });
});
