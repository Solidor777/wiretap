# The e2e Foundry server launcher

e2e needs Foundry on `:30000` with the module enabled and a GM user (see `tests/e2e/users.js`). Playwright's
`webServer.command` is `node scripts/e2e-foundry-server.mjs` (`reuseExistingServer: true`, 120 s): if nothing
answers on the port it runs `node main.js --dataPath=<userdata> --world=<world>` from the Foundry app dir, otherwise
it reuses the running server. A server it launched is killed when the run ends (signals, process exit, or the
watched process vanishing). Under Playwright the watched process is the nearest non-shell ancestor
(`pickWatchPid`). `npm run foundry:start` passes `--standalone`: the watched process is the one that launched the run
(`pickStandaloneWatchPid(ancestors, viaNpm)`: skip leading shells, skip the npm wrapper when `npm_execpath` is set,
take the next ancestor, shells included; without npm the nearest ancestor; `process.ppid` when the chain is
exhausted), so stopping the invoker stops Foundry. Defaults: userdata = three levels above the module folder, app dir = `<userdata>/../foundry`,
port `30000`, world `test-titan`, log `debug/dumps/e2e-server.log` (gitignored `debug/`). Overrides:
`FOUNDRY_DATA_PATH`, `FOUNDRY_APP_DIR`, `FOUNDRY_PORT`, `FOUNDRY_WORLD`, `FOUNDRY_SERVER_LOG`. The launcher does not
enable the module; the launched world must already have it enabled. `scripts/lib/superviseServer.mjs` holds the
injectable parts, unit-tested in `tests/unit/SuperviseServer.test.js` with ephemeral ports and idle node processes
(no Foundry, never `:30000`).
