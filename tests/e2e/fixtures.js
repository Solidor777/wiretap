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
