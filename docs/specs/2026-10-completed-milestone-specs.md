# Specifications of completed and dropped milestones

Moved from `docs/PLAN.md` section 5. These are the specifications as planned, kept for reference; what was built, results and deviations are in `docs/PROGRESS.md`, and the current state of the code is in the `wiretap-*` skills.

## Completed: M0, M1, M13, M2, M3, M14, M4

### M0 — Experiments against Foundry



**Depends on:** the launcher; no concurrent TITAN e2e run (§4.8). **Produces:** `docs/experiments/2026-10-m0-results.md`.
No product code.

**Safety limits:**

- No file deletion of any kind. Documents: only the `wtx-` documents an experiment created may be deleted, and only
  through Foundry document calls (`document.delete()`, `deleteEmbeddedDocuments`, `Document.deleteDocuments`); the
  experiment's running list (§4.8 pattern) records each id at creation, and a final census of `wtx-` names must be
  zero. Users (`wtx-*`) are not deleted (`User` deletion is outside M0).
- Created documents only inside folders named `Wiretap Experiments`. Names prefixed `wtx-`.
- Users limited to `wtx-assistant`, `wtx-gm`, `wtx-player`. Passwords are synthetic, from an env var, and never
  written to the repo or results.
- No combats and no tokens left in the world after an experiment (TITAN's sweep, §4.8).
- Experiment scripts live under `test/tmp/` (gitignored) or a scratch dir. Only the results doc is committed.

| Exp | Procedure | Pass / fail criteria | Unlocks |
|---|---|---|---|
| P1 password shape | As GM in the browser: `game.users.get(id)._source.password` and `toObject().password` for each `wtx-*` user. From Node: `getJoinData` socket payload `users[]` keys. | PASS = no password or hash anywhere client-visible. Any value present = FAIL → stop and report (D3 premise breaks) | D3 confirmed |
| E1 same user twice | Log `wtx-gm` in from two Playwright contexts. Check `game.users.get(id).active` and that both sockets stay connected for 60 s. Create a `wtx-` Folder in one; check the other receives the `createFolder` hook. | PASS = both stay connected and both receive broadcasts | Whether an agent may share a human's user (D3/D5) |
| E2 raw-socket fidelity | For each titan Actor subtype (`player`, `npc`): create `wtx-client-<type>` via `Actor.create` in a client, and `wtx-raw-<type>` via Node (`POST /join` → socket.io-client with cookie → `modifyDocument create`), same input. Read both via the client `toObject()`; diff excluding `_id`, `name`, `_stats` timestamps. Repeat for embedded Item and ActiveEffect (`parentUuid`), for update of a system field, for **delete** (client `delete()` vs raw `modifyDocument delete`: hooks and embedded cascade), and for invalid system data (wrong type, out-of-range). Also capture the client fingerprint (§4.5) per document class. | Per op class: PASS = empty diff for every subtype AND invalid data rejected or stored identically. Any diff = that op class is A-only | D1 boundary table |
| E3 headless cost | `playwright-core` with `executablePath` = (a) chromium-1223, (b) headless_shell-1223. ≥5 runs × `core.noCanvas` on/off as `wtx-assistant`. Measure launch→`game.ready` ms, browser-tree RSS after 60 s idle, mean CPU % over 60 s idle, and whether the Wiretap bridge identifies and `create_actor` round-trips. Report median and range. | Functional PASS required (ready, identify, create, sheet render offscreen). Build choice = smallest functional build; cost numbers go to the user for a budget | D2 build choice; agent runner defaults |
| E4 role behaviour | `wtx-assistant` (ASSISTANT) and `wtx-gm` (GAMEMASTER) with a human GAMEMASTER present and absent: read `game.users.activeGM` on each client. As ASSISTANT, try create/update/delete on every world document type, compendium write, `Setting` write and `User` role change; record denials. | Recorded matrix; no pass/fail | D4 |
| E7 unattended re-login | Set `world` in `options.json` (READ `common/config.mjs:65`), restart Foundry, run the agent-runner prototype script with stored credentials. Measure time to agent identify; then restart Foundry again with the script running. | PASS = agent identifies after both restarts with no human | M9 reconnect design |
| E8 schema size | For each document type and subtype in the titan world: byte size of (a) blank export (`new cls({name, type}).toCompendium(...)`), (b) a field-walker JSON Schema prototype run in the console, (c) both scoped to each top-level `system.*` path. Report bytes and bytes / 2 (estimate per §2.1). | Recorded table | D15 scoping thresholds, D26 |
| E9 titan result sizes | In the titan world, per Actor and Item subtype (`wtx-` documents plus the largest existing document per subtype, read only): bytes of the full `toCompendium` export, a compact-view prototype, a 10-field projection, and each top-level `system.*` path and `items` (the §2.1 path table for titan). On the headless agent (E3 build): `getBoundingClientRect` of 5 sheet selectors per sheet class with `core.noCanvas` on, a `sheet_layout` prototype's byte size, and the PNG pixel size of a default-sized sheet. | Recorded table; FLAG to the user any compact view > 2 KB or layout > 4 KB before M4/M15 | D20 values, D26, D25, `sheet_layout` design |

**Acceptance:** the results doc exists with every row filled or explicitly "not run: reason"; the `wtx-` census is
zero apart from the `wtx-*` users and the `Wiretap Experiments` folder contents the results doc lists as kept. The
decisions table in this plan is updated by the main thread, not by the experiment runner. **Context budget:** E9 is
filled; every titan size that breaks a §2.6 budget is listed with the proposed handling. **Risks:** sharing the world
with TITAN e2e (§4.8); E7 needs control of the Foundry process (the launcher).

### M1 — Endpoint registry, routing, protocol v2


**Goal:** replace `gmSockets` / first-socket routing with an explicit registry and router. **Depends on:** none (can
start before M0 finishes). **In:**

- `server/endpoints.ts`.
- `bridge:identify` v2 (`kind`, `dom`, `protocolVersion`; `gateState` arrives with M2, and `fingerprint` is dropped
  with M11/D27); v1 identify removed. Detailed design: `docs/specs/2026-10-11-wiretap-m1-endpoint-registry-design.md`. The
  sidecar acknowledges identify after the endpoint is registered (Socket.IO ack); the client exposes an "identified"
  state that the M9 runner waits on (M0 E3/E7: calls between identify-sent and registration failed).
- Routing per D5 (DECIDED) with per-call `endpoint` override. The default order lives in one constant and is
  documented in the README.
- `requestId`.
- Structured error contract `{code, message, failures?}`, message ≤ 512 B, `failures` capped at 10 plus a count.

**Out:** tokens (M10), raw socket (M11). **Tasks:**

1. Registry unit tests (add/update/remove on disconnect, kind priority).
2. Router.
3. Client identify v2.
4. `create_actor` runs on top of the router until M5 removes it (D16).

**Tests:** unit (registry, router, error-contract truncation); integration with two fake GM clients (agent + human)
asserting route choice and fallback on disconnect. **Acceptance:** existing `create_actor` tests green; routing tests
green; a v1 identify payload is refused with a clear log (no translation). **Context budget:** routing adds no fields
to tool results; a no-endpoint error is ≤ 256 B and names the fix ("open a GM tab or enable an agent"); the
error-contract truncation is unit-tested with a 50-failure input. **Risks:** a stale client build after an update →
refused with a "reload Foundry" message.

### M13 — Context-budget harness, result enforcer, handle store, path resolver


**Goal:** make §2.6 executable before any new tool exists. **Depends on:** M1. **Consent at start:** new files
`shared/budgets.js`, `shared/docPath.js`, `server/resultBudget.ts`, `server/handles.ts`, `tests/measure/`. **In:**

- `shared/budgets.js`: the §2.6 numbers as named constants, each tagged `hard` or `warn`.
- `shared/docPath.js`: the §2.8 grammar (parse, unsafe-segment refusal, resolve over an export by `_id` and index, one
  wildcard, missing-path list, grouping of embedded writes).
- `server/resultBudget.ts`: wraps every tool handler. Measures the serialized result; over the per-tool budget or the
  hard cap (8 KB default, `maxBytes` ≤ 16 KB) → stores the raw result in the handle store and returns `{handle,
  bytes, summary}` (summary = deterministic: top-level keys, counts, `name`/`type` if present). Caps error text.
  Refuses more than one image or an image above the pixel cap.
- `server/handles.ts`: per-session in-memory LRU (D23: 64 MB, 30 min idle), opaque ids, `slice(handle, paths?,
  offset, length)` with the §2.8 grammar; eviction is in memory only, nothing is written to disk.
- `tests/unit/contextBudget.test.js` (CI): builds the real MCP server in-process, lists tools with the SDK client and
  asserts per-tool name length, definition bytes, description length, total count and total bytes (hard vs warn per
  §2.6; warnings printed, hard limits fail); runs each registered tool's representative-result fixture through the
  enforcer and asserts its budget; asserts an over-cap fixture becomes a handle; asserts every tool name mentioned in
  a shipped skill or the server `instructions` exists (§2.7). A tool without a fixture fails the test.
- Fixtures: synthetic, obviously fake documents generated in the test (e.g. an actor with 120 embedded items named
  `MOCK_ITEM_n`), sized to exceed the cap, not copied from any system's data.
- `tests/measure/measureContext.mjs`: manual live calibration per §2.6 (not run in CI; no Foundry needed).

**Tests:** unit (enforcer thresholds at budget − 1, budget, budget + 1; handle LRU eviction; slice bounds; summary
determinism; path grammar incl. `_id` resolution, index, wildcard, missing, `__proto__` refusal). Integration: fake
GM client returns a 100 KB result → the MCP client receives a handle ≤ 256 B, and `read_handle` slices return within
the cap. **Acceptance:** the budget test runs in `npm test` and fails on a deliberately oversized definition in a
test-local registry. **Context budget:** this milestone's own surface (`read_handle`) is inside §2.6; the live
calibration has been run once and its numbers recorded next to §2.1's. **Risks:** byte budgets diverge from token
reality on other tokenizers → recalibration script; budgets change only by user decision.

### M2 — Risk-gate options


**Goal:** the gate settings and enforcement points before any write skill exists. **Depends on:** M1. **In:**

- World-scope `restricted` settings (§4.6, with D12a and D21 deciding which exist), labels and hints in
  `lang/en.json`, including the arbitrary-code caveat.
- Gate check helper `requireGate(name)`.
- The `wiretap.*` setting deny rule as a shared function used by every write path (update, replace, batch, delete).
- `gateState` pushed on identify and on change (`updateSetting` hook).

**Out:** the gated tools themselves (M5/M6). **Tests:**

- Unit: each gate default off.
- Unit: the deny rule for `wiretap.*` keys on create/update/replace/batch/delete.
- Integration: gate snapshot reaches the sidecar.
- e2e: as GM, toggling a gate in the settings UI updates the snapshot; the setting is restored afterwards (§4.8).

**Acceptance:** the deny function has 100% branch tests; no API path exists to set a `wiretap.*` setting from params.
**Context budget:** a gate denial is one error ≤ 256 B naming the gate and stating that only a GM can enable it in
the settings; gate state never appears in results except as one compact line in `list_endpoints`. **Risks:** a missed
write path. Mitigation: M4/M5 acceptance includes the deny test per path.

### M3 — Stateful MCP sessions


**Goal:** sessions with an SSE GET stream and `notifications/tools/list_changed` (D11, DECIDED). **Depends on:** M1,
M13. **In:**

- `sessionIdGenerator`; the stateless path is removed.
- A per-session `McpServer` holding the tool set of its routed endpoint.
- Server `instructions`: the ≤ 600-char pointer of §2.7.
- GET/POST/DELETE per the Streamable HTTP spec. HTTP `DELETE` ends a session in memory; it is not a file-deletion
  API.
- Idle-session expiry (in-memory); expiry also releases that session's handles (D23).
- `list_changed` on registry/endpoint change.

**Out:** auth (M10). **Tests:**

- Integration with the SDK client: a session is created; a tool registered later (fake client emits
  `bridge:registry`) appears after `list_changed`; the session ends cleanly.
- Live check against `claude` 2.1.296 repeating the coordinator's earlier measurement, recorded in the results doc.

**Acceptance:** a late tool is callable in the same session. **Context budget:** the live check also records (same
method as §2.1) whether a tool added by `list_changed` is deferred and its name cost, and the context cost of the
server `instructions`; `list_changed` fires at most once per registry change (debounced), so the client does not
re-list on every identify. **Risks:** session leak under abandoned clients. Mitigation: expiry with tests.

### M14 — Script runtime and the discovery layer


**Goal:** one registry for core tools, shipped scripts and plugin scripts (§2.4), and the skills that point to them
(§2.7). **Depends on:** M1, M3, M13. **Consent at start:** layout `src/bridge/scripts/`; delivery of user-facing
skills (§2.7). **In:**

- `src/bridge/scripts/registry.js`: `{name, version, description, inputSchema, result.budgetBytes, requires, mutates,
  gate?, handler}`; registration checks the §2.6 definition budgets and refuses with a logged reason.
- Client-side argument validation against the same JSON Schema the sidecar converts to zod.
- `ctx` (`core`, `shape`, `dom`, `signal`); `ctx.shape` implements compact view (40-tuple cap), projection, path
  slices (`shared/docPath.js`) and ack.
- Sidecar mapping registry → MCP tools (one tool per script; dispatcher deferred, D19).
- Routing by `requires` (D25): `dom` scripts need an endpoint with `dom: true`.
- `create_actor` moves onto the registry unchanged until M5 removes it (D16).
- A user-facing Wiretap skill (recipes naming the tools) and the `wiretap-mcp-bridge` developer skill updated to
  reference the tools.

**Tests:** unit (registration budget refusal, validation, `ctx.shape` outputs, `requires` routing); integration (fake
client registers a script → tool listed → call → enforcer). **Acceptance:** `create_actor` works through the
registry; a `dom` script with only a non-DOM endpoint returns a ≤ 256 B error naming the missing endpoint kind.
**Context budget:** every registered entry has a budget-test fixture (M13 test enforces); `ctx.shape` outputs meet
§2.6 on the synthetic fixtures; the skill-reference check of M13 passes. **Risks:** a second abstraction over ops →
scripts call ops, never the reverse.

### M4 — Core read tools

**Goal:** `list_document_types`, `get_document` (compact / `fields` / `paths` / `mode:"full"`), `search_documents`,
`describe_schema` (with `path`), registered as M14 scripts. **Depends on:** M1, M3, M13, M14. M0 inputs are in (E8,
E9): the compact view starts from the E9 prototype (uuid, name, type, up to 24 system leaves matched by a key-name
pattern, embedded tuples; ≤ 1,574 B on titan) and the per-subtype key-field lists are fixed and reviewed in this
milestone. **In:**

- Primary, embedded (via `parentUuid` or a path into the parent) and compendium (`pack`) reads.
- Default compact view; `fields` projection; `paths` (§2.8, incl. `derived: true` on client endpoints); `mode:"full"`
  canonical representation (§4.4); `ifModifiedSince`.
- `search_documents`: default limit 20, max 100, cursor, `total`; rows are `[uuid, name, type]` unless `fields`.
- `describe_schema(documentName, subtype, path?)` per D15: without `path`, the blank export plus a one-level schema
  outline (top-level field names and field classes); with `path`, the blank export's subtree plus constraints
  (choices, min/max, integer, required, nullable, blank) from a field-walker over
  `CONFIG[doc].dataModels[subtype].schema` and the core schema. The walker marks free-form fields (ObjectField 158,
  AnyField 3, JSONField 2, TypedObjectField 3 occurrences in E8) as free-form instead of expanding them, refers to
  embedded collections (EmbeddedCollectionField 39, EmbeddedCollectionDeltaField 4) by document name instead of
  inlining them (the inlining is what made Adventure 26.5 KB), and resolves TypeDataField (15) by subtype. Blank
  examples for ActorDelta, Drawing, Folder, Setting, TableResult, Tile and Wall use the minimal required fields or
  are omitted (E8: blank construction fails).
- `wiretap.*` settings and `User` password fields excluded from all reads, including any path that reaches them.

**Tests:**

- Unit: field-walker over each core field class with mocked fields; representation function; exclusions (a path to a
  password field returns it in `missing`, never the value); compact view, projection and path sizes on synthetic
  fixtures.
- Integration: fake client.
- e2e: read `Wiretap E2E ` documents the spec creates and records; teardown per §4.8.

**Acceptance:** every type in `ALL_DOCUMENT_TYPES` can be listed and read in the titan world (e2e enumerates); `paths`
returns `system.attributes`-style slices and `items.*.name` keyed by `_id` on a titan actor. **Context budget:**
compact ≤ 2 KB per document for every titan subtype in e2e (hard); a `paths` or full read above the hard cap returns a
handle; `describe_schema` without `path` within the 8 KB default cap for every titan document type and subtype (E8:
the blank Actor export alone is 4.85 KB, so the outline has ≈ 3 KB); a titan full actor read (5.7–12.5 KB, E9)
returns a handle at the default cap and inline with `maxBytes: 16000` (1 KB = 1,000 bytes). **Risks:** schema output size (E8: an
unscoped Actor walk is 19.9 KB, which is why constraints need `path`).

**As built:** see [`docs/PROGRESS.md`](PROGRESS.md) "As-built notes: M4" and the `wiretap-scripts` skill.

## Dropped: M11

### M11 — Raw-socket executor (option B)

**Status: DROPPED (D27 DECIDED 2026-10-11, user accepted the recommendation); not built, logged in `docs/TODO.md`.** E2 certifies reads of stored source data only
(§4.3). What a read-only B would add: answers when no client endpoint is live, limited to source data (no derived
values, no compact view key fields that depend on prepared data, sparse `system` for raw-created documents). What it
costs: a second login path and executor, a second shaping path, and an always-present risk that a later change routes
a write over it; the server stores invalid `system` values (E2), which the sidecar cannot detect without the
system's DataModels. The M9 runner provides a full client for ≈ 440 MB and 1.8 s (E3), and recovers from a restart in
≈ 8 s warm (E7). D27 = drop: this milestone is logged in `docs/TODO.md` and removed from the order; the read-only form below is kept
only as the scope to revisit if a raw-socket path is ever wanted. **Depends on:** M5, M8, M2 (gate snapshot). **In (read-only form):**

- `server/rawSocket.ts` (login with an agent credential, `modifyDocument` with action `get` only; any other action is
  refused in code, not by configuration).
- Eligibility = reads only ∩ gate snapshot.
- `wiretap.*` deny.
- Results marked `executor: "raw"` and shaped by the same `ctx.shape` rules (compact / projection / path slices /
  ack) on the sidecar.

**Tests:** unit (eligibility; non-`get` actions refused); integration against a fake Foundry socket server; e2e
comparing raw reads with the client path's source data. **Acceptance:** an ineligible op with no client gives a clear
"needs a Foundry client" error.
**Context budget:** raw results equal the client-path results plus at most 20 B (`executor`), asserted per certified
op.
