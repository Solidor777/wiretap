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
- [x] dedicated Foundry MCP server for the user's `claude` to call — vertical slice: one create tool (now `create_documents`)
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
- [ ] Undo history (docs/PLAN.md M17, dropped by D29): revisit if agents damage world content in use. Designs weighed
      on 2026-11-21: history held in the sidecar (not the executing client, which can reload or change between calls);
      grouped by agent turn, with turn boundaries from Claude Code hooks or agent-called markers; a pre-write copy of
      each document a turn touches. A lighter option: each update, replace or delete returns a handle to the
      document's earlier version, restorable with the existing write tools
- [ ] Whole-world backup (a later option; M21 backs up lists and groups only). Today a whole-world backup is made on
      Foundry's setup screen with the world shut down
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

- [ ] Make `destructiveHint` accurate for additive scripts: a definition has no field that declares a mutating script
      non-destructive, so the sidecar sets only `readOnlyHint` (`server/mcp.ts`) and every mutating script, including
      `create_documents`, keeps the MCP default `destructiveHint: true`. That is right for `delete_documents`,
      `replace_document` and `batch`; adding a definition field (shared contract, both validators, registry signature)
      would let `create_documents` say false
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
- [ ] Right after M7: built and shipped code references no game system (owner). The titan per-subtype key-field lists
      in `src/bridge/scripts/keyFields.json` leave Wiretap; the compact view uses only the generic key-name rule of
      `ctx.shape`. The lists move to the add-on module `wiretap-titan-vttrpg` (folder `Data/modules/wiretap-titan-vttrpg`,
      repo `https://github.com/Solidor777/wiretap-titan-vttrpg.git`), which depends on Wiretap; how an add-on supplies
      key fields is decided when that module is built, after Wiretap is done. Test machinery may keep using the titan
      install (the `test-titan` e2e world, titan-like unit fixtures). Walk through the code changes with the owner first.
- [ ] owner: decide whether non-core Settings are readable at all. Today every Setting outside the `wiretap.` namespace
      and the credential denylist is returned with secret-named keys dropped from its value (docs/PLAN.md section 4.4),
      so another module's setting that stores a secret under a name the pattern does not match is exposed. Options: a
      setting allowlist, or refusing all module settings by default
- [ ] owner: decide whether ChatMessage whispers and blind rolls are readable. A GM client reads every message, so
      `get_document` and `search_documents` return whispers addressed to other users and blind rolls; there is no
      per-message visibility rule
- [ ] `search_documents` still builds an ordering key for every readable document of the class on each call (a world
      with tens of thousands of ChatMessages pays that cost per page, with yields) before the scan cap applies, and
      `total` is only a count over the candidates examined. Add a persistent name index or a streaming order if a world
      needs it; a compendium search reads the index only
- [ ] Folders of type `ActiveEffect` and `Adventure` cannot be deleted through Foundry (client error in
      `Folders#_onModifyContents`, server error in `Folder#_preDelete`); e2e does not create them. If an agent
      creates one, only retyping it (`folder.update({ type: 'Item' })`) lets it be deleted. Consider refusing them in
      `create_documents` (M5)
- [ ] `describe_schema` blank examples are missing for `ActorDelta` and `TableResult` in the titan world (their blank
      construction fails without a parent or more data; MEASURED by `tests/e2e/searchSchema.spec.js`); the result then
      has `example: null` and an `exampleNote`. Add minimal data for them if agents need an example
- [ ] `describe_schema` was exercised against the titan system and the core classes only; the walker on other systems'
      custom field classes is unverified (an unknown class is reported as a leaf with its class name)
- [ ] `get_document` with `mode: "full"` fails with `RESULT_TOO_LARGE` when the client result is over 900,000 bytes (a
      scene with thousands of placeables). The agent reads such a document with `paths`; chunked full reads are not built

- [ ] e2e registry (docs/PLAN.md section 4.8): the running list records world documents and whole world compendium
      packs (`Compendium`, id `world.<name>`) only; embedded documents are removed with their recorded parent and
      documents inside a pack with the pack. Add `parent`, `packId` and `sceneId` fields with the first flow that must
      create an embedded document under a document it did not create, or a document inside a pack it did not create;
      also the TITAN safety net's chat messages since the run start and the E2E users' broken hotbar entries, and the
      restore of world settings other than the risk gates. The sweep and census cover prefixed world documents of the
      types in `ALLOWED_DOCUMENT_NAMES` (ChatMessage by `flavor`, Setting by key prefix), world packs by title, combats
      and orphan tokens (`tests/e2e/registryCore.js`)

## Carried-over cleanups

- [x] Sidecar: kill a running PTY on server shutdown — `dispose()` on the manager + SIGINT/SIGTERM teardown in `index.ts` (Windows console-window-close / CTRL_CLOSE still uncatchable by Node)
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

## After M7: ideas from the foundry-vtt-mcp survey

Accepted by the owner; each needs a design walkthrough when picked up. Survey:
`C:\Users\emper\.claude\work\fvttmcp-survey\comparison-wiretap.md`. Every item stays system agnostic; game-system
support goes in separate add-on modules that depend on Wiretap, after Wiretap is done.

- [ ] Audit log of agent writes: one line per mutating call (time, tool, endpoint kind, uuids, changed paths, result
      code), no document contents, readable by the GM. File growth is handled by moving a full file to the recycle bin
      (no permanent delete).
- [ ] One central guard on every `CONFIG.queries` handler Wiretap or a plugin registers, refusing a sender who is not a
      GM, plus a test that lists every registered `wiretap.*` handler and asserts each refuses a non-GM (with a count
      floor). foundry-vtt-mcp `packages/foundry-module/src/query-guard.ts` (MIT) may be adapted; keep its MIT notice.
- [ ] Range comparisons and a sort path in `search_documents` filters, over any document path (system agnostic), within
      the 800 B definition limit.
- [ ] A condition toggle script through Foundry core `Actor#toggleStatusEffect` (`client/documents/actor.mjs:547`).
      Item use is not in Foundry core, so it belongs in a system add-on, not Wiretap.
- [ ] Low priority: a player roll-request chat card, chat spoken as a token with whispers that fail on an ambiguous
      name, installers, and a Foundry hosted over HTTPS (M10).

## Deferred (later)

- [ ] A script that declares a `gate` is gated by the `callTool` dispatcher (`requireGate`, ack `GATE_DENIED`). Each
      core operation in `ctx.core` that touches a gated category must also call `requireGate` itself, because a script
      can call a core operation outside the gate of its own category. The write operations, `replace_document` and
      `batch` do (`guardWrite`); any further gated core operation must too.
- [ ] `guardWrite` applies `denyWiretapSettingWrite` to create, update, replace, batch and delete of Settings. A
      further Setting write path (a settings skill) must go through `guardWrite` as it lands, with a test that it
      refuses `wiretap.*`.
- [ ] The argument-schema subset has no free-form object node, so `create_documents` and `update_documents` take JSON
      text for data and values. A bounded free-form node (depth and byte limits on both validators, parity fixtures)
      would remove the text round trip; it changes the shared schema contract on both sides.
- [ ] Folder types with no world collection (`ActiveEffect`, `Adventure`) can be created but not deleted (see
      `docs/POST_WORK_FINDINGS.md`); `create_documents` does not refuse them. Decide whether it should.
- [ ] Idempotency covers `create_documents` only; `batch` and `replace_document` take no key (a replace repeated with the
      same data is naturally idempotent). Decide whether `batch` creates need one.
- [ ] `replace_document` supports primary document classes only; replacing an embedded document goes through
      `update_documents` paths. Decide whether embedded replace is wanted.
- [ ] `batch` has no `pack` or `keepId` on creates and cannot refer to a document an earlier operation creates; the flat
      schema is forced by the 800 B definition and depth 4 limits.
- [ ] `batch` entries are strict through the unlisted `strictNested` flag, but `required` on entries, an `op` enum and
      `maxLength` bounds are not in the schema: they would list at 915 B plus about 70 B against the 800 B definition
      limit (MEASURED). The handler checks them. Decide whether to raise `DEFINITION_MAX_BYTES`.
- [ ] `batch` cannot re-check compendium pack operations after a failure (the ghost and phantom repair reads the world
      database only).
- [ ] The idempotency record stamp (`u`, `d`) keeps mistakes out; two GM clients creating with one key at once are not
      coordinated (the lock is per client). Decide whether a cross-client guard is wanted.
- [ ] `delete_documents` is irreversible; besides the `allowDelete` gate the confirmation is the Claude Code ask rule in
      the README. Consider a one-line check in the Wiretap skill or a `setup` helper that writes the rule.
- [ ] `list_endpoints` must not serialize `Endpoint` objects directly: gate state is shown only as one compact line.
- [ ] owner: decide whether these writes need a gate; none is gated now. An author or user field a caller can set to
      any user id: ChatMessage `author`, Macro `author`, Drawing `author`, Note author, `Setting.user`,
      `FogExploration.user`.
- [ ] owner: decide whether `_stats.createdTime` should be writable. The idempotency retention reads it, so a caller
      who rewrites it can make a record look expired or fresh.
- [ ] owner: decide whether `folder` and `sort` need a gate; both are writable through any path or data.
- [ ] Integration tests wait for the GM identify and for an invocation with polls capped at 1,000 ms
      (`tests/integration/serverModes.test.js` and the other sidecar tests); under a CPU overload far beyond a normal run
      (four concurrent vitest runs on 24 cores) they expire. Make them wait on the event itself, or decide that the
      overload case is out of scope.

- [ ] `diff_since` mode 2 (the paths of one document changed since a stored snapshot; not built, docs/PLAN.md D35):
      about 8k tokens saved per edit cycle against a full re-read, about 0.7k against a compact re-read, for one more
      call. `foundry.utils.diffObject` returns a differing array whole, so it needs a keyed diff in the section 2.8
      path grammar. Mode 1 (documents changed since a time) is not planned: it cannot report deletions and its clock
      basis (`_stats.modifiedTime`) is unverified

- [ ] Settings menu beyond serverUrl/terminalCommand, keybindings, fonts, compendium packs
