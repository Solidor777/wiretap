# Open bugs

## `npm run foundry:start` does not stop Foundry when the invoking process is stopped

- **Where:** `scripts/e2e-foundry-server.mjs` (adopted from the titan system), `scripts/lib/superviseServer.mjs`.
- **Measured (2026-10-11):** the launcher was started as a background task (`npm run foundry:start`). Stopping that task
  ended the `npm` wrapper, but the supervisor (`node scripts/e2e-foundry-server.mjs`) and the Foundry server
  (`node main.js ...`) kept running and kept serving :30000 until the supervisor's process tree was killed with
  `taskkill /T /F`.
- **Read, not measured:** the supervisor watches the nearest non-shell ancestor of itself (`pickWatchPid`). Under
  Playwright that is the runner, so the pattern works there; started from `npm`, the watched process is something
  longer-lived than the `npm` wrapper.
- **Impact:** standalone use leaves Foundry running (holding the port and pack locks) after the starter is stopped.
- **Fix direction:** decide whether the standalone script should watch its own invoking process or document an explicit
  stop command; needs a decision because it changes the shared supervisor behaviour.
