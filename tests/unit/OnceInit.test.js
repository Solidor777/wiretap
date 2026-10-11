import { describe, it, expect, beforeEach, vi } from 'vitest';
import onceInit from '~/hooks/OnceInit.js';
import { bridgeState, reidentifyBridge } from '~/bridge/foundryBridge.js';

// The real tab class extends a Foundry global at import time, which the unit environment does not provide.
vi.mock('~/apps/WiretapSidebarTab.js', () => ({ default: class {} }));

// The bridge re-identify entry point is observed through a spy; the real implementation is covered in
// foundryBridge.identify.test.js.
vi.mock('~/bridge/foundryBridge.js', () => ({
   bridgeState: { identified: false },
   reidentifyBridge: vi.fn(),
}));

describe('onceInit settings registration', () => {
   /** @type {Map<string, object>} Registered setting configs keyed by setting key. */
   let registered;

   beforeEach(() => {
      vi.mocked(reidentifyBridge).mockClear();
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

   it('registers endpointKind as a hidden client String setting choosing human or agent, default human', () => {
      onceInit();
      const config = registered.get('endpointKind');
      expect(config.scope).toBe('client');
      expect(config.config).toBe(false);
      expect(config.type).toBe(String);
      expect(Object.keys(config.choices)).toEqual(['human', 'agent']);
      expect(config.default).toBe('human');
   });

   it('re-identifies the bridge when endpointKind changes', () => {
      onceInit();
      registered.get('endpointKind').onChange('agent');
      expect(reidentifyBridge).toHaveBeenCalledTimes(1);
   });

   it('exposes api.bridge.identified reflecting the bridge state', () => {
      onceInit();
      const api = globalThis.game.modules.get('wiretap').api;
      expect(api.bridge.identified).toBe(false);
      bridgeState.identified = true;
      expect(api.bridge.identified).toBe(true);
      bridgeState.identified = false;
   });
});
