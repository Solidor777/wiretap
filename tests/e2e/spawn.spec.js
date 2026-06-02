import { test, expect } from '@playwright/test';
import { openTab } from './fixtures.js';

// A command with nested quotes. node-pty's Windows array-arg escaping used to mangle this (the setInterval
// keep-alive was dropped, so it printed once then exited). With resolveSpawn returning a verbatim string the
// command runs intact. This spec needs a live PTY runtime — see the note in toolbar.spec.js.
const QUOTED_CMD =
   'node -e "process.stdout.write(\'QUOTED-OK\\r\\n\'); setInterval(() => process.stdout.write(\'.\'), 300)"';

test.describe('wiretap command spawn', () => {
   test.afterEach(async ({ page }) => {
      await page.evaluate(() => game.modules.get('wiretap')?.api?._probe?.terminal?.close());
   });

   test('launches a command containing quotes without truncating it', async ({ page }) => {
      await openTab(page, QUOTED_CMD);
      await page.locator('#sidebar section.wiretap button.wiretap__toggle').click();
      const rows = page.locator('#sidebar section.wiretap .xterm-rows');
      await expect(rows).toContainText('QUOTED-OK', { timeout: 15_000 });
      // The keep-alive survived (the bug made it exit right after printing): still running a few seconds on.
      await page.waitForTimeout(3_000);
      const running = await page.evaluate(() => game.modules.get('wiretap').api._probe.terminal.running());
      expect(running).toBe(true);
   });
});
