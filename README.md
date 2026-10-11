# Wiretap

A Foundry VTT v14 module that adds a tab and a bridge for AI agents inside Foundry. Built with
Svelte 5 (runes), SCSS, and Vite.

## Development

- `npm run dev` — Vite dev server (proxies to Foundry on :30000)
- `npm run build` — production build (emits `index.js` + `style.css`)
- `npm test` — unit tests (Vitest)
- `npm run test:e2e` — end-to-end tests (Playwright)
- `npm run foundry:start` — starts Foundry on the configured world if nothing answers on the port, and stays up until
  the process ends

## Running e2e / starting Foundry

`npm run test:e2e` starts Foundry itself through `scripts/e2e-foundry-server.mjs` when nothing answers on
`:30000`, reuses a running server otherwise, and stops a server it started when the run ends. The launched world
(default `test-titan`) must have Wiretap enabled. Defaults derive from the module location (userdata three levels
up, Foundry app in `<userdata>/../foundry`); override with `FOUNDRY_DATA_PATH`, `FOUNDRY_APP_DIR`, `FOUNDRY_PORT`,
`FOUNDRY_WORLD`, `FOUNDRY_SERVER_LOG` (default `debug/dumps/e2e-server.log`).

## Running the sidecar

Wiretap's terminal needs a small local Node sidecar (it runs the real PTY; a browser can't). Start it with
a single action:

- **Windows:** double-click `start-wiretap.cmd` in the module folder.
- **macOS/Linux:** run `./start-wiretap.sh` from the module folder.

A console window opens and stays up while the sidecar runs — its log shows `listening on http://127.0.0.1:31416`.
**Close that window (or press Ctrl-C) to stop the sidecar.** The Wiretap tab (GM-only) connects automatically
once the sidecar is up; until then it shows a "Sidecar not running" panel.

## MCP modes

The sidecar hosts a Streamable-HTTP MCP endpoint (default `http://127.0.0.1:31417/mcp`, loopback only; override the
port with `WIRETAP_MCP_PORT`) whose tools run against the live world through a GM-identified Foundry client.

- **In-session (default, `full` mode):** when the Wiretap terminal launches `claude` followed only by plain
  arguments (the default command is bare `claude`), the sidecar writes `.wiretap/mcp-<mcpPort>.json` in the module
  directory (the parent of `server/`, resolved from the server's own location; the directory is mode 0o700, the file
  0o600, gitignored) and appends `--mcp-config "<path>"`, so that `claude` sees the Wiretap tools with no setup. Wiring follows an allowlist: every argument must consist solely of
  `A-Z a-z 0-9 . _ : = / @ + , -`. Any other command line is launched unchanged and the skip is logged: a command
  that is not exactly `claude`, one that already passes `--mcp-config`, one with a standalone `--`, and one with any
  other character, which includes **every quoted argument** (for example `claude --append-system-prompt "..."` is
  not wired). The same applies if the config file cannot be written. The config file is rewritten on every wired
  launch (a symbolic link at the file path is refused) and is never deleted by the sidecar; a failed write is logged and
  the command is launched unchanged.
- **Standalone (`mcp-only` mode):** run the sidecar without the terminal relay and attach any MCP client:

  ```
  npm run server:mcp
  claude mcp add --transport http wiretap http://127.0.0.1:31417/mcp
  ```

  `--mcp-only` on the command line or `WIRETAP_MODE=mcp-only` selects this mode (the argument wins; `full` is the
  default and any other `WIRETAP_MODE` value exits with an error). The Socket.IO server and the Foundry bridge stay
  up (the Socket.IO server, like the MCP endpoint, binds `127.0.0.1` only and is not reachable from other machines) so the Foundry client can still identify as a GM.
