# Open bugs

## Terminal socket handlers do not validate payloads

- **Where:** `server/terminal.ts` input and resize handlers read `payload.data`, `payload.cols`, `payload.rows`
  without validating the payload (found by review; read, not run).
- **Inferred, not measured:** an undefined payload or a non-numeric size throws inside a Socket.IO listener, which
  likely terminates the sidecar as an uncaught exception.
- **Fix direction:** validate like the launch handler (R1.7).

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

## `mcpConfigFile.test.js` fails when a process id is reused

- **Where:** `tests/unit/mcpConfigFile.test.js`, `freshRoot(name)`: roots are `test/tmp/mcpConfigFile/<pid>-<counter>`.
- **Measured (2026-10-11):** one full `npm test` run failed 7 tests on the "scratch root must not exist yet" assertion;
  the file passed alone and in the next two full runs. `test/tmp/mcpConfigFile/` holds 121 leftover directories, none
  deletable by the no-deletion rule, so a reused pid plus counter collides with an older run's directory.
- **Fix direction:** add a time or random component to the root name (for example `<pid>-<Date.now()>-<counter>`).
