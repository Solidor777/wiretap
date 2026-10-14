import { describe, it, expect } from 'vitest';
import {
   OPERATOR_IDENTIFIER,
   canonicalKey,
   hasOperatorSegment,
   isOperatorKey,
   isOperatorWrapper,
   keyNames,
   splitKey,
} from '$shared/writeKeys.js';

describe('isOperatorKey follows Foundry isDeletionKey', () => {
   it('accepts exactly a second character "=" after "=" or "-"', () => {
      for (const key of [
         '==a',
         '-=a',
         '==',
         '-=',
         '==__proto__',
         '-=constructor',
      ]) {
         expect(isOperatorKey(key), key).toBe(true);
      }
      for (const key of [
         'a',
         '=a',
         '=-a',
         '+=a',
         '--a',
         'a==',
         '',
         '=',
         '-',
         '- =a',
      ]) {
         expect(isOperatorKey(key), key).toBe(false);
      }
   });

   it('is false for anything that is not a string', () => {
      for (const value of [
         undefined,
         null,
         0,
         {},
         ['=='],
      ]) {
         expect(isOperatorKey(value)).toBe(false);
      }
   });
});

describe('splitKey', () => {
   it('returns the names and the operator of each segment', () => {
      expect(splitKey('system.==hp')).toEqual({
         names: [
            'system',
            'hp',
         ],
         operators: [
            null,
            'replace',
         ],
      });
      expect(splitKey('-=flags.-=scope')).toEqual({
         names: [
            'flags',
            'scope',
         ],
         operators: [
            'delete',
            'delete',
         ],
      });
   });

   it('gives one canonical key to every spelling of the same field', () => {
      for (const key of [
         'system.hp',
         'system.==hp',
         'system.-=hp',
         '==system.hp',
         '-=system.==hp',
      ]) {
         expect(canonicalKey(key), key).toBe('system.hp');
         expect(keyNames(key), key).toEqual([
            'system',
            'hp',
         ]);
      }
   });

   it('flags an operator on any segment', () => {
      expect(hasOperatorSegment('a.b.c')).toBe(false);
      expect(hasOperatorSegment('a.==b.c')).toBe(true);
      expect(hasOperatorSegment('-=a')).toBe(true);
      expect(hasOperatorSegment('a.b.-=c')).toBe(true);
   });
});

describe('the identifier as a path segment', () => {
   it('is an operator spelling in any position of a dotted key', () => {
      for (const key of [
         OPERATOR_IDENTIFIER,
         `flags.${OPERATOR_IDENTIFIER}`,
         `items.X.effects.${OPERATOR_IDENTIFIER}`,
         `${OPERATOR_IDENTIFIER}.value`,
      ]) {
         expect(hasOperatorSegment(key), key).toBe(true);
      }
      expect(hasOperatorSegment(`flags.${OPERATOR_IDENTIFIER}x`)).toBe(false);
      expect(hasOperatorSegment('flags.value')).toBe(false);
   });
});

describe('isOperatorWrapper', () => {
   it('finds the identifier key, own or inherited, as Foundry does', () => {
      expect(isOperatorWrapper({ [OPERATOR_IDENTIFIER]: 'ForcedReplacement', value: [] })).toBe(true);
      expect(isOperatorWrapper({ [OPERATOR_IDENTIFIER]: 'Anything' })).toBe(true);
      expect(isOperatorWrapper(Object.create({ [OPERATOR_IDENTIFIER]: 'X' }))).toBe(true);
   });

   it('is false for other values', () => {
      for (const value of [
         null,
         undefined,
         'text',
         7,
         [],
         [{ [OPERATOR_IDENTIFIER]: 'X' }],
         {},
         { value: 1 },
      ]) {
         expect(isOperatorWrapper(value)).toBe(false);
      }
   });

   it('uses the identifier Foundry uses', () => {
      expect(OPERATOR_IDENTIFIER).toBe('__$OPERATOR$__');
   });
});
