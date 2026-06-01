# Wiretap TODO

## Completed

- [x] Package scaffold (Svelte 5 + SCSS + Vite, titan-parity tooling)
- [x] Wiretap sidebar tab with Svelte mount + pop-out
- [x] Unit + e2e smoke tests
- [x] AI bridge #1 — transport + sidecar skeleton (socket.io echo round-trip)

## AI bridge roadmap (remaining sub-projects)

- [ ] #2 Claude Code in the sidecar (embed Agent SDK, stream responses, session)
- [ ] #3 Read-only Foundry tool surface (tools round-trip into the module)
- [ ] #4 Write operations + features (create actors/items/walls, permission model)
- [ ] #5 Chat UX polish (streaming, tool-call display, approvals, history)
- [ ] #6 Security / permissions / auth

## Carried-over cleanups (surfaced during #1 reviews)

- [ ] `WiretapConnection`: add an explicit `disconnect()` / teardown + reconnect-to-new-URL path
      (today `#socket` stays set after disconnect and relies on socket.io auto-reconnection only)
- [ ] Status badge accessibility: add `role="status"` / `aria-live="polite"` (fits #5 UX polish)
- [ ] Sidecar `index.ts`: log "listening" on the `'listening'` event rather than synchronously after
      `createWiretapServer` (the async bind completes after the current log line)
- [ ] Automate the bridge e2e (launch the sidecar from the Playwright harness) — deferred from #1

## Deferred (later)

- [ ] Settings menu beyond serverUrl, keybindings, fonts, compendium packs
