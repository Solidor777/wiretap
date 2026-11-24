import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** @type {string[]} The order in which the mocked collaborators were called. */
const calls = [];

/** @type {Readonly<object>} The stand-in for the plugin API the hook must receive. */
const SENTINEL = Object.freeze({});

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
vi.mock('~/bridge/pluginApi.js', () => ({
   PLUGIN_HOOK: 'wiretap.registerTools',
   pluginApi: SENTINEL,
}));

const { default: onceReady } = await import('~/hooks/OnceReady.js');

beforeEach(() => {
   calls.length = 0;
   vi.spyOn(console, 'log');
   globalThis.Hooks.callAll = vi.fn((name, api) => calls.push(`hook:${name}:${api === SENTINEL}`));
});

afterEach(() => {
   delete globalThis.game;
   vi.restoreAllMocks();
});

describe('onceReady', () => {
   it('registers the shipped scripts before the bridge wires the socket, then fires the hook, for a GM', () => {
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
         'hook:wiretap.registerTools:true',
      ]);
   });

   it('fires the hook but connects and registers nothing for a user who is not a GM', () => {
      globalThis.game = {
         user: { isGM: false },
         settings: { get: () => 'http://127.0.0.1:31416' },
      };
      onceReady();
      expect(calls).toEqual(['hook:wiretap.registerTools:true']);
   });
});
