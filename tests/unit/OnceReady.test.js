import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** @type {string[]} The order in which the mocked collaborators were called. */
const calls = [];

vi.mock('~/bridge/TerminalConnection.svelte.js', () => ({
   connection: {
      connect: (url) => calls.push(`connect:${url}`),
   },
}));
vi.mock('~/bridge/foundryBridge.js', () => ({
   initFoundryBridge: () => calls.push('initFoundryBridge'),
}));
vi.mock('~/bridge/scripts/index.js', () => ({
   registerShippedScripts: () => calls.push('registerShippedScripts'),
}));

const { default: onceReady } = await import('~/hooks/OnceReady.js');

beforeEach(() => {
   calls.length = 0;
   vi.spyOn(console, 'log');
});

afterEach(() => {
   delete globalThis.game;
   vi.restoreAllMocks();
});

describe('onceReady', () => {
   it('registers the shipped scripts before the bridge wires the socket, for a GM', () => {
      globalThis.game = {
         user: { isGM: true },
         settings: { get: () => 'http://127.0.0.1:31416' },
      };
      onceReady();
      expect(console.log).not.toHaveBeenCalled();
      expect(calls).toEqual([
         'connect:http://127.0.0.1:31416',
         'registerShippedScripts',
         'initFoundryBridge',
      ]);
   });

   it('connects nothing and registers nothing for a user who is not a GM', () => {
      globalThis.game = {
         user: { isGM: false },
         settings: { get: () => 'http://127.0.0.1:31416' },
      };
      onceReady();
      expect(calls).toEqual([]);
   });
});
