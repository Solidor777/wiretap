import { GATES } from '$shared/gates.js';

/**
 * Derive the localization key of a gate setting label or hint from the gate name: the name with its first letter
 * upper-cased is the group, so `allowUserWrites` has `WIRETAP.Settings.Gates.AllowUserWrites.Name` and `.Hint`.
 * Every registered gate and `lang/en.json` use this one derivation.
 * @param {string} name - A gate name from the GATES registry.
 * @param {'Name' | 'Hint'} part - Which text of the gate to address.
 * @returns {string} The dotted localization key.
 */
export function gateLangKey(name, part) {
   return `WIRETAP.Settings.Gates.${name.charAt(0).toUpperCase()}${name.slice(1)}.${part}`;
}

/**
 * Register one world-scope, GM-only setting for every gate in the GATES registry, all closed by default. A `boolean`
 * gate is a Boolean setting. A `moduleList` gate is a String setting that holds comma-separated module ids: Foundry
 * settings have no list type with a text editor, and `readGateState` parses and sanitizes the string on every read.
 * The registry is iterated, so a gate cannot exist without a setting. Must run during `init`.
 * @returns {void}
 */
export function registerGateSettings() {
   for (const [name, gate] of Object.entries(GATES)) {
      game.settings.register('wiretap', name, {
         name: gateLangKey(name, 'Name'),
         hint: gateLangKey(name, 'Hint'),
         scope: 'world',
         restricted: true,
         config: true,
         type: gate.type === 'boolean' ? Boolean : String,
         default: gate.type === 'boolean' ? gate.default : gate.default.join(','),
      });
   }
}
