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
      `docs/specs/2026-06-02-wiretap-mcp-bridge-design.md`.
- [ ] MCP follow-ups: more tools (`create_item`, `create_walls`, scene reads); live-Foundry e2e for
      the bridge (drive an MCP HTTP client against the sidecar, assert an Actor appears); optional
      Wiretap settings UI (enable toggle + port); shared-secret handshake on the sidecar socket.

- [ ] MCP stdio transport (not built; only Streamable HTTP exists)
- [ ] Late-ack logging: when an endpoint acks an invocation after the sidecar already answered ENDPOINT_TIMEOUT, log
      the ack with its `requestId`, so an operator can tell whether a timed-out mutation applied
- [ ] Retry idempotent ops after an ENDPOINT_TIMEOUT: needs a sidecar-trusted `mutates: false` flag on shipped ops only
      (never client-declared), so a read can move to another endpoint and a mutation is still sent exactly once (M7)
- [ ] Raw-socket executor (docs/PLAN.md M11, dropped by D27): reads of stored source data only, for when no client
      endpoint is live. M0 showed raw creates skip the system's pre-create logic and the server accepts invalid data;
      revisit only if a raw path is ever wanted
- [ ] Script dispatcher mode for MCP clients that do not defer tool schemas: `list_scripts` / `describe_script` /
      `run_script` (docs/PLAN.md D19; per-script deferred tools are the primary mode, build this only if such a client is
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

- [ ] Result-handle eviction is global across owners: handles are owned per MCP session, but the LRU count and byte
      limits are shared, so one session's puts can evict another session's handles (the evicted owner then gets
      `HANDLE_NOT_FOUND`). Decide on per-owner quotas or a fairness rule
- [ ] A `read_handle` `paths` read parses the whole stored text again on every call (nothing cached). Measured: ~185 ms
      worst case for 7.7 MB of small objects, of which parsing is 26 to 55 ms and path resolution 153 to 170 ms, so a
      parsed-document cache would not bring it under 150 ms; make `resolvePaths` cheaper for wildcard reads over large
      arrays if it matters
- [ ] Run the live token calibration once: connect Claude Code to the Wiretap MCP server, compare `/context` before and
      after calls against the byte sizes printed by `npx tsx tests/measure/measureContext.mjs`, and replace the inferred
      bytes / 2 token column in `docs/PLAN.md` with the measured one
- [ ] Screenshot capture must enforce the 480,000 px default area (`IMAGE_DEFAULT_MAX_PIXELS`) when the capture tool
      exists; the result enforcer checks only the longest side (1280 px), the 1,000,000-character data size and the
      PNG type, never the area

- [ ] Set `destructiveHint` for scripts that delete: a script definition has no field that declares a script
      destructive, so the sidecar sets only `readOnlyHint`; add the field when `delete_documents` is built
- [ ] Plugin and agent-saved script routes: `validateScriptDefinition` already applies the 64-character
      `<moduleId>__<skill>` and `agent__<name>` rules but refuses both sources as not supported until their routes exist
      (docs/PLAN.md M7, M16)
- [ ] Point `WIRETAP_INSTRUCTIONS` (`server/mcp.ts`, a sidecar file) at the user-facing skill `skills/wiretap/SKILL.md`
      when that is judged right: one sentence within `INSTRUCTIONS_MAX_CHARS` (600; the current text leaves room to
      check against the constant), and the cost is paid by every session at start (the 531-character text measured about
      221 tokens, `docs/experiments/2026-10-m3-results.md`), so measure the sentence before keeping it
- [ ] `bridge:registry` acks carry counts only (`{ ok, accepted, refused }`), so the client logs how many scripts the
      sidecar refused but not which or why (the reasons are only in the sidecar log). Return `{ name, reason }` for each
      refused entry (sidecar change, bounded) so the client log can name them
- [ ] `ctx.dom` is `{ document }` only. Define the DOM surface (layout measurement, region capture) with the first
      `requires: 'dom'` script (docs/PLAN.md M15b); the client always identifies with `dom: true`
- [ ] The executing client's own gate check is covered by unit tests only: through the sidecar a closed gate is denied
      by the sidecar's snapshot before anything is sent (e2e `scripts.spec.js` shows that path). An e2e that reaches the
      client check needs a way to hold the sidecar's snapshot stale, for example a test-only observer command
- [ ] Compact view: `ctx.shape.compact` uses a generic default key-name pattern; the per-subtype key-field lists and
      the compact view of Foundry documents (a canonical export) belong to docs/PLAN.md M4. With 16-character ids and
      18-character names 40 tuples do not fit the 2 KB budget (35 fit in the fixture, asserted by
      `tests/unit/scriptShape.test.js`), so the byte budget trims them

- [ ] e2e registry (docs/PLAN.md section 4.8): the running list records world documents only. Add `parent`, `packId`
      and `sceneId` fields and embedded-first teardown ordering (tokens, then other embedded documents, then world
      documents, folders, world compendia) with the first flow that creates an embedded document or a compendium; also
      the TITAN safety net's chat messages since the run start and the E2E users' broken hotbar entries, and the
      restore of world settings other than the risk gates. The sweep and census cover prefixed world documents,
      combats and orphan tokens (`tests/e2e/registryCore.js`)

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

- [ ] A script that declares a `gate` is gated by the `callTool` dispatcher (`requireGate`, ack `GATE_DENIED`). Each
      core operation in `ctx.core` that touches a gated category must also call `requireGate` itself, because a script
      can call a core operation outside the gate of its own category; no such operation exists yet.
- [ ] Wire `denyWiretapSettingWrite` / `resolveSettingKey` into every Setting write path (CRUD, path-scoped writes,
      batch, replace, delete, settings skills, scripts' `ctx.core.*`) as those paths land; each path gets a test that
      it refuses `wiretap.*` and writes the string `resolveSettingKey` returned.
- [ ] `list_endpoints` must not serialize `Endpoint` objects directly: gate state is shown only as one compact line.

- [ ] Settings menu beyond serverUrl/terminalCommand, keybindings, fonts, compendium packs
