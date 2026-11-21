import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CONTROL_PATTERN } from '$shared/logText.js';
import { utf8Bytes } from '$shared/utf8.js';
import { openSheetHandler } from '~/bridge/scripts/openSheet.js';

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

describe('open_sheet', () => {
   /** @type {object} The `game` global before the test replaced it. */
   let savedGame;
   /** @type {{ render: Function, rendered: boolean, id: string }} The mocked sheet. */
   let sheet;
   /** @type {Record<string, unknown>} The mocked document `fromUuid` resolves. */
   let document;
   /** @type {{ id: string, name: string, active: boolean, query: Function }} The connected player. */
   let player;

   beforeEach(() => {
      savedGame = globalThis.game;
      sheet = {
         id: 'MockSheet-Actor-MOCKACTOR0000001',
         rendered: false,
         render: vi.fn(async () => {
            sheet.rendered = true;
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
            appId: 'MockSheet-Actor-MOCKACTOR0000001',
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
      vi.useRealTimers();
      globalThis.game = savedGame;
      delete globalThis.fromUuid;
   });

   it('renders on this client when no userId is given, sending no query', async () => {
      expect(await openSheetHandler({ uuid }, ctx)).toEqual({
         ok: true,
         appId: 'MockSheet-Actor-MOCKACTOR0000001',
      });
      expect(sheet.render).toHaveBeenCalledWith({ force: true });
      expect(player.query).not.toHaveBeenCalled();
   });

   it('renders on this client when userId is this client\'s own user', async () => {
      expect(await openSheetHandler({
         uuid,
         userId: 'MOCKGAMEMASTER01',
      }, ctx)).toEqual({
         ok: true,
         appId: 'MockSheet-Actor-MOCKACTOR0000001',
      });
      expect(player.query).not.toHaveBeenCalled();
   });

   it('throws a local render refusal as a ScriptError', async () => {
      document.sheet = null;
      const error = await refusal(openSheetHandler({ uuid }, ctx));
      expect(error.name).toBe('ScriptError');
      expect(error.code).toBe('SHEET_UNAVAILABLE');
   });

   it('sends wiretap.openSheet with the canonical uuid and a 5000 ms timeout', async () => {
      expect(await openSheetHandler({
         uuid: 'Actor.MOCKACTOR0000001',
         userId: 'MOCKPLAYER000001',
      }, ctx)).toEqual({
         ok: true,
         appId: 'MockSheet-Actor-MOCKACTOR0000001',
      });
      expect(player.query).toHaveBeenCalledWith('wiretap.openSheet', { uuid: 'Actor.MOCKACTOR0000001' }, {
         timeout: 5000,
      });
      expect(sheet.render).not.toHaveBeenCalled();
   });

   it('sends the canonical uuid when the caller named the document another way', async () => {
      globalThis.fromUuid = vi.fn(async () => document);
      await openSheetHandler({
         uuid: 'Compendium.world.actors.Actor.MOCKACTOR0000001',
         userId: 'MOCKPLAYER000001',
      }, ctx);
      expect(player.query.mock.calls[0][1]).toEqual({ uuid: 'Actor.MOCKACTOR0000001' });
   });

   it('refuses an unknown userId with ARGS_INVALID', async () => {
      const error = await refusal(openSheetHandler({
         uuid,
         userId: 'MOCKNOBODY000001',
      }, ctx));
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toBe('No user \'MOCKNOBODY000001\'.');
   });

   it('refuses an offline user with USER_OFFLINE naming the user and sends nothing', async () => {
      player.active = false;
      const error = await refusal(openSheetHandler({
         uuid,
         userId: 'MOCKPLAYER000001',
      }, ctx));
      expect(error.code).toBe('USER_OFFLINE');
      expect(error.message).toContain('MOCK_Player');
      expect(player.query).not.toHaveBeenCalled();
   });

   it('passes the target client\'s refusal code through', async () => {
      player.query = vi.fn(async () => ({
         ok: false,
         code: 'SHEET_DENIED',
         message: 'This user needs OBSERVER on the document to see its sheet.',
      }));
      const error = await refusal(openSheetHandler({
         uuid,
         userId: 'MOCKPLAYER000001',
      }, ctx));
      expect(error.code).toBe('SHEET_DENIED');
      expect(error.message).toBe('This user needs OBSERVER on the document to see its sheet.');
   });

   it('reports SHEET_QUERY_FAILED when the query rejects', async () => {
      player.query = vi.fn(async () => {
         throw new Error('MOCK query timed out');
      });
      const error = await refusal(openSheetHandler({
         uuid,
         userId: 'MOCKPLAYER000001',
      }, ctx));
      expect(error.code).toBe('SHEET_QUERY_FAILED');
      expect(error.message).toBe('MOCK query timed out');
   });

   it('reports SHEET_QUERY_FAILED for a refusal whose code is not a code', async () => {
      player.query = vi.fn(async () => ({
         ok: false,
         code: 'not a code',
         message: 'MOCK',
      }));
      const error = await refusal(openSheetHandler({
         uuid,
         userId: 'MOCKPLAYER000001',
      }, ctx));
      expect(error.code).toBe('SHEET_QUERY_FAILED');
      expect(error.message).toBe('The user\'s client sent an unexpected reply.');
   });

   it('reports SHEET_QUERY_FAILED for a reply without a text appId', async () => {
      player.query = vi.fn(async () => ({ ok: true }));
      const error = await refusal(openSheetHandler({
         uuid,
         userId: 'MOCKPLAYER000001',
      }, ctx));
      expect(error.code).toBe('SHEET_QUERY_FAILED');
   });

   it('keeps the result within 128 bytes for a 200-character app id', async () => {
      sheet.id = 'S'.repeat(200);
      expect(utf8Bytes(JSON.stringify(await openSheetHandler({ uuid }, ctx)))).toBeLessThanOrEqual(128);
      player.query = vi.fn(async () => ({
         ok: true,
         appId: 'R'.repeat(200),
      }));
      expect(utf8Bytes(JSON.stringify(await openSheetHandler({
         uuid,
         userId: 'MOCKPLAYER000001',
      }, ctx)))).toBeLessThanOrEqual(128);
   });

   it('keeps the result within 128 bytes of JSON and free of control characters for a reply of quotes and controls',
      async () => {
         player.query = vi.fn(async () => ({
            ok: true,
            appId: '"\\\u0001\u001f\u0085'.repeat(60),
         }));
         /** @type {{ ok: true, appId: string }} The bounded result. */
         const result = await openSheetHandler({
            uuid,
            userId: 'MOCKPLAYER000001',
         }, ctx);
         expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(128);
         expect(CONTROL_PATTERN.test(result.appId)).toBe(false);
         expect(result.appId.startsWith('"\\')).toBe(true);
      });

   it('reports SHEET_QUERY_FAILED after 5000 ms when the target client never answers', async () => {
      vi.useFakeTimers();
      player.query = vi.fn(() => new Promise(() => {}));
      /** @type {{ settled: boolean }} Whether the call has ended. */
      const state = { settled: false };
      /** @type {Promise<any>} The pending refusal. */
      const pending = refusal(openSheetHandler({
         uuid,
         userId: 'MOCKPLAYER000001',
      }, ctx)).finally(() => {
         state.settled = true;
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await pending;
      expect(error.code).toBe('SHEET_QUERY_FAILED');
      expect(error.message).toBe('The user\'s client did not answer within 5000 ms.');
   });

   it('refuses a wiretap setting with DOC_EXCLUDED', async () => {
      document = {
         uuid: 'Setting.MOCKSETTING000001',
         documentName: 'Setting',
         key: 'wiretap.serverUrl',
         sheet,
      };
      const error = await refusal(openSheetHandler({ uuid: 'Setting.MOCKSETTING000001' }, ctx));
      expect(error.code).toBe('DOC_EXCLUDED');
      expect(sheet.render).not.toHaveBeenCalled();
   });

   it('reports DOC_NOT_FOUND for a uuid that does not resolve', async () => {
      expect((await refusal(openSheetHandler({ uuid: 'Actor.MOCKMISSING00001' }, ctx))).code).toBe('DOC_NOT_FOUND');
   });
});
