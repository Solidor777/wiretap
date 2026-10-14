import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { OPERATOR_IDENTIFIER } from '$shared/writeKeys.js';
import { findUnsafeValue, groupWrites, parsePath } from '$shared/docPath.js';
import { guardWrite, scanWriteValues } from '~/bridge/scripts/writeGuard.js';
import { analyzeChanges } from '~/bridge/scripts/writeFields.js';
import { createDocuments } from '~/bridge/scripts/writes.js';
import { batchDocuments } from '~/bridge/scripts/writeBatch.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} The token of a live scene, whose delta holds an item. */
let token;

/** @type {object} A live actor. */
let actor;

beforeEach(() => {
   world = installWriteWorld(vi.fn, { userId: 'MOCKGM0000000001' });
   gates = {};
   globalThis.game.settings.get = (module, key) => gates[key];
   const scene = world.add('Scene', { name: 'MOCK_scene' });
   token = world.addChild(scene, 'Token', {
      name: 'MOCK_token',
      delta: {
         name: 'MOCK_delta',
         items: [{
            _id: 'MOCKDELTAITEM001',
            name: 'MOCK_item',
         }],
      },
   });
   actor = world.add('Actor', {
      name: 'MOCK_actor',
      type: 'npc',
   });
});

afterEach(() => {
   for (const name of [
      'CONST',
      'CONFIG',
      'fromUuid',
      'game',
   ]) {
      delete globalThis[name];
   }
});

/**
 * The operator classes of the mock Foundry.
 * @returns {typeof foundry.data.operators} The operator classes.
 */
function ops() {
   return foundry.data.operators;
}

/**
 * Build a forced deletion.
 * @returns {object} The operator.
 */
function deletion() {
   return new (ops().ForcedDeletion)();
}

/**
 * Build a forced replacement.
 * @param {unknown} value - The new value.
 * @returns {object} The operator.
 */
function replacement(value) {
   return ops().ForcedReplacement.create(value);
}

describe('docPath reads operators through the one normalizer', () => {
   it('refuses a prefixed unsafe name as a path segment, as an unprefixed one', () => {
      for (const path of [
         '==__proto__',
         'a.-=constructor',
         'a.==toString',
         '-=prototype.x',
      ]) {
         expect(parsePath(path).error?.code, path).toBe('PATH_UNSAFE_SEGMENT');
      }
   });

   it('refuses an operator segment in a written path, with PATH_OPERATOR', () => {
      for (const path of [
         'system.==hp',
         '-=flags',
         'flags.-=scope',
         'items.X.==effects',
      ]) {
         const result = groupWrites([{
            path,
            value: null,
         }], ['items']);
         expect(result.error?.code, path).toBe('PATH_OPERATOR');
      }
   });

   it('finds an operator key or wrapper anywhere in a value', () => {
      expect(findUnsafeValue({ a: { '==b': 1 } })).toBe('operator');
      expect(findUnsafeValue({ a: [{ 'x.-=y': null }] })).toBe('operator');
      expect(findUnsafeValue({
         a: {
            [OPERATOR_IDENTIFIER]: 'ForcedReplacement',
            value: [],
         },
      })).toBe('operator');
      expect(findUnsafeValue({ '-=constructor': null })).toBe('key');
      expect(findUnsafeValue({ ok: { fine: 1 } })).toBeNull();
   });

   it('refuses an operator value of a patch, with PATH_OPERATOR', () => {
      expect(groupWrites([{
         path: 'name',
         value: { '==x': 1 },
      }], []).error?.code).toBe('PATH_OPERATOR');
      expect(
         groupWrites([{
            path: 'name',
            value: { [OPERATOR_IDENTIFIER]: 'ForcedDeletion' },
         }], []).error?.code,
      ).toBe('PATH_OPERATOR');
   });
});

describe('the dotted spelling of the wrapper identifier', () => {
   const dotted = `flags.${OPERATOR_IDENTIFIER}`;

   it('is refused in a written path and in a value key at any depth', () => {
      expect(groupWrites([{ path: dotted, value: 'ForcedReplacement' }], ['items']).error?.code).toBe('PATH_OPERATOR');
      expect(groupWrites([{ path: `items.X.effects.${OPERATOR_IDENTIFIER}`, value: 'x' }], ['items']).error?.code)
         .toBe('PATH_OPERATOR');
      expect(groupWrites([{ path: 'system', value: { a: { [dotted]: 'ForcedReplacement' } } }], []).error?.code)
         .toBe('PATH_OPERATOR');
      expect(findUnsafeValue({ list: [{ [dotted]: 1 }] })).toBe('operator');
   });

   it('is reported by the scan', () => {
      expect(scanWriteValues([{ [dotted]: 'ForcedReplacement', 'flags.value': {} }]).operator).toBe(true);
   });

   it('is refused in create data and in a batch, before any write', async () => {
      const data = { name: 'MOCK_x', type: 'npc', [dotted]: 'ForcedReplacement', 'flags.value': {} };
      await expect(createDocuments({ documentName: 'Actor', data: [data] })).rejects.toMatchObject({
         code: 'PATH_OPERATOR',
      });
      await expect(batchDocuments({ creates: [{ documentName: 'Actor', data: [data] }] })).rejects.toMatchObject({
         code: 'PATH_OPERATOR',
      });
      await expect(
         batchDocuments({ updates: [{ uuid: actor.uuid, patches: [{ path: dotted, value: 'ForcedReplacement' }] }] }),
      ).rejects.toMatchObject({ code: 'PATH_OPERATOR' });
      expect(world.calls).toEqual([]);
   });
});

describe('scanWriteValues', () => {
   it('reports an operator key, a wrapper and an operator object in the values', () => {
      expect(scanWriteValues([{ '==flags': {} }]).operator).toBe(true);
      expect(scanWriteValues([{ a: { 'b.-=c': null } }]).operator).toBe(true);
      expect(scanWriteValues([{ a: { [OPERATOR_IDENTIFIER]: 'ForcedReplacement' } }]).operator).toBe(true);
      expect(scanWriteValues([{ a: replacement([]) }]).operator).toBe(true);
      expect(scanWriteValues([{ a: deletion() }]).operator).toBe(true);
      expect(scanWriteValues([{ a: { b: 1 } }]).operator).toBe(false);
   });

   it('reads through the operators of cleaned changes when asked, and still sees the flags scope inside them', () => {
      const cleaned = { flags: replacement({ wiretap: { k: 1 } }) };
      expect(scanWriteValues([cleaned], { operators: 'descend' })).toMatchObject({
         operator: false,
         wiretapFlag: true,
      });
   });
});

describe('guardWrite derives its gates from what the cleaned changes do', () => {
   it('needs allowDelete for a forced replacement of a token delta collection, whatever spelling made it', () => {
      const changes = { delta: { items: replacement([]) } };
      const run = () => guardWrite({
         documentName: 'Token',
         targets: [{
            document: token,
            changes,
         }],
      });
      expect(run).toThrow(expect.objectContaining({ code: GATE_DENIED }));
      gates = { allowReplace: true };
      expect(run).toThrow(expect.objectContaining({ code: GATE_DENIED }));
      gates = {
         allowReplace: true,
         allowDelete: true,
      };
      expect(run).not.toThrow();
   });

   it('needs allowDelete for a forced deletion of the delta itself, and none for a preview', () => {
      const changes = { delta: deletion() };
      const intent = {
         documentName: 'Token',
         targets: [{
            document: token,
            changes,
         }],
      };
      expect(() => guardWrite(intent)).toThrow(expect.objectContaining({ code: GATE_DENIED }));
      expect(() => guardWrite({
         ...intent,
         dryRun: true,
      })).not.toThrow();
   });

   it('reads ownership, password and data URI keys of the cleaned changes outside operator values', () => {
      gates = { allowUserWrites: true };
      const user = world.add('User', { name: 'MOCK_user' });
      for (const [documentName, document, changes, text] of [
         ['Actor', actor, { ownership: { default: 3 } }, 'allowOwnershipWrites'],
         ['Actor', actor, { items: [{ ownership: { default: 3 } }] }, 'allowOwnershipWrites'],
         ['User', user, { password: 'MOCK_secret' }, 'password'],
         ['Actor', actor, { img: 'data:image/png;base64,AAAA' }, 'allowFileUpload'],
      ]) {
         expect(() => guardWrite({
            documentName,
            targets: [{ document, changes }],
         }), text).toThrow(expect.objectContaining({ message: expect.stringContaining(text) }));
      }
   });

   it('reads the Wiretap flag scope inside an operator value of the cleaned changes', () => {
      gates = {
         allowReplace: true,
         allowDelete: true,
      };
      expect(() => guardWrite({
         documentName: 'Token',
         targets: [{
            document: token,
            changes: { delta: replacement({ flags: { wiretap: { k: 1 } } }) },
         }],
      })).toThrow(expect.objectContaining({ message: expect.stringContaining('flags.wiretap') }));
   });

   it('does not read the defaults that cleaning adds inside an operator value as a write of that field', () => {
      gates = {
         allowReplace: true,
         allowDelete: true,
      };
      expect(() => guardWrite({
         documentName: 'Token',
         targets: [{
            document: token,
            changes: {
               delta: replacement({
                  name: 'MOCK_delta',
                  ownership: { default: 0 },
                  password: 'default',
               }),
            },
         }],
      })).not.toThrow();
   });

   it('refuses an operator at flags or in the wiretap scope, and lets another scope through', () => {
      gates = {
         allowReplace: true,
         allowDelete: true,
      };
      for (const changes of [
         { flags: replacement({}) },
         { flags: deletion() },
         { flags: { wiretap: deletion() } },
         { flags: { wiretap: { idem: replacement(1) } } },
      ]) {
         expect(() => guardWrite({
            documentName: 'Actor',
            targets: [{
               document: actor,
               changes,
            }],
         })).toThrow(
            expect.objectContaining({
               code: GATE_DENIED,
               message: expect.stringContaining('flags.wiretap'),
            }),
         );
      }
      expect(() => guardWrite({
         documentName: 'Actor',
         targets: [{
            document: actor,
            changes: { flags: { mod: replacement({}) } },
         }],
      })).not.toThrow();
   });
});

describe('create judges the cleaned data again', () => {
   it('refuses data whose cleaned form holds an operator the raw data did not spell', async () => {
      world.classes.Actor.cleanData.mockImplementationOnce(() => ({
         name: 'MOCK_actor',
         type: 'npc',
         flags: replacement({}),
      }));
      await expect(
         createDocuments({
            documentName: 'Actor',
            data: [{
               name: 'MOCK_actor',
               type: 'npc',
            }],
         }),
      ).rejects.toMatchObject({
         code: GATE_DENIED,
         message: expect.stringContaining('operator'),
      });
      expect(world.calls).toEqual([]);
   });
});

describe('analyzeChanges', () => {
   it('reports the operations on embedded fields and flags by walking the cleaned changes', () => {
      expect(analyzeChanges(token, { delta: { items: replacement([]) } })).toEqual({
         operations: new Set([
            'replace',
            'delete',
         ]),
         reservedFlags: false,
      });
      expect(analyzeChanges(token, { delta: { effects: deletion() } }).operations).toEqual(new Set(['delete']));
      expect(analyzeChanges(token, { delta: { name: replacement('x') } }).operations).toEqual(new Set());
      expect(analyzeChanges(actor, { system: { bio: replacement({}) } }).operations).toEqual(
         new Set([
            'replace',
            'delete',
         ]),
      );
      expect(analyzeChanges(actor, { system: { hp: deletion() } }).operations).toEqual(new Set());
      expect(analyzeChanges(actor, { flags: { wiretap: deletion() } }).reservedFlags).toBe(true);
      expect(analyzeChanges(actor, { flags: 'text' }).reservedFlags).toBe(true);
      expect(analyzeChanges(actor, { flags: { mod: replacement({}) } }).reservedFlags).toBe(false);
   });

   it('fails closed on a nesting deeper than it will walk', () => {
      let deep = replacement({});
      for (let level = 0; level < 200; level += 1) {
         deep = { next: deep };
      }
      expect(analyzeChanges(actor, deep).operations.size).toBeGreaterThan(0);
   });
});
