# Wiretap TODO

## Completed

- [x] Package scaffold (Svelte 5 + SCSS + Vite, titan-parity tooling)
- [x] Wiretap sidebar tab with Svelte mount + pop-out
- [x] Unit + e2e smoke tests
- [x] AI bridge #1 — transport + sidecar skeleton (socket.io)
- [x] AI bridge #2 — Claude Code terminal relay (node-pty + xterm.js; Launch/Close; reattach)
- [x] Terminal-relay Playwright e2e (sidecar-in-harness; round-trip, fan-out + relaunch regressions)

## AI bridge roadmap (terminal-relay design)

- [ ] #3 terminal UX polish (theme dropdown ✓, popout-takeover + 4:3 default ✓, sidecar launcher + offline panel ✓, toolbar [clear/copy/font/restart] + persisted font size ✓; remaining: scrollback tuning)
- [ ] (optional/future) structured chat UI — only viable via headless/programmatic mode
      (Agent SDK / `claude -p`), which draws on the $200/mo Agent SDK credit + Commercial Terms
- [x] dedicated Foundry MCP server for the user's `claude` to call — vertical slice: `create_actor`
      (sidecar hosts MCP over Streamable HTTP on 127.0.0.1:31417; GM identify handshake routes tool
      calls to the GM browser; `Actor.create` round-trips the uuid back). See
      `docs/superpowers/specs/2026-06-02-wiretap-mcp-bridge-design.md`.
- [ ] MCP follow-ups: more tools (`create_item`, `create_walls`, scene reads); live-Foundry e2e for
      the bridge (drive an MCP HTTP client against the sidecar, assert an Actor appears); optional
      Wiretap settings UI (enable toggle + port); shared-secret handshake on the sidecar socket.

- [ ] MCP stdio transport (not built; only Streamable HTTP exists)
- [ ] Late-ack logging: when an endpoint acks an invocation after the sidecar already answered ENDPOINT_TIMEOUT, log
      the ack with its `requestId`, so an operator can tell whether a timed-out mutation applied
- [ ] Retry idempotent ops after an ENDPOINT_TIMEOUT: needs a sidecar-trusted `mutates: false` flag on shipped ops only
      (never client-declared), so a read can move to another endpoint and a mutation is still sent exactly once (M7)
- [ ] Raw-socket executor (plan.md M11, dropped by D27): reads of stored source data only, for when no client
      endpoint is live. M0 showed raw creates skip the system's pre-create logic and the server accepts invalid data;
      revisit only if a raw path is ever wanted
- [ ] Script dispatcher mode for MCP clients that do not defer tool schemas: `list_scripts` / `describe_script` /
      `run_script` (plan.md D19; per-script deferred tools are the primary mode, build this only if such a client is
      targeted)
- [ ] Surface a notice in the terminal stream when the MCP config write fails (today the failure is only logged by the
      sidecar and `claude` launches without the Wiretap tools; deferred by decision)
- [ ] Live-Foundry e2e for in-session MCP auto-wiring (launch the terminal `claude` and assert the Wiretap tools
      are registered; currently covered by unit tests only)
- [ ] MCP auto-wiring when the module directory is read-only or the sidecar runs relocated (the config root is derived
      from `import.meta.url`, so `<module root>/.wiretap/` cannot be written): choose a fallback location, and show an
      in-terminal hint when wiring is skipped (unsafe command or path) or the config write fails
- [ ] POSIX mode assertions (`.wiretap` 0o700, config file 0o600 in `tests/unit/mcpConfigFile.test.js`) are skipped on
      Windows and have never run here; needs a Linux CI job to execute them
- [ ] `server/index.ts` invalid-`WIRETAP_MODE` branch (`process.exit(1)` before listening) is untested; the entry file
      runs on import, so covering it needs the mode check extracted into a testable function

- [ ] Result handles are keyed by one process-wide owner key (`PROCESS_OWNER_KEY` in `server/mcp.ts`) because MCP
      sessions are stateless: any MCP caller can read any handle. When sessions become stateful, key the handle store by
      the MCP session id and release a session's handles when it ends. Until then handle eviction is global across
      owners (one caller's results can evict another's)
- [ ] A `read_handle` `paths` read parses the whole stored text again on every call (nothing cached). Measured: ~185 ms
      worst case for 7.7 MB of small objects, of which parsing is 26 to 55 ms and path resolution 153 to 170 ms, so a
      parsed-document cache would not bring it under 150 ms; make `resolvePaths` cheaper for wildcard reads over large
      arrays if it matters
- [ ] Run the live token calibration once: connect Claude Code to the Wiretap MCP server, compare `/context` before and
      after calls against the byte sizes printed by `npx tsx tests/measure/measureContext.mjs`, and replace the inferred
      bytes / 2 token column in `plan.md` with the measured one
- [ ] Write the production server `instructions` pointer (at most 600 characters, `INSTRUCTIONS_MAX_CHARS`) naming the
      skill and the tool families as `mcp__wiretap__<tool>`; `startMcpServer` takes the text through its `instructions`
      option and the context-budget test checks its length and tool names, but no production text is set yet
- [ ] Screenshot capture must enforce the 480,000 px default area (`IMAGE_DEFAULT_MAX_PIXELS`) when the capture tool
      exists; the result enforcer checks only the longest side (1280 px), the 1,000,000-character data size and the
      PNG type, never the area

## Carried-over cleanups

- [x] Sidecar: kill a running PTY on server shutdown — `dispose()` on the manager + SIGINT/SIGTERM teardown in `index.ts` (Windows console-window-close / CTRL_CLOSE still uncatchable by Node)
- [ ] Sidecar `index.ts`: log "listening" on the `'listening'` event, not synchronously after start
- [ ] Status badge accessibility: add `role="status"` / `aria-live="polite"` (fits #3 UX polish)
- [ ] Optional shared-secret handshake for the sidecar socket (defense in depth)
- [ ] Configurable terminal working directory (`terminalCwd`)
- [ ] Reattach fidelity for full-screen TUIs (resize nudge / repaint on reconnect)
- [ ] Extend e2e to cover reattach-after-reload + resize reflow (comprehensive tier, deferred earlier)
- [x] e2e reliability — RESOLVED. The flake was NOT the ConPTY backend: node-pty's Windows arg-escaping
      mangled the inline `node -e "..."` marker (dropping its keep-alive → early exit). Fixed by a committed
      file-based marker (`tests/e2e/marker.js`) + a quote-safe spawn (`server/spawnCommand.ts` passes the
      Windows command line as a verbatim string — also fixes user `terminalCommand`s containing quotes/args).
      Backend is not the lever (measured: conpty/conpty-dll/winpty all survive a single long PTY). The residual
      full-suite churn flake was fixed by per-spec sidecar isolation (below). `WIRETAP_PTY_BACKEND`
      (conpty|conpty-dll|winpty) remains a documented escape hatch; default `conpty` (best `claude` fidelity).
      Validated under portable Node 22 — recommend pinning CI/dev to a Node LTS.
- [x] e2e harness: per-spec sidecar isolation — each spec file gets a fresh sidecar (`tests/e2e/sidecar.js` +
      beforeAll/afterAll); `global-setup` only builds the bundle. Also rewrote 2 stale `terminal.spec` pop-out
      tests that asserted the pre-popout-takeover fan-out behavior (now assert takeover + return-on-close, via
      a new `closePopout` probe). FULL `npm run test:e2e` now GREEN — 3/3 runs (11/11) under Node 22.

## Deferred (later)

- [ ] Risk gates, client half (next step after the sidecar half): register the world-scope `restricted` gate settings,
      `lang/en.json` labels and hints (with the arbitrary-code caveat), the client-side `requireGate` that re-enforces
      every gate from `game.settings`, the gate snapshot in the identify and the `bridge:gateState` push on
      `updateSetting`, and the e2e that toggles a gate and restores it.
- [ ] Wire `denyWiretapSettingWrite` / `resolveSettingKey` into every Setting write path (CRUD, path-scoped writes,
      batch, replace, delete, settings skills, scripts' `ctx.core.*`) as those paths land; each path gets a test that
      it refuses `wiretap.*` and writes the string `resolveSettingKey` returned.
- [ ] `list_endpoints` must not serialize `Endpoint` objects directly: gate state is shown only as one compact line.

- [ ] Settings menu beyond serverUrl/terminalCommand, keybindings, fonts, compendium packs
