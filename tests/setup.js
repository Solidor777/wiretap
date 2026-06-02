import { beforeEach } from 'vitest';

/** Minimal stand-in for foundry.abstract.Document (used for instanceof checks). */
class MockDocument {}

/**
 * Minimal recursive merge mirroring foundry.utils.mergeObject for plain objects.
 * @param {object} original - Target object (mutated).
 * @param {object} [other] - Source object.
 * @returns {object} The merged target.
 */
function mergeObject(original, other = {}) {
   for (const [key, value] of Object.entries(other)) {
      const isPlain = value && typeof value === 'object' && !Array.isArray(value);
      if (isPlain && original[key] && typeof original[key] === 'object') {
         mergeObject(original[key], value);
      } else {
         original[key] = value;
      }
   }
   return original;
}

globalThis.foundry = {
   abstract: { Document: MockDocument },
   utils: { mergeObject },
};

// Minimal game mock: i18n.localize/format return the key so components render deterministically in tests;
// settings.get returns the sidecar default so the offline panel can render its target URL.
globalThis.game = {
   i18n: {
      localize: (key) => key,
      format: (key) => key,
   },
   settings: {
      get: () => 'http://localhost:31416',
   },
};

/** Minimal Hooks mock supporting on/off/call. */
class HooksMock {
   constructor() {
      this.handlers = {};
   }

   /**
    * Register a handler for a named hook.
    * @param {string} name - The hook name to subscribe to.
    * @param {Function} fn - The handler to invoke when the hook fires.
    * @returns {Function} The registered handler (mirrors Foundry's Hooks.on return).
    */
   on(name, fn) {
      (this.handlers[name] ??= new Set()).add(fn);
      return fn;
   }

   /**
    * Remove a previously registered handler for a named hook.
    * @param {string} name - The hook name to unsubscribe from.
    * @param {Function} fn - The handler to remove.
    * @returns {void}
    */
   off(name, fn) {
      this.handlers[name]?.delete(fn);
   }

   /**
    * Invoke all handlers registered for a named hook.
    * @param {string} name - The hook name to fire.
    * @param {...*} args - Arguments forwarded to each handler.
    * @returns {void}
    */
   call(name, ...args) {
      for (const fn of [...(this.handlers[name] ?? [])]) {
         fn(...args);
      }
   }
}

// Fresh Hooks per test so subscriber registrations never leak across tests.
beforeEach(() => {
   globalThis.Hooks = new HooksMock();
});
