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

- [ ] Settings menu beyond serverUrl/terminalCommand, keybindings, fonts, compendium packs
