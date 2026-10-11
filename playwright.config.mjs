import { defineConfig } from '@playwright/test';

export default defineConfig({
   testDir: './tests/e2e',
   timeout: 60_000,
   fullyParallel: false,
   workers: 1,
   globalSetup: './tests/e2e/global-setup.js',
   use: {
      baseURL: 'http://localhost:30000',
      headless: true,
   },
   // scripts/e2e-foundry-server.mjs reuses a Foundry already answering on :30000, otherwise launches one on the
   // configured world and kills it when the run ends.
   webServer: {
      command: 'node scripts/e2e-foundry-server.mjs',
      url: 'http://localhost:30000',
      reuseExistingServer: true,
      timeout: 120_000,
   },
});
