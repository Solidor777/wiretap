import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeSheetHandler } from '~/bridge/scripts/closeSheet.js';

/** @type {string} The uuid of the mocked actor. */
const uuid = 'Actor.MOCKACTOR0000001';

/** @type {object} The call context; the sheet handlers use none of it. */
const ctx = {};

/**
 * Run a promise expected to reject and return the error.
 * @param {Promise<unknown>} promise - The call.
 * @returns {Promise<any>} The rejection.
 */
async function refusal(promise) {
   return promise.then(
      () => {
         throw new Error('expected a refusal');
      },
      (error) => error,
   );
}

describe('close_sheet', () => {
   /** @type {object} The `game` global before the test replaced it. */
   let savedGame;
   /** @type {{ close: Function, rendered: boolean, id: string }} The mocked sheet. */
   let sheet;
   /** @type {Record<string, unknown>} The mocked document `fromUuid` resolves. */
   let document;
   /** @type {{ id: string, name: string, active: boolean, query: Function }} The connected player. */
   let player;

   beforeEach(() => {
      savedGame = globalThis.game;
      sheet = {
         id: 'MockSheet-Actor-MOCKACTOR0000001',
         rendered: true,
         close: vi.fn(async () => {
            sheet.rendered = false;
         }),
      };
      document = {
         uuid,
         documentName: 'Actor',
         sheet,
      };
      player = {
         id: 'MOCKPLAYER000001',
         name: 'MOCK_Player',
         active: true,
         query: vi.fn(async () => ({
            ok: true,
            closed: false,
         })),
      };
      /** @type {{ id: string, name: string, active: boolean }} This client's GM user. */
      const self = {
         id: 'MOCKGAMEMASTER01',
         name: 'MOCK_GM',
         active: true,
      };
      globalThis.game = {
         user: self,
         users: new Map([
            [
               self.id,
               self,
            ],
            [
               player.id,
               player,
            ],
         ]),
      };
      globalThis.fromUuid = vi.fn(async (wanted) => (wanted === document.uuid ? document : null));
   });

   afterEach(() => {
      globalThis.game = savedGame;
      delete globalThis.fromUuid;
   });

   it('closes a rendered sheet on this client when no userId is given, sending no query', async () => {
      expect(await closeSheetHandler({ uuid }, ctx)).toEqual({
         ok: true,
         closed: true,
      });
      expect(sheet.close).toHaveBeenCalledTimes(1);
      expect(player.query).not.toHaveBeenCalled();
   });

   it('reports closed false when the sheet is not open', async () => {
      sheet.rendered = false;
      expect(await closeSheetHandler({ uuid }, ctx)).toEqual({
         ok: true,
         closed: false,
      });
      expect(sheet.close).not.toHaveBeenCalled();
   });

   it('reports closed false for a document without a sheet', async () => {
      document.sheet = null;
      expect(await closeSheetHandler({ uuid }, ctx)).toEqual({
         ok: true,
         closed: false,
      });
   });

   it('sends wiretap.closeSheet with the canonical uuid and a 5000 ms timeout', async () => {
      player.query = vi.fn(async () => ({
         ok: true,
         closed: true,
      }));
      expect(await closeSheetHandler({
         uuid: 'Actor.MOCKACTOR0000001',
         userId: 'MOCKPLAYER000001',
      }, ctx)).toEqual({
         ok: true,
         closed: true,
      });
      expect(player.query).toHaveBeenCalledWith('wiretap.closeSheet', { uuid: 'Actor.MOCKACTOR0000001' }, {
         timeout: 5000,
      });
      expect(sheet.close).not.toHaveBeenCalled();
   });

   it('refuses an offline user with USER_OFFLINE and sends nothing', async () => {
      player.active = false;
      const error = await refusal(closeSheetHandler({
         uuid,
         userId: 'MOCKPLAYER000001',
      }, ctx));
      expect(error.code).toBe('USER_OFFLINE');
      expect(player.query).not.toHaveBeenCalled();
   });

   it('passes the target client\'s refusal code through', async () => {
      player.query = vi.fn(async () => ({
         ok: false,
         code: 'SHEET_DENIED',
         message: 'Only a GM may close a sheet on another user\'s client.',
      }));
      const error = await refusal(closeSheetHandler({
         uuid,
         userId: 'MOCKPLAYER000001',
      }, ctx));
      expect(error.code).toBe('SHEET_DENIED');
   });

   it('reports SHEET_QUERY_FAILED for a reply without a boolean closed', async () => {
      player.query = vi.fn(async () => ({ ok: true }));
      const error = await refusal(closeSheetHandler({
         uuid,
         userId: 'MOCKPLAYER000001',
      }, ctx));
      expect(error.code).toBe('SHEET_QUERY_FAILED');
      expect(error.message).toBe('The user\'s client sent an unexpected reply.');
   });

   it('refuses a wiretap setting with DOC_EXCLUDED', async () => {
      document = {
         uuid: 'Setting.MOCKSETTING000001',
         documentName: 'Setting',
         key: 'wiretap.serverUrl',
         sheet,
      };
      expect((await refusal(closeSheetHandler({ uuid: 'Setting.MOCKSETTING000001' }, ctx))).code).toBe('DOC_EXCLUDED');
      expect(sheet.close).not.toHaveBeenCalled();
   });
});
