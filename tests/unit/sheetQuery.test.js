import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
   CLOSE_SHEET_QUERY,
   OPEN_SHEET_QUERY,
   handleCloseSheetQuery,
   handleOpenSheetQuery,
   registerSheetQueries,
} from '~/bridge/sheetQuery.js';

/** @type {string} The uuid of the mocked actor. */
const uuid = 'Actor.MOCKACTOR0000001';

/** @type {{ isGM: boolean }} A GM sender, as the query context carries it. */
const gm = { isGM: true };

describe('the wiretap sheet user queries', () => {
   /** @type {object} The `game` global before the test replaced it. */
   let savedGame;
   /** @type {object} The `CONFIG` global before the test replaced it. */
   let savedConfig;
   /** @type {{ render: Function, close: Function, rendered: boolean, id: string }} The mocked sheet. */
   let sheet;
   /** @type {{ uuid: string, documentName: string, sheet: object, testUserPermission: Function }} The mocked actor. */
   let document;
   /** @type {{ id: string }} This client's user. */
   let game;

   beforeEach(() => {
      savedGame = globalThis.game;
      savedConfig = globalThis.CONFIG;
      sheet = {
         id: 'MockSheet-Actor-MOCKACTOR0000001',
         rendered: false,
         render: vi.fn(async () => {
            sheet.rendered = true;
         }),
         close: vi.fn(async () => {
            sheet.rendered = false;
         }),
      };
      document = {
         uuid,
         documentName: 'Actor',
         sheet,
         testUserPermission: vi.fn(() => true),
      };
      game = { user: { id: 'MOCKPLAYER000001' } };
      globalThis.game = game;
      globalThis.CONFIG = { queries: {} };
      globalThis.fromUuid = vi.fn(async (wanted) => (wanted === uuid ? document : null));
   });

   afterEach(() => {
      globalThis.game = savedGame;
      globalThis.CONFIG = savedConfig;
      delete globalThis.fromUuid;
   });

   it('refuses a sender who is not a GM and renders nothing', async () => {
      expect(await handleOpenSheetQuery({ uuid: 'Actor.MOCKACTOR0000001' }, { user: { isGM: false } })).toEqual({
         ok: false,
         code: 'SHEET_DENIED',
         message: expect.stringContaining('GM'),
      });
      expect(sheet.render).not.toHaveBeenCalled();
   });

   it('refuses a query with no sender', async () => {
      expect((await handleOpenSheetQuery({ uuid }, {})).code).toBe('SHEET_DENIED');
      expect(sheet.render).not.toHaveBeenCalled();
   });

   it('refuses when this client\'s user lacks OBSERVER, LIMITED included', async () => {
      document.testUserPermission = vi.fn(() => false);
      expect((await handleOpenSheetQuery({ uuid }, { user: gm })).code).toBe('SHEET_DENIED');
      expect(document.testUserPermission).toHaveBeenCalledWith(game.user, 'OBSERVER');
      expect(sheet.render).not.toHaveBeenCalled();
   });

   it('renders the sheet for a GM sender when the user has OBSERVER', async () => {
      expect(await handleOpenSheetQuery({ uuid }, { user: gm })).toEqual({
         ok: true,
         appId: 'MockSheet-Actor-MOCKACTOR0000001',
      });
      expect(sheet.render).toHaveBeenCalledWith({ force: true });
   });

   it('reports SHEET_UNAVAILABLE when Foundry declines to render', async () => {
      sheet.render = vi.fn(async () => {});
      expect(await handleOpenSheetQuery({ uuid }, { user: gm })).toEqual({
         ok: false,
         code: 'SHEET_UNAVAILABLE',
         message: 'Foundry did not render the sheet.',
      });
   });

   it('reports SHEET_UNAVAILABLE for a document without a sheet', async () => {
      document.sheet = null;
      expect(await handleOpenSheetQuery({ uuid }, { user: gm })).toEqual({
         ok: false,
         code: 'SHEET_UNAVAILABLE',
         message: 'This document has no sheet.',
      });
   });

   it('reports DOC_NOT_FOUND for a uuid that does not resolve', async () => {
      expect((await handleOpenSheetQuery({ uuid: 'Actor.MOCKMISSING00001' }, { user: gm })).code).toBe('DOC_NOT_FOUND');
   });

   it('reports ARGS_INVALID for a uuid that is not text', async () => {
      expect((await handleOpenSheetQuery({ uuid: 7 }, { user: gm })).code).toBe('ARGS_INVALID');
      expect((await handleOpenSheetQuery(null, { user: gm })).code).toBe('ARGS_INVALID');
      expect(globalThis.fromUuid).not.toHaveBeenCalled();
   });

   it('never throws: an exception from the sheet becomes SHEET_UNAVAILABLE', async () => {
      sheet.render = vi.fn(async () => {
         throw new Error('MOCK render failure');
      });
      expect(await handleOpenSheetQuery({ uuid }, { user: gm })).toEqual({
         ok: false,
         code: 'SHEET_UNAVAILABLE',
         message: 'MOCK render failure',
      });
   });

   it('close: refuses a sender who is not a GM and closes nothing', async () => {
      sheet.rendered = true;
      expect(await handleCloseSheetQuery({ uuid }, { user: { isGM: false } })).toEqual({
         ok: false,
         code: 'SHEET_DENIED',
         message: expect.stringContaining('GM'),
      });
      expect(sheet.close).not.toHaveBeenCalled();
   });

   it('close: closes a rendered sheet for a GM sender', async () => {
      sheet.rendered = true;
      expect(await handleCloseSheetQuery({ uuid }, { user: gm })).toEqual({
         ok: true,
         closed: true,
      });
      expect(sheet.close).toHaveBeenCalledTimes(1);
   });

   it('close: reports closed false when the sheet is not open', async () => {
      expect(await handleCloseSheetQuery({ uuid }, { user: gm })).toEqual({
         ok: true,
         closed: false,
      });
      expect(sheet.close).not.toHaveBeenCalled();
   });

   it('close: reports DOC_NOT_FOUND for a uuid that does not resolve', async () => {
      expect((await handleCloseSheetQuery({ uuid: 'Actor.MOCKMISSING00001' }, { user: gm })).code)
         .toBe('DOC_NOT_FOUND');
   });

   it('close: reports ARGS_INVALID for a uuid that is not text', async () => {
      expect((await handleCloseSheetQuery({}, { user: gm })).code).toBe('ARGS_INVALID');
   });

   it('close: never throws, an exception from the sheet becomes SHEET_UNAVAILABLE', async () => {
      sheet.rendered = true;
      sheet.close = vi.fn(async () => {
         throw new Error('MOCK close failure');
      });
      expect(await handleCloseSheetQuery({ uuid }, { user: gm })).toEqual({
         ok: false,
         code: 'SHEET_UNAVAILABLE',
         message: 'MOCK close failure',
      });
   });

   it('registers both queries', () => {
      registerSheetQueries();
      expect(OPEN_SHEET_QUERY).toBe('wiretap.openSheet');
      expect(CLOSE_SHEET_QUERY).toBe('wiretap.closeSheet');
      expect(CONFIG.queries['wiretap.openSheet']).toBe(handleOpenSheetQuery);
      expect(CONFIG.queries['wiretap.closeSheet']).toBe(handleCloseSheetQuery);
   });
});
