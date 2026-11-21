import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { guardWrite, scanWriteValues } from '~/bridge/scripts/writeGuard.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {Record<string, unknown>} Stored world setting values keyed by gate name. */
let stored;

/** @type {number} How many times a gate setting was read, to prove each guard reads the settings at call time. */
let reads;

beforeEach(() => {
   stored = {};
   reads = 0;
   // The guard walks create data through the written class's schema (`CONFIG[documentName].documentClass`), so the
   // mock world supplies `CONFIG` and the document classes; the gate settings are then read from `stored`.
   installWriteWorld(vi.fn);
   globalThis.game.settings.get = (module, key) => {
      reads += 1;
      return stored[key];
   };
});

/**
 * Run the guard and return what it threw.
 * @param {object} intent - The write intent.
 * @returns {ScriptError | null} The refusal, or null when the guard let the write through.
 */
function refusal(intent) {
   try {
      guardWrite(intent);
      return null;
   } catch (error) {
      return error;
   }
}

describe('scanWriteValues', () => {
   it('finds password-named keys at any depth', () => {
      expect(scanWriteValues([{ password: 'x' }]).password).toBe(true);
      expect(scanWriteValues([{ passwordSalt: 'x' }]).password).toBe(true);
      expect(scanWriteValues([{ a: [{ b: { hashedPassword: 'x' } }] }]).password).toBe(true);
      expect(scanWriteValues([{ name: 'MOCK_name' }]).password).toBe(false);
   });

   it('finds an ownership key at any depth and ignores the word in a value', () => {
      expect(scanWriteValues([{ ownership: { default: 0 } }]).ownership).toBe(true);
      expect(scanWriteValues([{ items: [{ ownership: {} }] }]).ownership).toBe(true);
      expect(scanWriteValues([{ name: 'ownership' }]).ownership).toBe(false);
   });

   it('finds an ownership segment in a dotted key, at any depth and behind a Foundry operator prefix', () => {
      expect(scanWriteValues([{ 'ownership.default': 3 }]).ownership).toBe(true);
      expect(scanWriteValues([{ 'a.ownership.b': 3 }]).ownership).toBe(true);
      expect(scanWriteValues([{ items: [{ 'ownership.default': 3 }] }]).ownership).toBe(true);
      expect(scanWriteValues([{ '-=ownership': null }]).ownership).toBe(true);
      expect(scanWriteValues([{ '==ownership': {} }]).ownership).toBe(true);
      expect(scanWriteValues([{ 'x.-=ownership': null }]).ownership).toBe(true);
      expect(scanWriteValues([{ 'ownershipNote.default': 3 }]).ownership).toBe(false);
   });

   it('finds the reserved wiretap flag scope at any depth and in dotted keys', () => {
      expect(scanWriteValues([{ flags: { wiretap: { idem: {} } } }]).wiretapFlag).toBe(true);
      expect(scanWriteValues([{ 'flags.wiretap.idem': 1 }]).wiretapFlag).toBe(true);
      expect(scanWriteValues([{ flags: { 'wiretap.idem': 1 } }]).wiretapFlag).toBe(true);
      expect(scanWriteValues([{ 'flags.wiretap': {} }]).wiretapFlag).toBe(true);
      expect(scanWriteValues([{ items: [{ flags: { wiretap: 1 } }] }]).wiretapFlag).toBe(true);
      expect(scanWriteValues([{ flags: null }]).wiretapFlag).toBe(true);
      expect(scanWriteValues([{ flags: 'text' }]).wiretapFlag).toBe(true);
      expect(scanWriteValues([{ flags: { wiretapE2e: { marker: 1 } } }]).wiretapFlag).toBe(false);
      expect(scanWriteValues([{
         wiretap: 1,
         flags: { other: {} }
      }]).wiretapFlag).toBe(false);
   });

   it('finds a password segment in a dotted key', () => {
      expect(scanWriteValues([{ 'x.password': 'a' }]).password).toBe(true);
      expect(scanWriteValues([{ items: [{ 'a.passwordSalt': 'a' }] }]).password).toBe(true);
   });

   it('finds base64 data URIs and ignores plain file paths', () => {
      expect(scanWriteValues([{ img: 'data:image/png;base64,AAAA' }]).dataUri).toBe(true);
      expect(scanWriteValues([{ img: '  DATA:image/png;base64,AAAA' }]).dataUri).toBe(true);
      expect(scanWriteValues([{ items: [{ img: 'data:image/webp;base64,AAAA' }] }]).dataUri).toBe(true);
      expect(scanWriteValues([{ img: 'icons/svg/mystery-man.svg' }]).dataUri).toBe(false);
      expect(scanWriteValues([{ note: 'data: is a word' }]).dataUri).toBe(false);
   });

   it('fails closed past the node bound without throwing', () => {
      /** @type {unknown[]} A very wide value. */
      const wide = Array.from({ length: 200000 }, (_, index) => ({ index }));
      expect(scanWriteValues([wide])).toEqual({
         password: true,
         ownership: true,
         dataUri: true,
         wiretapFlag: true,
         operator: true,
      });
   });
});

describe('guardWrite: plain documents', () => {
   it('lets an Actor create and update through with every gate closed', () => {
      expect(
         refusal({
            documentName: 'Actor',
            values: [{
               name: 'MOCK_actor',
               img: 'icons/svg/mystery-man.svg'
            }],
         }),
      ).toBeNull();
      expect(
         refusal({
            documentName: 'Item',
            values: [{ 'system.quantity': 3 }],
         }),
      ).toBeNull();
   });

   it('reads the gate settings at call time, not once', () => {
      stored.allowOwnershipWrites = false;
      const intent = {
         documentName: 'Actor',
         values: [{ ownership: { default: 3 } }],
      };
      expect(refusal(intent)?.code).toBe(GATE_DENIED);
      stored.allowOwnershipWrites = true;
      expect(refusal(intent)).toBeNull();
      expect(reads).toBeGreaterThan(1);
   });
});

describe('guardWrite: User documents', () => {
   it('refuses password fields in create data whatever the gate, naming the rule', () => {
      stored.allowUserWrites = true;
      for (const field of [
         'password',
         'passwordSalt',
         'hashedPassword',
      ]) {
         const error = refusal({
            documentName: 'User',
            values: [{
               name: 'MOCK_user',
               [field]: 'MOCK_secret'
            }],
         });
         expect(error, field).toBeInstanceOf(ScriptError);
         expect(error.code).toBe(GATE_DENIED);
         expect(error.message).toContain('password');
         expect(new TextEncoder().encode(error.message).length).toBeLessThanOrEqual(256);
      }
   });

   it('refuses a password path in an update whatever the gate', () => {
      stored.allowUserWrites = true;
      for (const path of [
         'password',
         'passwordSalt',
         'flags.password',
      ]) {
         const error = refusal({
            documentName: 'User',
            values: [{ [path]: 'MOCK_value' }],
         });
         expect(error?.code, path).toBe(GATE_DENIED);
         expect(error.message, path).toContain('password');
      }
   });

   it('refuses a password field inside a value of an update', () => {
      stored.allowUserWrites = true;
      const error = refusal({
         documentName: 'User',
         values: [{ flags: { nested: { password: 'MOCK_secret' } } }],
      });
      expect(error?.code).toBe(GATE_DENIED);
      expect(error.message).toContain('password');
   });

   it('refuses the password with the gate closed too', () => {
      const error = refusal({
         documentName: 'User',
         values: [{ password: 'MOCK_secret' }],
      });
      expect(error?.code).toBe(GATE_DENIED);
      expect(error.message).toContain('password');
   });

   it('denies every User write while allowUserWrites is closed and names the gate', () => {
      const error = refusal({
         documentName: 'User',
         values: [{ name: 'MOCK_user' }],
      });
      expect(error?.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowUserWrites');
   });

   it('lets a User write through when allowUserWrites is open', () => {
      stored.allowUserWrites = true;
      expect(
         refusal({
            documentName: 'User',
            values: [{
               name: 'MOCK_user',
               role: 1
            }],
         }),
      ).toBeNull();
   });

   it('does not apply the password rule to other classes', () => {
      expect(
         refusal({
            documentName: 'Actor',
            values: [{
               name: 'MOCK_actor',
               flags: { password: 'MOCK_value' }
            }],
         }),
      ).toBeNull();
   });
});

describe('guardWrite: Setting documents', () => {
   it('denies a Setting write while allowSettingWrites is closed and names the gate', () => {
      const error = refusal({
         documentName: 'Setting',
         values: [{
            key: 'mock.setting',
            value: '1'
         }],
         settingTargets: [{ key: 'mock.setting' }],
      });
      expect(error?.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowSettingWrites');
   });

   it('lets a Setting write through when allowSettingWrites is open', () => {
      stored.allowSettingWrites = true;
      expect(
         refusal({
            documentName: 'Setting',
            values: [{
               key: 'mock.setting',
               value: '1'
            }],
            settingTargets: [{ key: 'mock.setting' }],
         }),
      ).toBeNull();
   });

   it('refuses every wiretap key spelling with the gate open', () => {
      stored.allowSettingWrites = true;
      for (const target of [
         { key: 'wiretap.allowUserWrites' },
         { key: 'WireTap.allowUserWrites' },
         { key: ' wiretap.allowUserWrites ' },
         { key: 'wire​tap.allowUserWrites' },
         { key: 'wiretap' },
         {
            namespace: 'wiretap',
            key: 'allowUserWrites'
         },
         'wiretap.allowMacroExecution',
         { key: 5 },
         {},
         null,
         undefined,
      ]) {
         const error = refusal({
            documentName: 'Setting',
            values: [{ value: '1' }],
            settingTargets: [target],
         });
         expect(error?.code, JSON.stringify(target)).toBe(GATE_DENIED);
         expect(error.message, JSON.stringify(target)).toContain('Wiretap settings');
      }
   });

   it('refuses a wiretap key when only one of several targets names it', () => {
      stored.allowSettingWrites = true;
      const error = refusal({
         documentName: 'Setting',
         values: [{}, {}],
         settingTargets: [
            { key: 'mock.one' },
            { key: 'wiretap.allowUserWrites' },
         ],
      });
      expect(error?.code).toBe(GATE_DENIED);
   });

   it('refuses a target document in the wiretap namespace when the data holds no key', () => {
      stored.allowSettingWrites = true;
      const error = refusal({
         documentName: 'Setting',
         values: [{ value: '"x"' }],
         settingTargets: [{ key: 'wiretap.allowUserWrites' }],
      });
      expect(error?.code).toBe(GATE_DENIED);
      expect(error.message).toContain('Wiretap settings');
   });

   it('refuses the reserved wiretap flag scope for every class, whatever the gates say', () => {
      stored.allowUserWrites = true;
      stored.allowSettingWrites = true;
      for (const intent of [
         {
            documentName: 'Actor',
            values: [{ flags: { wiretap: { idem: {} } } }],
         },
         {
            documentName: 'Actor',
            values: [{ 'flags.wiretap.idem': 1 }],
         },
         {
            documentName: 'Item',
            values: [{ 'flags.wiretap.idem': 1 }],
         },
         {
            documentName: 'Actor',
            values: [{ 'items.AAAAAAAAAAAAAAAA.flags.wiretap.x': 1 }],
         },
      ]) {
         const error = refusal(intent);
         expect(error?.code, JSON.stringify(intent)).toBe(GATE_DENIED);
         expect(error.message).toContain('flags.wiretap');
      }
   });

   it('lets other flag scopes through', () => {
      expect(
         refusal({
            documentName: 'Actor',
            values: [{ 'flags.wiretapE2e.marker': 1 }],
         }),
      ).toBeNull();
   });

   it('needs allowOwnershipWrites for a dotted ownership key segment', () => {
      for (const path of [
         'ownership.default',
         'items.AAAAAAAAAAAAAAAA.ownership.default',
      ]) {
         const error = refusal({
            documentName: 'Actor',
            values: [{ [path]: 3 }],
         });
         expect(error?.message, path).toContain('allowOwnershipWrites');
      }
   });

   it('refuses a Setting write whose target is not a key text', () => {
      stored.allowSettingWrites = true;
      expect(
         refusal({
            documentName: 'Setting',
            values: [{}],
            settingTargets: [null],
         })?.code,
      ).toBe(GATE_DENIED);
   });

   it('refuses a Setting write that has no target at all', () => {
      stored.allowSettingWrites = true;
      const error = refusal({
         documentName: 'Setting',
         values: [{ value: '1' }],
      });
      expect(error?.code).toBe(GATE_DENIED);
   });

   it('names the module configuration gate for core.moduleConfiguration', () => {
      stored.allowSettingWrites = true;
      const error = refusal({
         documentName: 'Setting',
         values: [{ value: '{}' }],
         settingTargets: [{ key: 'core.moduleConfiguration' }],
      });
      expect(error?.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowModuleConfigWrites');
   });

   it('lets core.moduleConfiguration through when both gates are open', () => {
      stored.allowSettingWrites = true;
      stored.allowModuleConfigWrites = true;
      expect(
         refusal({
            documentName: 'Setting',
            values: [{ value: '{}' }],
            settingTargets: [{ key: 'core.moduleConfiguration' }],
         }),
      ).toBeNull();
   });

   it('still needs allowSettingWrites when only the module configuration gate is open', () => {
      stored.allowModuleConfigWrites = true;
      const error = refusal({
         documentName: 'Setting',
         values: [{ value: '{}' }],
         settingTargets: [{ key: 'core.moduleConfiguration' }],
      });
      expect(error.message).toContain('allowSettingWrites');
   });
});

describe('guardWrite: file upload, ownership and compendium gates', () => {
   it('denies a data URI while allowFileUpload is closed and passes it when open', () => {
      const intent = {
         documentName: 'Actor',
         values: [{
            name: 'MOCK_actor',
            img: 'data:image/png;base64,AAAA'
         }],
      };
      const error = refusal(intent);
      expect(error?.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowFileUpload');
      stored.allowFileUpload = true;
      expect(refusal(intent)).toBeNull();
   });

   it('denies an ownership change while allowOwnershipWrites is closed and passes it when open', () => {
      const intent = {
         documentName: 'Actor',
         values: [{ ownership: { default: 3 } }],
      };
      expect(refusal(intent).message).toContain('allowOwnershipWrites');
      stored.allowOwnershipWrites = true;
      expect(refusal(intent)).toBeNull();
   });

   it('denies an ownership path of an update', () => {
      const error = refusal({
         documentName: 'Actor',
         values: [{ 'ownership.default': 3 }],
      });
      expect(error?.message).toContain('allowOwnershipWrites');
   });

   it('denies an ownership path inside an embedded document path', () => {
      const error = refusal({
         documentName: 'Actor',
         values: [{ 'items.AAAAAAAAAAAAAAAA.ownership.default': 3 }],
      });
      expect(error?.message).toContain('allowOwnershipWrites');
   });

   it('denies a write into a compendium pack while allowCompendiumWrites is closed', () => {
      const intent = {
         documentName: 'Item',
         inPack: true,
         values: [{ name: 'MOCK_item' }],
      };
      expect(refusal(intent).message).toContain('allowCompendiumWrites');
      stored.allowCompendiumWrites = true;
      expect(refusal(intent)).toBeNull();
   });

   it('keeps every gate independent', () => {
      stored.allowOwnershipWrites = true;
      const error = refusal({
         documentName: 'Item',
         inPack: true,
         values: [{ ownership: { default: 1 } }],
      });
      expect(error.message).toContain('allowCompendiumWrites');
   });
});
