---
name: wiretap-sidecar
description: Wiretap Node sidecar — Socket.IO server, node-pty terminal relay, PTY spawn/backends, server entrypoint and composition, shared wire protocol. Use when reading or editing server/ or shared/ (for MCP and the Foundry bridge also load wiretap-mcp-bridge).
paths:
  - "server/**"
  - "shared/**"
---

# Wiretap sidecar (`server/`)

Current-state reference; verify against code before relying on a detail. Core context: `wiretap-codebase-core`.

## Composition

- `server/index.ts` — entrypoint. Reads `WIRETAP_PORT` (default 31416) and `WIRETAP_MCP_PORT` (default 31417), selects
  the mode via `resolveMode(process.argv.slice(2), process.env)` (an invalid `WIRETAP_MODE` logs an error and exits 1
  before listening), calls `createWiretapServer(port, mcpPort, mode)` and awaits `awaitStartup(server, onReady, exit)`;
  the mode / `listening on http://127.0.0.1:<port>` / MCP ready / `claude mcp add --transport http wiretap …` lines
  print only after both ports are bound. Disposes on SIGINT/SIGTERM.
- `server/serverMode.ts` — `ServerMode = 'full' | 'mcp-only'`; `resolveMode(argv, env)`: `--mcp-only` wins over
  `WIRETAP_MODE=mcp-only|full`; unset means `full`; any other value throws.
- `server/server.ts` — `createWiretapServer(port, mcpPort, mode = 'full')` returns `{ io, bridge, ready, dispose }` (`bridge` is the Foundry bridge; its `invoke` takes the per-call `endpoint` option). Creates an
  `http.Server`, listens on `127.0.0.1` only (not configurable; port 0 selects an ephemeral port), and attaches a
  Socket.IO `Server` to it (CORS origin list and `allowRequest` both read `ALLOWED_ORIGINS`; a handshake whose `Origin`
  header is present and not listed is refused, one with no `Origin` is accepted, and a refusal is logged as
  `Wiretap sidecar | refused origin "<origin cut to 64 bytes>"` through `createLogThrottle` (10 per minute, one
  `N further origin refusals suppressed` line after the window);
  `io.httpServer` is that server). `ready` resolves
  once both the Socket.IO port and the MCP port are bound (`address()` is null before then) and rejects with the first
  bind failure (for example `EADDRINUSE`); tests `await server.ready`
  before reading `io.httpServer.address().port`, `createFoundryBridge()`, `startMcpServer`. In `full` mode
  it also creates `createTerminalManager(io, undefined, { mcpPort })` and calls `terminal.handleConnection(socket)`;
  in `mcp-only` mode there is no terminal manager and terminal events are not handled. Every connection gets
  `bridge.handleConnection(socket)`. `dispose()` kills any PTY (full mode), then closes MCP, then Socket.IO, in nested try/finally so each step runs even if
  an earlier one throws (the first error propagates).
- `server/logThrottle.ts` — `createLogThrottle({ log, now, limit, windowMs, noun })`: fixed-window throttle for log
  lines an unauthenticated caller can trigger; writes `limit` lines per window, counts the rest and writes one
  `Wiretap sidecar | N further <noun> suppressed` line from the first call after the window (no timer). Used by
  `server.ts` (origin refusals) and `foundryBridge.ts` (identify refusals).
- `server/origins.ts` — `ALLOWED_ORIGINS` (`http://localhost:30000`, `http://127.0.0.1:30000` and the Vite dev-server
  page origins `http://localhost:30001`, `http://127.0.0.1:30001`; the one definition),
  `isOriginAllowed(origin)` (absent or listed; a repeated or comma-joined header never matches) and
  `isMcpHostAllowed(host, port)` (`127.0.0.1:<port>` or `localhost:<port>`, case-insensitive). Used by `server.ts`
  (Socket.IO handshake and CORS) and `mcp.ts` (the `/mcp` endpoint).
- `server/shutdown.ts` — `shutdown(dispose, exit)`: runs `dispose`, logs (does not rethrow) an error, and always calls
  `exit(0)`; the SIGINT/SIGTERM handlers in `index.ts` use it. `awaitStartup(server, onReady, exit)`: awaits
  `server.ready` then runs `onReady`; on rejection logs `Wiretap sidecar | failed to start: <cause>`, runs `dispose`
  (an error is logged, not rethrown) and calls `exit(1)`.
- npm scripts: `server:start` (full), `server:mcp` (`tsx server/index.ts --mcp-only`).

## Terminal relay

| File | Role |
|---|---|
| `server/terminal.ts` | `createTerminalManager(io, spawn?, options?)`; spawns `payload.command ?? 'claude'` via node-pty with `process.env`; relays `TERMINAL_*` events. `options.mcpPort` (> 0) enables MCP auto-wiring; `options.writeConfig(port, root?)` is an injectable config writer (default `writeMcpConfig`), `options.configRoot` the root passed to it (default: the module root). The launch handler ignores (logs) a payload that is not an object or whose `command` is neither absent nor a string. Every wired launch calls the writer again (rewrite, no existence check, no cached path); a writer failure is logged and the command is spawned unchanged. `dispose()` kills the PTY and clears state in `try/finally` (a kill error still propagates); it touches no files |
| `server/mcpWiring.ts` | Pure: `buildMcpConfig(port)`, `mcpConfigFileName(port)` (`mcp-<port>.json`), `planMcpWiring(command)` (the only command-line judgement; returns `{ kind: 'wire' }`, `{ kind: 'skip', reason }` or `{ kind: 'not-claude' }`), `isSafeConfigPath(path, platform)` (the only path-safety check; rejects `"` and `%` everywhere and `$`, backtick and `\` on POSIX), `wireMcpConfig(command, path)` (unconditional append of `--mcp-config "<path>"`). Wiring is an allowlist: the executable is exactly `claude` and every following space/tab-separated token consists solely of `[A-Za-z0-9._:=/@+,-]`; anything else (every quoted argument, any shell metacharacter, `^ # \ % $` backtick, newline) is skipped. A standalone `--` and an existing `--mcp-config` are skipped too. A config path containing `"` or `%` (and, on POSIX, `$`, a backtick or a backslash) is not wired. `terminal.ts` calls the plan once per launch and logs skips |
| `server/mcpConfigFile.ts` | `defaultConfigRoot()` (the module root, the parent of `server/`, from `import.meta.url`, never `process.cwd()`); `writeMcpConfig(port, root = defaultConfigRoot())` writes `<root>/.wiretap/mcp-<port>.json`: `mkdirSync` recursive mode 0o700, `lstatSync` on the `.wiretap` directory and then on the file path (a symbolic link throws; ENOENT proceeds), `writeFileSync` mode 0o600, overwriting every time. The modes apply only when the directory or file is created; the lstat-then-write sequence is a time-of-check to time-of-use residual risk (no `O_NOFOLLOW`). `.wiretap/` is gitignored. No deletion API exists anywhere in `server/`; the file is never removed |
| `server/spawnCommand.ts` | `resolveSpawn(command, platform, comspec)`: Windows → `ComSpec /c <command>` as a verbatim string (node-pty array escaping mangles quotes); POSIX → `/bin/sh -c` |
| `server/ptyOptions.ts` | `resolvePtyOptions(platform, env)`; Windows backend `conpty` (default) / `conpty-dll` / `winpty` via `WIRETAP_PTY_BACKEND` |

`spawnCommand.ts` and `ptyOptions.ts` are pure (no node-pty import) so unit tests do not load the native addon.

## Shared protocol

`shared/protocol.js` exports `TERMINAL_LAUNCH|INPUT|RESIZE|CLOSE|DATA|STATE|EXIT`, `PROTOCOL_VERSION` (2), `BRIDGE_IDENTIFY`,
`BRIDGE_INVOKE`, `OP_CREATE_ACTOR`, `ENDPOINT_KINDS`, the error codes `NO_ENDPOINT`, `ENDPOINT_TIMEOUT`,
`ENDPOINT_GONE`, `ENDPOINT_LIMIT`, `OP_FAILED`, `PROTOCOL_MISMATCH`, `NOT_GM`, and typedefs for the identify, identify ack, invoke, op ack and error payloads. Routing,
the endpoint registry and the error contract are in `server/endpoints.ts` (see `wiretap-mcp-bridge`). Both sides import these constants; adding an event means editing this file and both consumers.

## Rules specific to this subsystem

- TypeScript run by `tsx`; typecheck with `npm run typecheck` (`server/tsconfig.json`).
- The MCP endpoint and the Socket.IO server both bind `127.0.0.1`. Both refuse a browser request whose `Origin` is not
  in `ALLOWED_ORIGINS` (`tests/integration/originValidation.test.js`); a request with no `Origin` (a local non-browser
  process) is accepted by design, so there is still no authentication on socket events (shared-secret handshake is a
  `TODO.md` item).
- Windows console-window-close (CTRL_CLOSE) cannot be trapped by Node; PTY teardown covers Ctrl-C, SIGTERM, e2e
  teardown.
- Tests: `tests/unit/sidecarPty.test.js` (incl. auto-wiring), `mcpWiring`, `mcpConfigFile`, `serverMode`, `shutdown`; `tests/integration/terminal.test.js`, `serverModes.test.js`,
  `endpointRouting.test.js` (fake v2 clients), `originValidation.test.js` (hostile, allowed and absent Origin on the
  socket handshake; Origin and Host on `/mcp`), unit `origins`, `logThrottle`, `serverStartup.test.js` (occupied Socket.IO/MCP port rejects `ready`; `awaitStartup` exits 1 and frees the other port), `serverDispose.test.js` (terminal.dispose / mcp.close throwing still release both ports).
