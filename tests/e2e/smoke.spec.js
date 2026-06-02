import { test, expect } from '@playwright/test';
import { login } from './fixtures.js';

test.describe('wiretap terminal tab smoke', () => {
   test.beforeEach(async ({ page }) => {
      await login(page);
   });

   test('module is active and tab is registered', async ({ page }) => {
      const state = await page.evaluate(() => ({
         active: game.modules.get('wiretap')?.active === true,
         registered: game.modules.get('wiretap')?.api?._probe?.tabRegistered() === true,
      }));
      expect(state.active, 'wiretap module must be enabled in the test world').toBe(true);
      expect(state.registered, 'wiretap sidebar tab must be registered').toBe(true);
   });

   test('sidebar tab shows the terminal panel and a Launch control', async ({ page }) => {
      const button = page.locator('#sidebar nav.tabs [data-tab="wiretap"]');
      await expect(button).toHaveCount(1);
      await button.click();
      await expect(page.locator('#sidebar section.wiretap .wiretap__terminal')).toBeVisible();
      await expect(page.locator('#sidebar section.wiretap button.wiretap__toggle')).toBeVisible();
   });
});
