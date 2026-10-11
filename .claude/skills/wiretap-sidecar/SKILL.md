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
  `bridge.handleConnection(socket)`. `dispose()` kills any PTY (full mode), then closes MCP, then stops the bridge's endpoint
  health probes (`bridge.dispose()`), then closes Socket.IO, in nested try/finally so each step runs even if an
  earlier one throws (the first error propagates).
- `server/logThrottle.ts` — `createLogThrottle({ log, now, limit, windowMs, noun })`: fixed-window throttle for log
  lines an unauthenticated caller can trigger; writes `limit` lines per window, counts the rest and writes one
  `Wiretap sidecar | N further <noun> suppressed` line from the first call after the window (no timer). Used by
  `server.ts` (origin refusals) and `foundryBridge.ts` (identify refusals and endpoint health lines).
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
| `server/terminal.ts` | `createTerminalManager(io, spawn?, options?)`; spawns `payload.command ?? 'claude'` via node-pty with `process.env`; relays `TERMINAL_*` events. `options.mcpPort` (> 0) enables MCP auto-wiring; `options.writeConfig(port, root?)` is an injectable config writer (default `writeMcpConfig`), `options.configRoot` the root passed to it (default: the module root). Every handler treats its payload as untrusted and ignores it with one fixed `console.warn` line (no payload text) instead of throwing: launch ignores a payload that is not an object (arrays included), whose `command` is neither absent nor a string, or whose present `cols`/`rows` is not an integer in 1..`MAX_TERMINAL_DIMENSION` (1000), and an absent `cols`/`rows` keeps the stored size (default 80x24); input ignores a non-object payload or a non-string `data` (no length cap; Socket.IO's event size limit applies); resize ignores a non-object payload or an invalid `cols`/`rows` and leaves the stored size unchanged. Every wired launch calls the writer again (rewrite, no existence check, no cached path); a writer failure is logged and the command is spawned unchanged. `dispose()` kills the PTY and clears state in `try/finally` (a kill error still propagates); it touches no files |
| `server/mcpWiring.ts` | Pure: `buildMcpConfig(port)`, `mcpConfigFileName(port)` (`mcp-<port>.json`), `planMcpWiring(command)` (the only command-line judgement; returns `{ kind: 'wire' }`, `{ kind: 'skip', reason }` or `{ kind: 'not-claude' }`), `isSafeConfigPath(path, platform)` (the only path-safety check; rejects `"` and `%` everywhere and `$`, backtick and `\` on POSIX), `wireMcpConfig(command, path)` (unconditional append of `--mcp-config "<path>"`). Wiring is an allowlist: the executable is exactly `claude` and every following space/tab-separated token consists solely of `[A-Za-z0-9._:=/@+,-]`; anything else (every quoted argument, any shell metacharacter, `^ # \ % $` backtick, newline) is skipped. A standalone `--` and an existing `--mcp-config` are skipped too. A config path containing `"` or `%` (and, on POSIX, `$`, a backtick or a backslash) is not wired. `terminal.ts` calls the plan once per launch and logs skips |
| `server/mcpConfigFile.ts` | `defaultConfigRoot()` (the module root, the parent of `server/`, from `import.meta.url`, never `process.cwd()`); `writeMcpConfig(port, root = defaultConfigRoot())` writes `<root>/.wiretap/mcp-<port>.json`: `mkdirSync` recursive mode 0o700, `lstatSync` on the `.wiretap` directory and then on the file path (a symbolic link throws; ENOENT proceeds), `writeFileSync` mode 0o600, overwriting every time. The modes apply only when the directory or file is created; the lstat-then-write sequence is a time-of-check to time-of-use residual risk (no `O_NOFOLLOW`). `.wiretap/` is gitignored. No deletion API exists anywhere in `server/`; the file is never removed |
| `server/spawnCommand.ts` | `resolveSpawn(command, platform, comspec)`: Windows → `ComSpec /c <command>` as a verbatim string (node-pty array escaping mangles quotes); POSIX → `/bin/sh -c` |
| `server/ptyOptions.ts` | `resolvePtyOptions(platform, env)`; Windows backend `conpty` (default) / `conpty-dll` / `winpty` via `WIRETAP_PTY_BACKEND` |

`spawnCommand.ts` and `ptyOptions.ts` are pure (no node-pty import) so unit tests do not load the native addon.

## Shared protocol

`shared/protocol.js` exports `TERMINAL_LAUNCH|INPUT|RESIZE|CLOSE|DATA|STATE|EXIT`, `PROTOCOL_VERSION` (3), `BRIDGE_IDENTIFY`, `BRIDGE_GATE_STATE`,
`BRIDGE_INVOKE`, `BRIDGE_PING`, `OP_CREATE_ACTOR`, `ENDPOINT_KINDS`, the error codes `NO_ENDPOINT`,
`ENDPOINT_TIMEOUT`, `ENDPOINT_UNAVAILABLE`, `ENDPOINT_GONE`, `ENDPOINT_LIMIT`, `OP_FAILED`, `PROTOCOL_MISMATCH`, `NOT_GM`, `GATE_DENIED`, and typedefs for the identify (with its optional `gateState`), identify ack, gate-state ack, invoke, op ack and error payloads. Routing,
the endpoint registry and the error contract are in `server/endpoints.ts` (see `wiretap-mcp-bridge`). Both sides import these constants; adding an event means editing this file and both consumers.

## Risk gates (`shared/gates.js`)

Plain JS, no dependencies, shared by both sides (today only `server/` imports it; `src/` does not yet). `GATES` is the one deep-frozen registry: entries `{ type: 'boolean' | 'moduleList', default, unlocks }` for `allowMacroExecution`, `allowUserWrites`, `allowSettingWrites`, `allowFileUpload`, `allowOwnershipWrites`, `allowCompendiumWrites`, `allowModuleConfigWrites`, `allowAgentScripts` (boolean, default false) and `allowedPluginModules` (module-id list, default empty). There is no delete or undo gate. A `GateState` is an object with exactly those keys.

- `closedGateState()` returns a fresh all-closed snapshot. `sanitizeGateState(input)` returns a fresh complete snapshot: only registry names, only own properties, booleans only for boolean gates, the module list only when an array of at most `GATE_MODULES_MAX` (64) entries (a longer array is treated as empty without being walked) keeping module ids (`/^[a-z0-9][a-z0-9_-]*$/`, 1 to `GATE_MODULE_ID_MAX_CHARS` (64) characters, duplicates removed); anything else is dropped and the gate stays closed; a non-object, or an input whose reads throw, gives the closed state.
- `gateDenial(gateState, name, moduleId?)` returns null when open, else `{ code: 'GATE_DENIED', message }` (message at most 256 bytes, names the gate, says only a GM can enable it in the Wiretap module settings). It always sanitizes the state first, so raw or oversized module lists are never open. Deny when the name is not an own key of `GATES` (unknown-gate message names no caller text) or the sanitized value is not exactly `true`; for `allowedPluginModules` a missing `moduleId` denies and a `moduleId` must be a member of the sanitized list (the id is ignored for boolean gates). `isGateOpen(state, name, moduleId?)` is `gateDenial(...) === null`; `isModuleAllowed(state, id)` is the plugin-module form. `GATE_DENIED` is not a reserved protocol code (the client may send it).
- `isWiretapSettingKey(key)`: non-strings never match; the key is NFKC-normalized, whitespace and control/format characters removed, lowercased; it matches the bare `wiretap` or anything starting `wiretap.`. `resolveSettingKey(documentOrKey)` reads each property once inside try/catch and returns the string key (a string input, `document.key`, or `${namespace}.${key}` when `namespace` is a string) or null. `denyWiretapSettingWrite(documentOrKey)` never throws: it returns null when the resolved key is outside the namespace and a `GATE_DENIED` denial otherwise, including when no key resolves (a by-id payload without `key`, a throwing getter or Proxy). Contract: every Setting write path calls it before any gate check and writes the string `resolveSettingKey` returned, never a re-read of the input; by-id updates are resolved to a key first; namespaced settings are passed as `{ namespace, key }`.

Tests: `tests/unit/gates.test.js` (every branch enumerated; no coverage provider is installed).

## Shared budgets and document paths

Plain JS with no dependencies and JSDoc types, shared by both sides. Today only `server/` imports them: `handles.ts` (`getBudget`, `resolvePaths`), `resultBudget.ts` and `mcp.ts` (`getBudget`); nothing in `src/` does.

- `shared/budgets.js` — `BUDGETS` (frozen table of named entries `{ name, value, unit, severity }`), `BUDGET_SEVERITY`
  (`hard` | `warn`) and `getBudget(name)` (throws on an unknown name; inherited properties are not budgets). The numbers
  are the context budgets (tool name, definition, description, ack, compact view, search page, error, text hard cap and
  per-call maximum, sheet layout, image side, count and data size, stored-result entry size and count, live recalibration, paths per call, path-error bytes, `PATH_BYTES_MAX` 512,
  `PATH_SEGMENTS_MAX` 16). `warn` entries are `DESCRIPTION_TARGET_CHARS`, `PROJECTION_BYTES_PER_10_FIELDS`,
  `LIVE_RECALIBRATION_MAX_RUNS`. 1 KB is 1000 bytes (8000, 16000, 2000, 1000, 4000).
- `shared/docPath.js` — the path grammar over a canonical document export. `parsePath(path)` refuses non-strings,
  paths over `PATH_BYTES_MAX` bytes or `PATH_SEGMENTS_MAX` segments (`PATH_LIMIT`, checked before splitting), empty
  segments, more than one `*`, `prototype` and every member of `Object.prototype` (`UNSAFE_SEGMENTS` lists the three
  pollution names also refused as own keys of written values). A `.` always splits, so a key containing `.` cannot be
  addressed. `resolvePath(node, segments)` is iterative: it steps own properties on objects; on arrays a canonical
  integer is an index and any other name is an own element `_id`; an in-range index that is also another element's
  `_id` resolves to nothing; a `*` over an array returns `{<_id or index>: value}` (empty array `{}`; a non-empty array
  where no element resolves, or a `*` over a non-array, is not found; two elements producing the same key make it
  `{found: false, code: 'PATH_AMBIGUOUS'}`; a second `*` in hand-built segments is not found).
  `resolvePaths(export, paths)` returns `{ ok, values, missing }` (up to `PATHS_PER_CALL_MAX`; repeated paths read once;
  any malformed, over-long or unsafe path refuses the whole call; ambiguous wildcards land in `missing`).
  `groupWrites(patches, embeddedCollections)` turns `[{ path, value, op }]` (`op` `set` | `replace` | `delete`) into
  `{ document, embedded }`, where `embedded` is `[{ collection, entries: [{ _id, changes }] }]` with paths relative to
  the embedded document (`collection` is the collection name such as `items`; the client maps it to the document name).
  Refused: wildcard writes, unsafe or duplicate paths, a path that is a prefix of another patch path (`PATH_CONFLICT`),
  unknown ops, an embedded path with no field after the id, a purely numeric id segment on an embedded write (writes
  address documents by `_id`; reads accept an index or an `_id`), a non-string-array `embeddedCollections`, and a set
  or replace value with an own `__proto__`/`constructor`/`prototype` key or nesting over 32 levels (`PATH_UNSAFE_VALUE`).
  Errors are `{ code, message }` (message within `PATH_ERROR_MAX_BYTES`) with `PATH_*` codes. Tests:
  `tests/unit/budgets.test.js`, `docPath.test.js`.

## Result enforcer and handle store

`server/handles.ts`, `server/resultBudget.ts` and `server/utf8.ts` are pure in-memory modules (no file-system import or write/delete call, enforced by a unit test that resolves the sources from `import.meta.url`). They are consumed by `server/mcp.ts`; the details are in `wiretap-mcp-bridge`. Tests: `tests/unit/handles.test.js`, `resultBudget.test.js`, `tests/integration/resultHandles.test.js`.

## Rules specific to this subsystem

- TypeScript run by `tsx`; typecheck with `npm run typecheck` (`server/tsconfig.json`).
- The MCP endpoint and the Socket.IO server both bind `127.0.0.1`. Both refuse a browser request whose `Origin` is not
  in `ALLOWED_ORIGINS` (`tests/integration/originValidation.test.js`); a request with no `Origin` (a local non-browser
  process) is accepted by design, so there is still no authentication on socket events (shared-secret handshake is a
  `TODO.md` item).
- Windows console-window-close (CTRL_CLOSE) cannot be trapped by Node; PTY teardown covers Ctrl-C, SIGTERM, e2e
  teardown.
- Tests: `tests/unit/sidecarPty.test.js` (incl. auto-wiring), `terminalPayloads` (input/resize/launch payload validation), `mcpWiring`, `mcpConfigFile`, `serverMode`, `shutdown`; `tests/integration/terminal.test.js`, `serverModes.test.js`,
  `endpointRouting.test.js` (fake GM clients), `gateState.test.js` (risk-gate snapshots over real sockets), `endpointHealth.test.js` (ping/probe health over real sockets with fake timers), `originValidation.test.js` (hostile, allowed and absent Origin on the
  socket handshake; Origin and Host on `/mcp`), unit `origins`, `logThrottle`, `serverStartup.test.js` (occupied Socket.IO/MCP port rejects `ready`; `awaitStartup` exits 1 and frees the other port), `serverDispose.test.js` (terminal.dispose / mcp.close throwing still release both ports).
