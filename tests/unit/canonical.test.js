import { describe, it, expect, afterEach, vi } from 'vitest';
import { REDACT_MAX_NODES, exportDocument, resolveDocument } from '~/bridge/scripts/canonical.js';
import { resolvePaths } from '$shared/docPath.js';
import { installWorld, mockDocument, removeWorld } from './mockDocuments.js';

afterEach(() => {
   removeWorld();
});

/**
 * Build a mocked User with password fields in both the stored and the prepared data.
 * @returns {import('./mockDocuments.js').MockDocument} A user with `password` and `passwordSalt` set.
 */
function mockUser() {
   return mockDocument(
      {
         documentName: 'User',
         id: 'MOCKUSER00000001',
         name: 'MOCK_User',
         source: {
            role: 4,
            password: 'MOCK_HASH',
            passwordSalt: 'MOCK_SALT',
            color: '#112233',
         },
         prepared: { passwordSalt: 'MOCK_SALT_PREPARED' },
      },
      vi.fn,
   );
}

describe('exportDocument', () => {
   it('exports with the canonical options and adds the uuid', () => {
      const actor = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000001',
            type: 'npc',
            source: { system: { hp: { value: 3 } } },
         },
         vi.fn,
      );
      const outcome = exportDocument(actor, {});
      expect(actor.toCompendium).toHaveBeenCalledWith(null, {
         clearSource: false,
         keepId: true,
         clearSort: false,
         clearOwnership: false,
      });
      expect(outcome).toEqual({
         ok: true,
         data: expect.objectContaining({
            _id: 'MOCKACTOR0000001',
            uuid: 'Actor.MOCKACTOR0000001',
            system: { hp: { value: 3 } },
         }),
      });
   });

   it('exports the prepared data with ids kept and a Set turned into an array when derived', () => {
      const actor = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000001',
            type: 'npc',
            source: { system: { hp: { max: 1 } } },
            prepared: {
               system: {
                  hp: { max: 9 },
                  tags: new Set([
                     'a',
                     'b',
                  ]),
               },
            },
         },
         vi.fn,
      );
      actor.toObject = vi.fn(() => ({
         _id: 'MOCKACTOR0000001',
         name: 'MOCK_Actor',
         system: {
            hp: { max: 9 },
            tags: new Set([
               'a',
               'b',
            ]),
         },
      }));
      const outcome = exportDocument(actor, { derived: true });
      expect(actor.toObject).toHaveBeenCalledWith(false);
      expect(outcome.data.system).toEqual({
         hp: { max: 9 },
         tags: [
            'a',
            'b',
         ],
      });
      expect(outcome.data._id).toBe('MOCKACTOR0000001');
   });

   it('refuses a wiretap setting without exporting it', () => {
      for (const key of [
         'wiretap.allowUserWrites',
         'wiretap.serverUrl',
         'WIRETAP.allowUserWrites',
         'wiretap.',
      ]) {
         const setting = mockDocument(
            {
               documentName: 'Setting',
               id: 'MOCKSETTING00001',
               source: { key },
            },
            vi.fn,
         );
         setting.key = key;
         expect(exportDocument(setting, {})).toEqual({
            ok: false,
            code: 'DOC_EXCLUDED',
            message: expect.stringContaining('wiretap'),
         });
         expect(setting.toCompendium).not.toHaveBeenCalled();
         expect(setting.toObject).not.toHaveBeenCalled();
      }
   });

   it('refuses a setting whose key cannot be read as text', () => {
      const setting = mockDocument(
         {
            documentName: 'Setting',
            id: 'MOCKSETTING00002',
         },
         vi.fn,
      );
      setting.key = undefined;
      expect(exportDocument(setting, {}).ok).toBe(false);
   });

   it('exports a setting of another namespace', () => {
      const setting = mockDocument(
         {
            documentName: 'Setting',
            id: 'MOCKSETTING00003',
            source: {
               key: 'core.mock',
               value: '1',
            },
         },
         vi.fn,
      );
      setting.key = 'core.mock';
      expect(exportDocument(setting, {}).ok).toBe(true);
   });

   it('omits the password fields of a User in both source and derived exports', () => {
      for (const derived of [
         false,
         true,
      ]) {
         const user = mockUser();
         const outcome = exportDocument(user, { derived });
         expect(outcome.ok).toBe(true);
         expect(Object.hasOwn(outcome.data, 'password')).toBe(false);
         expect(Object.hasOwn(outcome.data, 'passwordSalt')).toBe(false);
         expect(JSON.stringify(outcome.data)).not.toContain('MOCK_HASH');
         expect(JSON.stringify(outcome.data)).not.toContain('MOCK_SALT');
         expect(outcome.data.role).toBe(4);
         expect(outcome.data.color).toBe('#112233');
      }
   });

   it('reports a password path as missing and never returns its value', () => {
      const outcome = exportDocument(mockUser(), {});
      const read = resolvePaths(outcome.data, [
         'password',
         'passwordSalt',
         'role',
      ]);
      expect(read).toEqual({
         ok: true,
         values: { role: 4 },
         missing: [
            'password',
            'passwordSalt',
         ],
      });
   });

   it('keeps the password fields on a non-User document', () => {
      const actor = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000002',
            source: { password: 'MOCK_FIELD' },
         },
         vi.fn,
      );
      expect(exportDocument(actor, {}).data.password).toBe('MOCK_FIELD');
   });

   it('reports an export that throws as DOC_UNREADABLE', () => {
      const actor = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000003',
         },
         vi.fn,
      );
      actor.toCompendium = () => {
         throw new Error('MOCK_BOOM');
      };
      expect(exportDocument(actor, {})).toEqual({
         ok: false,
         code: 'DOC_UNREADABLE',
         message: expect.any(String),
      });
   });
});

/**
 * Build a mocked Setting.
 * @param {string} key - The setting key, for example `core.mock`.
 * @param {string} value - The stored value as JSON text.
 * @returns {import('./mockDocuments.js').MockDocument & { key: string }} The setting with its key set.
 */
function mockSetting(key, value) {
   /** @type {import('./mockDocuments.js').MockDocument & { key: string }} The setting being built. */
   const setting = mockDocument(
      {
         documentName: 'Setting',
         id: 'MOCKSETTING00009',
         source: {
            key,
            value,
         },
      },
      vi.fn,
   );
   setting.key = key;
   return setting;
}

describe('secret redaction', () => {
   it('refuses core settings that hold credentials without exporting them', () => {
      for (const key of [
         'core.rtcWorldSettings',
         'CORE.RTCWORLDSETTINGS',
      ]) {
         const setting = mockSetting(key, '{"turn":{"password":"MOCK_TURN_PASSWORD"}}');
         expect(exportDocument(setting, {})).toEqual({
            ok: false,
            code: 'DOC_EXCLUDED',
            message: expect.any(String),
         });
         expect(setting.toCompendium).not.toHaveBeenCalled();
         expect(setting.toObject).not.toHaveBeenCalled();
      }
   });

   it('refuses a setting whose key names a secret', () => {
      for (const key of [
         'mock-module.apiKey',
         'mock-module.api_token',
         'mock-module.clientSecret',
      ]) {
         expect(exportDocument(mockSetting(key, '"MOCK_VALUE"'), {}).ok).toBe(false);
      }
   });

   it('drops secret-named keys from a setting value at any depth', () => {
      const value = JSON.stringify({
         mode: 1,
         nested: {
            Password: 'MOCK_P1',
            list: [
               {
                  passphrase: 'MOCK_P2',
                  keep: 'MOCK_KEEP',
               },
            ],
            auth_token: 'MOCK_P3',
            private_key: 'MOCK_P4',
            api_key: 'MOCK_P5',
            credentials: 'MOCK_P6',
            secret: 'MOCK_P7',
         },
      });
      const outcome = exportDocument(mockSetting('mock-module.config', value), {});
      expect(outcome.ok).toBe(true);
      expect(JSON.parse(outcome.data.value)).toEqual({
         mode: 1,
         nested: { list: [{ keep: 'MOCK_KEEP' }] },
      });
      expect(outcome.data.value).not.toContain('MOCK_P');
   });

   it('leaves a setting value that is not JSON text untouched', () => {
      const outcome = exportDocument(mockSetting('mock-module.plain', 'MOCK_PLAIN'), {});
      expect(outcome.data.value).toBe('MOCK_PLAIN');
   });

   it('drops secret-named keys from the flags of a User and of any document', () => {
      const user = mockDocument(
         {
            documentName: 'User',
            id: 'MOCKUSER00000002',
            source: {
               flags: {
                  'mock-module': {
                     apiKey: 'MOCK_F1',
                     fine: 1,
                  },
               },
            },
         },
         vi.fn,
      );
      const actor = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000009',
            source: { flags: { 'mock-module': { Token: 'MOCK_F2' } } },
         },
         vi.fn,
      );
      for (const document of [
         user,
         actor,
      ]) {
         for (const derived of [
            false,
            true,
         ]) {
            const outcome = exportDocument(document, { derived });
            expect(JSON.stringify(outcome.data)).not.toContain('MOCK_F');
         }
      }
      expect(exportDocument(user, {}).data.flags).toEqual({ 'mock-module': { fine: 1 } });
   });

   it('reports a path into a redacted key as missing', () => {
      const outcome = exportDocument(mockSetting('mock-module.config', '{"a":{"password":"MOCK_P"}}'), {});
      expect(outcome.ok).toBe(true);
      const user = mockDocument(
         {
            documentName: 'User',
            id: 'MOCKUSER00000003',
            source: { flags: { m: { secret: 'MOCK_S' } } },
         },
         vi.fn,
      );
      const read = resolvePaths(exportDocument(user, {}).data, ['flags.m.secret']);
      expect(read).toEqual({
         ok: true,
         values: {},
         missing: ['flags.m.secret'],
      });
   });

   it('keeps core schema fields whose names match the pattern', () => {
      const actor = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000010',
            source: { prototypeToken: { name: 'MOCK_TOKEN' } },
         },
         vi.fn,
      );
      expect(exportDocument(actor, {}).data.prototypeToken).toEqual({ name: 'MOCK_TOKEN' });
   });

   it('bounds the redaction walk and fails closed beyond the bound', () => {
      /** @type {Record<string, unknown>} A structure deeper than the walk bound. */
      let deep = { leaf: 'MOCK_DEEP' };
      for (let level = 0; level < 200; level += 1) {
         deep = { inner: deep };
      }
      const user = mockDocument(
         {
            documentName: 'User',
            id: 'MOCKUSER00000004',
            source: { flags: { deep } },
         },
         vi.fn,
      );
      const outcome = exportDocument(user, {});
      expect(outcome.ok).toBe(true);
      expect(JSON.stringify(outcome.data)).not.toContain('MOCK_DEEP');
   });
});

describe('secret redaction walk details', () => {
   it('keeps the index of every element it keeps when the budget runs out inside an array', () => {
      const user = mockDocument(
         {
            documentName: 'User',
            id: 'MOCKUSER00000006',
            source: { flags: { wide: Array.from({ length: REDACT_MAX_NODES + 10 }, (_, index) => ({ index })) } },
         },
         vi.fn,
      );
      const wide = exportDocument(user, {}).data.flags.wide;
      expect(wide.length).toBeGreaterThan(0);
      expect(wide.length).toBeLessThan(REDACT_MAX_NODES);
      expect(wide.every((entry, position) => entry.index === position)).toBe(true);
   });

   it('still redacts the flags of a Setting when its value uses up the walk budget', () => {
      const setting = mockSetting(
         'mock-module.big',
         JSON.stringify({ wide: Array.from({ length: REDACT_MAX_NODES + 10 }, () => ({})) }),
      );
      setting.toCompendium = vi.fn(() => ({
         _id: 'MOCKSETTING00009',
         key: 'mock-module.big',
         value: JSON.stringify({ wide: Array.from({ length: REDACT_MAX_NODES + 10 }, () => ({})) }),
         flags: { m: { password: 'MOCK_ROOT_FLAG' } },
      }));
      const outcome = exportDocument(setting, {});
      expect(outcome.ok).toBe(true);
      expect(JSON.stringify(outcome.data)).not.toContain('MOCK_ROOT_FLAG');
   });

   it('redacts a Setting value in derived mode too', () => {
      const setting = mockSetting('mock-module.derived', '{"password":"MOCK_P","keep":1}');
      const outcome = exportDocument(setting, { derived: true });
      expect(outcome.ok).toBe(true);
      expect(outcome.data.value).toBe('{"keep":1}');
   });

   it('treats a __proto__ key of a Setting value as data and does not pollute', () => {
      const setting = mockSetting('mock-module.proto', '{"__proto__":{"password":"MOCK_P","keep":1},"a":1}');
      const outcome = exportDocument(setting, {});
      expect(outcome.ok).toBe(true);
      expect(outcome.data.value).not.toContain('MOCK_P');
      expect(outcome.data.value).toContain('"keep":1');
      expect({}.password).toBeUndefined();
      expect({}.keep).toBeUndefined();
   });

   it('drops a Setting value whose JSON is nested in strings deeper than the nesting bound', () => {
      let text = '{"password":"MOCK_DEEP","keep":1}';
      for (let level = 0; level < 8; level += 1) {
         text = JSON.stringify(text);
      }
      expect(exportDocument(mockSetting('mock-module.deep', text), {}).data.value).toBe('null');
   });

   it('walks string values that hold JSON, with the same bounds', () => {
      const inner = JSON.stringify({
         password: 'MOCK_P',
         keep: 1,
      });
      const nested = mockSetting('mock-module.nested', JSON.stringify({ inner }));
      const outer = mockSetting('mock-module.outer', JSON.stringify(JSON.stringify({ apiKey: 'MOCK_K', keep: 2 })));
      for (const setting of [nested, outer]) {
         const text = exportDocument(setting, {}).data.value;
         expect(text).not.toContain('MOCK_P');
         expect(text).not.toContain('MOCK_K');
         expect(text).toMatch(/keep/);
      }
      const flagged = mockDocument(
         {
            documentName: 'User',
            id: 'MOCKUSER00000007',
            source: { flags: { m: { blob: JSON.stringify({ token: 'MOCK_T', fine: 1 }) } } },
         },
         vi.fn,
      );
      expect(JSON.stringify(exportDocument(flagged, {}).data)).not.toContain('MOCK_T');
   });
});

describe('secret redaction node bound', () => {
   it('drops what lies beyond the node budget instead of exporting it unwalked', () => {
      const user = mockDocument(
         {
            documentName: 'User',
            id: 'MOCKUSER00000005',
            source: {
               flags: {
                  wide: Array.from({ length: REDACT_MAX_NODES + 10 }, () => ({})),
                  late: { value: 'MOCK_LATE' },
               },
            },
         },
         vi.fn,
      );
      const outcome = exportDocument(user, {});
      expect(outcome.ok).toBe(true);
      expect(JSON.stringify(outcome.data)).not.toContain('MOCK_LATE');
      expect(outcome.data.flags.wide.length).toBeLessThan(REDACT_MAX_NODES);
   });
});

describe('resolveDocument', () => {
   it('resolves by uuid, by world id, by pack and through a parent', async () => {
      const actor = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000001',
         },
         vi.fn,
      );
      const item = mockDocument(
         {
            documentName: 'Item',
            id: 'MOCKITEM00000001',
         },
         vi.fn,
      );
      const packed = mockDocument(
         {
            documentName: 'Item',
            id: 'MOCKITEM00000002',
            uuid: 'Compendium.mock.items.Item.MOCKITEM00000002',
         },
         vi.fn,
      );
      installWorld(
         {
            documents: [
               actor,
               item,
            ],
            embedded: {
               [actor.uuid]: [
                  mockDocument(
                     {
                        documentName: 'Item',
                        id: 'MOCKITEM00000003',
                     },
                     vi.fn,
                  ),
               ],
            },
            packs: { 'mock.items': [packed] },
         },
         vi.fn,
      );
      expect(await resolveDocument({ uuid: actor.uuid })).toBe(actor);
      expect(
         await resolveDocument({
            documentName: 'Item',
            id: 'MOCKITEM00000001',
         }),
      ).toBe(item);
      expect(
         await resolveDocument({
            documentName: 'Item',
            id: 'MOCKITEM00000002',
            pack: 'mock.items',
         }),
      ).toBe(packed);
      expect(
         (
            await resolveDocument({
               documentName: 'Item',
               id: 'MOCKITEM00000003',
               parentUuid: actor.uuid,
            })
         ).id,
      ).toBe('MOCKITEM00000003');
   });

   it('refuses unclear references with ARGS_INVALID and unknown ones with DOC_NOT_FOUND', async () => {
      installWorld({ documents: [] }, vi.fn);
      const codeOf = async (ref) => {
         try {
            await resolveDocument(ref);
         } catch (error) {
            return error.code;
         }
         return 'resolved';
      };
      expect(await codeOf({})).toBe('ARGS_INVALID');
      expect(await codeOf({ documentName: 'Actor' })).toBe('ARGS_INVALID');
      expect(
         await codeOf({
            uuid: 'Actor.MOCKACTOR0000001',
            id: 'MOCKACTOR0000001',
         }),
      ).toBe('ARGS_INVALID');
      expect(
         await codeOf({
            documentName: 'Nonsense',
            id: 'MOCKACTOR0000001',
         }),
      ).toBe('ARGS_INVALID');
      expect(
         await codeOf({
            documentName: 'Item',
            id: 'MOCKITEM00000001',
            pack: 'mock.items',
            parentUuid: 'Actor.MOCKACTOR0000001',
         }),
      ).toBe('ARGS_INVALID');
      expect(await codeOf({ uuid: 'Actor.MOCKACTOR0000001' })).toBe('DOC_NOT_FOUND');
      expect(
         await codeOf({
            documentName: 'Actor',
            id: 'MOCKACTOR0000001',
         }),
      ).toBe('DOC_NOT_FOUND');
      expect(
         await codeOf({
            documentName: 'Item',
            id: 'MOCKITEM00000001',
            pack: 'mock.missing',
         }),
      ).toBe('DOC_NOT_FOUND');
      expect(
         await codeOf({
            documentName: 'Item',
            id: 'MOCKITEM00000001',
            parentUuid: 'Actor.MOCKACTOR0000001',
         }),
      ).toBe('DOC_NOT_FOUND');
   });

   it('answers a pack of another document class as DOC_NOT_FOUND', async () => {
      const packed = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTOR0000009',
         },
         vi.fn,
      );
      installWorld({ packs: { 'mock.actors': [packed] } }, vi.fn);
      await expect(
         resolveDocument({
            documentName: 'Item',
            id: 'MOCKACTOR0000009',
            pack: 'mock.actors',
         }),
      ).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' });
   });

   it('keeps every error message within 256 bytes whatever the caller sent', async () => {
      installWorld({ documents: [] }, vi.fn);
      const long = 'x'.repeat(5000);
      for (const ref of [
         { uuid: long },
         {
            documentName: long,
            id: 'MOCKACTOR0000001',
         },
         {
            documentName: 'Item',
            id: long,
            pack: long,
         },
      ]) {
         const error = await resolveDocument(ref).catch((caught) => caught);
         expect(new TextEncoder().encode(error.message).length).toBeLessThanOrEqual(256);
      }
   });
});
