# Wiretap MCP modes — design

Approved scope: in-session MCP auto-wiring and a standalone (headless) sidecar mode. Out of scope: stdio transport,
headless `claude -p` runs, new MCP tools.

## R1 — In-session mode: auto-wire MCP into the terminal's `claude`

- R1.1 When the terminal spawns a command whose executable is exactly `claude` (the bare command, optionally followed
  by arguments) and the arguments do not already contain `--mcp-config`, the sidecar appends an `--mcp-config`
  argument referencing a config file that registers Wiretap's MCP endpoint.
- R1.2 The config file content is `{"mcpServers":{"wiretap":{"type":"http","url":"http://127.0.0.1:<mcpPort>/mcp"}}}`.
  It is written to a fixed module-local path `<module root>/.wiretap/mcp-<mcpPort>.json`, where the module root is the
  parent of `server/`, resolved from `import.meta.url` (never `process.cwd()`); `.wiretap/` is gitignored.
  The directory is created with `fs.mkdirSync(..., { recursive: true, mode: 0o700 })`; the file is written with mode 0o600 and is OVERWRITTEN on
  each write (no exclusive create). Windows ignores POSIX modes and relies on the module directory ACL. Before writing,
  `lstat` the `.wiretap` directory and the file path: if either exists and is a symbolic link, refuse (log, spawn
  unchanged). The modes apply only when the directory/file is created, and the lstat-then-write gap is a documented
  residual risk. The flag name and
  config schema were verified against the installed `claude` (`claude --help`: `--mcp-config <configs...>`).
- R1.3 Any other command (custom `payload.command` not starting with the bare `claude` executable) is spawned
  unchanged.
- R1.4 The path is quoted so a module path containing spaces survives `resolveSpawn`'s verbatim Windows
  command-line passthrough.
- R1.5 The command rewriting is a pure function in its own module (no node-pty, no fs) and unit-tested; file writing
  is a separate small function, also tested.
- R1.6 `createTerminalManager` receives the MCP port through an options parameter; existing call sites and tests keep
  working.

- R1.7 `payload.command` from the socket is validated as a string inside the launch handler before any string
  operation; a non-string launches nothing and does not throw.
- R1.8 Wiring applies only to a command line that is allowlisted: `claude` followed by whitespace-separated tokens
  made solely of `[A-Za-z0-9._:=/@+,-]`. Anything else (quotes, any shell metacharacter, `^`, `#`, `\`, `%`, `$`,
  backtick, newline, standalone `--`) is spawned unchanged and the skip is logged. This deliberately skips commands
  with quoted arguments. The check is an allowlist, never a blocklist, because `cmd /c` and `sh -c` differ in their
  special characters. A single function returns a discriminated result (`wire` | `skip` with reason | `not-claude`);
  no check is evaluated twice.
- R1.9 Failure to write the config is logged and the command is spawned unchanged (kept from the first
  implementation); tests do not print noise (the logger is mocked).
- R1.10 Wiring tests assert the platform-specific spawn form (`resolveSpawn` win32 string form and POSIX array form).

- R1.11 Config lifecycle: every wired launch (re)writes the config file (idempotent, cheap), so a file removed by
  anything is restored. A failed mkdir/lstat/write is logged and the command is spawned unchanged (R1.9).
- R1.12 Teardown: `terminal.dispose()` kills the PTY; there is no file or directory cleanup. `server.dispose()`
  closes MCP and Socket.IO even if an earlier step throws, and the SIGINT/SIGTERM handlers in `index.ts` always reach
  `process.exit`. Each ordering case has a test.
- R1.13 NO deletion API (`fs.rm`, `fs.rmSync`, `fs.unlink*`, `fs.rmdir*`, `fs.promises.*` equivalents, `trash`
  shims) appears anywhere in product code or tests. Tests that need a config directory use a fixed, gitignored
  directory under `test/tmp/` with fixed file names that are overwritten between runs, or mock `node:fs`.
  Any destructive call must be mocked from the first red run. A repository grep for those APIs is part of the
  verification.

## R2 — Standalone mode: MCP-only sidecar

- R2.1 `createWiretapServer(port, mcpPort, mode = 'full')`; `mode` is `'full' | 'mcp-only'`.
- R2.2 `'full'` behaves exactly as before.
- R2.3 `'mcp-only'` does not create the terminal manager and does not wire terminal events; it still creates the
  Socket.IO server, the Foundry bridge (`bridge.handleConnection` on each socket) and the MCP HTTP server.
  `dispose()` handles the missing terminal.
- R2.4 `server/index.ts` selects the mode from the `--mcp-only` CLI argument or `WIRETAP_MODE=mcp-only|full`
  (argument wins); any other `WIRETAP_MODE` value exits with a clear error before listening. The startup log states
  the mode.
- R2.5 `package.json` gains `server:mcp` → `tsx server/index.ts --mcp-only`.
- R2.6 Unit/integration tests cover both modes: terminal events work in `full`; in `mcp-only` the bridge identify and
  an MCP request path still work and terminal launch is not handled.

## R3 — Documentation

- R3.1 README documents both modes: auto-wired in-session use, and standalone use with
  `claude mcp add --transport http wiretap http://127.0.0.1:31417/mcp` plus `npm run server:mcp`.
- R3.2 `wiretap-sidecar` and `wiretap-mcp-bridge` skills describe the new current state (the "no headless mode"
  statement is removed); `wiretap-build-test` lists the new script.
- R3.3 The deferred-work file (`TODO.md` at the repo root; `docs/TODO.md` does not exist — report this, do not
  create `docs/`) records: stdio transport (not built), live-Foundry e2e for in-session auto-wiring.
- R3.4 `graphify update .` is run after the code changes.

## Constraints

Project rules in `.claude/CLAUDE.md` apply: 120 columns, typed and commented declarations, multi-line `{}`, no stubs,
e2e waits ≤ 1000 ms, no raw `console.log` added beyond the existing startup logging style, loopback-only MCP binding
unchanged.

## R4 — Loopback-only Socket.IO binding

- R4.1 The sidecar creates its own `http.Server`, calls `listen(port, '127.0.0.1')`, and attaches Socket.IO to it
  (the Socket.IO `cors` option stays). Port 0 (ephemeral, used by tests) keeps working and the actual port is
  discoverable as before.
- R4.2 A test connects over loopback successfully and asserts the server's bound address is `127.0.0.1`
  (`server.address()`), measured, not assumed. `dispose()` still releases the port.
- R4.3 No other behavior changes; the bind address is not configurable.
- R4.4 (done) `docs/OPEN_BUGS.md` entry for the unbound Socket.IO server moves to `docs/CLOSED_BUGS.md` (new file if
  absent) with the measured bound address; the `wiretap-sidecar` and `wiretap-codebase-core` skills and the README
  state the loopback bind as current behavior (remove the "open bug" statements). The terminal-handler payload
  validation bug stays open.
