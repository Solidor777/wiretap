import { describe, it, expect } from 'vitest';
import { carrySecrets } from '~/bridge/backup/secretCarry.js';

describe('carrySecrets', () => {
   it('copies the live value of each path into the data', () => {
      const live = {
         name: 'MOCK_live',
         system: { secret: { key: 'MOCK_VALUE_A' } },
      };
      const data = {
         name: 'MOCK_backup',
         system: {},
      };
      expect(carrySecrets(data, live, [
         [
            'system',
            'secret',
         ],
      ])).toBe(0);
      expect(data.system.secret).toEqual({ key: 'MOCK_VALUE_A' });
      // The copy is a clone: changing it leaves the live data alone.
      data.system.secret.key = 'MOCK_CHANGED';
      expect(live.system.secret.key).toBe('MOCK_VALUE_A');
   });

   it('follows embedded documents by _id when their order changed', () => {
      const live = {
         items: [
            {
               _id: 'MOCKITEM00000002',
               system: { code: 'MOCK_SECOND' },
            },
            {
               _id: 'MOCKITEM00000001',
               system: { code: 'MOCK_FIRST' },
            },
         ],
      };
      const data = {
         items: [
            {
               _id: 'MOCKITEM00000001',
               system: {},
            },
            {
               _id: 'MOCKITEM00000002',
               system: {},
            },
         ],
      };
      expect(carrySecrets(data, live, [
         [
            'items',
            0,
            'system',
            'code',
         ],
         [
            'items',
            1,
            'system',
            'code',
         ],
      ])).toBe(0);
      expect(data.items[0].system.code).toBe('MOCK_FIRST');
      expect(data.items[1].system.code).toBe('MOCK_SECOND');
   });

   it('counts a path with no live value and leaves the data unchanged there', () => {
      const live = {
         system: { kept: 'MOCK_KEPT' },
         items: [],
      };
      const data = {
         system: {},
         items: [
            {
               _id: 'MOCKITEM00000003',
               system: {},
            },
         ],
      };
      expect(carrySecrets(data, live, [
         [
            'system',
            'gone',
         ],
         [
            'items',
            0,
            'system',
            'code',
         ],
         [
            'system',
            'kept',
         ],
      ])).toBe(2);
      expect(data).toEqual({
         system: { kept: 'MOCK_KEPT' },
         items: [
            {
               _id: 'MOCKITEM00000003',
               system: {},
            },
         ],
      });
   });
});
