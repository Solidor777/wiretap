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

   test('mirrors the live session to both the docked tab and the pop-out (fan-out regression)', async ({ page }) => {
      await openTab(page, MARKER_CMD);
      await page.locator('#sidebar section.wiretap button.wiretap__toggle').click();
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 15_000 });

      await page.evaluate(() => game.modules.get('wiretap').api._probe.popout());
      const popout = page.locator('.sidebar-popout section.wiretap .xterm-rows');
      await expect(popout).toContainText('READY-MARK', { timeout: 10_000 });
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toContainText('READY-MARK');
   });

   test('relaunch reaches the docked tab after a pop-out + close (relaunch regression)', async ({ page }) => {
      await openTab(page, MARKER_CMD);
      const toggle = page.locator('#sidebar section.wiretap button.wiretap__toggle');
      await toggle.click();
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 15_000 });

      await page.evaluate(() => game.modules.get('wiretap').api._probe.popout());
      await expect(page.locator('.sidebar-popout section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 10_000 });

      await toggle.click();
      await expect(toggle).toHaveText(/Launch/);
      await toggle.click();
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 15_000 });
   });
});
