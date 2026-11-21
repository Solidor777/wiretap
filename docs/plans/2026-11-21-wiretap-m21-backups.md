# Wiretap M21 "Document backups" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `parallel-subagent-development` to implement this plan. Steps use
> checkbox (`- [ ]`) syntax for tracking. Every task brief is the task's text plus the whole "Global Constraints"
> section, copied verbatim: the implementer does not read this file.

**Goal:** ship the four backup tools `backup_documents`, `list_backups`, `restore_backup` and `delete_backup`, the
piece transport that moves backup data between the GM client and the sidecar (bridge protocol 5), the GM-only world
setting `backupFolder` and the `settings` object that carries it to the sidecar, the `allowBackupAnyFolder` gate, the
`trash` dependency with the recycle-bin-only removal rule (D34), and the user-facing skill text that tells the agent
when to offer a backup.

**Architecture:** the four tools are sidecar built-ins registered beside `read_handle` in every MCP session
(`server/backupTools.ts`), backed by a file store (`server/backups.ts`) that alone touches backup files and alone
imports `trash`. A backup runs as one routed op, `backupExport`, on the picked GM client: the client plans the
selection, measures it, then exports document by document and sends 512,000-byte pieces on `bridge:backupPiece`; the
sidecar appends each piece to an exclusively created file and writes the fixed-width header last. A restore runs as
op `backupRestore`: the sidecar opens and checks the file, then sends its bytes in pieces on `bridge:restorePiece`;
the client applies each line through the existing replace and create code (`prepareReplace` / `prepareCreate`), so
every gate, the write guard and Foundry validation apply. Each piece is acked before the next is sent.

**Tech Stack:** TypeScript on `tsx` (sidecar), JavaScript ES modules (shared, client), Foundry VTT v14 client API,
Socket.IO 4 binary payloads, MCP SDK (Streamable HTTP), zod, the `trash` npm package, vitest + happy-dom, Playwright
(headless).

**Spec:** `docs/specs/2026-11-21-wiretap-backups-design.md` (approved 2026-11-21; the owner delegated the remaining
calls), with `docs/PLAN.md` §5 "M21 — Document backups" (tests, acceptance, context budgets), D33, D34, §4.4
(canonical export and redaction), §4.6 (gates) and §4.8 (test-data cleanup).

## Model/Effort directives

- Plan writer: dispatched `sdd-plan-writer` (Opus).
- Execution method: parallel
- Loop owner: mainline session
- Implementer per task (project rule, `.claude/CLAUDE.md`): `foundry-module-dev` for Tasks 4, 5, 6 and 7 (client
  `.js` under `src/`); `wiretap-coder` for Tasks 1, 2, 3, 8, 9, 10, 11 and 12 (`server/`, `shared/`, tests, build
  config, docs). The `dispatching-sdd-agents` tiers choose only the model and effort these agents run at.
- Per-task review: `wiretap-spec-reviewer`, then `wiretap-code-reviewer`; at most three fix rounds per task. Tasks
  2, 3, 4, 6 and 8 take a buddy check instead (see "Buddy-check directives").

## Global Constraints

Every task's requirements include each line below.

- **Scope.** The user asked for "a lean set of skills / tools to do backups and advise the agent to use or offer it
  before bulk changes or risky operations", for a restore tool, for backups "wherever you ask it to" with a default
  folder, for the `trash` npm package, and for the rule that Wiretap removes files only through the recycle bin. This
  milestone builds that exactly as `docs/specs/2026-11-21-wiretap-backups-design.md` states it, with the calls in
  "Designer decisions" below. Whole-world backups, undo and scheduled backups are not built. Nothing outside the task's
  own files is changed; a defect found elsewhere is reported, not fixed.
- **Builders carry this line word for word:** "No unrequested features, shims or defensive code. A guard against input
  the product cannot send is not requested." The sidecar treats what arrives on a socket as untrusted (any local
  process can connect and identify), so bounds on piece and result shapes received from a client are requested.
- **Agents.** Implementers: `foundry-module-dev` for client `.js`/`.svelte`; `wiretap-coder` for `server/`,
  `shared/`, tests, build config. Reviewers: `wiretap-spec-reviewer` then `wiretap-code-reviewer`.
- **Skills first.** Before reading or editing a subsystem's files, read its skill file under `.claude/skills/`:
  `wiretap-codebase-core` always; `wiretap-sidecar` for `server/**` and `shared/**`; `wiretap-mcp-bridge` for
  `server/endpoints.ts`, `server/foundryBridge.ts`, `server/mcp.ts`, `src/bridge/foundryBridge.js` and the ops;
  `wiretap-mcp-sessions` for `server/mcp.ts` sessions and tests under `tests/integration/mcpSessions*`;
  `wiretap-client` for `src/bridge/*.js`, `src/settings/**`, `src/hooks/**` and `lang/**`; `wiretap-scripts` for
  `src/bridge/scripts/canonical.js`, `shared/scripts.js` and `skills/**`; `wiretap-writes` for
  `src/bridge/scripts/writeReplace.js`, `writes.js` and `tests/unit/mockWriteWorld.js`; `wiretap-write-guard` for
  `shared/gates.js` and the guard; `wiretap-build-test` for `tests/**`. For Foundry API behaviour invoke the
  `foundry-vtt:foundry-vtt` skill.
- **TDD, no stubs.** Write the failing test, see it fail, write the code, see it pass. No placeholder bodies.
- **Formatting.** 3-space indentation as the existing files use; 120-character lines; multi-line `{}` on every
  conditional; objects with more than one property and arrays with more than one entry are multi-line; every variable
  typed with a one-line comment (JSDoc `@type` in `.js`, a type annotation plus a `//` line in `.ts`); every function a
  JSDoc block with typed params (`{Type} [optional] - text`) and a typed return (async included); classes and objects
  typed with `@typedef` / interfaces. No `:global` CSS selectors.
- **Comments.** Present tense, what or why only. No task IDs, plan or spec references, review notes or history. Cite
  the Foundry source file for any Foundry behaviour a comment relies on. A `TODO:` describes the work only and is
  logged in `docs/TODO.md`.
- **No backwards compatibility.** No aliases, shims, deprecation paths or migrations (the bare `GateState` payload of
  `bridge:gateState` stops being accepted). No dynamic imports in shipping builds. No test code in shipping builds.
- **Recycle bin only (D34).** No permanent file-deletion API in product or test code: no `fs.rm*`, `fs.unlink*`,
  `fs.rmdir*`, `fs.promises` equivalents, recursive removal helpers, `rimraf` or `del`. A file is removed only by
  `trash([path], { glob: false })` of the `trash` package, imported only in `server/backups.ts`.
  `tests/unit/noPermanentDelete.test.js` (Task 1) enforces both. Unit and integration tests never run the real
  `trash`: they inject `fakeTrash(binDir)` of `tests/unit/backupTestHelpers.js` (Task 2), which moves the file into a
  bin directory with `fs.renameSync`. Only e2e runs the real `trash`, on files under `test/tmp/`. Tests write files
  only under a unique scratch root `test/tmp/<prefix>-<Date.now()>-<pid>-<counter>/` (the pattern of
  `tests/unit/buildOutput.test.js`; `test/tmp/` is gitignored and scratch roots stay there). Foundry documents
  created by tests are deleted through Foundry calls (§4.8).
- **Never probe malformed create data on the shared live world** (a wrapper in `name` once stopped the world booting).
  Unit tests mock `game`; e2e creates only well-formed `Wiretap E2E ` documents.
- **e2e.** Headless Playwright only (`playwright.config.mjs`). Every wait inside a loaded page is at most 1000 ms
  (`expect.poll`, `waitForFunction`, `toPass`, `timeout:`); world boot, login, reload, the build, the `actionTimeout`
  safety net and per-test limits are exempt. Only one task runs e2e at a time: `npx playwright test` uses the live
  Foundry on `:30000` (shared with TITAN e2e) and ports 31416, 31418 and 31419, and overwrites `dist/`; run
  `npm run build` after it. Every e2e document name starts with `Wiretap E2E ` and is recorded with `recordDocument`
  of `tests/e2e/registry.js` right after creation; `settleRegistry` / `teardownRecorded` remove it.
- **Context budgets (D17), enforced by `tests/unit/contextBudget.test.js`:** `backup_documents` result ≤ 256 B;
  `list_backups` ≤ 2 KB (2000 B); `restore_backup` ≤ 4 KB (4000 B); `delete_backup` ≤ 128 B. Every definition
  ≤ 800 B; description ≤ 160 chars (warn) and ≤ 240 (hard); all definitions together ≤ 16,000 B; at most 30 listed
  tools. A budget is raised only by the user. Bytes are raw UTF-8 bytes; 1 KB = 1000 B in this project.
- **Errors.** A sidecar tool fails by throwing `new BridgeError(code, message)` of `server/endpoints.ts`; the result
  enforcer turns it into `<code>: <message>` within 512 B. A client op fails by throwing `new ScriptError(code,
  message)` of `src/bridge/scripts/registry.js` (code `/^[A-Z][A-Z0-9_]{0,63}$/`, message ≤ 256 B). No message echoes
  file content or unbounded caller text: bound caller text with `cleanForLog` of `shared/logText.js` and
  `truncateUtf8` of `shared/utf8.js`.
- **Commands.** `npm test`, `npm run typecheck`, `npm run eslint`, `npm run build`, `npx playwright test <spec>`.
  A task is verified when all three of `npm test`, `npm run typecheck` and `npm run eslint` pass; report their output.
- **Commits.** Commit each task as one logical unit once local CI passes. Do not push (the controller pushes at the
  milestone end). End commit messages with the attribution lines the controller gives.
- **Foundry source.** Behaviour cited below was read in the Foundry v14 tree at `C:\FoundryVTT\V14\dev\foundry\`
  (build 14.364, the version the live world runs); paths below are relative to it.
- **Repeat errors.** The second occurrence of the same failure ends the task: report the count and a diagnosis
  instead of patching the symptom again.

## Review Focus

Inputs the spec implies but does not spell out, most likely to bite first; each has a test in the owning task.

1. A selection that names one document twice: an embedded uuid beside its parent, a uuid listed twice, or a folder
   group whose subfolder holds a document also named by uuid. Expected: one line per document; `parents` counts the
   embedded uuids mapped to a parent. Test: Task 5.
2. One document whose line is larger than a piece (a Scene with many walls, a journal with long pages). Expected: the
   line is split across pieces and restored intact. Tests: Task 5 (piece writer), Task 6 (line reader), Task 10.
3. A `folder` argument spelled differently from the default folder or the `backupFolder` setting (other letter case,
   a trailing separator, a `..` segment) on Windows. Expected: recognised as the same folder, so no gate is needed; a
   different folder still needs `allowBackupAnyFolder`. Test: Task 2.
4. A document deleted after the backup whose Folder was deleted too and is not in the backup. Expected: re-created
   outside any folder with the reason `FOLDER_GONE`, not failed. Test: Task 6.
5. A user renames, copies, truncates or appends to a file in the backup folder, or a crash leaves a partial file.
   Expected: an off-pattern name is `BACKUP_NOT_FOUND` and is not listed; a size that differs from `header.bytes` is
   `BACKUP_INVALID`; a partial file (its header line still blank) is counted as `invalid` by `list_backups` and never
   restored. Test: Task 2.

---

## File structure

| File | Task | Responsibility |
|---|---|---|
| `package.json`, `package-lock.json` | 1 | `trash` runtime dependency |
| `shared/backup.js` | 1 | Backup constants, error codes, file name, header line format and checks, line typedefs |
| `shared/bridgeSettings.js` | 1 | The `settings` object of identify and its update: defaults and sanitizer |
| `shared/protocol.js` | 1 | `PROTOCOL_VERSION` 5, the two piece events, the two ops, `PIECE_REFUSED` |
| `shared/budgets.js`, `shared/gates.js`, `lang/en.json` | 1 | Four result budgets; `allowBackupAnyFolder`; gate and setting texts |
| `tests/unit/noPermanentDelete.test.js` | 1 | D34 source check over the whole repository code |
| `server/backups.ts` | 2 | The file store: folders, exclusive create, header rewrite, open checks, list, recycle bin |
| `server/mcpConfigFile.ts` | 2 | Exports the `.wiretap/` directory and symbolic-link checks the store reuses |
| `tests/unit/backupTestHelpers.js` | 2 | `scratchRoot`, `fakeTrash` for every later test |
| `server/endpoints.ts` | 3 | `settings` on endpoints; router `prepare`, `onSent`, `replyWaitMs`, `snapshot`; reserved codes |
| `server/foundryBridge.ts` | 3 | `bridge:gateState` payload `{ gateState, settings }`; piece receive and send |
| `src/bridge/pieces.js` | 4 | Client piece channel: send backup pieces, receive restore pieces |
| `src/bridge/bridgeSettings.js`, `src/settings/bridgeSettings.js` | 4 | Read and register `backupFolder` |
| `src/bridge/foundryBridge.js`, `src/hooks/OnceInit.js` | 4 | Identify and push carry `settings`; op handlers get `{ requestId, pieces }` |
| `src/bridge/scripts/canonical.js` | 5 | `exportForBackup`: the canonical export plus the paths redaction removed |
| `src/bridge/backup/selection.js`, `pieceWriter.js`, `exportBackup.js` | 5 | Plan, measure and stream a backup |
| `src/bridge/scripts/writeReplace.js` | 6 | `prepareReplace` / `runReplace` split and the restore mode |
| `src/bridge/backup/lineReader.js`, `secretCarry.js`, `restoreBackup.js` | 6 | Read lines from pieces, carry live secret keys, apply a restore |
| `src/bridge/foundryBridge.js` | 7 | The two backup ops in the op table |
| `server/backupTools.ts` | 8 | The four tool registrations, the busy lock, folder and gate checks, result fitting |
| `server/mcp.ts`, `server/server.ts`, `shared/scripts.js` | 9 | Register the tools in every session; reserved names; instructions text |
| `tests/unit/contextBudgetHarness.js`, `skills/wiretap/SKILL.md` | 9 | Budget fixtures; the agent guidance |
| `tests/integration/backupTools.test.js` | 10 | Pieces both ways over a real socket, failures, busy, gates, no document text in MCP |
| `tests/e2e/backupTools.spec.js` | 11 | Live world: back up, change, restore, compare, trash |
| `docs/**`, `README.md`, `.claude/**`, `graphify-out/` | 12 | Tracking files, skills, the new `wiretap-backups` skill, graph |

## Lanes

| Task | Writes | Shared resources | Waits on | Review group | Review timing | Risky |
|---|---|---|---|---|---|---|
| T1 Foundation | `package.json`, `package-lock.json`, `shared/backup.js`, `shared/bridgeSettings.js`, `shared/protocol.js`, `shared/budgets.js`, `shared/gates.js`, `lang/en.json`, `tests/unit/backupFormat.test.js`, `tests/unit/bridgeSettings.test.js`, `tests/unit/budgets.test.js`, `tests/unit/gates.test.js`, `tests/unit/endpoints.test.js` (the protocol version line only), `tests/unit/noPermanentDelete.test.js` | `package.json` / `package-lock.json` (only T1 installs) | none | G1 Foundation | on landing | no |
| T2 File store | `server/backups.ts`, `server/mcpConfigFile.ts`, `tests/unit/backups.test.js`, `tests/unit/backupTestHelpers.js`, `tests/unit/mcpConfigFile.test.js` | none | T1 | B2 buddy check (alone) | on landing | yes |
| T3 Sidecar transport and settings carrier | `server/endpoints.ts`, `server/foundryBridge.ts`, `tests/unit/endpoints.test.js`, `tests/unit/foundryBridge.gateState.test.js`, `tests/unit/foundryBridge.pieces.test.js`, `tests/integration/gateState.test.js`, `tests/integration/mcpHarness.js`, `tests/integration/mcpSessions.test.js` (its `pushGates` helper only), `tests/integration/backupPieces.test.js` | none | T1 | B3 buddy check (alone) | on landing | yes |
| T4 Client settings carrier and piece channel | `src/bridge/pieces.js`, `src/bridge/bridgeSettings.js`, `src/settings/bridgeSettings.js`, `src/hooks/OnceInit.js`, `src/bridge/foundryBridge.js`, `tests/unit/pieces.test.js`, `tests/unit/bridgeSettings.client.test.js`, `tests/unit/foundryBridge.identify.test.js`, `tests/unit/foundryBridge.gatePush.test.js`, `tests/unit/foundryBridge.client.test.js`, `tests/unit/OnceInit.test.js` | none | T1 | B4 buddy check (alone) | on landing | yes |
| T5 Client export | `src/bridge/scripts/canonical.js`, `src/bridge/backup/selection.js`, `src/bridge/backup/pieceWriter.js`, `src/bridge/backup/exportBackup.js`, `tests/unit/mockBackupWorld.js`, `tests/unit/canonicalBackup.test.js`, `tests/unit/backupSelection.test.js`, `tests/unit/pieceWriter.test.js`, `tests/unit/exportBackup.test.js` | none | T1 | G5 Client export and wiring | on landing | no |
| T6 Client restore | `src/bridge/scripts/writeReplace.js`, `src/bridge/backup/lineReader.js`, `src/bridge/backup/secretCarry.js`, `src/bridge/backup/restoreBackup.js`, `tests/unit/mockWriteWorld.js`, `tests/unit/writeReplaceRestore.test.js`, `tests/unit/lineReader.test.js`, `tests/unit/secretCarry.test.js`, `tests/unit/restoreBackup.test.js` | none | T1 | B6 buddy check (alone) | on landing | yes |
| T7 Client op wiring | `src/bridge/foundryBridge.js`, `tests/unit/foundryBridge.backupOps.test.js` | none | T4, T5, T6 | G5 Client export and wiring | on landing | no |
| T8 Sidecar backup tools | `server/backupTools.ts`, `tests/unit/backupTools.test.js` | none | T2, T3 | B8 buddy check (alone) | on landing | yes |
| T9 Registration, fixtures, user skill | `server/mcp.ts`, `server/server.ts`, `shared/scripts.js`, `tests/unit/scripts.test.js`, `tests/unit/scriptRegistry.test.js`, `tests/unit/contextBudgetHarness.js`, `tests/integration/mcpSessions.test.js`, `tests/integration/mcpHardening.test.js`, `tests/integration/scriptRegistry.test.js`, `skills/wiretap/SKILL.md` | none | T8 | G9 Sidecar integration | on landing | no |
| T10 Integration tests | `tests/integration/backupTools.test.js`, `docs/OPEN_BUGS.md` | none | T9 | G9 Sidecar integration | on landing | no |
| T11 e2e on the live world | `tests/e2e/backupTools.spec.js`, `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md` | Foundry `:30000`, ports 31416 / 31418 / 31419, `dist/` | T7, T10 | G11 e2e | on landing | yes |
| T12 Docs, skills, graph | `docs/PROGRESS.md`, `docs/PLAN.md` (M19 lines only), `docs/TODO.md`, `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md`, `docs/POST_WORK_FINDINGS.md`, `README.md`, `lang/en.json`, `skills/wiretap/SKILL.md`, `.claude/skills/**`, `.claude/CLAUDE.md`, `graphify-out/` | none | T11 | G12 Docs | on landing | no |

Waves: T1; then T2, T3, T4, T5 and T6 at once (no shared file); then T7 and T8 at once; then T9; then T10; then T11;
then T12. `src/bridge/foundryBridge.js` is written by T4 and later by T7 only. `tests/unit/endpoints.test.js` is
written by T1 (one line) and later by T3. `tests/integration/mcpSessions.test.js` is written by T3 and later by T9.
`docs/OPEN_BUGS.md` is written by T10, then T11, then T12, never at once.

| Stop | Where | Kind |
|---|---|---|
| `npm install trash` fails, or the installed `trash` does not load under the sidecar's Node and `tsx` | T1 step 1 | stops everything |
| A TITAN e2e run is active, or the Wiretap census is not zero after the e2e spec | T11 | stops everything |
| The four new definitions push the definitions total over 16,000 B or the tool count over 30, or the user-facing skill cannot hold the backup section within 70 lines without dropping a fact | T9 step 4 | stops this lane |
| The measured throughput puts a 64,000,000-byte backup past the 300,000 ms timeout maximum (the bounds then need the owner) | T10 step 4, T11 step 4 | stops this lane |
| The e2e spec exposes a defect in a buddy-checked file (Tasks 2, 3, 4, 6, 8; a change there is a high-risk signal) | T11 step 3 | stops this lane |
| An unflagged task shows a high-risk signal (security boundary, process spawn, protocol or public API change) | any task | stops this lane |
| A buddy check ends with a finding the two seats did not settle | T2, T3, T4, T6, T8 | stops this lane |
| The same failure occurs a second time | any task | stops this lane |
| A task's third fix round leaves review findings open | any task | stops this lane |

## Buddy-check directives

- T2, T3, T4, T6 and T8 get a buddy check (`buddy-checking`) with `wiretap-spec-reviewer` and
  `wiretap-code-reviewer` as the two seats. It replaces their per-task review and their group review.
  - T2: security boundary. The store is the only code that creates, reads and moves files at a path an agent names;
    it must never overwrite, read or trash a file that is not a Wiretap backup, and it holds the recycle-bin rule.
  - T3: protocol change and security boundary. Protocol 5, a new event pair carrying binary data from any connected
    socket, and the router's new pre-send hook that judges the folder gate on the picked endpoint.
  - T4: protocol change. The client half of protocol 5: identify and update payloads, and the piece channel.
  - T6: security boundary. Restore writes documents; it must meet every gate, the write guard and Foundry validation
    exactly as `replace_document` and `create_documents` do, and it changes `writeReplace.js`.
  - T8: security boundary. It decides which folder a call reaches, enforces `allowBackupAnyFolder`, the busy lock and
    the trust checks on what a client sends.
- T11 covers the same boundaries live; it is test-only and takes the ordinary review. A change it would make to a
  buddy-checked file follows the stop above.

## Owner decisions

From the design's "Owner decisions (2026-11-21)" and the user's words of 2026-11-21, one line each.

- Backups are files the sidecar writes (JSON Lines), not compendium packs or world copies.
- Default folder `<module root>/.wiretap/backups/`; a GM-only world setting `backupFolder` changes it; a call may name
  any other folder, which needs the new gate `allowBackupAnyFolder` (default OFF).
- A restore tool is built. One backup covers a list of documents or one group: a folder, a document type or a pack.
- Wiretap may remove files only by moving them to the recycle bin with the `trash` package (D34).
- M21 goes before M18. The user asked for parallel subagent development.

## Designer decisions

Calls the design leaves to the builder (or marks "designer's call"), made under the owner's delegation; each goes into
`docs/PROGRESS.md` as-built notes in Task 12.

- All four tools are sidecar built-ins beside `read_handle`; their names join `RESERVED_SCRIPT_NAMES`. The client
  work runs as two ops, `backupExport` and `backupRestore`, routed by the existing router.
- Events `bridge:backupPiece` (client to sidecar) and `bridge:restorePiece` (sidecar to client). A piece is
  `{ requestId, seq, data }` with binary `data` of 1 to 512,000 bytes; the end marker is
  `{ requestId, seq, end: true, pieces, bytes }`; the ack is `{ ok: true }` or `{ ok: false, error: { code, message } }`.
  Binary data avoids JSON escaping, so a piece stays under Socket.IO's 1,000,000-byte message limit.
- "512 KB" is read as 512,000 bytes and "64 MB" as 64,000,000 bytes (the project's 1 KB = 1000 B). The 64 MB bound
  counts the whole file, header line included.
- The header is line 1, written as a reserved blank line of 2,048 bytes when the file is created and rewritten in place
  with the final totals when the backup completes, padded with spaces; a file whose header is still blank is a
  partial file and is never restored. `bytes` in the header is the whole file size.
- `bridge:gateState` keeps its name; its payload becomes `{ gateState, settings }` (a rename was rejected as churn).
- The router gains `prepare`, `onSent`, `replyWaitMs` and `snapshot`, so the folder gate and the folder choice are
  judged on the same picked endpoint that runs the op, with no second pick.
- `allowBackupAnyFolder` applies to all four tools when `folder` names a folder other than the default or the
  setting, since restore and delete open files there too.
- The `folder` argument and the `backupFolder` setting must be absolute paths; paths compare after `path.resolve`,
  and case-insensitively on Windows.
- The backup file is created only when the first piece arrives, so a call that fails before any data leaves no file.
- A backup measures every export before it sends anything, so a too-large backup fails before writing; then it exports
  again and streams. A dry run returns that measurement.
- A type group (`documentName`) also backs up the Folders of that type, so a restore can re-create them; a `uuids`
  list backs up only the documents named.
- Restore carries live secret keys by recording, per line, the paths the export redaction removed (`secretPaths`);
  a path that no longer exists in the live document counts in `secretLost`. A JSON text in a flag that redaction
  changed is carried as the whole live text.
- `replace_document` keeps the live `ownership`, `folder` and `sort`; a restore must restore them, so `prepareReplace`
  gains a restore mode that writes the backed-up values back after the guard has judged them (ownership only when it
  differs from the live value, as the design says).
- A restore dry run judges every gate as the real run would (it reports `GATE_DENIED` per document), unlike a write
  tool's dry run, because the design says the dry run reports what would happen.
- A document re-created by a restore carries its `ownership`, so it needs `allowOwnershipWrites`, exactly as
  `create_documents` with that data would.
- Error codes: `BACKUP_NOT_FOUND`, `BACKUP_INVALID`, `BACKUP_BUSY`, `BACKUP_TOO_LARGE`, `BACKUP_EMPTY`,
  `BACKUP_FOLDER_INVALID`, `BACKUP_WRITE_FAILED`, `BACKUP_INCOMPLETE`, `TRASH_FAILED` and `PIECE_REFUSED`; reused:
  `ARGS_INVALID`, `GATE_DENIED`, `DOC_NOT_FOUND`, `ENDPOINT_GONE`, `ENDPOINT_TIMEOUT`, `NO_ENDPOINT`, `SCRIPT_TIMEOUT`.
- `list_backups` default limit 10, maximum 50, notes cut to 40 B in rows, at most 1,000 headers read per call.
- The backup result adds `folder` (`default`, `setting` or `named`) to `{ file, documents, bytes }` so the agent can
  say where the file went (the design's guidance); a path would not fit the 256 B budget, and the agent cannot read
  the `wiretap.backupFolder` setting.
- Unit and integration tests replace `trash` with `fakeTrash`, which renames the file into a bin folder, because the
  store checks that the file is gone after `trash` returns.
- Bound measurement: Task 10 times a 2,048,000-byte stream and Task 11 times a dry run of the largest live pack; both
  are recorded; a bound change needs the owner (stop above).

---

### Task 1: Foundation — `trash`, shared backup constants, settings carrier shape, protocol 5, gate, budgets, D34 check

The user asked for backup tools, the `trash` package and the recycle-bin rule. This task adds what every other task
names: the dependency, the shared constants and formats, the protocol identifiers, the new gate and its texts, the four
result budgets, and the source check that bans permanent deletion.

**Files:**
- Modify: `package.json`, `package-lock.json` (through `npm install trash`)
- Create: `shared/backup.js`, `shared/bridgeSettings.js`, `tests/unit/backupFormat.test.js`,
  `tests/unit/bridgeSettings.test.js`, `tests/unit/noPermanentDelete.test.js`
- Modify: `shared/protocol.js` (after `OP_CALL_TOOL`), `shared/budgets.js` (after `SHEET_RESULT_MAX_BYTES`),
  `shared/gates.js` (`GATES` and the `GateState` typedef), `lang/en.json`
- Test: `tests/unit/budgets.test.js` (`EXPECTED`), `tests/unit/gates.test.js` (`BOOLEAN_GATES`, "ten" becomes
  "eleven"), `tests/unit/endpoints.test.js:371` (`expect(PROTOCOL_VERSION).toBe(5)`)

**Interfaces:**
- Produces, `shared/backup.js` (plain JS, no imports except `./utf8.js`):
  - Constants: `BACKUP_FORMAT_VERSION = 1`; `BACKUP_FILE_SUFFIX = '.wtbackup.jsonl'`;
    `BACKUP_FILE_PATTERN = /^\d{8}T\d{9}Z-[A-Za-z0-9_-]{8}\.wtbackup\.jsonl$/`; `HEADER_LINE_BYTES = 2048`;
    `BACKUP_PIECE_MAX_BYTES = 512_000`; `BACKUP_MAX_DOCUMENTS = 10_000`; `BACKUP_MAX_BYTES = 64_000_000`;
    `BACKUP_NOTE_MAX_BYTES = 200`; `BACKUP_WORLD_FIELD_MAX_BYTES = 128`; `BACKUP_UUIDS_MAX = 200`;
    `BACKUP_TIMEOUT_MIN_MS = 1_000`; `BACKUP_TIMEOUT_DEFAULT_MS = 120_000`; `BACKUP_TIMEOUT_MAX_MS = 300_000`;
    `LIST_LIMIT_DEFAULT = 10`; `LIST_LIMIT_MAX = 50`; `LIST_HEADER_READS_MAX = 1000`; `LIST_NOTE_MAX_BYTES = 40`;
    `RESTORE_ROWS_MAX = 20`; `RESTORE_REASON_MAX_BYTES = 160`.
  - Codes (string constants equal to their names): `BACKUP_NOT_FOUND`, `BACKUP_INVALID`, `BACKUP_BUSY`,
    `BACKUP_TOO_LARGE`, `BACKUP_EMPTY`, `BACKUP_FOLDER_INVALID`, `BACKUP_WRITE_FAILED`, `BACKUP_INCOMPLETE`,
    `TRASH_FAILED`; `BACKUP_SIDECAR_CODES = Object.freeze([BACKUP_NOT_FOUND, BACKUP_INVALID, BACKUP_BUSY,
    BACKUP_FOLDER_INVALID, BACKUP_WRITE_FAILED, TRASH_FAILED])` (codes only the sidecar may produce).
  - Typedefs: `BackupHeader` `{ wiretapBackup: 1, created: string, worldId: string, foundryVersion: string,
    systemId: string, systemVersion: string, note: string, documents: number, bytes: number }` (key order as listed);
    `WorldDescription` `{ worldId, foundryVersion, systemId, systemVersion }` (strings); `BackupLine`
    `{ uuid: string, documentName: string, pack?: string, data: Record<string, unknown>,
    secretPaths?: Array<Array<string | number>> }`.
  - `backupFileName(date: Date, suffix: string): string` — `YYYYMMDDTHHMMSSmmmZ-<suffix>.wtbackup.jsonl` in UTC.
  - `blankHeaderLine(): string` — 2,047 spaces and `\n` (2,048 bytes).
  - `formatHeaderLine(header: BackupHeader): string` — `JSON.stringify(header)` padded with spaces to 2,047 UTF-8
    bytes, then `\n`; throws `RangeError` when the JSON is longer than 2,047 bytes.
  - `parseHeaderLine(text: string): BackupHeader | null` — null unless the text parses to an object with exactly the
    nine keys, `wiretapBackup === 1`, `created` matching `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`, the four
    world fields passing `isWorldField`, `note` passing `isBackupNote`, `documents` an integer 0 to 10,000 and `bytes`
    an integer 2,048 to 64,000,000.
  - `isWorldField(value: unknown): boolean` — a string of at most 128 UTF-8 bytes with no `\p{Cc}` character.
  - `isBackupNote(value: unknown): boolean` — a string of at most 200 UTF-8 bytes with no `\p{Cc}` character.
- Produces, `shared/bridgeSettings.js`: `BACKUP_FOLDER_MAX_BYTES = 1024`;
  `BRIDGE_SETTING_KEYS = Object.freeze(['backupFolder'])`; `@typedef {{ backupFolder: string }} BridgeSettings`;
  `defaultBridgeSettings(): BridgeSettings` (`{ backupFolder: '' }`, a fresh object);
  `sanitizeBridgeSettings(input: unknown): BridgeSettings` — keeps `backupFolder` when it is an own string property of
  at most 1,024 UTF-8 bytes with no `\p{Cc}` character, else `''`; never throws (a throwing getter gives defaults).
- Produces, `shared/protocol.js`: `PROTOCOL_VERSION = 5`; `BRIDGE_BACKUP_PIECE = 'bridge:backupPiece'`;
  `BRIDGE_RESTORE_PIECE = 'bridge:restorePiece'`; `OP_BACKUP_EXPORT = 'backupExport'`;
  `OP_BACKUP_RESTORE = 'backupRestore'`; `PIECE_REFUSED = 'PIECE_REFUSED'`; typedefs `BackupPiece`
  (`{ requestId: string, seq: number, data: Uint8Array }` or `{ requestId: string, seq: number, end: true,
  pieces: number, bytes: number }`), `PieceAck` (`{ ok: true }` or `{ ok: false, error: { code: string,
  message: string } }`) and `BridgeStatePush` (`{ gateState: GateState, settings: BridgeSettings }`); the comment of
  `BRIDGE_GATE_STATE` says its payload is a `BridgeStatePush`.
- Produces: `getBudget('BACKUP_RESULT_MAX_BYTES').value === 256`, `getBudget('BACKUP_LIST_MAX_BYTES').value === 2000`,
  `getBudget('RESTORE_RESULT_MAX_BYTES').value === 4000`, `getBudget('BACKUP_DELETE_MAX_BYTES').value === 128`; unit
  `bytes`, severity `hard`.
- Produces: `GATES.allowBackupAnyFolder = entry('boolean', false, 'Writing, listing, restoring and deleting backup
  files in a folder other than the default or the Backup folder setting.')`, placed after `allowReplace`.

- [ ] **Step 1: Install `trash`.** `npm install trash` (a runtime dependency, so it lands in `dependencies`). Then
  check it loads under the sidecar runtime: write `test/tmp/trash-load.mjs` containing
  `import trash from 'trash'; console.log(typeof trash);`, run `npx tsx test/tmp/trash-load.mjs`; expected `function`.
  Leave the file in `test/tmp/` (gitignored; no deletion API). Report the installed version and `node --version`.
- [ ] **Step 2: Write the failing tests.**

```js
// tests/unit/backupFormat.test.js
it('names a file from the UTC time and the suffix', () => {
   expect(backupFileName(new Date(Date.UTC(2026, 10, 21, 3, 4, 5, 6)), 'Ab_-1234'))
      .toBe('20261121T030405006Z-Ab_-1234.wtbackup.jsonl');
   expect(BACKUP_FILE_PATTERN.test('20261121T030405006Z-Ab_-1234.wtbackup.jsonl')).toBe(true);
});
it.each(['x.wtbackup.jsonl', '20261121T030405006Z-Ab_-1234.wtbackup.json', '20261121T030405006Z-Ab_-123.wtbackup.jsonl',
   '../20261121T030405006Z-Ab_-1234.wtbackup.jsonl'])('refuses the name %s', (name) => {
   expect(BACKUP_FILE_PATTERN.test(name)).toBe(false);
});
it('pads the header line to 2048 bytes and parses it back', () => {
   // header: wiretapBackup 1, created '2026-11-21T03:04:05.006Z', worldId 'w', foundryVersion '14.364',
   // systemId 's', systemVersion '1.0.0', note 'n', documents 3, bytes 5000
   const line = formatHeaderLine(header);
   expect(Buffer.byteLength(line)).toBe(2048);
   expect(line.endsWith('\n')).toBe(true);
   expect(parseHeaderLine(line)).toEqual(header);
});
it('fits the largest header: a 200-byte note of quotes and four 128-byte world fields of backslashes', ...);
//   formatHeaderLine does not throw; Buffer.byteLength is 2048
it('throws a RangeError for a header longer than the line', ...);   // a note of 2000 bytes (bypassing isBackupNote)
it('parses a blank header line to null', () => { expect(parseHeaderLine(blankHeaderLine())).toBeNull(); });
it.each([/* extra key, wiretapBackup 2, created without milliseconds, documents 10001, bytes 2047, bytes 64000001,
   note of 201 bytes, worldId with a tab, documents 1.5, a JSON array */])('parses an invalid header to null', ...);

// tests/unit/bridgeSettings.test.js
it('defaults backupFolder to the empty string, a fresh object each call', ...);
it('keeps a folder of exactly 1024 bytes and refuses 1025 bytes, a control character and a non-string', ...);
it('ignores inherited and unknown keys and never throws on a throwing getter', ...);

// tests/unit/noPermanentDelete.test.js — the regexes are built from joined strings so this file does not match itself
it('no product or test file calls a permanent-delete API', ...);
//   every .js, .mjs, .ts and .svelte file under server/, shared/, src/, scripts/ and tests/ (skip node_modules):
//   no match of new RegExp(`\\b(?:${['unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync'].join('|')})\\s*\\(`)
//   and no import or require of the packages ['rimraf', 'del'] (a quoted specifier equal to either name)
it('only server/backups.ts imports trash', ...);
//   files whose source holds a quoted 'trash' module specifier in an import: exactly ['server/backups.ts'] once
//   Task 2 lands; in this task the list is empty or that one file (the assertion is "a subset of
//   ['server/backups.ts']")
```

  Append to `EXPECTED` of `tests/unit/budgets.test.js`: `['BACKUP_RESULT_MAX_BYTES', 256, 'bytes', 'hard']`,
  `['BACKUP_LIST_MAX_BYTES', 2000, 'bytes', 'hard']`, `['RESTORE_RESULT_MAX_BYTES', 4000, 'bytes', 'hard']`,
  `['BACKUP_DELETE_MAX_BYTES', 128, 'bytes', 'hard']`. Add `'allowBackupAnyFolder'` to `BOOLEAN_GATES` of
  `tests/unit/gates.test.js` and rename that test "holds exactly the eleven boolean gates and the plugin module list".
  Set `tests/unit/endpoints.test.js:371` to `toBe(5)`.
- [ ] **Step 3: Run them.** `npx vitest run tests/unit/backupFormat.test.js tests/unit/bridgeSettings.test.js
  tests/unit/budgets.test.js tests/unit/gates.test.js`. Expected: FAIL (modules or entries missing).
- [ ] **Step 4: Implement** `shared/backup.js`, `shared/bridgeSettings.js`, the protocol constants, the budgets (one
  comment line each: the result of `backup_documents`; of `list_backups`; of `restore_backup`; of `delete_backup`)
  and the gate (add `@property {boolean} allowBackupAnyFolder - Backup files in a folder other than the default or
  the Backup folder setting.` to the `GateState` typedef). Add to `lang/en.json`:
  `WIRETAP.Settings.Gates.AllowBackupAnyFolder` `{ "Name": "Allow backups in any folder", "Hint": "Lets agents write,
  list, restore and delete backup files in a folder other than the default (.wiretap/backups in the module folder) or
  the Backup folder setting." }` and `WIRETAP.Settings.BackupFolder` `{ "Name": "Backup folder", "Hint": "Absolute
  path of the folder the sidecar writes document backups to. Empty uses .wiretap/backups in the module folder." }`.
- [ ] **Step 5: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass (`gateSettings.test.js`
  finds the new gate's lang texts; `noPermanentDelete.test.js` passes on the current tree).
- [ ] **Step 6: Commit** `feat(shared): backup format, settings carrier shape, protocol 5, backup gate and budgets`.

---

### Task 2: Sidecar file store — `server/backups.ts`

The user asked for backups saved to files, in a default folder or wherever they ask, removed only through the recycle
bin. This task builds the one module that touches backup files. It is a security boundary: it must never overwrite,
read or trash a file that is not a Wiretap backup.

**Files:**
- Create: `server/backups.ts`, `tests/unit/backups.test.js`, `tests/unit/backupTestHelpers.js`
- Modify: `server/mcpConfigFile.ts` (export the directory and link checks), `tests/unit/mcpConfigFile.test.js`

**Interfaces:**
- Consumes: Task 1's `shared/backup.js` (constants, codes, `backupFileName`, `blankHeaderLine`, `formatHeaderLine`,
  `parseHeaderLine`, `BackupHeader`); `BridgeError` of `server/endpoints.ts`; `truncateUtf8` of `server/utf8.ts`;
  `describeCause` of `shared/logText.js`.
- Produces, `server/mcpConfigFile.ts`: `export function refuseSymbolicLink(target: string, purpose: string): void`
  (throws `Error(\`refusing to ${purpose}: ${target} is a symbolic link\`)`; ENOENT accepted);
  `export function ensureWiretapDir(root: string = defaultConfigRoot()): string` (creates `<root>/.wiretap` with
  `{ recursive: true, mode: 0o700 }`, refuses a link, returns its path). `writeMcpConfig` uses both with purpose
  `'write the MCP config'`; its behaviour is unchanged.
- Produces, `server/backups.ts`:
  - `export type TrashFunction = (paths: string[], options: { glob: false }) => Promise<void>;`
  - `export interface BackupStoreOptions { root?: string; trash?: TrashFunction; now?: () => Date;
    randomSuffix?: () => string; platform?: NodeJS.Platform }` — defaults: `defaultConfigRoot()`, the `trash`
    package, `() => new Date()`, `() => randomBytes(6).toString('base64url')`, `process.platform`.
  - `export type FolderKind = 'default' | 'setting' | 'named';`
    `export interface ResolvedFolder { path: string; kind: FolderKind }`
  - `export interface BackupFileWriter { file: string; filePath: string; append(data: Uint8Array): void;
    size(): number; finish(fields: Omit<BackupHeader, 'wiretapBackup' | 'created' | 'bytes'>): BackupHeader;
    close(): void }`
  - `export interface BackupFileReader { file: string; header: BackupHeader; readPiece(maxBytes: number):
    Buffer | null; close(): void }` — pieces start at byte 2,048 (after the header line); null at the end.
  - `export interface BackupListing { rows: Array<[string, string, number, string]>; total: number;
    invalid: number }` — rows are `[file, created, documents, note]`, full notes.
  - `export interface BackupStore { defaultFolder: string; resolveFolder(folder: string | undefined,
    settingFolder: string): ResolvedFolder; checkFolder(folder: ResolvedFolder, create: boolean): boolean;
    createFile(folder: ResolvedFolder): BackupFileWriter; openFile(folder: ResolvedFolder, file: string):
    BackupFileReader; list(folder: ResolvedFolder, limit: number): BackupListing; trashFile(folder: ResolvedFolder,
    file: string): Promise<void>; trashPath(filePath: string): Promise<void> }`
  - `export function createBackupStore(options: BackupStoreOptions = {}): BackupStore` — no file I/O until a method
    is called.
- Produces, `tests/unit/backupTestHelpers.js`: `scratchRoot(prefix: string): string` (creates and returns
  `test/tmp/<prefix>-<Date.now()>-<pid>-<counter>/`, failing when it already exists);
  `fakeTrash(binDir: string): TrashFunction & { calls: string[][] }` (records each call's paths and moves each
  existing file into `binDir` with `fs.renameSync`, creating `binDir`; a missing path is ignored, as `trash` does).

Rules the store implements (the design's "Folders, gate and setting" and "File format and naming"):
- `defaultFolder` is `<root>/.wiretap/backups`.
- `resolveFolder`: with `folder` undefined, a non-empty `settingFolder` gives kind `setting` and an empty one kind
  `default`. A given `folder` and a non-empty setting must satisfy `path.isAbsolute`, else `BridgeError(
  BACKUP_FOLDER_INVALID, 'The folder must be an absolute path.')` (or `'The Backup folder setting must be an
  absolute path.'`). A given `folder` equal to the default after resolution is kind `default`, equal to the resolved
  setting is kind `setting`, else `named`. Equality: `path.resolve` both (which removes `..` and trailing
  separators), compared case-insensitively when `platform === 'win32'`. The returned `path` is the resolved path.
- `checkFolder`: for `default`, with `create` it runs `ensureWiretapDir(root)` and creates `backups` (mode 0o700)
  when missing; without `create` a missing default returns false. Every folder is `lstat`-checked: a symbolic link
  (the `.wiretap` directory included) is `BACKUP_FOLDER_INVALID 'The backup folder is a symbolic link.'`; a missing
  `setting` or `named` folder is `BACKUP_FOLDER_INVALID 'The folder does not exist.'`; a path that is not a directory
  is `BACKUP_FOLDER_INVALID 'The folder is not a directory.'`. Returns whether the folder exists.
- `createFile`: names the file `backupFileName(now(), randomSuffix())`, refuses a symbolic link at the path, opens it
  with `fs.openSync(path, 'wx', 0o600)` (an existing file is never overwritten) and writes `blankHeaderLine()`;
  `created` is `now().toISOString()` at this moment. `append` writes at the end; `finish` writes
  `formatHeaderLine(header)` at offset 0 with `bytes` = the file size, closes the file and returns the header. Any
  file-system failure is `BridgeError(BACKUP_WRITE_FAILED, 'The backup file could not be written.')` (the cause goes
  to the sidecar log).
- `openFile`: a name not matching `BACKUP_FILE_PATTERN`, or a missing file, is `BACKUP_NOT_FOUND 'No backup file of
  that name.'`; a symbolic link or a non-file is `BACKUP_INVALID 'The file is not a Wiretap backup.'`; a first
  2,048 bytes that `parseHeaderLine` refuses is `BACKUP_INVALID 'The file is not a Wiretap backup.'`; a file size
  different from `header.bytes` is `BACKUP_INVALID 'The backup file is incomplete or was changed.'`. No message holds
  file content.
- `list`: names in the folder matching the pattern, sorted descending (the names start with the UTC time, so this is
  newest first); `total` is their count; headers are read in that order until `limit` valid rows are collected or
  1,000 headers are read; a link, a non-file, a refused header or a size mismatch counts in `invalid` and gives no
  row. A missing default folder gives `{ rows: [], total: 0, invalid: 0 }`.
- `trashFile`: runs the `openFile` checks first (and closes the reader), then `trashPath`.
- `trashPath`: `await trash([filePath], { glob: false })`; when it throws, or when `lstat` still finds the path
  afterwards, `BridgeError(TRASH_FAILED, \`Could not move ${basename} to the recycle bin\` + (reason ? \`: ${reason}\` :
  '') + '.')` with the reason `describeCause` bounded to 120 bytes.

- [ ] **Step 1: Write the failing tests** in `tests/unit/backups.test.js` (`// @vitest-environment node`), each
  with a store over `scratchRoot('backups')` and `fakeTrash(<scratch>/bin)`:

```js
it('resolves no folder to the default, and to the setting when the setting is set', ...);
//   resolveFolder(undefined, '') -> { kind: 'default', path: <root>/.wiretap/backups }
//   resolveFolder(undefined, <abs dir>) -> { kind: 'setting', path: <abs dir> }
it('treats other spellings of the default and the setting as the same folder on Windows', ...);
//   platform 'win32': upper-cased default path, default + path.sep, default + '\\x\\..' -> kind 'default';
//   the same for the setting -> kind 'setting'; <abs other dir> -> kind 'named'
//   platform 'linux': the upper-cased default path -> kind 'named'
it('refuses a relative folder and a relative setting with BACKUP_FOLDER_INVALID', ...);
it('creates the default folder only when asked, and refuses a missing named folder', ...);
//   checkFolder(default, false) -> false and <root>/.wiretap does not exist; checkFolder(default, true) -> true and
//   the folder exists; checkFolder(named missing, true) -> throws BACKUP_FOLDER_INVALID 'The folder does not exist.'
it('refuses a folder that is a symbolic link, and a .wiretap that is one', ...);
//   fs.symlinkSync(target, link, 'junction') on win32 (no admin needed), 'dir' elsewhere -> BACKUP_FOLDER_INVALID
it('creates the file exclusively at 0o600 with a blank header, then writes the header in place', ...);
//   writer.file matches BACKUP_FILE_PATTERN; append(Buffer.from('{"a":1}\n')); finish({ worldId: 'w', ... ,
//   note: '', documents: 1 }) -> header.bytes === 2048 + 8 === fs.statSync(path).size; first line parses to header;
//   on non-win32 (fs.statSync(path).mode & 0o777) === 0o600
it('never overwrites an existing file', ...);
//   randomSuffix and now fixed so two createFile calls give one name -> the second throws BACKUP_WRITE_FAILED and the
//   first file's bytes are unchanged
it('opens a valid backup and reads it in pieces after the header', ...);
//   readPiece(5) twice then null; the concatenation equals the bytes after offset 2048
it('refuses an off-pattern or missing name with BACKUP_NOT_FOUND', ...);   // '../x', a renamed copy, absent file
it('refuses a truncated, appended, blank-header or non-backup file with BACKUP_INVALID, without echoing content', ...);
//   message contains no byte of the file
it('lists newest first, counts total and invalid, and skips partial files', ...);
//   three valid files with increasing now(), one partial (blank header), one off-pattern name:
//   list(folder, 2) -> rows of the two newest valid ones, total 4, invalid counts the partial one when it was read
it('stops reading headers after 1000', ...);   // 1001 partial files named on the pattern -> invalid 1000, rows []
it('moves a valid backup to the recycle bin and refuses a non-backup', ...);
//   trashFile -> fakeTrash.calls === [[path]] with { glob: false }; the file is in bin/; trashFile on a blank-header
//   file -> BACKUP_INVALID and fakeTrash not called
it('fails TRASH_FAILED naming the file when trash throws or leaves the file in place', ...);
//   trash rejecting Error('no bin') -> message contains the file name and 'no bin'; a trash that resolves without
//   moving -> TRASH_FAILED; the file still exists in both cases
```

  In `tests/unit/mcpConfigFile.test.js` add: `it('refuses a symbolic link with the purpose in the message')` for
  `refuseSymbolicLink(link, 'do x')` → message `refusing to do x: <link> is a symbolic link`, and
  `it('ensureWiretapDir creates .wiretap and returns its path')`.
- [ ] **Step 2: Run them.** `npx vitest run tests/unit/backups.test.js tests/unit/mcpConfigFile.test.js`. Expected:
  FAIL (module missing).
- [ ] **Step 3: Implement** the helpers, the `mcpConfigFile.ts` exports and `server/backups.ts` by the rules above,
  with synchronous `node:fs` calls (`openSync`, `writeSync`, `readSync`, `fstatSync`, `lstatSync`, `readdirSync`,
  `closeSync`). The file header comment states the residual risk the config file already documents: the link check
  and the open are separate calls.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass, including
  `noPermanentDelete.test.js` with `server/backups.ts` the only `trash` importer.
- [ ] **Step 5: Commit** `feat(server): backup file store with exclusive create and recycle-bin removal`.

---

### Task 3: Sidecar transport and settings carrier — `server/endpoints.ts`, `server/foundryBridge.ts`

The user asked for backups written by the sidecar from the GM client's export, and for a default folder a GM setting
can change. This task carries that setting to the sidecar beside the gate snapshot and adds the piece transport in
both directions (bridge protocol 5). It is a protocol change and a security boundary.

**Files:**
- Modify: `server/endpoints.ts` (`EndpointIdentity`, `InvokeOptions`, `EndpointRegistry`, `Router`,
  `validateIdentify`, `RESERVED_CODES`, `dispatch`), `server/foundryBridge.ts` (`BRIDGE_GATE_STATE` handler, new
  piece handler, return object)
- Modify tests: `tests/unit/endpoints.test.js`, `tests/unit/foundryBridge.gateState.test.js`,
  `tests/integration/gateState.test.js`, `tests/integration/mcpHarness.js` (`pushGates` sends
  `{ gateState: state }`), `tests/integration/mcpSessions.test.js` (its `pushGates` helper the same)
- Create: `tests/unit/foundryBridge.pieces.test.js`, `tests/integration/backupPieces.test.js`

**Interfaces:**
- Consumes: Task 1's `sanitizeBridgeSettings`, `defaultBridgeSettings`, `BridgeSettings`, `BRIDGE_BACKUP_PIECE`,
  `BRIDGE_RESTORE_PIECE`, `PIECE_REFUSED`, `BACKUP_PIECE_MAX_BYTES`, `BACKUP_SIDECAR_CODES`.
- Produces, `server/endpoints.ts`:
  - `EndpointIdentity.settings: BridgeSettings` (sanitized; defaults when the identify carries none or an invalid one).
  - `EndpointRegistry.setSettings: (socketId: string, settings: BridgeSettings) => void` (ignored for an unregistered
    socket; does not notify subscribers, like `setGateState`).
  - `InvokeOptions` gains `replyWaitMs?: number` (the reply wait of `invoke`; default `DEFAULT_REPLY_WAIT_MS`),
    `prepare?: (endpoint: Endpoint, requestId: string) => object | undefined` (runs synchronously after the pick and
    the `requireGate` check and before the send; an object it returns replaces `params`; a throw aborts the call with
    that error and sends nothing) and `onSent?: () => void` (called synchronously right after the payload is handed
    to `deps.send`, before the ack is awaited).
  - `export interface EndpointSnapshot { socketId: string; gateState: GateState; settings: BridgeSettings }` and
    `Router.snapshot: (options?: InvokeOptions) => EndpointSnapshot | undefined` (copies of the endpoint a plain
    `invoke` with the same `endpoint` option would pick now; undefined when none is healthy).
  - `RESERVED_CODES` also holds every code of `BACKUP_SIDECAR_CODES`, so a client cannot claim them.
- Produces, `server/foundryBridge.ts`:
  - `export interface IncomingPiece { seq: number; data?: Buffer; end?: true; pieces?: number; bytes?: number }`
  - `export interface PieceSink { piece(piece: IncomingPiece): void | Promise<void>; gone(): void }`
  - `export type OutgoingPiece = { requestId: string; seq: number; data: Buffer } | { requestId: string; seq: number;
    end: true; pieces: number; bytes: number };`
  - The bridge object gains `snapshot: Router['snapshot']`,
    `expectPieces(socketId: string, requestId: string, sink: PieceSink): () => void` (the returned function removes
    the sink; calling it twice is harmless) and
    `sendPiece(socketId: string, piece: OutgoingPiece, timeoutMs: number): Promise<void>`.

Rules:
- `bridge:gateState` payload is `{ gateState, settings }`: the handler stores `sanitizeGateState(payload.gateState)`
  and `sanitizeBridgeSettings(payload.settings)`; a payload without `gateState` (the old bare snapshot) closes every
  gate. On a throw it stores the closed state and the default settings (fail closed), as today.
- `bridge:backupPiece` (acked): valid when it is an object with `requestId` a string of 1 to 64 bytes, `seq` an
  integer 0 to 2^31 − 1, and either `data` a `Buffer` (a `Uint8Array` is wrapped) of 1 to `BACKUP_PIECE_MAX_BYTES`
  bytes and no `end`, or `end === true` with integer `pieces` ≥ 0 and `bytes` ≥ 0 and no `data`. Else ack
  `{ ok: false, error: { code: PIECE_REFUSED, message: 'Malformed backup piece.' } }`. A piece with no sink for its
  socket and `requestId` is refused `'No backup is waiting for this piece.'`; a piece that arrives while the sink is
  still handling the previous one is refused `'A backup piece is already being written.'`. Otherwise the bridge awaits
  `sink.piece(...)` and acks `{ ok: true }`; a `BridgeError` from the sink acks `{ ok: false, error: { code: err.code,
  message: err.message } }`; any other throw acks `PIECE_REFUSED 'The backup piece could not be written.'` and logs
  the cause. Refusals are logged through a throttle like the other refusal logs.
- On a socket's disconnect, every sink of that socket gets `gone()` and is removed.
- `sendPiece` emits `bridge:restorePiece` through the existing `emitWithAck(..., track: true)`; `{ ok: true }`
  resolves; a refusal rejects `BridgeError(PIECE_REFUSED, \`The Foundry client refused a restore piece:
  ${code}.\`)` with the code bounded by `CLIENT_CODE_PATTERN` (else `OP_FAILED`); `EndpointGoneError` and
  `EndpointTimeoutError` pass through.

- [ ] **Step 1: Write the failing tests.**

```js
// tests/unit/endpoints.test.js (new describe blocks)
it('stores sanitized settings from identify, and defaults when absent or invalid', ...);
it('setSettings replaces a registered endpoint\'s settings and ignores an unregistered socket', ...);
it('prepare sees the picked endpoint and the requestId, and its object replaces params', ...);
//   deps.send receives params === prepared object and requestId === the one prepare saw
it('a prepare that throws sends nothing and rejects with its error', ...);
it('runs prepare after the requireGate check, so a closed gate never reaches prepare', ...);
it('calls onSent after send was called and before the ack resolves', ...);
//   order log: ['send', 'onSent', 'ack']
it('waits replyWaitMs for the reply and names it in the timeout message', ...);   // fake send never acks; 3 s
it('snapshot copies the gate state and settings of the endpoint invoke would pick, or undefined', ...);
it('reports a client that claims a sidecar backup code as OP_FAILED', ...);   // ack error code TRASH_FAILED

// tests/unit/foundryBridge.gateState.test.js: every existing push now sends { gateState: {...} }; add
it('stores the settings of a gate-state push', ...);
it('closes every gate for a bare gate snapshot payload', ...);   // { allowDelete: true } -> all closed

// tests/unit/foundryBridge.pieces.test.js (fake sockets as foundryBridge.gateState.test.js builds them)
it('hands a valid data piece to the sink of its socket and requestId and acks ok', ...);
it('wraps a Uint8Array piece as a Buffer', ...);
it.each([/* no requestId, requestId of 65 bytes, seq -1, seq 1.5, empty data, data of 512001 bytes, data and end,
   end with pieces -1, a string as data */])('refuses a malformed piece with PIECE_REFUSED', ...);
it('refuses a piece for another socket\'s requestId and a piece nobody expects', ...);
it('refuses a second piece while the first is still being written', ...);   // sink.piece pending on a promise
it('passes a BridgeError of the sink back in the ack', ...);   // BACKUP_INCOMPLETE 'x' -> ack error code and message
it('calls gone() on disconnect and forgets the sink', ...);
it('stops delivering once the returned function is called', ...);
it('sendPiece resolves on an ok ack and rejects PIECE_REFUSED on a refusal', ...);
it('sendPiece rejects EndpointGoneError when the socket disconnects before the ack', ...);

// tests/integration/backupPieces.test.js (createWiretapServer(0, port, 'mcp-only') + socket.io-client fake GM)
it('carries a 512000-byte binary piece each way over a real socket', ...);
//   client emits { requestId, seq: 0, data: Buffer.alloc(512000, 7) } -> the sink receives 512000 bytes of 7, ack ok;
//   bridge.sendPiece(socketId, { requestId, seq: 0, data: Buffer.alloc(512000, 9) }, 1000) -> the client receives
//   512000 bytes of 9 and acks; the promise resolves
it('carries settings from identify and from a gate-state push to snapshot()', ...);
```

  Update the gate-state integration tests (`tests/integration/gateState.test.js`) and both `pushGates` helpers to the
  `{ gateState }` payload; their assertions stay as they are.
- [ ] **Step 2: Run them.** `npx vitest run tests/unit/endpoints.test.js tests/unit/foundryBridge.gateState.test.js
  tests/unit/foundryBridge.pieces.test.js tests/integration/backupPieces.test.js tests/integration/gateState.test.js`.
  Expected: FAIL on the new behaviour.
- [ ] **Step 3: Implement** by the rules above. `requestId` is generated before `prepare` runs. The comment on
  `prepare` states the invariant: the pick, the gate check, `prepare` and the send are one synchronous step on one
  endpoint.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(server): bridge protocol 5 piece transport and the settings carrier`.

---

### Task 4: Client settings carrier and piece channel

The user asked for a default folder that a GM setting can change, and for backups the GM client streams to the
sidecar. This task registers the `backupFolder` world setting, sends it in identify and in the update push, and gives
op handlers a piece channel. It is the client half of protocol 5.

**Files:**
- Create: `src/bridge/pieces.js`, `src/bridge/bridgeSettings.js`, `src/settings/bridgeSettings.js`,
  `tests/unit/pieces.test.js`, `tests/unit/bridgeSettings.client.test.js`
- Modify: `src/bridge/foundryBridge.js` (identify payload, `pushGateState`, the `BRIDGE_INVOKE` listener),
  `src/hooks/OnceInit.js` (call `registerBridgeSettings()` right after `registerGateSettings()`)
- Test: `tests/unit/foundryBridge.identify.test.js`, `tests/unit/foundryBridge.gatePush.test.js`,
  `tests/unit/foundryBridge.client.test.js`, `tests/unit/OnceInit.test.js`

**Interfaces:**
- Consumes: Task 1's `BRIDGE_BACKUP_PIECE`, `BRIDGE_RESTORE_PIECE`, `PIECE_REFUSED`, `BACKUP_PIECE_MAX_BYTES`,
  `sanitizeBridgeSettings`, `defaultBridgeSettings`; `ScriptError` of `src/bridge/scripts/registry.js`.
- Produces, `src/settings/bridgeSettings.js`: `export function registerBridgeSettings(): void` — registers
  `game.settings.register('wiretap', 'backupFolder', { name: 'WIRETAP.Settings.BackupFolder.Name', hint:
  'WIRETAP.Settings.BackupFolder.Hint', scope: 'world', restricted: true, config: true, type: String, default: '' })`.
- Produces, `src/bridge/bridgeSettings.js`: `export function readBridgeSettings(): BridgeSettings` (reads
  `wiretap.backupFolder`, sanitized; a read that throws gives the defaults) and
  `export function isBridgeSettingKey(key: unknown): boolean` (true for `'wiretap.backupFolder'`, built from
  `BRIDGE_SETTING_KEYS`).
- Produces, `src/bridge/pieces.js`:
  - `@typedef {object} ReceivedPiece` `{ seq: number, data?: Uint8Array, end?: true, pieces?: number, bytes?: number,
    ack: (refusal?: { code: string, message: string }) => void }`
  - `@typedef {object} PieceReceiver` `{ next: (waitMs: number) => Promise<ReceivedPiece>, close: () => void }`
  - `@typedef {object} PieceChannel` `{ send: (requestId: string, seq: number, data: Uint8Array, waitMs: number) =>
    Promise<void>, end: (requestId: string, seq: number, pieces: number, bytes: number, waitMs: number) =>
    Promise<void>, receive: (requestId: string) => PieceReceiver }`
  - `@typedef {object} OpInvocation` `{ requestId: string, pieces: PieceChannel }`
  - `export function createPieceChannel(socket): PieceChannel`
- Produces, `src/bridge/foundryBridge.js`: identify payload gains `settings: readBridgeSettings()`; the push emits
  `BRIDGE_GATE_STATE` with `{ gateState: readGateState(), settings: readBridgeSettings() }` when a GM changes a gate
  key or the `wiretap.backupFolder` key; every op handler is called as `handler(request.params, { requestId:
  request.requestId, pieces })`, where `pieces` is the socket's channel, created once per socket in `onSocket`. The
  handler is called synchronously inside the listener (before its first `await`), so a handler that registers a
  receiver as its first statement receives a piece emitted right after the invoke.

Channel rules:
- `send` / `end` emit `BRIDGE_BACKUP_PIECE` with `socket.timeout(waitMs).emitWithAck(...)`; `{ ok: true }` resolves; a
  refusal throws `ScriptError(PIECE_REFUSED, \`The sidecar refused a backup piece (${code}).\`)` with the code bounded
  by `cleanForLog(code, 64)`; a timeout or disconnect throws `ScriptError('SCRIPT_TIMEOUT', 'The sidecar did not
  confirm a backup piece in time.')`.
- One `BRIDGE_RESTORE_PIECE` listener per socket dispatches by `requestId` to the open receiver. A malformed piece
  (the shape rules of Task 3, with `data` an `ArrayBuffer` in the browser, wrapped in a `Uint8Array`, or a
  `Uint8Array`), a piece with no open receiver, or a piece that arrives while the receiver still holds an unacked one,
  is acked `{ ok: false, error: { code: PIECE_REFUSED, message } }` at once.
- `next(waitMs)` resolves with the held piece, or with the next one to arrive; after `waitMs` with none it rejects
  `ScriptError('SCRIPT_TIMEOUT', 'The restore waited too long for the next piece.')`. `ack()` sends `{ ok: true }`;
  `ack(refusal)` sends the refusal. `close()` removes the receiver and refuses a held, unacked piece.

- [ ] **Step 1: Write the failing tests.**

```js
// tests/unit/bridgeSettings.client.test.js
it('registers backupFolder as a world-scope restricted config String setting defaulting to empty', ...);
it('reads the sanitized backupFolder, and the defaults when the read throws', ...);
it('recognises only wiretap.backupFolder as a bridge setting key', ...);   // gate keys and other keys -> false

// tests/unit/foundryBridge.identify.test.js
it('sends the bridge settings in the identify', ...);   // payload.settings toEqual { backupFolder: 'C:\\x' }

// tests/unit/foundryBridge.gatePush.test.js — existing pushes now assert { gateState, settings }; add
it('pushes { gateState, settings } when a GM changes wiretap.backupFolder', ...);
it('does not push when a player changes wiretap.backupFolder', ...);

// tests/unit/foundryBridge.client.test.js
it('calls an op handler with the params and { requestId, pieces }', ...);

// tests/unit/OnceInit.test.js
it('registers the bridge settings at init', ...);   // wiretap.backupFolder is registered

// tests/unit/pieces.test.js (a fake socket recording emits and exposing its listeners)
it('send emits the piece with its binary data and resolves on an ok ack', ...);
it('send throws PIECE_REFUSED naming the code on a refusal, and SCRIPT_TIMEOUT on a timeout', ...);
it('end emits the end marker with pieces and bytes', ...);
it('receive delivers a piece and acks it only when ack() is called', ...);
it('wraps an ArrayBuffer piece in a Uint8Array', ...);
it('refuses a piece nobody receives, a malformed piece and a second unacked piece', ...);
it('next rejects SCRIPT_TIMEOUT after waitMs with no piece', ...);   // fake timers, 1000 ms
it('close refuses a held piece and removes the receiver', ...);
it('delivers a piece emitted in the same tick as the receive call', ...);   // receive() then the listener fires
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/pieces.test.js tests/unit/bridgeSettings.client.test.js
  tests/unit/foundryBridge.identify.test.js tests/unit/foundryBridge.gatePush.test.js
  tests/unit/foundryBridge.client.test.js tests/unit/OnceInit.test.js`. Expected: FAIL on the new behaviour.
- [ ] **Step 3: Implement** by the rules above. `pushGateState` keeps its GM and author checks and fires when
  `gateNameFromSettingKey(document?.key) !== null || isBridgeSettingKey(document?.key)`.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`, `npm run build`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(client): backupFolder setting, settings in identify and push, piece channel`.

---

### Task 5: Client export — selection, measurement and streaming

The user asked for backups of a list of documents or a whole group (folder, type, pack) that never pass through the
agent's context. This task writes the GM-client half of `backup_documents`: it plans the selection, measures it,
and streams the canonical exports to the sidecar in pieces.

Foundry behaviour this relies on (READ): `CONST.WORLD_DOCUMENT_TYPES` and `PRIMARY_DOCUMENT_TYPES`
(`common/constants.mjs:332-408`); `fromUuid` resolves world, embedded and compendium uuids; a Folder's parent is
`_source.folder`; `CompendiumCollection#getIndex({ fields })` and `#getDocuments({ _id__in })` load a pack in parts,
and `pack.folders` holds the pack's Folders; a Folder of `type: 'Compendium'` holds packs, not documents.

**Files:**
- Modify: `src/bridge/scripts/canonical.js` (add `exportForBackup`)
- Create: `src/bridge/backup/selection.js`, `src/bridge/backup/pieceWriter.js`, `src/bridge/backup/exportBackup.js`,
  `tests/unit/mockBackupWorld.js`, `tests/unit/canonicalBackup.test.js`, `tests/unit/backupSelection.test.js`,
  `tests/unit/pieceWriter.test.js`, `tests/unit/exportBackup.test.js`

**Interfaces:**
- Consumes: Task 1's `BACKUP_PIECE_MAX_BYTES`, `BACKUP_MAX_DOCUMENTS`, `BACKUP_MAX_BYTES`, `HEADER_LINE_BYTES`,
  `BACKUP_TOO_LARGE`, `BACKUP_EMPTY`, `BackupLine`, `WorldDescription`; Task 4's `OpInvocation` (only its shape:
  `invocation.requestId`, `invocation.pieces.send`, `invocation.pieces.end`; tests pass a fake);
  `ScriptError`; `cleanForLog`.
- Produces, `canonical.js`: `export function exportForBackup(document): { ok: true, data: Record<string, unknown>,
  secretPaths: Array<Array<string | number>> } | { ok: false, code: string, message: string }` — `data` is what
  `exportDocument(document, {})` gives without `uuid`; `secretPaths` lists, in walk order, the path of every key the
  redaction removed and every string it changed, found by walking the unredacted plain copy beside the redacted one
  (array members are addressed by index). Never throws.
- Produces, `selection.js`: `export const PACK_BATCH_SIZE = 100;`
  `@typedef {object} SelectionEntry` `{ uuid: string, documentName: string, pack: string | null, id: string }`;
  `@typedef {object} SelectionPlan` `{ entries: SelectionEntry[], parents: number }`;
  `export async function planSelection(params: ExportParams): Promise<SelectionPlan>`;
  `export async function* loadEntries(entries: SelectionEntry[]): AsyncGenerator<{ entry: SelectionEntry,
  document: object | null }>`.
- Produces, `pieceWriter.js`: `export function createPieceWriter(send: (seq: number, bytes: Uint8Array) =>
  Promise<void>, maxBytes: number = BACKUP_PIECE_MAX_BYTES): { write: (text: string) => Promise<void>, finish: () =>
  Promise<{ pieces: number, bytes: number }> }` — buffers UTF-8 bytes, sends every full `maxBytes` slice (a line may
  span pieces), `finish` sends the remainder.
- Produces, `exportBackup.js`: `@typedef {object} ExportParams` `{ uuids?: string[], folderUuid?: string,
  documentName?: string, pack?: string, dryRun?: boolean, timeoutMs: number }`;
  `@typedef {object} ExportResult` `{ documents: number, bytes: number, unreadable: number, parents: number,
  world?: WorldDescription }` (`world` only when not a dry run);
  `export async function exportBackup(params: ExportParams, invocation: OpInvocation): Promise<ExportResult>`.

Selection rules (`planSelection`):
- `uuids`: each resolved with `fromUuid`; a null result is `ScriptError('DOC_NOT_FOUND', \`No document has uuid
  ${cleanForLog(uuid, 64)}.\`)` for the whole call. An embedded document is replaced by its top parent (follow
  `.parent` until none), and each such mapping adds 1 to `parents`. Duplicates (by uuid) are removed, first position
  kept. `User` and `Setting` are `ScriptError('ARGS_INVALID', 'User and Setting documents cannot be backed up: the
  export drops passwords and redacts setting values.')`.
- `folderUuid`: must resolve to a Folder, else `ARGS_INVALID 'folderUuid must name a Folder.'`; a Folder of type
  `Compendium` is `ARGS_INVALID 'A folder of compendium packs cannot be backed up; name a pack.'`. The group is the
  Folder, every descendant Folder (walking the world's `game.folders`, or the pack's `pack.folders`, by
  `_source.folder`) and every document whose `_source.folder` is one of them (the world collection of the Folder's
  type, or the pack's `getIndex({ fields: ['folder'] })` for a pack Folder).
- `documentName`: must be in `CONST.WORLD_DOCUMENT_TYPES` and not `User` or `Setting`, else `ARGS_INVALID`. The group
  is every Folder of that type (`folder.type === documentName`), then every document of the world collection; for
  `Folder` it is every world Folder.
- `pack`: `game.packs.get(pack)`, else `ARGS_INVALID \`Unknown pack ${cleanForLog(pack, 64)}.\``. The group is every
  Folder of the pack, then every entry of `pack.getIndex()` (its `uuid` and `_id`).
- Order: Folders first, a parent Folder before its children (by depth along `_source.folder`), then the other
  documents in collection or index order (or the given order for `uuids`).
- `loadEntries` yields each entry with its document: world entries from their collection, pack Folders from
  `pack.folders`, other pack entries loaded `PACK_BATCH_SIZE` consecutive entries of one pack at a time with
  `pack.getDocuments({ _id__in: ids })`; a document gone since the plan yields `document: null`.

Export rules (`exportBackup`):
1. The deadline is `Date.now() + params.timeoutMs`; before each document past the deadline the call throws
   `ScriptError('SCRIPT_TIMEOUT', 'The backup stopped at its time limit; nothing was saved.')`.
2. `planSelection`; more than `BACKUP_MAX_DOCUMENTS` entries is `ScriptError(BACKUP_TOO_LARGE, \`The selection holds
   ${count} documents; a backup holds at most 10000.\`)`.
3. Measure: for each loaded document, `exportForBackup`; a refusal or a null document adds 1 to `unreadable`; else
   the line `JSON.stringify(line) + '\n'` (a `BackupLine`: `uuid`, `documentName`, `pack` when in a pack, `data`,
   `secretPaths` when not empty) adds its UTF-8 byte length. No readable document is `ScriptError(BACKUP_EMPTY,
   'Nothing to back up: the selection holds no readable document.')`. `HEADER_LINE_BYTES` plus the line bytes over
   `BACKUP_MAX_BYTES` is `ScriptError(BACKUP_TOO_LARGE, \`The backup would be ${bytes} bytes; a backup holds at most
   64000000.\`)`.
4. A dry run returns `{ documents, bytes, unreadable, parents }` with `bytes` the measured file size.
5. Otherwise export again in the same order, write each line through `createPieceWriter((seq, bytes) =>
   invocation.pieces.send(invocation.requestId, seq, bytes, remaining()))`, then `invocation.pieces.end(requestId,
   pieces, pieces, bytes, remaining())` (the end marker's `seq` is the piece count). Return the counts of this pass,
   `bytes` = `HEADER_LINE_BYTES` + the streamed bytes, and `world: { worldId: game.world.id, foundryVersion:
   game.version, systemId: game.system.id, systemVersion: game.system.version }`.

- [ ] **Step 1: Write the failing tests.** `tests/unit/mockBackupWorld.js` builds a mocked `game`, `CONST`,
  `fromUuid` and `CONFIG` with world Folders (nested two deep), Actors with embedded Items, a JournalEntry, a User, a
  Setting, and one pack with two Folders and three indexed Items (its documents export through `toCompendium` like
  world ones).

```js
// tests/unit/canonicalBackup.test.js
it('returns the canonical export without uuid and no secret paths for a plain document', ...);
it('lists the path of each secret-named flag key the redaction dropped, embedded documents included', ...);
//   flags.world.apiKey and items[0].flags.mod.token -> secretPaths [['flags','world','apiKey'],
//   ['items',0,'flags','mod','token']]; data lacks both keys
it('lists a JSON text in a flag whose redaction changed it', ...);   // flags.m.cfg = '{"password":"x","a":1}'
it('refuses a document that cannot be exported, without throwing', ...);   // toCompendium throws -> ok false

// tests/unit/backupSelection.test.js
it('maps an embedded uuid to its parent once and counts it in parents', ...);   // [item uuid, actor uuid] -> 1 entry
it('keeps one entry for a uuid listed twice and for a document named by uuid and by its folder', ...);
it('refuses a missing uuid with DOC_NOT_FOUND and a User or Setting with ARGS_INVALID', ...);
it('selects a world folder group: the folder, its subfolders, then their documents, parents first', ...);
it('selects a pack folder group from pack.folders and the index', ...);
it('refuses a folderUuid that is not a Folder, and a Compendium folder', ...);
it('selects a type group with the folders of that type first', ...);
it('refuses documentName User, Setting and a non-world type', ...);
it('selects a whole pack: its folders, then every index entry', ...);
it('loads pack entries 100 at a time with getDocuments', ...);   // 250 entries -> getDocuments called 3 times
it('yields null for a document deleted since the plan', ...);

// tests/unit/pieceWriter.test.js
it('sends nothing until a piece is full, then exactly maxBytes per piece', ...);   // maxBytes 10
it('splits one line longer than a piece across pieces, byte for byte', ...);
//   a 25-byte line with a 3-byte character at offsets 9..11 -> pieces of 10, 10, 5; concatenation decodes to the line
it('finish sends the remainder and reports pieces and bytes', ...);

// tests/unit/exportBackup.test.js (fake invocation recording send/end calls)
it('streams one line per document in the planned order, then the end marker with the counts', ...);
//   lines parse to BackupLine; end(requestId, n, n, streamedBytes); result.bytes === 2048 + streamedBytes;
//   result.world toEqual { worldId, foundryVersion, systemId, systemVersion } of the mocked game
it('a dry run measures the same bytes and sends nothing', ...);   // dry bytes === real bytes of the same selection
it('refuses more than 10000 documents and more than 64000000 bytes before sending anything', ...);
//   10001 mocked actors -> BACKUP_TOO_LARGE naming 10001; one document whose export is 64000000 bytes -> naming the
//   size; send never called in either case
it('counts unreadable documents and refuses a selection with none readable as BACKUP_EMPTY', ...);
it('stops with SCRIPT_TIMEOUT once the deadline passes', ...);   // Date.now mocked to jump past timeoutMs
it('passes a refused piece on as the error', ...);   // send rejects ScriptError PIECE_REFUSED -> rejects with it
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/canonicalBackup.test.js tests/unit/backupSelection.test.js
  tests/unit/pieceWriter.test.js tests/unit/exportBackup.test.js`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `exportForBackup`, `selection.js`, `pieceWriter.js` and `exportBackup.js` by the rules
  above. `exportForBackup` reuses the private `toPlain` and `stripExcluded` of `canonical.js`.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`, `npm run build`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(client): backup export with selection, measurement and piece streaming`.

---

### Task 6: Client restore — replace split, line reader, secret carry, `restoreBackup`

The user asked for a restore tool. This task writes the GM-client half of `restore_backup`: it reads the backup's
lines from pieces and applies each one through the same replace and create code the write tools use. It is a security
boundary: a restore meets every gate, the write guard and Foundry validation that the same write through
`replace_document` or `create_documents` meets.

Foundry behaviour this relies on (READ in the current code): `replacementOf` in `writeReplace.js` drops `_id`,
`sort`, `active`, `ownership` (recursively), the `preserveOnImport` keys (`folder` among them) and `_stats`, so a
plain replace keeps the live values of those fields; `prepareCreate` with `keepId` refuses taken ids; the guard
refuses a `flags.wiretap` scope in written data.

**Files:**
- Modify: `src/bridge/scripts/writeReplace.js` (split `replaceDocument` into `prepareReplace` and `runReplace`; add
  the restore mode; export `stripWiretapFlags`), `tests/unit/mockWriteWorld.js` (only what the new tests need:
  `game.world`, `game.system`, `game.packs` lookups, `game.documentTypes`, a locked pack)
- Create: `src/bridge/backup/lineReader.js`, `src/bridge/backup/secretCarry.js`, `src/bridge/backup/restoreBackup.js`,
  `tests/unit/writeReplaceRestore.test.js`, `tests/unit/lineReader.test.js`, `tests/unit/secretCarry.test.js`,
  `tests/unit/restoreBackup.test.js`

**Interfaces:**
- Consumes: Task 1's `BackupHeader`, `BackupLine`, `BACKUP_INCOMPLETE`, `RESTORE_ROWS_MAX`,
  `RESTORE_REASON_MAX_BYTES`; Task 4's `OpInvocation` shape (`invocation.pieces.receive(requestId)` returning a
  `PieceReceiver`; tests pass a fake); `prepareCreate`, `runCreate` of `writes.js`; `ScriptError`; `cleanForLog`,
  `describeCause`; `truncateUtf8`.
- Produces, `writeReplace.js`:
  - `@typedef {object} ReplacePlan` `{ target: object, replacement: Record<string, unknown>, changed: string[],
    dropped: number, dryRun: boolean }`
  - `export async function prepareReplace({ uuid, data, dryRun = false, actAs, restore = false }): Promise<ReplacePlan>`
    — every check `replaceDocument` makes today, in today's order, ending before the write.
  - `export async function runReplace(plan: ReplacePlan, readback = false): Promise<ReplacedRow>` — the update with
    `{ diff: false, recursive: false }`, `WRITE_NOT_APPLIED` when a hook cancels, and the read-back.
  - `replaceDocument` keeps its signature and results: `prepareReplace`, then the dry-run row or `runReplace`.
  - `export function stripWiretapFlags(root: unknown): void` (the existing function, exported).
  - Restore mode (`restore: true`): the first guard judges the given data without each `ownership` value that deep
    equals its live counterpart (the document's own, and each first-level embedded document's matched by `_id`), and
    without an embedded document's `ownership` equal to `{ default: 0 }` when it has no live counterpart; after
    `carryWiretapFlags`, the backed-up `sort`, `folder` and `ownership` of the document, and the `ownership` of each
    first-level embedded document (matched by `_id`), are written into the replacement when the given data holds
    them. The first-level embedded collections are the keys of `documentClass.hierarchy`.
- Produces, `lineReader.js`: `export function createLineReader(): { push: (bytes: Uint8Array) => Uint8Array[],
  pending: () => number }` — `push` returns the complete lines (without `\n`) the bytes finish, split on the byte
  0x0A, and keeps the rest; `pending` is the kept byte count.
- Produces, `secretCarry.js`: `export function carrySecrets(data: Record<string, unknown>, live: Record<string,
  unknown>, paths: Array<Array<string | number>>): number` — for each path, walks `data` and `live` together (a
  numeric segment in `live` follows the array member whose `_id` equals the `data` member's `_id`, else the same
  index) and copies a deep clone of the live value into `data`; returns how many paths had no live value.
- Produces, `restoreBackup.js`: `@typedef {object} RestoreParams` `{ header: BackupHeader, uuids?: string[],
  dryRun?: boolean, timeoutMs: number }`; `@typedef {[string, string, string?]} RestoreRow` (`[uuid, state,
  reason]`, state `replaced`, `created`, `skipped` or `failed`); `@typedef {object} RestoreResult` `{ replaced:
  number, created: number, skipped: number, failed: number, rows: RestoreRow[], secretLost: number,
  differences?: string[], dryRun?: true }`; `export async function restoreBackup(params: RestoreParams, invocation:
  OpInvocation): Promise<RestoreResult>`.

Restore rules (`restoreBackup`), applied line by line in file order (the backup already puts Folders first, parents
first):
1. The first statement registers `invocation.pieces.receive(invocation.requestId)`, before any `await`; the receiver
   is closed in a `finally`.
2. `header.worldId !== game.world.id` is `ScriptError('ARGS_INVALID', \`The backup is of world
   ${cleanForLog(header.worldId, 64)}, not this world.\`)`. `differences` lists, for `foundryVersion` against
   `game.version`, `systemId` against `game.system.id` and `systemVersion` against `game.system.version`, each
   differing field as `<field>: <backup> -> <current>` (values bounded to 64 bytes); absent when none differ.
3. Each piece's data goes through the line reader; each complete line is applied, then the piece is acked. The end
   marker is acked once `pieces` and `bytes` equal the counts received and no partial line is pending; else
   `ScriptError(BACKUP_INCOMPLETE, 'The backup data ended early or did not match its end marker.')`.
4. Before each line past the deadline (`timeoutMs` from the start) the call throws `ScriptError('SCRIPT_TIMEOUT',
   \`The restore stopped at its time limit after ${applied} documents; it is partly applied.\`)` (`applied` is 0 on a
   dry run).
5. A line that does not parse to a `BackupLine` is `failed` with uuid `line <n>` (1-based after the header) and
   reason `LINE_INVALID: the line is not a backup entry.`
6. With `uuids`, a line applies when one asked uuid equals `line.uuid` or starts with `line.uuid + '.'`; at the end,
   each asked uuid no line matched is `skipped` with reason `not in the backup`.
7. Checks before writing, each making the line `failed` with the reason shown: `line.pack` with no
   `game.packs.get(line.pack)`: `PACK_GONE: the pack no longer exists.`; a locked pack: `PACK_LOCKED: unlock the pack
   to restore into it.`; no `CONFIG[line.documentName]?.documentClass`: `TYPE_GONE: the document type no longer
   exists.`; a `data.type` string not in `game.documentTypes[line.documentName]` (when that list exists):
   `TYPE_GONE: subtype <type> no longer exists.`.
8. A `data.folder` id that names no Folder (in `game.folders`, or the pack's `pack.folders`, or among the Folder ids
   this dry run planned to create) is set to null and the row's reason is `FOLDER_GONE: restored outside its folder.`
9. `stripWiretapFlags(data)`. When `fromUuid(line.uuid)` finds the document: `secretLost` counts the line when
   `carrySecrets(data, live.toObject(), line.secretPaths ?? [])` returns more than 0; then `prepareReplace({ uuid:
   line.uuid, data, dryRun: false, restore: true })` and, unless a dry run, `runReplace(plan)`; state `replaced`.
   Otherwise `secretLost` counts the line when `secretPaths` is not empty; then `prepareCreate({ documentName:
   line.documentName, data: [data], pack: line.pack, keepId: true })` and, unless a dry run, `runCreate(plan)`; state
   `created`. A dry run passes `dryRun: false` to the prepare calls, so it reports every gate the real run would meet.
10. A `ScriptError` makes the line `failed` with reason `<code>: <message>`; any other throw `FAILED: <describeCause>`;
    reasons are cut to 160 bytes with `truncateUtf8`.
11. `rows` holds at most 20 rows: failed first, then skipped, created, replaced, each in file order. `dryRun: true` on
    a dry run.

- [ ] **Step 1: Write the failing tests.**

```js
// tests/unit/writeReplaceRestore.test.js (mockWriteWorld)
it('replaceDocument keeps every existing result once split into prepareReplace and runReplace', ...);
//   the dry-run row, the write row, dropped, WRITE_NOT_APPLIED, readback: as the existing writeReplace tests assert
it('restore mode writes the backed-up sort, folder and ownership back into the replacement', ...);
it('restore mode needs no allowOwnershipWrites when ownership equals the live value', ...);
it('restore mode needs allowOwnershipWrites when ownership differs, and writes nothing without it', ...);
it('restore mode restores the ownership of a kept embedded document', ...);
it('restore mode still needs allowReplace, and allowDelete when it removes an embedded document added since', ...);

// tests/unit/lineReader.test.js
it('returns complete lines and keeps the tail', ...);
it('rebuilds a line split across three pieces, a multi-byte character cut at a piece edge', ...);
it('reports the pending tail length', ...);

// tests/unit/secretCarry.test.js
it('copies the live value of each path into the data', ...);
it('follows embedded documents by _id when their order changed', ...);
it('counts a path with no live value and leaves the data unchanged there', ...);

// tests/unit/restoreBackup.test.js (fake invocation whose receiver yields pieces built from given lines)
it('registers the receiver before its first await', ...);
//   invocation.pieces.receive is called synchronously inside the restoreBackup(...) call expression
it('refuses a backup of another world with ARGS_INVALID', ...);
it('replaces an existing document and re-creates a deleted one with its id', ...);
//   replaced 1, created 1; created document's _id equals the line's data._id
it('re-creates a deleted Folder before the document inside it', ...);
it('restores a document whose folder is gone and not in the backup outside any folder, reason FOLDER_GONE', ...);
it('fails a document whose pack is gone or locked, or whose type or subtype is gone', ...);
it('fails one document denied by a gate with the gate named, and applies the others', ...);
//   allowReplace closed: replaced 0, failed 1, reason contains GATE_DENIED and allowReplace; the created one applies
it('a dry run writes nothing and reports the gate denials the real run would meet', ...);
it('carries a live secret flag into the replaced document and counts a lost one', ...);
it('applies only the asked uuids, maps an embedded uuid to its line, and skips the ones not in the backup', ...);
it('fails an unparsable line as line <n> and goes on', ...);
it('names the version differences', ...);   // systemVersion '1.0.0 -> 2.0.0'
it('orders at most 20 rows: failed, skipped, created, replaced', ...);   // 30 lines of mixed states
it('throws BACKUP_INCOMPLETE when the end marker counts do not match', ...);
it('stops with SCRIPT_TIMEOUT once the deadline passes, naming how many documents applied', ...);
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/writeReplace.test.js tests/unit/writeReplaceRestore.test.js
  tests/unit/lineReader.test.js tests/unit/secretCarry.test.js tests/unit/restoreBackup.test.js`. Expected: the
  existing `writeReplace.test.js` passes; the new tests FAIL.
- [ ] **Step 3: Implement** the split, the restore mode, `lineReader.js`, `secretCarry.js` and `restoreBackup.js` by
  the rules above. The `writeReplace.js` header comment gains one paragraph stating what restore mode writes back
  and why (a plain replace keeps the live `ownership`, `folder` and `sort`).
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`, `npm run build`. Expected: all pass,
  `riskGates.test.js` included.
- [ ] **Step 5: Commit** `feat(client): backup restore through the replace and create paths`.

---

### Task 7: Client op wiring

The user asked for backup and restore tools; this task connects the client halves (Tasks 5 and 6) to the bridge so
the sidecar can run them.

**Files:**
- Modify: `src/bridge/foundryBridge.js` (the `opHandlers` table)
- Create: `tests/unit/foundryBridge.backupOps.test.js`

**Interfaces:**
- Consumes: `OP_BACKUP_EXPORT`, `OP_BACKUP_RESTORE` (Task 1); `exportBackup` (Task 5); `restoreBackup` (Task 6); the
  invocation of Task 4.
- Produces: `opHandlers[OP_BACKUP_EXPORT] = exportBackup`, `opHandlers[OP_BACKUP_RESTORE] = restoreBackup`.

- [ ] **Step 1: Write the failing tests** (the fake socket of `foundryBridge.client.test.js`, `exportBackup` and
  `restoreBackup` mocked with `vi.mock`):

```js
it('routes backupExport to exportBackup with params and { requestId, pieces }', ...);
it('routes backupRestore to restoreBackup', ...);
it('a restore piece emitted right after the invoke, in the same tick, reaches the restore', ...);
//   the mocked restoreBackup calls invocation.pieces.receive(invocation.requestId) as its first statement, then
//   awaits next(1000); the test fires the invoke listener and, with no await between, the restore-piece listener;
//   the mock receives the piece and the piece is not refused
it('acks a ScriptError of a backup op with its code', ...);   // BACKUP_EMPTY -> ack error code BACKUP_EMPTY
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/foundryBridge.backupOps.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the two table entries (one comment line each).
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`, `npm run build`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(client): route the backup and restore ops`.

---

### Task 8: Sidecar backup tools — `server/backupTools.ts`

The user asked for a lean set of backup tools. This task builds the four tool registrations: their arguments, the
folder choice and gate, the busy lock, the trust checks on what the client sends, and results fitted to their
budgets. It is a security boundary.

**Files:**
- Create: `server/backupTools.ts`, `tests/unit/backupTools.test.js`

**Interfaces:**
- Consumes: `createBackupStore`, `BackupStore`, `ResolvedFolder`, `BackupFileWriter` (Task 2); `InvokeOptions`,
  `EndpointSnapshot`,
  `Endpoint`, `BridgeError` (Task 3); `PieceSink`, `IncomingPiece`, `OutgoingPiece` (Task 3); `OP_BACKUP_EXPORT`,
  `OP_BACKUP_RESTORE`, the constants, codes and `isWorldField`, `isBackupNote` (Task 1); `ToolRegistration` of
  `server/mcp.ts` (type import only); `gateDenial`, `closedGateState` of `shared/gates.js`; `defaultBridgeSettings`;
  `getBudget`; `truncateUtf8`.
- Produces:
  - `export interface BackupBridge { invoke(op: string, params: object, options?: InvokeOptions): Promise<unknown>;
    snapshot(options?: InvokeOptions): EndpointSnapshot | undefined; expectPieces(socketId: string, requestId: string,
    sink: PieceSink): () => void; sendPiece(socketId: string, piece: OutgoingPiece, timeoutMs: number):
    Promise<void> }`
  - `export interface BackupToolsDeps { bridge: BackupBridge; store: BackupStore; log?: (line: string) => void;
    now?: () => number }`
  - `export function createBackupTools(deps: BackupToolsDeps): (endpoint: EndpointKind | undefined) =>
    ToolRegistration[]` — one busy lock shared by every session; each call returns the four registrations for a
    session that routes to `endpoint`.
  - `export function fitListResult(result: object, maxBytes: number): object` and
    `export function fitRestoreResult(result: object, maxBytes: number): object` — drop rows from the end until the
    JSON fits and set `cut: true` when any was dropped.
  - `export interface BackupSink extends PieceSink { failure(): BridgeError | undefined; writer(): BackupFileWriter |
    undefined; counts(): { pieces: number; bytes: number; lines: number; ended: boolean } }` and
    `export function createBackupSink(openWriter: () => BackupFileWriter): BackupSink` — the backup sink rules below;
    `openWriter` runs on the first data piece.

Tool definitions (zod shapes; every argument has a short `.describe`):
- `backup_documents` — description `Save documents (uuids, or one folderUuid, documentName or pack) to a new backup
  file in the sidecar. Offer before bulk or risky changes.`; `uuids` array of strings (max 256 chars) 1 to 200,
  optional; `folderUuid`, `documentName`, `pack` optional strings (max 256, 32, 128 chars); `folder` optional string
  (max 1024 chars); `note` optional string; `dryRun` optional boolean; `timeoutMs` optional integer 1,000 to 300,000;
  `budgetBytes` = `BACKUP_RESULT_MAX_BYTES`.
- `list_backups` — description `List the backup files of a folder, newest first, as [file, created, documents, note]
  rows.`; `folder` optional; `limit` optional integer 1 to 50; budget `BACKUP_LIST_MAX_BYTES`.
- `restore_backup` — description `Restore documents from a backup file through the write gates. Not atomic: documents
  apply one by one and hooks run. dryRun plans it.`; `file` string (max 64 chars); `folder` optional; `uuids`
  optional 1 to 200; `dryRun` optional; `timeoutMs` optional 1,000 to 300,000; budget `RESTORE_RESULT_MAX_BYTES`.
- `delete_backup` — description `Move a backup file to the recycle bin.`; `file`; `folder` optional; budget
  `BACKUP_DELETE_MAX_BYTES`.

Rules:
- Routing: every call passes `{ endpoint }` when the session restricts its endpoint kind, else `{}`.
- Folder and gate: inside `prepare` (backup, restore) or on `bridge.snapshot(...)` (list, delete; with no
  endpoint the closed gate state and `defaultBridgeSettings()`), the folder is `store.resolveFolder(args.folder,
  settings.backupFolder)`; kind `named` with `gateDenial(gateState, 'allowBackupAnyFolder')` not null is
  `BridgeError(GATE_DENIED, denial.message)`.
- `backup_documents`: exactly one of `uuids`, `folderUuid`, `documentName`, `pack`, else `ARGS_INVALID 'Give exactly
  one of uuids, folderUuid, documentName or pack.'`; `note` must pass `isBackupNote`, else `ARGS_INVALID 'note must be
  at most 200 bytes with no control characters.'`. Busy (dry runs included) is `BACKUP_BUSY 'A backup or restore is
  already running; retry when it ends.'`. `invoke(OP_BACKUP_EXPORT, {}, { endpoint, replyWaitMs: timeoutMs + 2000, prepare })`;
  `prepare` resolves and gate-checks the folder, runs `store.checkFolder(folder, !dryRun)`, registers (not on a dry
  run) a sink with `bridge.expectPieces(endpoint.socketId, requestId, sink)`, and returns `{ uuids, folderUuid,
  documentName, pack, dryRun, timeoutMs }` (absent keys left out; `timeoutMs` defaults to 120,000).
- The backup sink: data pieces must arrive with `seq` 0, 1, 2, … (else `BACKUP_INCOMPLETE 'A backup piece arrived
  out of order.'`); the file is created with `store.createFile(folder)` on the first piece; the received bytes plus
  `HEADER_LINE_BYTES` must stay within `BACKUP_MAX_BYTES` (else `BACKUP_TOO_LARGE`); newline bytes are counted. The end
  marker must have `seq` and `pieces` equal to the data piece count and `bytes` equal to the data bytes (else
  `BACKUP_INCOMPLETE`). `gone()` records `ENDPOINT_GONE 'The Foundry endpoint disconnected during the backup;
  nothing was saved.'`. The sink's first failure is kept.
- After the invoke: the sink is removed. A kept sink failure is the error, else the invoke's error, else these
  checks: an end marker was received; the result's `documents` is a non-negative integer equal to the newline count
  and at least 1; `bytes` equals the file size; each `world` field passes `isWorldField` (else `BACKUP_INCOMPLETE
  'The Foundry client sent a result that does not match the pieces it sent.'`). Then `writer.finish({ ...world, note:
  note ?? '', documents })`. On any failure after the file was created, the writer is closed and the file goes to
  `store.trashPath`; when that throws, the error message gains ` The partial file <name> could not be moved to the
  recycle bin.` (within 512 B).
- Backup result: `{ file, folder: kind, documents, bytes }`, plus `unreadable` and `parents` when above 0. A dry run:
  `{ dryRun: true, folder: kind, documents, bytes }` plus the same optional counts; client counts must be non-negative
  integers (else `BACKUP_INCOMPLETE`).
- `restore_backup`: busy as above. `prepare` resolves and gate-checks the folder, opens `store.openFile(folder,
  file)` and returns `{ header, uuids, dryRun, timeoutMs }`; `onSent` starts the pump: read `readPiece(512000)` and
  `await bridge.sendPiece(socketId, { requestId, seq, data }, remaining)` until null, then send the end marker
  `{ requestId, seq, end: true, pieces, bytes }`; a pump failure is logged and stops the pump (the invoke's outcome
  is authoritative); the reader is closed when both the pump and the invoke are done. An `ENDPOINT_GONE` from the
  invoke becomes `BridgeError(ENDPOINT_GONE, 'The Foundry endpoint disconnected during the restore; the restore may be
  partly applied.')`. The result is the client's counts, rows and fields after a shape check (counts non-negative
  integers, at most 20 rows of `[string, string, string?]`, each string at most 256 bytes; else `BACKUP_INCOMPLETE`),
  with `file` first, fitted with `fitRestoreResult` to `RESTORE_RESULT_MAX_BYTES`.
- `list_backups`: `store.checkFolder(folder, false)`, `store.list(folder, limit ?? 10)`; rows with the note cut to
  40 bytes; result `{ folder: kind, rows, total }` plus `invalid` when above 0; fitted with `fitListResult` to
  `BACKUP_LIST_MAX_BYTES`. Not refused while busy.
- `delete_backup`: refused `BACKUP_BUSY` while a backup or restore runs; `store.trashFile(folder, file)`; result
  `{ file, trashed: true }`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/backupTools.test.js` with a fake `BackupBridge` (its
  `invoke` runs `options.prepare` with a fake endpoint, feeds pieces to the registered sink, calls `onSent`, and
  resolves the configured client result), the real store over `scratchRoot('backupTools')` and `fakeTrash`. Call a
  tool through its registration's `handler`; parse the text.

```js
it('refuses no selector and two selectors with ARGS_INVALID', ...);
it('refuses a note over 200 bytes or with a control character', ...);
it('writes the file from the pieces and finishes the header from the client result', ...);
//   result { file, folder: 'default', documents: 2, bytes } <= 256 B; header.documents 2, header.note 'n',
//   header.worldId from the result; file size === bytes
it('a dry run sends no sink, creates no folder and returns the measurement', ...);
it('writes to the setting folder without the gate and needs allowBackupAnyFolder for a named folder', ...);
//   named folder with the gate closed -> GATE_DENIED naming allowBackupAnyFolder, prepare returned nothing, no file
it('refuses an out-of-order piece, a short end marker and a result whose documents differ from the lines', ...);
//   each -> BACKUP_INCOMPLETE; the partial file is in fakeTrash.calls; the folder holds no backup file
it('createBackupSink refuses received bytes over 64000000 with BACKUP_TOO_LARGE', ...);
//   a fake writer that only counts; 125 pieces reusing one 512000-byte Buffer: piece 125 (2048 + 64000000 bytes) is
//   refused BACKUP_TOO_LARGE, failure() returns it, and no further piece is accepted
it('names the partial file when the recycle bin refuses it', ...);   // trash rejects -> message contains file name
it('reports ENDPOINT_GONE when the client disconnects mid-backup and trashes the partial file', ...);
it('refuses a second backup or restore and a delete while one runs, and lists meanwhile', ...);
it('restore opens the file in prepare and pumps its bytes after the header in order, then the end marker', ...);
it('restore of an off-pattern or invalid file fails before anything is sent', ...);
it('restore maps ENDPOINT_GONE to the partly applied message', ...);
it('fits a restore result to 4000 bytes, dropping rows from the end and setting cut', ...);
//   20 rows of 250-byte uuids -> JSON <= 4000 B, cut true, file first
it('refuses a malformed restore result with BACKUP_INCOMPLETE', ...);   // 21 rows; a count of -1; a 300-byte reason
it('lists with the note cut to 40 bytes and fits the list to 2000 bytes', ...);
it('lists and deletes in the default folder only when no GM endpoint is connected', ...);
//   snapshot undefined: list default ok; list with a named folder -> GATE_DENIED
it('deletes a valid backup into the recycle bin and returns { file, trashed: true } within 128 bytes', ...);
```

- [ ] **Step 2: Run them.** `npx vitest run tests/unit/backupTools.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `server/backupTools.ts` by the rules above.
- [ ] **Step 4: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(server): backup, list, restore and delete backup tools`.

---

### Task 9: Register the tools in every session; budget fixtures; the user-facing skill

The user asked for the tools and for the agent to be advised to offer a backup before bulk or risky changes. This task
lists the four tools in every MCP session, holds them to their budgets, and adds the guidance to the skill the agent
reads.

**Files:**
- Modify: `server/mcp.ts` (`McpServerOptions`, `FoundryBridge`, `WIRETAP_INSTRUCTIONS`, `buildServer`,
  `createSession`, `startMcpServer`), `server/server.ts` (`createWiretapServer` gains `options`),
  `shared/scripts.js:127` (`RESERVED_SCRIPT_NAMES`), `skills/wiretap/SKILL.md`
- Test: `tests/unit/scripts.test.js:53`, `tests/unit/scriptRegistry.test.js:202,215,217`,
  `tests/unit/contextBudgetHarness.js` (fixtures, `startHarness` options and return),
  `tests/integration/mcpSessions.test.js`, `tests/integration/mcpHardening.test.js:340`,
  `tests/integration/scriptRegistry.test.js:30,184`

**Interfaces:**
- Consumes: `createBackupTools`, `BackupBridge` (Task 8); `createBackupStore`, `BackupStoreOptions` (Task 2);
  `fakeTrash`, `scratchRoot` (Task 2); the bridge's `snapshot`, `expectPieces`, `sendPiece` (Task 3).
- Produces:
  - `RESERVED_SCRIPT_NAMES = Object.freeze(['read_handle', 'backup_documents', 'list_backups', 'restore_backup',
    'delete_backup'])`.
  - `McpServerOptions.backups?: BackupStoreOptions`; the `FoundryBridge` interface of `mcp.ts` also extends
    `BackupBridge`; `startMcpServer` builds one store and one `createBackupTools({ bridge, store, log })`, and each
    session registers `read_handle`, then the four backup tools for its endpoint, then the caller's `tools`.
  - `createWiretapServer(port, mcpPort, mode = 'full', options: { backups?: BackupStoreOptions } = {})` passes
    `backups` to `startMcpServer`; production passes nothing.
  - `WIRETAP_INSTRUCTIONS` =
    `'Wiretap connects this session to the live Foundry VTT world through a GM browser. ' +
    'A result over the size cap comes back as a handle: page it with mcp__wiretap__read_handle (offset and length, ' +
    'or paths into the stored JSON). The backup tools run in this sidecar; every other tool is a script the GM ' +
    'client registers, and those can appear or vanish while the session runs (the server sends tools/list_changed).'`
    (its comment's constraint text is updated: it names only `read_handle`).
  - `startHarness({ tools, instructions, registry, backups })` of `contextBudgetHarness.js` also returns `gm` (the
    fake GM socket) and `setGmHandler(handler: (request, gm) => Promise<object>)` (the fake GM answers an invoke with
    the handler's ack; without one it answers `gmAck` as today); `backups` defaults to
    `{ root: scratchRoot('harness'), trash: fakeTrash(<root>/bin) }`.

- [ ] **Step 1: Update the tests.** `scripts.test.js:53` expects the five names. In `scriptRegistry.test.js` the
  scripts limit becomes `at most ${30 - RESERVED_SCRIPT_NAMES.length} scripts` (25), and the room kept for the
  built-ins is `DEFINITION_MAX_BYTES * RESERVED_SCRIPT_NAMES.length`, with the tool-count bound
  `ALWAYS_LISTED_TOOLS_MAX - RESERVED_SCRIPT_NAMES.length`. Every expected tool-name list in the three integration
  files holds the five built-in names where it held `'read_handle'`, in the list's own order. Add `FIXTURES` entries:

```js
backup_documents: [{ label: 'largest ack: longest counts', budget: 'BACKUP_RESULT_MAX_BYTES', run: ... }],
//   setGmHandler: for op backupExport, emit one BRIDGE_BACKUP_PIECE { requestId, seq: 0, data: Buffer of one line },
//   then the end marker, then answer okAck({ documents: 1, bytes: 2048 + line bytes, unreadable: 9999,
//   parents: 199, world }) with each of the four world fields 128 ASCII characters; call backup_documents
//   { uuids: ['Actor.x'] }
list_backups: [{ label: 'fifty rows cut to the budget', budget: 'BACKUP_LIST_MAX_BYTES', run: ... }],
//   fifty backups made as above, each with a 200-byte note; list_backups { limit: 50 }
restore_backup: [{ label: 'twenty long rows', budget: 'RESTORE_RESULT_MAX_BYTES', run: ... }],
//   a backup made as above; for op backupRestore the handler acks every BRIDGE_RESTORE_PIECE on gm, then answers 20
//   rows of 256-byte uuids and 160-byte reasons and three differences
delete_backup: [{ label: 'trashed ack', budget: 'BACKUP_DELETE_MAX_BYTES', run: ... }],
```

  In `contextBudget.test.js` nothing changes: line 526 still expects the instructions to mention only `read_handle`.
- [ ] **Step 2: Run them.** `npx vitest run tests/unit/contextBudget.test.js tests/unit/scripts.test.js
  tests/unit/scriptRegistry.test.js tests/integration/mcpSessions.test.js`. Expected: FAIL (tools not listed).
- [ ] **Step 3: Implement** the registration, the server option and the instructions text. Then add to
  `skills/wiretap/SKILL.md` a recipe paragraph with these facts, and tighten the existing text so the file stays at
  most 70 lines (`tests/unit/shippedSkill.test.js`) without dropping any existing fact:

```
**Backups.** Before a bulk update (more than about 10 documents), any `replace_document`, any delete, or an
`execute_macro` that changes documents, offer `mcp__wiretap__backup_documents`: `uuids` (up to 200; an embedded one
saves its parent) or one `folderUuid`, `documentName` or `pack`, and a `note`. Tell the user the `file` and where it
went (`folder: "default"` is `.wiretap/backups` in the module folder; `"setting"` is the GM's Backup folder setting).
`mcp__wiretap__list_backups` lists them. `mcp__wiretap__restore_backup` (`file`, `uuids`, `dryRun`) only when the user
asks: not atomic, hooks run; it needs `allowReplace`, `allowOwnershipWrites` to re-create a deleted document and
`allowDelete` when embedded documents were added since. `mcp__wiretap__delete_backup` moves a file to the recycle bin.
Another `folder` needs `allowBackupAnyFolder`. A whole-world backup is made on Foundry's setup screen, world shut down.
```

  and add `BACKUP_NOT_FOUND`, `BACKUP_BUSY` (one at a time; retry) and `BACKUP_TOO_LARGE` (10,000 documents or
  64,000,000 bytes) to "Errors you may meet".
- [ ] **Step 4: Measure.** `npx tsx tests/measure/measureContext.mjs` and `npx vitest run
  tests/unit/contextBudget.test.js tests/unit/shippedSkill.test.js`. Expected: each new definition ≤ 800 B, all
  definitions ≤ 16,000 B, at most 30 tools, every fixture within its budget, the skill ≤ 70 lines. Report each
  definition size and the total. Over a limit: stop and report (a budget is raised only by the user).
- [ ] **Step 5: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 6: Commit** `feat(server): list the backup tools in every session; skill guidance`.

---

### Task 10: Integration tests over a real socket

The user asked for backups that stream between the GM client and the sidecar; `docs/PLAN.md` M21 names these
integration tests ("pieces both ways, a lost piece, a disconnect mid-backup, busy refusal, the gate on another folder")
and the acceptance that no document text appears in any MCP message. This task proves them through the real sidecar,
Socket.IO and the MCP SDK client, with a fake GM client.

**Files:**
- Create: `tests/integration/backupTools.test.js`
- Modify: `docs/OPEN_BUGS.md` only to log a defect the tests expose

**Interfaces:**
- Consumes: `startHarness` (its `gm`, `setGmHandler`, `backups`) of `tests/unit/contextBudgetHarness.js` (Task 9);
  `fakeTrash`, `scratchRoot` (Task 2); `BRIDGE_BACKUP_PIECE`, `BRIDGE_RESTORE_PIECE`, `BRIDGE_GATE_STATE`
  (Task 1); `parseHeaderLine`, `HEADER_LINE_BYTES` (Task 1).
- The fake GM's lines carry the marker text `WIRETAP-MARKER-7f3a` in their `data`. "Received payloads" are recorded by
  wrapping the SDK client transport's `onmessage` after `client.connect` (each message `JSON.stringify`-ed into a
  list).

- [ ] **Step 1: Write the tests.**

```js
it('backs up in pieces: the file holds the header and every line, one line longer than a piece', ...);
//   lines: 600000-byte line (split over two pieces) and two short ones; file bytes after 2048 equal the lines;
//   header documents 3, bytes === file size
it('restores in pieces: the client receives the file bytes after the header, in order, one piece at a time', ...);
//   the fake GM holds each piece 20 ms before acking and asserts it never holds two
it('a lost piece fails the backup with BACKUP_INCOMPLETE and moves the partial file to the recycle bin', ...);
//   the fake GM sends seq 0 then seq 2
it('a restore piece the client refuses stops the pump', ...);   // no piece after the refused one arrives
it('a disconnect mid-backup fails ENDPOINT_GONE and moves the partial file to the recycle bin', ...);
it('a disconnect mid-restore fails ENDPOINT_GONE saying the restore may be partly applied', ...);
it('a second backup or restore while one runs is BACKUP_BUSY', ...);
it('a folder outside the default and the setting needs allowBackupAnyFolder on the picked endpoint', ...);
//   gm pushes { gateState: { allowBackupAnyFolder: true }, settings: {} } -> the same call succeeds
it('the backupFolder setting pushed by the GM chooses the folder', ...);
it('no document text appears in any MCP message of a backup or restore', ...);
//   the recorded messages of backup_documents, list_backups, restore_backup and delete_backup contain no
//   'WIRETAP-MARKER-7f3a'
it('streams 2048000 bytes in 512000-byte pieces and records the duration', ...);
//   four pieces; the elapsed milliseconds are written with console.info (test code, not shipped)
```

- [ ] **Step 2: Run.** `npx vitest run tests/integration/backupTools.test.js`. Expected: all pass. A failure that is a
  product defect: log it in `docs/OPEN_BUGS.md` and stop the lane (the code under test is buddy-checked).
- [ ] **Step 3: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`. Expected: all pass.
- [ ] **Step 4: Measure.** From the 2,048,000-byte test's duration, compute the time a 64,000,000-byte backup would
  take (Inferred: transport only). Report both numbers. Over 300,000 ms: stop and report (the bounds need the owner).
- [ ] **Step 5: Commit** `test(integration): backup pieces both ways, failures, busy, gates, no document text`.

---

### Task 11: e2e on the live world

The user asked for backup and restore tools; `docs/PLAN.md` M21 names the e2e flow ("back up, change and delete,
restore, compare, and trash the backup file under `test/tmp/`") and the acceptance "a restored document equals its
backed-up export apart from documented system side effects".

**Files:**
- Create: `tests/e2e/backupTools.spec.js`
- Modify: `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md` as defects are found

**Interfaces:**
- Consumes: the shipped tools (Tasks 7 to 9); `login(page, user)` of `tests/e2e/fixtures.js`; `startGateSidecar`,
  `stopSidecar` of `tests/e2e/sidecar.js`; `E2E_MCP_PORT` of `tests/e2e/ports.js`; `recordGateSettings`,
  `restoreGateSettings`, `readSidecarGateState` of `tests/e2e/gates.js`; `E2E_PREFIX`, `recordDocument`,
  `settleRegistry`, `assertSettled`, `teardownRecorded` of `tests/e2e/registry.js`; `parseHeaderLine` of
  `shared/backup.js`. Follow the setup of `tests/e2e/macroTools.spec.js` (sidecar per spec file, MCP SDK client per
  test, a `callText` helper, an `openGate` helper that sets a gate in the page and polls the page and the sidecar
  snapshot with `timeout: 1000`, `recordGateSettings` in `beforeEach` and `restoreGateSettings` in `afterEach`).

Setup: `beforeAll` creates `test/tmp/e2e-backups-<ts>/setting` and `.../named` with `fs.mkdirSync` and records the
page's `wiretap.backupFolder` value; `afterAll` sets it back in a `finally`. Per test, in the page: a Folder
`${E2E_PREFIX}Folder <ts>` (type Actor), an Actor `${E2E_PREFIX}Actor <ts>` in it with two embedded Items and
`flags.world.e2eText` holding `WIRETAP-MARKER-7f3a`, and a JournalEntry
`${E2E_PREFIX}Journal <ts>`; each recorded right after creation. The export compared is the page's
`doc.toCompendium(null, { clearSource: false, keepId: true, clearSort: false, clearOwnership: false })` without
`_stats`; the documented side effects excluded are `_stats` and a Scene's `active`.

- [ ] **Step 1: Write the spec** with these tests:

```js
test('backs up to the Backup folder setting, lists the file, and the file holds a valid header', ...);
//   set wiretap.backupFolder to the setting dir; poll list_backups until folder === 'setting' (timeout 1000);
//   backup_documents { folderUuid } -> { file, folder: 'setting', documents: 2 }; the file exists there; its first
//   2048 bytes parse with parseHeaderLine; worldId equals game.world.id; list_backups rows[0][0] === file
test('restores changed, deleted and added-to documents to their backed-up export', ...);
//   backup_documents { uuids: [actor, journal] }; then rename the actor, delete one item, add a third item, delete the
//   journal; open allowReplace, allowDelete, allowOwnershipWrites; restore_backup { file } -> replaced 1, created 1,
//   failed 0; the actor's export equals the backup line data (no _stats), two items with the original ids; the
//   journal exists again with its id
test('a restore dry run writes nothing, and a closed allowReplace fails the document naming the gate', ...);
test('a folder argument outside the default and the setting needs allowBackupAnyFolder', ...);
//   folder: the named dir -> GATE_DENIED naming allowBackupAnyFolder; after openGate -> ok, folder 'named'
test('no document text appears in any MCP message of a backup or restore', ...);
//   transport onmessage recorded as in the integration test; no message contains 'WIRETAP-MARKER-7f3a'
test('delete_backup moves the file to the recycle bin, and a second delete is BACKUP_NOT_FOUND', ...);
//   real trash; fs.existsSync(file) false; result { file, trashed: true } <= 128 B
test('a dry run of the largest pack reports its documents and bytes', ...);
//   the pack with the most index entries in game.packs; backup_documents { pack, dryRun: true, timeoutMs: 300000 };
//   annotate documents, bytes and elapsed ms
```

  Every backup file a test makes is trashed by `delete_backup` in its `finally`.
- [ ] **Step 2: Run.** Confirm no TITAN e2e run is active, then `npx playwright test tests/e2e/backupTools.spec.js`.
  Expected: 7 passed, the global teardown reports a zero Wiretap census, every gate and the setting restored. Then
  `npm run build`.
- [ ] **Step 3: Report a defect** the spec exposes: log it in `docs/OPEN_BUGS.md` and stop the lane. A fix in a
  buddy-checked file (Tasks 2, 3, 4, 6, 8) is a high-risk change, so the controller takes it to the owner; the spec
  itself is fixed only where the spec, not the code, is wrong. A defect in Task 5's or Task 7's files is fixed with a
  unit test in that task's test file and moved to `docs/CLOSED_BUGS.md`.
- [ ] **Step 4: Measure.** Report the dry run's documents, bytes and elapsed time, and the time 64,000,000 bytes of
  export would take at that rate (Inferred). Over 300,000 ms: stop and report.
- [ ] **Step 5: Verify.** `npm test`, `npm run typecheck`, `npm run eslint`, the Step 2 command. Expected: all pass.
- [ ] **Step 6: Commit** `test(e2e): back up, restore and trash on the live world`.

---

### Task 12: Tracking files, skills and the knowledge graph

The user asked for M21; `.claude/CLAUDE.md` makes the documentation step part of every plan ("a plan is not complete
until this is done"). This task brings every tracking file and skill to the state the code is in now.

**Files:**
- Modify: `docs/PROGRESS.md`: the M21 row in "Milestone completion" (status Done, date, commit hashes) and an
  "As-built notes: M21" section with the `trash` version and Node version (Task 1), the definition sizes and total
  (Task 9), the throughput and bound numbers (Tasks 10 and 11, labelled Inferred where extrapolated), the e2e results,
  and every line of "Designer decisions" above. The "Next milestone" line names M18.
- Modify: `docs/PLAN.md` M19 only (it stays forward-looking): line 832 "expired entries are overwritten, never
  deleted" becomes "expired entries are overwritten; a file is removed only through the recycle bin (D34)"; line 837
  "no deletion API" becomes "no permanent-delete API (D34)". The §5 preamble, M18 and the §4.6 gate row already carry
  D34 and the gate.
- Modify: `docs/TODO.md`: add "Whole-world backup (a later option; M21 backs up lists and groups only)"; delete any
  item M21 completed.
- Modify: `docs/OPEN_BUGS.md`, `docs/CLOSED_BUGS.md`, `docs/POST_WORK_FINDINGS.md` as the run touched them.
- Modify: `README.md`: the four tools and their arguments; where backups go (the default folder, the Backup folder
  setting, a named folder behind the gate); that a restore is not atomic, runs hooks, and needs the write gates;
  the "Settings and risk gates" rows for `allowBackupAnyFolder` and `backupFolder`; the recycle-bin rule and its
  limit (a sidecar running as the Windows SYSTEM account sends files to that account's recycle bin, per the `trash`
  README); that a whole-world backup is made on Foundry's setup screen with the world shut down.
- Check: `lang/en.json` holds the Task 1 texts; `skills/wiretap/SKILL.md` matches the shipped tools (Task 9).
- Modify skills to the current code: `.claude/skills/wiretap-codebase-core/SKILL.md` (line 57 rule becomes the D34
  recycle-bin rule; the subsystem map gains backups), `.claude/skills/wiretap-build-test/SKILL.md` (lines 37 and 70:
  the D34 rule, `noPermanentDelete.test.js`, `fakeTrash`; the new test files), `.claude/skills/wiretap-sidecar/
  SKILL.md` (line 58: the D34 rule; protocol 5), `.claude/skills/wiretap-mcp-bridge/SKILL.md` (the built-in tool list,
  the router's `prepare` / `onSent` / `replyWaitMs` / `snapshot`, the piece events), `.claude/skills/wiretap-client/
  SKILL.md` (`backupFolder`, the piece channel, the op invocation argument), `.claude/skills/wiretap-writes/SKILL.md`
  (`prepareReplace` / `runReplace` and restore mode), `.claude/skills/wiretap-scripts/SKILL.md` (`exportForBackup`;
  the user-facing skill), `.claude/skills/wiretap-mcp-sessions/SKILL.md` (built-ins registered per session).
  `wiretap-build-test` and `wiretap-sidecar` are near 20,000 characters: put new detail in their `references/` files
  and keep a pointer in `SKILL.md`.
- Create: `.claude/skills/wiretap-backups/SKILL.md` (a new subsystem: the store, the tools, the transport, export and
  restore), with `paths:` `server/backups.ts`, `server/backupTools.ts`, `shared/backup.js`, `shared/bridgeSettings.js`,
  `src/bridge/backup/**`, `src/bridge/pieces.js`, `src/bridge/bridgeSettings.js`, `src/settings/bridgeSettings.js`
  and their tests; add its row to the skill table of `.claude/CLAUDE.md` and to the core skill's subsystem map.

- [ ] **Step 1: Write** the updates above. Skills describe the current code only, read from the code, not a
  changelog.
- [ ] **Step 2: Measure** every `SKILL.md` touched or created: each stays below 20,000 characters.
- [ ] **Step 3: Run** `graphify update .`. Expected: completes without error.
- [ ] **Step 4: Verify.** `npm test` (the skill-mention checks of `contextBudget.test.js` and `shippedSkill.test.js`
  read `skills/**`). Expected: pass.
- [ ] **Step 5: Commit** `docs: close M21; progress, README and skills`.
