import { test, expect } from '@playwright/test';
import { login } from './fixtures.js';

// A deterministic, long-lived command: prints a marker then ticks, so output persists for assertions.
const MARKER_CMD = 'node -e "process.stdout.write(\'READY-MARK\'); setInterval(() => process.stdout.write(\'.\'), 300)"';

/**
 * Log in, set the terminal command, open the Wiretap tab, and wait for the toggle to be enabled.
 * @param {import('@playwright/test').Page} page - The Playwright page.
 * @param {string} command - The deterministic command to launch.
 * @returns {Promise<void>} Resolves with the tab open and the toggle enabled.
 */
async function openTab(page, command) {
   await login(page);
   await page.evaluate((cmd) => game.settings.set('wiretap', 'terminalCommand', cmd), command);
   await page.locator('#sidebar nav.tabs [data-tab="wiretap"]').click();
   const toggle = page.locator('#sidebar section.wiretap button.wiretap__toggle');
   await expect(toggle).toBeEnabled();
   // Ensure a clean (closed) starting state: a sidecar reused across runs may already have a session,
   // which would make the first toggle click a Close instead of a Launch. Close it and wait for Launch.
   await page.evaluate(() => {
      const probe = game.modules.get('wiretap')?.api?._probe;
      if (probe?.terminal?.running()) {
         probe.terminal.close();
      }
   });
   await expect(toggle).toHaveText(/Launch/, { timeout: 10_000 });
}

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
