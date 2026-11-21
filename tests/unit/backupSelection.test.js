import { describe, it, expect, afterEach, vi } from 'vitest';
import { PACK_BATCH_SIZE, loadEntries, planSelection } from '~/bridge/backup/selection.js';
import { MOCK_PACK_ID, installBackupWorld, removeBackupWorld } from './mockBackupWorld.js';

afterEach(() => {
   removeBackupWorld();
});

/**
 * The uuids of a plan's entries, in order.
 * @param {{ entries: Array<{ uuid: string }> }} plan - The selection plan.
 * @returns {string[]} The document addresses of the entries.
 */
function uuidsOf(plan) {
   return plan.entries.map((entry) => entry.uuid);
}

/**
 * Collect every pair `loadEntries` yields.
 * @param {Array<object>} entries - The entries to load.
 * @returns {Promise<Array<{ entry: object, document: object | null }>>} The yielded pairs.
 */
async function loadAll(entries) {
   /** @type {Array<{ entry: object, document: object | null }>} Every pair, in order. */
   const pairs = [];
   for await (const pair of loadEntries(entries)) {
      pairs.push(pair);
   }
   return pairs;
}

describe('planSelection by uuids', () => {
   it('maps an embedded uuid to its parent once and counts it in parents', async () => {
      const { docs } = installBackupWorld(vi.fn);
      const plan = await planSelection({
         uuids: [
            docs.item1.uuid,
            docs.actor1.uuid,
         ],
         timeoutMs: 1000,
      });
      expect(plan).toEqual({
         entries: [{
            uuid: docs.actor1.uuid,
            documentName: 'Actor',
            pack: null,
            id: docs.actor1.id,
         }],
         parents: 1,
      });
   });

   it('keeps one entry for a uuid listed twice, puts named folders first, parent first, and keeps a pack', async () => {
      const { docs } = installBackupWorld(vi.fn);
      const plan = await planSelection({
         uuids: [
            docs.actor2.uuid,
            docs.journal.uuid,
            docs.actor2.uuid,
            docs.packItem0.uuid,
            docs.folderC.uuid,
            docs.folderA.uuid,
         ],
         timeoutMs: 1000,
      });
      // Folders come first, the parent before the child; the others keep the given order.
      expect(uuidsOf(plan)).toEqual([
         docs.folderA.uuid,
         docs.folderC.uuid,
         docs.actor2.uuid,
         docs.journal.uuid,
         docs.packItem0.uuid,
      ]);
      expect(plan.entries[4]).toEqual({
         uuid: docs.packItem0.uuid,
         documentName: 'Item',
         pack: MOCK_PACK_ID,
         id: docs.packItem0.id,
      });
      expect(plan.parents).toBe(0);
   });

   it('refuses a missing uuid with DOC_NOT_FOUND and a User or Setting with ARGS_INVALID', async () => {
      const { docs } = installBackupWorld(vi.fn);
      await expect(planSelection({
         uuids: [
            docs.actor1.uuid,
            'Actor.MOCKMISSING00001',
         ],
         timeoutMs: 1000,
      })).rejects.toMatchObject({
         code: 'DOC_NOT_FOUND',
         message: 'No document has uuid Actor.MOCKMISSING00001.',
      });
      for (const document of [
         docs.user,
         docs.setting,
      ]) {
         await expect(planSelection({
            uuids: [document.uuid],
            timeoutMs: 1000,
         })).rejects.toMatchObject({
            code: 'ARGS_INVALID',
            message: 'User and Setting documents cannot be backed up: the export drops passwords and redacts setting '
               + 'values.',
         });
      }
   });
});

describe('planSelection by folder', () => {
   it('selects a world folder group: the folder, its subfolders, then their documents, parents first', async () => {
      const { docs } = installBackupWorld(vi.fn);
      const plan = await planSelection({
         folderUuid: docs.folderA.uuid,
         timeoutMs: 1000,
      });
      expect(uuidsOf(plan)).toEqual([
         docs.folderA.uuid,
         docs.folderB.uuid,
         docs.folderC.uuid,
         docs.actor1.uuid,
         docs.actor2.uuid,
      ]);
      expect(plan.parents).toBe(0);
      const sub = await planSelection({
         folderUuid: docs.folderB.uuid,
         timeoutMs: 1000,
      });
      expect(uuidsOf(sub)).toEqual([
         docs.folderB.uuid,
         docs.folderC.uuid,
         docs.actor2.uuid,
      ]);
   });

   it('selects a pack folder group from pack.folders and the index', async () => {
      const { docs, pack } = installBackupWorld(vi.fn);
      const plan = await planSelection({
         folderUuid: docs.packFolderA.uuid,
         timeoutMs: 1000,
      });
      expect(pack.getIndex).toHaveBeenCalledWith({ fields: ['folder'] });
      expect(plan.entries).toEqual([
         {
            uuid: docs.packFolderA.uuid,
            documentName: 'Folder',
            pack: MOCK_PACK_ID,
            id: docs.packFolderA.id,
         },
         {
            uuid: docs.packFolderB.uuid,
            documentName: 'Folder',
            pack: MOCK_PACK_ID,
            id: docs.packFolderB.id,
         },
         {
            uuid: docs.packItem0.uuid,
            documentName: 'Item',
            pack: MOCK_PACK_ID,
            id: docs.packItem0.id,
         },
         {
            uuid: docs.packItem1.uuid,
            documentName: 'Item',
            pack: MOCK_PACK_ID,
            id: docs.packItem1.id,
         },
      ]);
   });

   it('refuses a folderUuid that is not a Folder, and a Compendium folder', async () => {
      const { docs } = installBackupWorld(vi.fn);
      await expect(planSelection({
         folderUuid: docs.actor1.uuid,
         timeoutMs: 1000,
      })).rejects.toMatchObject({
         code: 'ARGS_INVALID',
         message: 'folderUuid must name a Folder.',
      });
      await expect(planSelection({
         folderUuid: 'Folder.MOCKMISSING00001',
         timeoutMs: 1000,
      })).rejects.toMatchObject({
         code: 'ARGS_INVALID',
         message: 'folderUuid must name a Folder.',
      });
      await expect(planSelection({
         folderUuid: docs.folderPacks.uuid,
         timeoutMs: 1000,
      })).rejects.toMatchObject({
         code: 'ARGS_INVALID',
         message: 'A folder of compendium packs cannot be backed up; name a pack.',
      });
   });
});

describe('planSelection by type and pack', () => {
   it('selects a type group with the folders of that type first', async () => {
      const { docs } = installBackupWorld(vi.fn);
      const plan = await planSelection({
         documentName: 'Actor',
         timeoutMs: 1000,
      });
      expect(uuidsOf(plan)).toEqual([
         docs.folderA.uuid,
         docs.folderB.uuid,
         docs.folderC.uuid,
         docs.actor1.uuid,
         docs.actor2.uuid,
         docs.actor3.uuid,
      ]);
      const folders = await planSelection({
         documentName: 'Folder',
         timeoutMs: 1000,
      });
      expect(uuidsOf(folders)).toEqual([
         docs.folderA.uuid,
         docs.folderJ.uuid,
         docs.folderPacks.uuid,
         docs.folderB.uuid,
         docs.folderC.uuid,
      ]);
   });

   it('refuses documentName User, Setting and a non-world type', async () => {
      installBackupWorld(vi.fn);
      for (const documentName of [
         'User',
         'Setting',
      ]) {
         await expect(planSelection({
            documentName,
            timeoutMs: 1000,
         })).rejects.toMatchObject({
            code: 'ARGS_INVALID',
            message: 'User and Setting documents cannot be backed up: the export drops passwords and redacts setting '
               + 'values.',
         });
      }
      await expect(planSelection({
         documentName: 'ActiveEffect',
         timeoutMs: 1000,
      })).rejects.toMatchObject({
         code: 'ARGS_INVALID',
         message: 'ActiveEffect is not a world document type.',
      });
   });

   it('selects a whole pack: its folders, then every index entry', async () => {
      const { docs } = installBackupWorld(vi.fn);
      const plan = await planSelection({
         pack: MOCK_PACK_ID,
         timeoutMs: 1000,
      });
      expect(uuidsOf(plan)).toEqual([
         docs.packFolderA.uuid,
         docs.packFolderB.uuid,
         docs.packItem0.uuid,
         docs.packItem1.uuid,
         docs.packItem2.uuid,
      ]);
      await expect(planSelection({
         pack: 'world.mock-missing',
         timeoutMs: 1000,
      })).rejects.toMatchObject({
         code: 'ARGS_INVALID',
         message: 'Unknown pack world.mock-missing.',
      });
   });
});

describe('loadEntries', () => {
   it('loads pack entries 100 at a time with getDocuments', async () => {
      const { docs, pack } = installBackupWorld(vi.fn, { packItems: 250 });
      const plan = await planSelection({
         pack: MOCK_PACK_ID,
         timeoutMs: 1000,
      });
      const pairs = await loadAll(plan.entries);
      expect(PACK_BATCH_SIZE).toBe(100);
      expect(pack.getDocuments).toHaveBeenCalledTimes(3);
      expect(pack.getDocuments.mock.calls.map(([query]) => query._id__in.length)).toEqual([
         100,
         100,
         50,
      ]);
      expect(pairs).toHaveLength(252);
      expect(pairs[0].document).toBe(docs.packFolderA);
      expect(pairs[1].document).toBe(docs.packFolderB);
      expect(pairs.slice(2).map((pair) => pair.document)).toEqual(
         Array.from({ length: 250 }, (unused, position) => docs[`packItem${position}`]),
      );
   });

   it('yields null for a document deleted since the plan', async () => {
      const { docs, pack, actors } = installBackupWorld(vi.fn);
      const plan = await planSelection({
         uuids: [
            docs.actor1.uuid,
            docs.packItem1.uuid,
            docs.actor3.uuid,
         ],
         timeoutMs: 1000,
      });
      actors.delete(docs.actor1.id);
      pack.documents.delete(docs.packItem1.id);
      const pairs = await loadAll(plan.entries);
      expect(pairs.map((pair) => pair.document)).toEqual([
         null,
         null,
         docs.actor3,
      ]);
      expect(pairs.map((pair) => pair.entry)).toEqual(plan.entries);
   });
});
