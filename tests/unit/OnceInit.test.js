import { describe, it, expect, beforeEach, vi } from 'vitest';
import onceInit from '~/hooks/OnceInit.js';

// The real tab class extends a Foundry global at import time, which the unit environment does not provide.
vi.mock('~/apps/WiretapSidebarTab.js', () => ({ default: class {} }));

describe('onceInit settings registration', () => {
   /** @type {Map<string, object>} Registered setting configs keyed by setting key. */
   let registered;

   beforeEach(() => {
      registered = new Map();
      globalThis.__WIRETAP_PROBE__ = false;
      globalThis.CONFIG = { ui: {} };
      globalThis.foundry.applications = {
         sidebar: {
            AbstractSidebarTab: class {},
            Sidebar: { TABS: {} },
         },
      };
      globalThis.game = {
         i18n: globalThis.game.i18n,
         modules: new Map([['wiretap', {}]]),
         settings: {
            register: (module, key, config) => {
               registered.set(key, config);
            },
            get: (module, key) => registered.get(key).default,
         },
      };
   });

   it('registers serverUrl with the IPv4 loopback default the sidecar binds', () => {
      onceInit();
      expect(registered.get('serverUrl').default).toBe('http://127.0.0.1:31416');
   });
});
