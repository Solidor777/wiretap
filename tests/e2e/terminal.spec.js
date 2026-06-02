import { test, expect } from '@playwright/test';
import { openTab, MARKER_CMD } from './fixtures.js';
import { startSidecar, stopSidecar } from './sidecar.js';

// Each spec file runs against its own fresh sidecar so cumulative PTY kill/respawn churn stays bounded.
let sidecar;
test.beforeAll(async () => {
   sidecar = await startSidecar();
});
test.afterAll(async () => {
   await stopSidecar(sidecar);
});

test.describe('wiretap terminal relay', () => {
   // Ensure no PTY leaks between serial tests.
   test.afterEach(async ({ page }) => {
      await page.evaluate(() => game.modules.get('wiretap')?.api?._probe?.terminal?.close());
   });

   test('launches a command, renders output in xterm, and clears on close', async ({ page }) => {
      await openTab(page, MARKER_CMD);
      const toggle = page.locator('#sidebar section.wiretap button.wiretap__toggle');
      await toggle.click();
      const rows = page.locator('#sidebar section.wiretap .xterm-rows');
      await expect(rows).toContainText('READY-MARK', { timeout: 15_000 });
      await expect(toggle).toHaveText(/Close/);
      await toggle.click();
      await expect(rows).not.toContainText('READY-MARK', { timeout: 10_000 });
      await expect(toggle).toHaveText(/Launch/);
   });

   test('pop-out takes over the live terminal; the docked tab shows the placeholder', async ({ page }) => {
      await openTab(page, MARKER_CMD);
      await page.locator('#sidebar section.wiretap button.wiretap__toggle').click();
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 15_000 });

      await page.evaluate(() => game.modules.get('wiretap').api._probe.popout());
      // The pop-out shows the live terminal; the docked tab yields it and shows the placeholder (no docked xterm).
      await expect(page.locator('.sidebar-popout section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 10_000 });
      await expect(page.locator('#sidebar section.wiretap .wiretap__popped-out')).toBeVisible();
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toHaveCount(0);
   });

   test('closing the pop-out returns the live terminal to the docked tab with scrollback', async ({ page }) => {
      await openTab(page, MARKER_CMD);
      await page.locator('#sidebar section.wiretap button.wiretap__toggle').click();
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 15_000 });

      await page.evaluate(() => game.modules.get('wiretap').api._probe.popout());
      await expect(page.locator('.sidebar-popout section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 10_000 });
      await expect(page.locator('#sidebar section.wiretap .wiretap__popped-out')).toBeVisible();

      // Close the pop-out → the terminal returns to the docked tab, re-attached with its scrollback.
      await page.evaluate(() => game.modules.get('wiretap').api._probe.closePopout());
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 15_000 });
   });
});
