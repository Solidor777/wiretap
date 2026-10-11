# M0 experiment results

Run 2026-10-11 against Foundry 14.364, world `test-titan`, system titan 2.2.0, on a Windows host (i7-13700K, 24
logical processors). Run by the coordinator's experiment agent; condensed and checked against the raw JSON by the
planning agent. Raw data and scripts are in the session scratchpad (`wtx\*.json`, `wtx\*.mjs`); they are not
committed. Labels: **MEASURED** (raw file named), **READ** (source location named), **INFERRED** (not verified).
No passwords, salts or credential files are reproduced here.

## Corrections the experiment agent made to its own runs

- **E4 first run used the wrong role.** `wtx-assistant` was created as TRUSTED (2) instead of ASSISTANT (3). That run
  is kept as `e4-trusted-role2.json`; the user was updated to role 3 and E4 was re-run (`e4.json`). P1 ran while the
  user still had role 2 (MEASURED, `p1.json` shows `role: 2`); P1's result does not depend on that role.
- **E2 first update rows used a malformed path.** `e2.json` updated `system.system.documentVersion` (doubled
  `system`); the client refused it and the raw socket stored it under `system.system`. The valid/wrong-type/
  non-integer update rows were re-run with `system.attribute.body.baseValue` (`e2b.json`); the table below uses
  `e2b.json`. Side observation (MEASURED, `e2.json`): the server also accepted the malformed path.
- **E3 smoke run discarded.** `e3-smoke.json` is a single preliminary run; the reported figures come from the 5-run
  set (`e3-stats.json`).
- **E3f race.** The first MCP call after the agent identified failed; the cause and the passing retry are recorded
  under E3.

## Launcher (MEASURED, `debug/dumps/e2e-server.log`)

- `[supervisor] started` 07:34:27.436Z → `Server started and listening on port 30000` 07:34:53.932Z: 26.5 s.
- World `test-titan` launched; `game.modules.get('wiretap').active === true` (MEASURED, `probe.json`).
- Startup log: `Metadata validation failed for system "dnd5e": The file "dnd5e.css" ... does not exist` (unrelated
  system), and Foundry's own `Deleted 4 orphaned embedded documents from the scenes database` before any experiment
  session.
- During the experiments the log has 140 lines `TypeError: Cannot read properties of undefined (reading 'length')`
  (MEASURED, `grep -c`), each after a rejected server-side `modifyDocument`. The experiment agent READ
  `dist/database/backend/server-backend.mjs`: after an error the result is undefined and its `length` is read when a
  callback was supplied. The caller still receives its reply.

## World at start (MEASURED, `probe.json`)

5 users (E2E GM 1, E2E GM 2, Gamemaster: GAMEMASTER; E2E Player 1, E2E Player 2: PLAYER). Actor subtypes `player`,
`npc`; Item subtypes `ability`, `armor`, `commodity`, `equipment`, `shield`, `spell`, `weapon`; ActiveEffect subtypes
`base`, `effect`, `condition`. Active modules: hush, muffler, titan-vttrpg-compendium, wiretap.

## P1 password shape (MEASURED, `p1.json`) — PASS

| Path | GM client | PLAYER client |
|---|---|---|
| browser `_source.password` / `toObject().password` | `""` (length 0) for all 8 users | same |
| browser `passwordSalt` | absent | same |
| browser `game.data.users[i]` | keys `password`, `passwordSalt` present; `""` / absent | same |
| raw socket `getJoinData` and `world` `users[]` | no password keys | same |
| raw socket `modifyDocument {type: 'User', action: 'get'}` | keys present, both `""` | same |
| anonymous session (cookie from `GET /join`, no login) `getJoinData` | no password keys; **full user list with names and roles** | — |

The `wtx-*` users had real passwords; their client-visible values were empty strings on every path. Consistent with
READ `User.dump` deleting both fields.

## E1 same user twice (MEASURED, `e1.json`) — PASS at the socket level

- The stock `/join` form refuses: the active user's option is disabled ("no option"). A direct `POST /join`
  returned 200 and the second context reached `/game`.
- 12 samples, t = 0 to 55.2 s: both sockets connected, distinct socket ids, 0 disconnects, the user `active` in both.
- `wtx-e1-folder` created in context A at t₀: `createFolder` fired in A at t₀ + 15 ms and in B at t₀ + 14 ms.
- After closing B, A stayed connected and the user stayed active.

## E2 raw-socket fidelity (MEASURED, `e2.json`, `e2b.json`, `e2c.json`, `scene.json`)

Client path: a Playwright page as `wtx-gm` calling `Document.create` / `createEmbeddedDocuments` / `update`. Raw path:
Node as `wtx-gm` (`POST /join` → socket.io-client with the session cookie → `modifyDocument`), same input. Diffs
exclude `_id`, `name`, `prototypeToken.name`, `_stats` times. "Stored" = server `modifyDocument get`; "client view" =
`toObject()` after the broadcast.

| Op class | Client-view diff paths | Stored diff paths | What differs |
|---|---|---|---|
| create Actor `player` | 9 | 21 | titan `_preCreate` output missing on raw: `prototypeToken.actorLink`, `disposition`, `displayName`, `displayBars`, `bar1`/`bar2` attributes, `sight.enabled`; `flags.titan.uuid`; stored `system` has no defaults |
| create Actor `npc` | 6 | 17 | same minus actorLink / disposition / sight |
| create Item (7 subtypes) | 1–2 | 8–14 | `img`, `flags.titan.uuid`, stored `system` defaults |
| create embedded Item (7 subtypes × 2 actors) | 1–2 | 12 | as Item |
| create embedded ActiveEffect (3 subtypes × 2) | 1–2 | 1 | `start` (client sets time/combat), `showIcon` |
| create Item with inline effects | 2 | 12 | as Item |
| create Scene | — | — | raw Scene has 0 Levels, `initialLevel` null; client Scene has 1 Level; `view()` of the raw Scene throws `Cannot read properties of undefined (reading 'id')` |
| update valid `system.attribute.body.baseValue = 4` (player, npc) | 0 | 0 | identical |
| update wrong type `"not-a-number"` | — | differs | client: nothing sent; raw: server stores the string; live clients keep 4 |
| update non-integer 2.5 | — | differs | client rounds and stores 3; raw stores 2.5; clients show 3 |
| create with invalid `system` | — | — | client: nothing created; raw: server creates it; it never appears in live clients; on a fresh load it is in `game.actors.invalidDocumentIds` (`e2c.json`) |
| create unknown subtype `wtxbogus` | — | — | raw: server rejects (`"wtxbogus" is not a valid type for the Actor Document class`) |
| replay of the client's exact emitted create payload (player, npc, weapon) | — | only `flags.titan` | a raw create matches only when the sender reproduces the client pipeline output |
| out-of-range | — | — | not run: no ranged NumberField in titan Actor schemas |
| delete | — | — | not measured for fidelity (raw delete was used only for cleanup) |

Fingerprint (MEASURED in a `wtx-gm` page; titan class names are minified): titan Actor and Item override `_preCreate`;
titan ActiveEffect overrides `_preCreate` and `_preUpdate`; ChatMessage overrides `_preCreate`. Core client classes
with their own `_pre*` include Scene, Token, Folder, Cards, Combatant, Level, Playlist, PlaylistSound, TableResult,
ActorDelta and every CanvasDocument. No `preCreate*` / `preUpdate*` / `preDelete*` hooks are registered.

**Verdict:** every create op class differs (A only); a valid system-field update is identical; the server does not
validate `system` data (it stores invalid values the client refuses).

## E3 headless agent cost (MEASURED, `e3-stats.json`, `e3f.json`, `e3f-race.json`)

Playwright 1.60 `chromium.launch({headless: true, executablePath})`, one fresh browser per run, login as
`wtx-assistant` (ASSISTANT) through the form, `core.noCanvas` set by a localStorage init script in that context. 5 runs
per configuration, interleaved. "noCanvas off" runs then view a client-created scene. 60 s idle after ready. Memory =
sum over the browser process tree (Win32_Process); CPU = % of one logical core over the 60 s. Builds: full =
chromium-1223 (413 MB on disk), shell = chromium_headless_shell-1223 (273 MB).

| Config | launch→ready ms min / med / max | tree working set MB (med) | tree private MB (med) | idle CPU % of one core min / med / max | processes |
|---|---|---|---|---|---|
| full, noCanvas on | 2731 / 2945 / 3177 | 547.3 | 345.0 | 35.8 / 42.1 / 43.9 | 8–9 |
| full, noCanvas off (+scene) | 3206 / 3376 / 4031 | 814.1 | 732.8 | 57.1 / 62.2 / 66.7 | 8–9 |
| shell, noCanvas on | 1649 / 1826 / 2204 | 438.7 | 294.8 | 16.7 / 18.2 / 18.8 | 5 |
| shell, noCanvas off (+scene) | 2546 / 2940 / 3001 | 830.7 | 589.9 | 602.4 / 608.3 / 749.6 | 5 |

- The shell drawing a canvas uses about 6 cores at idle (INFERRED cause: software WebGL render loop).
- Functional check (`e3f.json`, noCanvas on, one run per build): the bridge identified as `isGM: true`; MCP
  `create_actor` succeeded (20 ms full, 15 ms shell; `_stats.lastModifiedBy` = `wtx-assistant`); an offscreen actor
  sheet rendered 850×925 (101 ms full, 50 ms shell).
- **Race (`e3f-race.json`):** the first `create_actor`, made as soon as the identify was *sent*, failed on both builds
  with `No Foundry GM client connected`. Identify travels over Engine.IO polling about 100 ms before the websocket
  upgrade (debug trace); the call succeeded once the identify request had completed.

## E4 role behaviour (MEASURED, `e4.json`)

READ: roles PLAYER 1, TRUSTED 2, ASSISTANT 3, GAMEMASTER 4 (`common/constants.mjs:1243-1255`); `User#isGM` =
`hasRole(ASSISTANT)` (`common/documents/user.mjs:124`); `activeGM` = highest role among active GM users, ties to the
smallest id (`client/documents/collections/users.mjs:70-96`).

| Active users | activeGM (all clients agree) | ASSISTANT `isGM` / `isActiveGM` |
|---|---|---|
| ASSISTANT only | ASSISTANT | true / true |
| ASSISTANT + GAMEMASTER `wtx-gm` | `wtx-gm` | true / false |
| ASSISTANT + `wtx-gm` + `E2E GM 1` (both GAMEMASTER) | `wtx-gm` (smaller id) | true / false |
| ASSISTANT + `E2E GM 1` | `E2E GM 1` | true / false |

Permission matrix (raw socket, `dryRun` where the safety rules did not allow a real write; a `dryRun` control matched
a real create for one allow and one deny case):

| Operation | ASSISTANT | GAMEMASTER | PLAYER |
|---|---|---|---|
| create/update Actor, Item, Scene, JournalEntry, Macro, RollTable, Playlist, Cards | allow | allow | deny |
| update an Actor created by another GM user | allow | allow | deny |
| create Combat, top-level Folder, world Setting, User | allow | allow | deny |
| update User role PLAYER → TRUSTED | allow | allow | deny |
| update User role PLAYER → GAMEMASTER | **deny** (`lacks permission to update User`) | allow | deny |
| create in world compendium | allow | allow | deny |

ChatMessage, Adventure and FogExploration rows ended in payload or server errors, not permission results.

## E7 unattended re-login and Foundry restart (MEASURED, `e7.json`, `summary.json` key `e7`)

Unattended login without a restart (earlier run): a script logged in with stored credentials and identified (E3
shell/noCanvas median launch→identify-sent 2154 ms) and completed an MCP round trip after identify finished.

Restart run, 2026-10-11 from 08:17:17.691Z. Headless shell, `core.noCanvas` on, pre-existing GAMEMASTER user
`E2E GM 1` (not an agent user; no new users). The coordinator restarted Foundry through the launcher
(`npm run foundry:start`, which passes `--world=test-titan`, so the `options.json` world setting was not needed). One
restart was run, not two.

- Before the restart: login → ready 1,869 ms; the identify request completed; MCP `create_actor` succeeded in 57 ms.
- 08:17:58.5: the Foundry socket closed ("You have lost connection to the server"); 7 reconnect attempts about 2.8 s
  apart were refused.
- Launcher log: new server process 08:18:11.029, listening 08:18:15.920 (4.9 s spawn → listening; the cold start in
  this session was 26.5 s).
- The page's socket reconnected 17.4 s after the disconnect (socket events: disconnect → reconnect = 17,444 ms).
- **The page did not recover by itself.** About 0.3 s after reconnecting it was sent to `/join` and stayed there with
  `game.ready` false; the sidecar socket closed on that navigation, and the bridge did not identify again. INFERRED
  cause: the server keeps sessions in memory (the experiment agent READ `dist/sessions.mjs`), so the restart lost the
  page's session.
- MCP `create_actor` without a new login failed in 11 ms: `No Foundry GM client connected`.
- Recovery by a fresh login in a new browser context: ready in 2,057 ms, identify completed, `create_actor` succeeded
  in 37 ms; done 7,822 ms after the restart flag.
- **Correction:** `e7.json` records `autoRecovered: true` (`flagToAutoRecoveredMs: 2023`). That is a false positive:
  one 1 s sample fell in the 0.3 s window between reconnect and the redirect. `summary.json` holds the corrected
  `pageAutoRecovered: false`; the final sample of the original page shows `/join`, `ready: false`.
- Cleanup: `wtx-e7-pre`, `wtx-e7-post-fresh` and the E7 `Wiretap Experiments` Actor folder deleted through Foundry
  document deletion; afterwards 0 `wtx-` actors and 0 E7 folders.

## Launcher defect found during M0 (MEASURED; logged in `docs/OPEN_BUGS.md`)

Stopping a background `npm run foundry:start` ended the `npm` wrapper, but the supervisor and the Foundry server kept
running and serving :30000 until the supervisor's process tree was killed. The cause recorded in `OPEN_BUGS.md` is
READ, not measured: the supervisor watches the nearest non-shell ancestor (`pickWatchPid`), which under `npm` is a
longer-lived process.

## E8 schema size (MEASURED, `e89.json`)

84 (document, subtype) rows; field-walker JSON bytes base + system: Actor `player` 6003 + 13923 = 19,926; `npc` 6003 +
13856 = 19,859; Items 2,046–2,550; Scene 5,645; Token 6,392; Adventure 26,460 (walks every embedded schema). Sum
262,178. Blank `toCompendium` export: Actor 4,854 / 4,840; Items 389–648; Scene 1,234; Token 1,212. Blank construction
fails for ActorDelta (needs parent), Drawing, Folder (needs type), Setting (needs key), TableResult, Tile, Wall.
Field classes needing special handling (counts): ObjectField 158, DocumentFlagsField 46, EmbeddedCollectionField 39,
DocumentOwnershipField 21, HTMLField 16, TypeDataField 15, EmbeddedCollectionDeltaField 4, AnyField 3,
TypedObjectField 3, JSONField 2, TypedSchemaField 1.

## E9 titan result sizes (MEASURED, `e89.json`; shell build, noCanvas on, viewport 1920×1080)

| Document | Full export B | Compact prototype B | 10-field projection B |
|---|---|---|---|
| Actor `player`, experiment doc / largest existing | 12,011 / 12,492 | 1,574 / 1,455 | 277 / 323 |
| Actor `npc`, experiment doc / largest existing | 11,994 / 5,738 | 1,568 / 1,060 | 271 / 270 |
| Item `ability`, experiment doc / existing | 684 / 1,697 | 127 / 116 | 202 / 1,224 |
| Items armor…weapon (experiment docs only) | 634–887 | 124–152 | 199–211 |
| Largest embedded items on existing actors (armor, ability, weapon, spell) | 676–1,054 | 143–168 | 215–532 |

- No compact view above 2 KB (max 1,574 B). The 1,224 B projection includes a long text leaf (INFERRED).
- Sheets (offscreen, all rendered): actor 850×925, item 700×650. `sheet_layout` prototype (depth 2, maxNodes 40):
  actor 441 B / 11 nodes, item 401 B / 10 nodes, but depth 2 reaches only the window header and content wrappers
  (INFERRED: a useful layout needs more depth; not measured).
- Element screenshot PNG: actor 850×926, 111,415–115,249 B; item 700×650, 22,882–30,743 B.
- Coverage gap: no existing world items for 6 of 7 item subtypes.

## E5/E6 (MCP transport, earlier run 2026-10-10, `e5-*.log`, `summary.json`)

Stateless server: tool list fixed for the session. Stateful server with `notifications/tools/list_changed`: Claude
Code re-listed tools 6 ms and 5 ms after registration (2 runs) and called the new tool in the same session. Server
`sampling/createMessage` → `-32601 Method not found`.

## Created and deleted (MEASURED, `created.json`, `cleanup.json`)

Created: users `wtx-assistant`, `wtx-gm`, `wtx-player`; `Wiretap Experiments` folders; `wtx-` documents. Deleted
through Foundry `modifyDocument delete` as `E2E GM 1`: Actor 19, Item 21, JournalEntry 4, Scene 4, Macro 3, RollTable
3, Playlist 3, Cards 3 (embedded documents with their parents), Folder 1 + 8, User 3. Skipped 0, errors 0, unrecorded
`wtx-` documents 0; a scan afterwards found 0 `wtx-` documents in Actor, Item, Scene, JournalEntry, Macro, RollTable,
Playlist, Cards, Folder, User, ChatMessage and Combat. No files were deleted. Not reverted: login activity of
`E2E GM 1`. E7 created and deleted its own three documents (see E7). Deviation from plan revision 3 (M0 safety limits said `wtx-*` users are not deleted): the three
experiment-created users were deleted, through Foundry document deletion.
