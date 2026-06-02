# Wiretap TODO

## Completed

- [x] Package scaffold (Svelte 5 + SCSS + Vite, titan-parity tooling)
- [x] Wiretap sidebar tab with Svelte mount + pop-out
- [x] Unit + e2e smoke tests
- [x] AI bridge #1 — transport + sidecar skeleton (socket.io)
- [x] AI bridge #2 — Claude Code terminal relay (node-pty + xterm.js; Launch/Close; reattach)
- [x] Terminal-relay Playwright e2e (sidecar-in-harness; round-trip, fan-out + relaunch regressions)

## AI bridge roadmap (terminal-relay design)

- [ ] #3 terminal UX polish (theme dropdown ✓, popout-takeover + 4:3 default ✓, sidecar launcher + offline panel ✓; remaining: font-size setting, toolbar niceties, scrollback tuning)
- [ ] (optional/future) structured chat UI — only viable via headless/programmatic mode
      (Agent SDK / `claude -p`), which draws on the $200/mo Agent SDK credit + Commercial Terms
- [ ] (optional/future) dedicated Foundry MCP server for the user's `claude` to call

## Carried-over cleanups

- [ ] Sidecar: kill a running PTY on server shutdown (expose `dispose()`; today a PTY orphans on SIGTERM)
- [ ] Sidecar `index.ts`: log "listening" on the `'listening'` event, not synchronously after start
- [ ] Status badge accessibility: add `role="status"` / `aria-live="polite"` (fits #3 UX polish)
- [ ] Optional shared-secret handshake for the sidecar socket (defense in depth)
- [ ] Configurable terminal working directory (`terminalCwd`)
- [ ] Reattach fidelity for full-screen TUIs (resize nudge / repaint on reconnect)
- [ ] Extend e2e to cover reattach-after-reload + resize reflow (comprehensive tier, deferred earlier)

## Deferred (later)

- [ ] Settings menu beyond serverUrl/terminalCommand, keybindings, fonts, compendium packs
