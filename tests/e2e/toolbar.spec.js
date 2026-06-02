import { test, expect } from '@playwright/test';
import { openTab, MARKER_CMD } from './fixtures.js';
import { startSidecar, stopSidecar } from './sidecar.js';

/**
 * Locate a toolbar tool button by its accessible label within the docked Wiretap tab.
 * @param {import('@playwright/test').Page} page - The Playwright page.
 * @param {string} label - The button's aria-label.
 * @returns {import('@playwright/test').Locator} The button locator.
 */
function tool(page, label) {
   return page.locator(`#sidebar section.wiretap button.wiretap__tool[aria-label="${label}"]`);
}

// Each spec file runs against its own fresh sidecar so cumulative PTY kill/respawn churn stays bounded.
let sidecar;
test.beforeAll(async () => {
   sidecar = await startSidecar();
});
test.afterAll(async () => {
   await stopSidecar(sidecar);
});

// NOTE: these specs need a live PTY. node-pty's Windows ConPTY backend intermittently severs long-lived PTYs
// (spurious exit + the `conpty_console_list_agent` AttachConsole crash seen in the sidecar log), which flakes
// terminal e2e on this machine (the pre-existing terminal.spec pop-out tests flake the same way on a clean
// checkout). Node 22 LTS substantially reduces it vs Node 25 (single runs are commonly clean) but does not
// fully eliminate it — full reliability needs the sidecar PTY-shutdown hardening (see TODO.md). Each test is
// kept short so the PTY only has to survive a few seconds.
test.describe('wiretap terminal toolbar', () => {
   // Ensure no PTY leaks between serial tests.
   test.afterEach(async ({ page }) => {
      await page.evaluate(() => game.modules.get('wiretap')?.api?._probe?.terminal?.close());
   });

   test('action buttons are disabled when idle and enabled when running', async ({ page }) => {
      await openTab(page, MARKER_CMD);
      // Connected but idle: the toolbar is present and the action buttons are disabled.
      await expect(tool(page, 'Clear terminal')).toBeDisabled();
      await expect(tool(page, 'Copy')).toBeDisabled();
      await expect(tool(page, 'Restart')).toBeDisabled();
      await expect(tool(page, 'Decrease font size')).toBeVisible();
      await expect(tool(page, 'Increase font size')).toBeVisible();

      // Launch a session: the action buttons become enabled.
      const toggle = page.locator('#sidebar section.wiretap button.wiretap__toggle');
      await toggle.click();
      const rows = page.locator('#sidebar section.wiretap .xterm-rows');
      await expect(rows).toContainText('READY-MARK', { timeout: 15_000 });
      await expect(tool(page, 'Clear terminal')).toBeEnabled();
      await expect(tool(page, 'Copy')).toBeEnabled();
      await expect(tool(page, 'Restart')).toBeEnabled();
   });

   test('Clear wipes the on-screen scrollback', async ({ page }) => {
      await openTab(page, MARKER_CMD);
      await page.locator('#sidebar section.wiretap button.wiretap__toggle').click();
      const rows = page.locator('#sidebar section.wiretap .xterm-rows');
      await expect(rows).toContainText('READY-MARK', { timeout: 15_000 });
      await tool(page, 'Clear terminal').click();
      await expect(rows).not.toContainText('READY-MARK', { timeout: 10_000 });
   });

   test('Copy puts the terminal buffer on the clipboard', async ({ page }) => {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await openTab(page, MARKER_CMD);
      await page.locator('#sidebar section.wiretap button.wiretap__toggle').click();
      await expect(page.locator('#sidebar section.wiretap .xterm-rows')).toContainText('READY-MARK', { timeout: 15_000 });
      await tool(page, 'Copy').click();
      await expect
         .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
         .toContain('READY-MARK');
   });

   test('Font +/- persist the terminal font size setting', async ({ page }) => {
      await openTab(page, MARKER_CMD);
      // Normalize to the default so the assertions are deterministic.
      await page.evaluate(() => game.settings.set('wiretap', 'terminalFontSize', 16));
      await tool(page, 'Increase font size').click();
      await expect
         .poll(() => page.evaluate(() => game.settings.get('wiretap', 'terminalFontSize')), { timeout: 5_000 })
         .toBe(18);
      await tool(page, 'Decrease font size').click();
      await expect
         .poll(() => page.evaluate(() => game.settings.get('wiretap', 'terminalFontSize')), { timeout: 5_000 })
         .toBe(16);
   });

   test('Restart relaunches the command', async ({ page }) => {
      await openTab(page, MARKER_CMD);
      const rows = page.locator('#sidebar section.wiretap .xterm-rows');
      await page.locator('#sidebar section.wiretap button.wiretap__toggle').click();
      await expect(rows).toContainText('READY-MARK', { timeout: 15_000 });
      // Restart closes the running PTY (the reset-on-close effect blanks the screen), then relaunches it: a
      // fresh process reprints the marker. Asserting the marker disappears and returns proves the relaunch.
      await tool(page, 'Restart').click();
      await expect(rows).not.toContainText('READY-MARK', { timeout: 10_000 });
      await expect(rows).toContainText('READY-MARK', { timeout: 15_000 });
   });
});
