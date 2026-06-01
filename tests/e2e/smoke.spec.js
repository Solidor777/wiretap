import { test, expect } from '@playwright/test';
import { login } from './fixtures.js';

test.describe('wiretap scaffold smoke', () => {
   // A ready world with the wiretap module enabled is required for sidebar introspection.
   test.beforeEach(async ({ page }) => {
      await login(page);
   });

   // The module must be active and its sidebar tab registered in the live runtime.
   test('module is active and tab is registered', async ({ page }) => {
      const state = await page.evaluate(() => ({
         active: game.modules.get('wiretap')?.active === true,
         registered: game.modules.get('wiretap')?.api?._probe?.tabRegistered() === true,
      }));
      expect(state.active, 'wiretap module must be enabled in the test world').toBe(true);
      expect(state.registered, 'wiretap sidebar tab must be registered').toBe(true);
   });

   // The sidebar nav button must exist, and clicking it must mount the Svelte component.
   test('sidebar tab renders the mounted component', async ({ page }) => {
      const button = page.locator('#sidebar nav.tabs [data-tab="wiretap"]');
      await expect(button).toHaveCount(1);
      await button.click();
      await expect(page.locator('section.wiretap .wiretap__counter')).toBeVisible();
   });

   // Popping the tab out must mount the same component in a standalone window.
   test('tab pops out into its own window', async ({ page }) => {
      await page.evaluate(() => game.modules.get('wiretap').api._probe.popout());
      await expect(page.locator('.sidebar-popout section.wiretap')).toBeVisible();
   });
});
