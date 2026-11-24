import { describe, it, expect, vi } from 'vitest';
import { buildRegistryPayload } from '~/bridge/scripts/registryPayload.js';

/**
 * A shipped definition stand-in: no `moduleId`, padded by its description.
 * @param {string} name - The tool name.
 * @param {number} [size] - The description length in characters.
 * @returns {{ name: string, description: string }} The definition.
 */
const shipped = (name, size = 10) => ({
   name,
   description: 'd'.repeat(size),
});

/**
 * A plugin definition stand-in: an own `moduleId`, padded by its description.
 * @param {string} name - The tool name.
 * @param {number} size - The description length in characters.
 * @returns {{ name: string, moduleId: string, description: string }} The definition.
 */
const plugin = (name, size) => ({
   name,
   moduleId: 'p',
   description: 'd'.repeat(size),
});

describe('buildRegistryPayload', () => {
   it('holds every definition when the payload fits', () => {
      const log = vi.fn();
      const definitions = [
         shipped('a'),
         plugin('p__1', 10),
      ];
      expect(buildRegistryPayload(definitions, log)).toEqual({
         apiVersion: 1,
         scripts: definitions,
      });
      expect(log).not.toHaveBeenCalled();
   });

   it('leaves out plugin definitions, most recently registered first, until the payload fits', () => {
      const log = vi.fn();
      const definitions = [
         shipped('a'),
         plugin('p__1', 400_000),
         plugin('p__2', 400_000),
         plugin('p__3', 400_000),
      ];
      expect(buildRegistryPayload(definitions, log).scripts.map((d) => d.name)).toEqual([
         'a',
         'p__1',
         'p__2',
      ]);
      expect(log.mock.calls).toEqual([
         [
            'Wiretap | registry push left out plugin tool "p__3": the registry message would exceed 900000 bytes ' +
               '(the sidecar\'s Socket.IO message bound is 1000000 bytes)',
         ],
      ]);
   });

   it('leaves out a plugin definition registered before a shipped one when the later ones are not enough', () => {
      const log = vi.fn();
      const definitions = [
         plugin('p__1', 500_000),
         shipped('a', 450_000),
         plugin('p__2', 10),
      ];
      expect(buildRegistryPayload(definitions, log).scripts.map((d) => d.name)).toEqual(['a']);
      expect(log).toHaveBeenCalledTimes(2);
   });

   it('always keeps shipped definitions', () => {
      const definitions = [
         shipped('a', 950_000),
         plugin('p__1', 10),
      ];
      expect(buildRegistryPayload(definitions, () => undefined).scripts.map((d) => d.name)).toEqual(['a']);
   });
});
