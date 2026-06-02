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
- [ ] (optional/future) dedicated Foundry MCP server for the user's `claude` to call

## Carried-over cleanups

- [x] Sidecar: kill a running PTY on server shutdown — `dispose()` on the manager + SIGINT/SIGTERM teardown in `index.ts` (Windows console-window-close / CTRL_CLOSE still uncatchable by Node)
- [ ] Sidecar `index.ts`: log "listening" on the `'listening'` event, not synchronously after start
- [ ] Status badge accessibility: add `role="status"` / `aria-live="polite"` (fits #3 UX polish)
- [ ] Optional shared-secret handshake for the sidecar socket (defense in depth)
- [ ] Configurable terminal working directory (`terminalCwd`)
- [ ] Reattach fidelity for full-screen TUIs (resize nudge / repaint on reconnect)
- [ ] Extend e2e to cover reattach-after-reload + resize reflow (comprehensive tier, deferred earlier)
- [~] e2e reliability — ROOT CAUSE FOUND + core fixed. The flake was NOT the ConPTY backend: node-pty's
      Windows arg-escaping mangled the inline `node -e "..."` marker (dropping its keep-alive → early exit).
      Fixed by a committed file-based marker (`tests/e2e/marker.js`) and a quote-safe spawn (`resolveSpawn`
      now passes the Windows command line as a verbatim string — `server/spawnCommand.ts`). Per-spec the e2e
      is now SOLID (`toolbar.spec` 25/25 on `--repeat-each=5`; `spawn.spec` 3/3) under Node 22. Backend is not
      the lever (measured: conpty/conpty-dll/winpty all survive a single long PTY; both conpty & winpty still
      flake the FULL suite). RESIDUAL: running ALL specs against ONE shared sidecar flakes under cumulative
      rapid PTY kill/respawn churn (backend-agnostic; concentrated in the popout tests). FIX: give each spec
      file a fresh sidecar (per-file restart) or run specs separately in CI. `WIRETAP_PTY_BACKEND`
      (conpty|conpty-dll|winpty) is a documented escape hatch; default stays `conpty` (best `claude` fidelity).
- [ ] e2e harness: per-spec sidecar isolation so the FULL suite is reliable (see the residual above).

## Deferred (later)

- [ ] Settings menu beyond serverUrl/terminalCommand, keybindings, fonts, compendium packs
