import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { batchDocuments } from '~/bridge/scripts/writeBatch.js';
import { replaceDocument } from '~/bridge/scripts/writeReplace.js';
import { createDocuments, updateDocuments } from '~/bridge/scripts/writes.js';
import { installWriteWorld } from './mockWriteWorld.js';
import {
  dataWith,
  holdsDocuments,
  dataWithout,
  gatesFor,
  opPatch,
  prefixPatch,
  targetsOf,
  wrapperPatch,
  dottedWrapperPatch,
} from './operatorGridCases.js';

/**
 * The generated grid. Dimensions: every embedded field the mock schemas hold (nested ones through an embedded
 * document, a token delta and the system data model included) x operation (set, replace, delete) x spelling of the
 * operator (explicit `op`, key prefix, serialized wrapper) x gate state (all closed, each single gate open, all open)
 * x tool (update_documents, batch updates, replace_document, create_documents, batch creates). The expected result of
 * a cell comes from the field type alone, never from the key text.
 */

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} A live actor with an item, effects and an embedded system model. */
let actor;

/** @type {object} A live scene with a token whose delta holds an item and an effect. */
let scene;

/**
 * Build a fresh mock world with the actor and the scene, every id fixed so a path from one build addresses the same
 * document in the next. A cell that really writes changes the mock documents, so each target gets its own world.
 * @returns {void}
 */
function build() {
   world = installWriteWorld(vi.fn, {
      users: [{
         id: 'MOCKGM0000000001',
         role: 4,
         name: 'MOCK_gm',
      }],
      userId: 'MOCKGM0000000001',
   });
   gates = {};
   globalThis.game.settings.get = (module, key) => gates[key];
   actor = world.add('Actor', {
      _id: 'MOCKACTOR0000001',
      name: 'MOCK_actor',
      type: 'npc',
      system: {
         hp: 1,
         attributes: { a: 1 },
         bio: { text: 'MOCK_text' },
      },
      flags: { mod: { x: 1 } },
   });
   const sword = world.addChild(actor, 'Item', {
      _id: 'MOCKSWORD0000001',
      name: 'MOCK_sword',
      type: 'weapon',
      system: { damage: 1 },
   });
   world.addChild(sword, 'ActiveEffect', {
      _id: 'MOCKEDGE00000001',
      name: 'MOCK_edge',
   });
   world.addChild(actor, 'ActiveEffect', {
      _id: 'MOCKGLOW00000001',
      name: 'MOCK_glow',
   });
   scene = world.add('Scene', {
      _id: 'MOCKSCENE0000001',
      name: 'MOCK_scene',
   });
   world.addChild(scene, 'Token', {
      _id: 'MOCKTOKEN0000001',
      name: 'MOCK_token',
      delta: {
         _id: 'MOCKTOKEN0000001',
         name: 'MOCK_delta',
         items: [{
            _id: 'MOCKDELTAITEM001',
            name: 'MOCK_deltaitem',
            type: 'weapon',
         }],
         effects: [{
            _id: 'MOCKDELTAEFFECT1',
            name: 'MOCK_deltaeffect',
         }],
      },
   });
}

beforeEach(() => {
   build();
});

/**
 * Build a fresh world and return the root and the target of a path in it.
 * @param {'actor' | 'scene'} rootName - Which root.
 * @param {string} path - The target path.
 * @param {boolean} [withTop] - Whether top-level collections are listed.
 * @returns {{ root: object, target: import('./operatorGridCases.js').Target }} The root and its target.
 */
function fresh(rootName, path, withTop = false) {
   build();
   /** @type {object} The root document. */
   const root = rootName === 'actor' ? actor : scene;
   return {
      root,
      target: targetsOf(root, withTop).find((candidate) => candidate.path === path),
   };
}

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
 * Run a call and return what it threw.
 * @param {() => Promise<unknown>} call - The operation to attempt.
 * @returns {Promise<Error | null>} The rejection, or null when the call resolved.
 */
async function outcome(call) {
   try {
      await call();
   } catch (error) {
      return error;
   }
   return null;
}

/**
 * Assert that no write API ran.
 * @returns {void}
 */
function expectNoWrites() {
   expect(world.calls.filter((call) => /create|update|delete|modify/i.test(call))).toEqual([]);
}

/**
 * Names whose paths the dedicated flags, ownership and identity tests cover: the generic grid leaves them out.
 * @type {string[]}
 */
const SPECIAL = [
   '_id',
   'type',
   'flags',
   'ownership',
];

/**
 * The tools that take patches.
 * @type {Array<[string, (root: object, patch: object, dryRun: boolean) => Promise<unknown>]>}
 */
const PATCH_TOOLS = [
   [
      'update_documents',
      (root, patch, dryRun) => updateDocuments({
         updates: [{
            uuid: root.uuid,
            patches: [patch],
         }],
         dryRun,
      }),
   ],
   [
      'batch updates',
      (root, patch, dryRun) => batchDocuments({
         updates: [{
            uuid: root.uuid,
            patches: [patch],
         }],
         dryRun,
      }),
   ],
];

/**
 * The tools that take whole documents, each as the data of a new document.
 * @type {Array<[string, (root: object, data: object) => Promise<unknown>]>}
 */
const DATA_TOOLS = [
   [
      'create_documents',
      (root, data) => createDocuments({
         documentName: root.documentName,
         data: [data],
      }),
   ],
   [
      'batch creates',
      (root, data) => batchDocuments({
         creates: [{
            documentName: root.documentName,
            data: [data],
         }],
      }),
   ],
   [
      'replace_document',
      (root, data) => replaceDocument({
         uuid: root.uuid,
         data,
      }),
   ],
];

/**
 * All gate states of a need: everything closed, each single gate open, everything open.
 * @param {string[]} needs - The gates the cell needs.
 * @returns {Array<Record<string, boolean>>} The states, closed first and fully open last.
 */
function gateStates(needs) {
   return [
      {},
      ...needs.map((name) => ({ [name]: true })),
      Object.fromEntries(needs.map((name) => [name, true])),
   ];
}

describe('the grid is generated from the schemas', () => {
   it('finds the embedded fields of every depth, the system model and the token delta', () => {
      const kinds = (root) => new Map(targetsOf(root).map((target) => [target.path, target.kind]));
      const actorKinds = kinds(actor);
      expect(actorKinds.get('system')).toBe('contains');
      expect(actorKinds.get('system.bio')).toBe('single');
      expect(actorKinds.get('system.hp')).toBe('plain');
      expect([...actorKinds.values()].filter((kind) => kind === 'collection')).toHaveLength(1);
      const sceneKinds = kinds(scene);
      const tokenPath = [...sceneKinds.keys()].find((path) => path.endsWith('.delta'));
      expect(sceneKinds.get(tokenPath)).toBe('single');
      expect(sceneKinds.get(`${tokenPath}.items`)).toBe('collection');
      expect(sceneKinds.get(`${tokenPath}.effects`)).toBe('collection');
      expect([...sceneKinds.values()]).toContain('element');
   });
});

describe('explicit op: the gates follow the type of the field', () => {
   for (const [tool, run] of PATCH_TOOLS) {
      for (const rootName of [
         'actor',
         'scene',
      ]) {
         for (const op of [
            'set',
            'replace',
            'delete',
         ]) {
            it(`${tool} on the ${rootName}, op ${op}: every target, every gate state`, async () => {
               for (const { path, kind, names } of targetsOf(rootName === 'actor' ? actor : scene)) {
                  if (SPECIAL.some((name) => names.includes(name))) {
                     continue;
                  }
                  /** @type {string[]} The gates this cell needs. */
                  const needs = gatesFor(kind, op);
                  for (const state of [
                     ...gateStates(needs),
                     'dry',
                  ]) {
                     // A cell that really writes changes the mock documents, so each cell has its own world.
                     const { root, target } = fresh(rootName, path);
                     const dry = state === 'dry';
                     gates = dry ? {} : state;
                     const error = await outcome(() => run(root, opPatch(target, op), dry));
                     const label = `${tool} ${op} ${path} (${kind}) with ${JSON.stringify(state)}`;
                     if (!dry && needs.length > 0 && Object.keys(state).length < needs.length) {
                        expect(error?.code, label).toBe(GATE_DENIED);
                        expectNoWrites();
                     } else {
                        expect(error, label).toBeNull();
                        if (dry) {
                           expectNoWrites();
                        }
                     }
                  }
               }
            });
         }
      }
   }
});

describe('key prefix and wrapper spellings are refused in every tool, whatever the gates', () => {
   for (const [tool, run] of PATCH_TOOLS) {
      for (const representation of [
         'prefix',
         'wrapper',
         'dottedWrapper',
      ]) {
         it(`${tool}, ${representation}: refused for every target, op, gate state and dry run`, async () => {
            for (const root of [
               actor,
               scene,
            ]) {
               for (const target of targetsOf(root).filter((candidate) => !candidate.names.includes('_id'))) {
                  for (const op of [
                     'replace',
                     'delete',
                  ]) {
                     /** @type {object} The patch in this spelling. */
                     const patch = {
                        prefix: prefixPatch,
                        wrapper: wrapperPatch,
                        dottedWrapper: dottedWrapperPatch,
                     }[representation](target, op);
                     for (const [state, dryRun] of [
                        [{}, false],
                        [{ allowReplace: true, allowDelete: true }, false],
                        [{}, true],
                     ]) {
                        gates = state;
                        world.calls.length = 0;
                        const error = await outcome(() => run(root, patch, dryRun));
                        expect(error?.code, `${tool} ${representation} ${op} ${target.path}`).toBe('PATH_OPERATOR');
                        expectNoWrites();
                     }
                  }
               }
            }
         });
      }
   }
});

describe('operators in the data of a create or a replace are refused, whatever the gates', () => {
   for (const [tool, run] of DATA_TOOLS) {
      for (const representation of [
         'prefix',
         'wrapper',
         'dotted',
         'dottedWrapper',
      ]) {
         it(`${tool}, ${representation}: refused at every field, with every gate open`, async () => {
            gates = {
               allowReplace: true,
               allowDelete: true,
            };
            for (const root of [
               actor,
               scene,
            ]) {
               for (const target of targetsOf(root, true).filter((candidate) => !candidate.names.includes('_id'))) {
                  for (const op of [
                     'replace',
                     'delete',
                  ]) {
                     /** @type {Record<string, unknown> | null} The data that carries the operator. */
                     const data = dataWith(target, representation, op);
                     if (data === null) {
                        continue;
                     }
                     world.calls.length = 0;
                     const error = await outcome(() => run(root, data));
                     expect(error?.code, `${tool} ${representation} ${op} ${target.path}`).toBe('PATH_OPERATOR');
                     expectNoWrites();
                  }
               }
            }
         });
      }
   }
});

describe('replace_document: dropping any embedded document needs the delete gate', () => {
   it('gates every embedded field, single or collection, at every depth', async () => {
      for (const rootName of [
         'actor',
         'scene',
      ]) {
         for (const { path, document } of targetsOf(rootName === 'actor' ? actor : scene, true)) {
            if (document !== true) {
               continue;
            }
            for (const state of [
               ...gateStates([
                  'allowReplace',
                  'allowDelete',
               ]),
               'dry',
            ]) {
               const { root, target } = fresh(rootName, path, true);
               /** @type {Record<string, unknown>} The full data without the field. */
               const data = dataWithout(target);
               /** @type {boolean} Whether the field holds any live document, so omitting it drops something. */
               const drops = holdsDocuments(target);
               const dry = state === 'dry';
               gates = dry ? {} : state;
               const error = await outcome(() => replaceDocument({
                  uuid: root.uuid,
                  data,
                  dryRun: dry,
               }));
               const label = `${path} ${JSON.stringify(state)}`;
               const enough = state.allowReplace === true && (state.allowDelete === true || !drops);
               if (dry || enough) {
                  expect(error, label).toBeNull();
               } else {
                  expect(error?.code, label).toBe(GATE_DENIED);
                  expectNoWrites();
               }
            }
         }
      }
   });

   it('reports dropped documents on a dry run for every field that holds some', async () => {
      for (const rootName of [
         'actor',
         'scene',
      ]) {
         for (const { path, document } of targetsOf(rootName === 'actor' ? actor : scene, true)) {
            if (document !== true) {
               continue;
            }
            const { root, target } = fresh(rootName, path, true);
            const row = await replaceDocument({
               uuid: root.uuid,
               data: dataWithout(target),
               dryRun: true,
            });
            expect(row.dropped === undefined, `${path} dropped ${row.dropped}`).toBe(!holdsDocuments(target));
         }
      }
   });

   it('does not count an embedded data model that is not a document as dropped', async () => {
      const { root, target } = fresh('actor', 'system.bio');
      gates = { allowReplace: true };
      expect(target.kind).toBe('single');
      expect(target.document).toBe(false);
      const row = await replaceDocument({
         uuid: root.uuid,
         data: dataWithout(target),
      });
      expect(row.dropped).toBeUndefined();
   });

   it('needs only the replace gate when nothing is dropped', async () => {
      gates = { allowReplace: true };
      for (const root of [
         actor,
         scene,
      ]) {
         const data = structuredClone(root.toObject());
         delete data._id;
         const row = await replaceDocument({
            uuid: root.uuid,
            data,
         });
         expect(row.dropped).toBeUndefined();
      }
   });
});

describe('the flags scope, ownership and the Setting key through every spelling', () => {
   it('refuses op replace and op delete of flags and of the wiretap scope, whatever the gates', async () => {
      gates = {
         allowReplace: true,
         allowDelete: true,
         allowOwnershipWrites: true,
      };
      for (const [tool, run] of PATCH_TOOLS) {
         for (const path of [
            'flags',
            'flags.wiretap',
            'flags.wiretap.idem',
         ]) {
            for (const op of [
               'replace',
               'delete',
            ]) {
               world.calls.length = 0;
               const patch = op === 'delete'
                  ? {
                     path,
                     op,
                  }
                  : {
                     path,
                     op,
                     value: {},
                  };
               const error = await outcome(() => run(actor, patch, false));
               expect(error?.code, `${tool} ${op} ${path}`).toBe(GATE_DENIED);
               expect(error.message).toContain('flags.wiretap');
               expectNoWrites();
            }
         }
      }
   });

   it('lets op replace and op delete of another flags scope through', async () => {
      gates = {};
      for (const [tool, run] of PATCH_TOOLS) {
         for (const op of [
            'replace',
            'delete',
         ]) {
            const patch = op === 'delete'
               ? {
                  path: 'flags.mod',
                  op,
               }
               : {
                  path: 'flags.mod',
                  op,
                  value: { y: 1 },
               };
            expect(await outcome(() => run(actor, patch, false)), `${tool} ${op}`).toBeNull();
         }
      }
   });

   it('refuses every spelling of a flags or wiretap-scope operator in a patch, a create and a replace', async () => {
      gates = {
         allowReplace: true,
         allowDelete: true,
      };
      for (const path of [
         'flags',
         'flags.wiretap',
      ]) {
         for (const [tool, run] of PATCH_TOOLS) {
            for (const patch of [
               prefixPatch({ names: path.split('.'), sample: {} }, 'replace'),
               prefixPatch({ names: path.split('.'), sample: {} }, 'delete'),
               wrapperPatch({ path, sample: {} }, 'replace'),
               wrapperPatch({ path, sample: {} }, 'delete'),
            ]) {
               const error = await outcome(() => run(actor, patch, false));
               expect(error?.code, `${tool} ${JSON.stringify(patch)}`).toBe('PATH_OPERATOR');
            }
         }
         for (const [tool, run] of DATA_TOOLS) {
            for (const representation of [
               'prefix',
               'wrapper',
               'dotted',
            ]) {
               for (const op of [
                  'replace',
                  'delete',
               ]) {
                  const data = dataWith(
                     {
                        root: actor,
                        names: path.split('.'),
                        sample: {},
                     },
                     representation,
                     op,
                  );
                  if (data !== null) {
                     const error = await outcome(() => run(actor, data));
                     expect(error?.code, `${tool} ${representation} ${path}`).toBe('PATH_OPERATOR');
                  }
               }
            }
         }
      }
      expectNoWrites();
   });

   it('denies op replace and op delete of ownership while the ownership gate is closed', async () => {
      gates = {
         allowReplace: true,
         allowDelete: true,
      };
      for (const [tool, run] of PATCH_TOOLS) {
         for (const op of [
            'replace',
            'delete',
         ]) {
            const patch = op === 'delete'
               ? {
                  path: 'ownership',
                  op,
               }
               : {
                  path: 'ownership',
                  op,
                  value: { default: 3 },
               };
            const error = await outcome(() => run(actor, patch, false));
            expect(error?.code, `${tool} ${op}`).toBe(GATE_DENIED);
            expect(error.message).toContain('allowOwnershipWrites');
            expectNoWrites();
         }
      }
   });

   it('judges a Setting rename by the key the change leaves, whatever the spelling', async () => {
      gates = {
         allowSettingWrites: true,
         allowReplace: true,
         allowDelete: true,
      };
      const setting = world.add('Setting', {
         key: 'mock.thing',
         value: '1',
      });
      for (const [tool, run] of PATCH_TOOLS) {
         for (const patch of [
            {
               path: 'key',
               value: 'wiretap.x',
            },
            {
               path: 'key',
               op: 'replace',
               value: 'wiretap.x',
            },
            {
               path: 'key',
               op: 'delete',
            },
         ]) {
            const error = await outcome(() => run(setting, patch, false));
            expect(error?.code, `${tool} ${JSON.stringify(patch)}`).toBe(GATE_DENIED);
            expectNoWrites();
         }
         for (const patch of [
            prefixPatch({ names: ['key'], sample: 'wiretap.x' }, 'replace'),
            wrapperPatch({ path: 'key', sample: 'wiretap.x' }, 'replace'),
         ]) {
            const error = await outcome(() => run(setting, patch, false));
            expect(error?.code, `${tool} ${JSON.stringify(patch)}`).toBe('PATH_OPERATOR');
         }
      }
   });
});
