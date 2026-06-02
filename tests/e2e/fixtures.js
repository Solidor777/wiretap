import { expect } from '@playwright/test';
import { DEFAULT_GM } from './users.js';

/**
 * Authenticate against the live Foundry v14 `/join` screen and wait for the world to become ready.
 * @param {import('@playwright/test').Page} page - The Playwright page to drive.
 * @param {string} [user] - Display name of the user to log in as. Defaults to FOUNDRY_USER or DEFAULT_GM.
 * @returns {Promise<void>} Resolves once `game.ready === true`.
 */
export async function login(page, user = process.env.FOUNDRY_USER || DEFAULT_GM) {
   // Navigate to the join screen and select the configured user.
   await page.goto('/join');
   await page.selectOption('select[name="userid"]', { label: user });

   // Fill the password only when one is configured (the test world has none by default).
   if (process.env.FOUNDRY_PASSWORD) {
      await page.fill('input[name="password"]', process.env.FOUNDRY_PASSWORD);
   }

   // Submit the join form and wait for the world to load and become ready.
   await page.click('button[name="join"]');
   await page.waitForURL('**/game');
   await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60_000 });
}

// A deterministic, long-lived command: prints a marker then ticks, so output persists for assertions. Runs a
// committed script (not inline `node -e "..."`) because node-pty's Windows arg-escaping mangles nested quotes.
export const MARKER_CMD = 'node tests/e2e/marker.js';

/**
 * Log in, set the terminal command, open the Wiretap tab, and wait for the toggle to be enabled in a clean
 * (idle) state — closing any session a reused sidecar may have left running.
 * @param {import('@playwright/test').Page} page - The Playwright page.
 * @param {string} command - The deterministic command to launch.
 * @returns {Promise<void>} Resolves with the tab open and the toggle showing Launch.
 */
export async function openTab(page, command) {
   await login(page);
   // Foundry's permanent "no hardware acceleration" toast (headless Chromium has no GPU) overlays the sidebar
   // and intercepts pointer events; make the whole notifications layer non-interactive (the `*` is needed —
   // the `<li>` toasts carry their own pointer-events) and clear any already-shown toasts so clicks land.
   await page.addStyleTag({ content: '#notifications, #notifications * { pointer-events: none !important; }' });
   await page.evaluate(() => globalThis.ui?.notifications?.clear?.());
   await page.evaluate((cmd) => game.settings.set('wiretap', 'terminalCommand', cmd), command);
   await page.locator('#sidebar nav.tabs [data-tab="wiretap"]').click();
   const toggle = page.locator('#sidebar section.wiretap button.wiretap__toggle');
   await expect(toggle).toBeEnabled();
   await page.evaluate(() => {
      const probe = game.modules.get('wiretap')?.api?._probe;
      if (probe?.terminal?.running()) {
         probe.terminal.close();
      }
   });
   await expect(toggle).toHaveText(/Launch/, { timeout: 10_000 });
}
