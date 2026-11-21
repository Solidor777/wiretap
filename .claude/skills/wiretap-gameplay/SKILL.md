---
name: wiretap-gameplay
description: Wiretap gameplay tools - open_sheet and close_sheet (with the wiretap.openSheet / wiretap.closeSheet user queries and their sender-is-GM and OBSERVER checks), roll and draw_table (toChat, result shaping within their budgets, TABLE_EMPTY), and execute_macro (allowMacroExecution, actorUuid / tokenUuid scope, timeoutMs, tooLarge and unserializable values, MACRO_FAILED). Use when reading or editing the sheet, dice or macro scripts, src/bridge/sheetQuery.js or their tests.
paths:
  - "src/bridge/sheetQuery.js"
  - "src/bridge/scripts/sheets.js"
  - "src/bridge/scripts/sheetDefinitions.js"
  - "src/bridge/scripts/openSheet.js"
  - "src/bridge/scripts/closeSheet.js"
  - "src/bridge/scripts/diceDefinitions.js"
  - "src/bridge/scripts/roll.js"
  - "src/bridge/scripts/drawTable.js"
  - "src/bridge/scripts/macroDefinitions.js"
  - "src/bridge/scripts/executeMacro.js"
  - "tests/unit/sheetQuery.test.js"
  - "tests/unit/openSheet.test.js"
  - "tests/unit/closeSheet.test.js"
  - "tests/unit/roll.test.js"
  - "tests/unit/drawTable.test.js"
  - "tests/unit/executeMacro.test.js"
  - "tests/integration/sheetTools.test.js"
  - "tests/integration/diceTools.test.js"
  - "tests/integration/macroTools.test.js"
  - "tests/e2e/sheetTools.spec.js"
  - "tests/e2e/diceTools.spec.js"
  - "tests/e2e/macroTools.spec.js"
---

# Wiretap gameplay tools

Current-state reference; verify against code before relying on a detail. Core context: `wiretap-codebase-core`; the
script runtime (registry, `callTool`, `ScriptError`, `resolveDocument`, `unreadable`) is in `wiretap-scripts`; the
write gate on macro and region script code is in `wiretap-write-guard`. Foundry version read: 14.364.

Five shipped scripts, registered by `SHIPPED_SCRIPTS` in `src/bridge/scripts/index.js`. Their definitions live in one
file per family (`sheetDefinitions.js`, `diceDefinitions.js`, `macroDefinitions.js`), not in `definitions.js`; each
imports only through relative paths so the `tsx`-run measurement can load it. Every input schema has
`additionalProperties: false`. All five are `requires: 'api'` (normal tools, not DOM tools).

| Tool | `mutates` | Gate | Result budget (`shared/budgets.js`) | Listed definition (MEASURED) |
|---|---|---|---|---|
| `open_sheet` | false | none | `SHEET_RESULT_MAX_BYTES` 128 | 370 B |
| `close_sheet` | false | none | `SHEET_RESULT_MAX_BYTES` 128 | 363 B |
| `roll` | true (can post a ChatMessage) | none | `ROLL_RESULT_MAX_BYTES` 512 | 368 B |
| `draw_table` | true (marks results drawn) | none | `DRAW_RESULT_MAX_BYTES` 1000 | 358 B |
| `execute_macro` | true | `allowMacroExecution` | `RESULT_HARD_CAP_MAX_BYTES` (results over 8,000 B become a handle) | 488 B |

Sizes from `npx tsx tests/measure/measureContext.mjs`. The error codes these scripts add: `SHEET_UNAVAILABLE`,
`SHEET_DENIED`, `USER_OFFLINE`, `SHEET_QUERY_FAILED`, `TABLE_EMPTY`, `MACRO_FAILED`.

## Files

| File | Role |
|---|---|
| `src/bridge/scripts/sheets.js` | `renderSheet(document)`, `closeSheet(document)` on this client; `remoteUser(userId)`, `askUser(user, queryName, uuid, isSuccess)`: the cross-user path; `boundAppId`, `APP_ID_MAX_BYTES` (100), `SHEET_QUERY_TIMEOUT_MS` (5000) |
| `src/bridge/sheetQuery.js` | `OPEN_SHEET_QUERY` (`wiretap.openSheet`), `CLOSE_SHEET_QUERY` (`wiretap.closeSheet`), `handleOpenSheetQuery`, `handleCloseSheetQuery`, `registerSheetQueries()` (called by `hooks/OnceInit.js` on every client) |
| `src/bridge/scripts/sheetDefinitions.js` | `openSheetDefinition`, `closeSheetDefinition`: one shared schema `{ uuid, userId? }` (`userId` `maxLength` 16) |
| `src/bridge/scripts/openSheet.js`, `closeSheet.js` | `openSheetHandler`, `closeSheetHandler` |
| `src/bridge/scripts/diceDefinitions.js` | `rollDefinition` (`{ formula (maxLength 256), toChat? }`), `drawTableDefinition` (`{ uuid, toChat? }`) |
| `src/bridge/scripts/roll.js`, `drawTable.js` | `rollHandler`, `drawTableHandler` and their result shaping |
| `src/bridge/scripts/macroDefinitions.js` | `executeMacroDefinition` (`{ uuid, actorUuid?, tokenUuid?, timeoutMs? }`, `timeoutMs` an integer 1000 to 300,000) |
| `src/bridge/scripts/executeMacro.js` | `executeMacroHandler` |

## Sheets (`open_sheet`, `close_sheet`)

- Both handlers resolve the document (`resolveDocument`), refuse an `unreadable` one (`DOC_EXCLUDED`), then pick the
  client: `remoteUser(userId)` returns null for no `userId` or this client's own user (the sheet acts on the client
  running the call), throws `ARGS_INVALID` for an unknown user and `USER_OFFLINE` (naming the user, bounded) for one
  with `active !== true`. Nothing is ever broadcast.
- Local: `renderSheet` calls `sheet.render({ force: true })` and succeeds only when `sheet.rendered === true` (Foundry's
  `render` resolves without rendering when its own permission check fails), else `SHEET_UNAVAILABLE`; no sheet at all
  is `SHEET_UNAVAILABLE` too. The result is `{ ok: true, appId }`. `closeSheet` closes a rendered sheet and returns
  `{ ok: true, closed: boolean }`.
- Remote: `askUser` sends `user.query(queryName, { uuid }, { timeout: SHEET_QUERY_TIMEOUT_MS })` and races it against
  its own 5 s timer, because the server may never answer a query whose target disconnects as it is sent; 5 s stays
  under the 8 s script limit, so the agent sees `SHEET_QUERY_FAILED`, not `SCRIPT_TIMEOUT`. A rejection, the timer or a
  reply of neither shape is `SHEET_QUERY_FAILED`; a reply `{ ok: false, code, message }` whose code matches the script
  error code form is rethrown with that code and the message cleaned to 200 B. The remote `appId` is bounded again.
- `boundAppId` cleans control characters and cuts until the id's JSON form is at most 100 B, so `{ ok: true, appId }`
  stays within 128 B whatever the target client replies.
- Receiving side (`sheetQuery.js`): registered on players' clients too, because the receiver judges the request.
  Foundry lets players query users by default (`QUERY_USER`), so each handler first refuses a sender with
  `context.user?.isGM !== true` (`SHEET_DENIED`). The open handler also refuses unless this client's user has
  OBSERVER (`testUserPermission(game.user, 'OBSERVER')`), stricter than Foundry's LIMITED sheet threshold. The
  handlers never throw (Foundry passes a thrown error to the sender as text only): every outcome is an answer, an
  unexpected error `SHEET_UNAVAILABLE` with its text bounded to 200 B; a non-text uuid is `ARGS_INVALID`.
- Inferred from Foundry's per-user query: a sheet opens on every tab the target user has open (the user-facing skill
  says so; the first answer is reported).

## Dice (`roll`, `draw_table`)

- `roll`: a formula containing `@` is `ARGS_INVALID` (no data source, so a reference would silently become another
  value); `Roll.validate` false is `ARGS_INVALID` (formula echoed cleaned, 64 B); `evaluate({ allowInteractive: false })`
  (never waits on manual dice) that throws is `ARGS_INVALID` with the cause (200 B). `toChat: true` calls
  `roll.toMessage()`; otherwise nothing is posted. Result `{ total, formula (128 B), dice: [faces, active[],
  inactive[]?][] }`; when it is over 512 B, results are appended in order while they fit and `cut: true` is set (a
  term's entry is measured when added, so a term that rolls no dice, like `0d6`, is dropped when it does not fit; an
  inactive list appears only once its first value fits). MEASURED in e2e: 999d1000 fits with `cut`; 1000d6 is
  `ARGS_INVALID` (Foundry's evaluation refuses more than 999 results, and the throw becomes the refusal).
- `draw_table`: the uuid must resolve to a `RollTable` (`ARGS_INVALID` names the class otherwise). It calls Foundry's
  `table.draw({ displayChat: toChat === true })`, which marks drawn results when the table has no replacement and is
  not in a compendium. No results (every result drawn, or none in the formula's range; Foundry only warns) is
  `TABLE_EMPTY`. Rows are `{ name (64 B), text? (plain text of the description: tags to spaces, then character references decoded through a
  detached `<textarea>` so no markup runs, then whitespace collapsed; 200 B), uuid? }`; the
  result is `{ total (null without a roll), results, count }`, rows popped from the end with `cut: true` until it is at
  most 1000 B.

## Macros (`execute_macro`)

- Gate: the definition declares `gate: 'allowMacroExecution'`; the sidecar judges it on the endpoint's gate snapshot
  and `callTool` judges it again on this client before validation and before the handler.
- Every argument is resolved before the macro runs, so a refusal never leaves a macro half run: `resolveAs` checks the
  class (`ARGS_INVALID`: `<arg> '<uuid>' is a document of type X, not a Y.`, uuid cleaned to 64 B). A `tokenUuid` must
  have a canvas placeable (`tokenDocument.object`), which exists only on the scene this client views, else
  `ARGS_INVALID`. The scope `{ speaker, actor, token }` is passed to `macro.execute(scope)` only when one of the two is
  named; `speaker` is `ChatMessage.implementation.getSpeaker({ actor, token })`, so a chat macro speaks as the named
  actor. With only `tokenUuid`, Foundry gives the macro `token.actor` (MEASURED in e2e: for an unlinked token, the
  synthetic actor with the token's name).
- `MACRO_FAILED`: a synchronous throw from `execute` means the command did not compile and nothing ran (`Macro#execute`
  builds the function first); a rejection means it threw while running and may have partly run. The cause is bounded
  to 200 B.
- Value shaping (`shapeValue`), never an error because the macro already ran: a Document becomes its uuid, `undefined`
  becomes null, a value `JSON.stringify` cannot serialize (cycle, BigInt, function) gives `value: null,
  unserializable: true`, and a result whose envelope plus value JSON would exceed `RESULT_WIRE_MAX_BYTES` (900,000, the
  `callTool` wire bound) gives `value: null, tooLarge: true, bytes`. The user-facing skill warns that `tooLarge` alone
  does not show the macro worked.
- `timeoutMs` is the shared time-limit argument (`wiretap-scripts`, Dispatch): `callTool` runs the handler under it
  (default 8 s) and the sidecar waits `timeoutMs` + 2 s for the reply (`wiretap-mcp-bridge`). The handler does not read
  it. A macro may keep running after `SCRIPT_TIMEOUT`.

## Tests

- Unit: `sheetQuery` (sender and OBSERVER checks, never throwing, registration), `openSheet` and `closeSheet` (local
  and remote paths, refusals passed through, timer, bounded ids), `roll` (references, invalid formulas, `toChat`, the
  cut), `drawTable` (class check, `TABLE_EMPTY`, rows, the cut), `executeMacro` (scope, compile versus run failures,
  value shaping, `tooLarge`); `OnceInit` asserts both queries are registered for a player.
- Integration (`tests/integration/`, the sidecar with a fake GM client): `sheetTools`, `diceTools`, `macroTools`:
  annotations, arguments forwarded as a `callTool` op, schema refusals before anything is sent (a `userId` over 16
  characters, a formula over 256, an undeclared argument), and `execute_macro` forwarded only once the endpoint pushes
  `allowMacroExecution` open.
- e2e on the live world (`tests/e2e/`, harness in `wiretap-build-test`):
  - `sheetTools.spec.js` (4 tests): a GM page and a recorded player logged in through a second browser context; the
    GM tab without `userId`; the player's client only once the player has OBSERVER (NONE and LIMITED give
    `SHEET_DENIED`), then closed there; `USER_OFFLINE` for a recorded user who never logs in; the GM client refusing
    either query a player sends.
  - `diceTools.spec.js` (6): `roll` with and without `toChat`, a 999d1000 roll within 512 B with `cut`, 1000d6
    refused; `draw_table` from a recorded table marking the result drawn, `TABLE_EMPTY` once every result is drawn,
    `toChat`. A chat message gets the `Wiretap E2E ` flavor in a `preCreateChatMessage` hook and is recorded.
  - `macroTools.spec.js` (6): Macro code writes and `execute_macro` with the gate closed and open, a chat Macro changed
    to script denied, `MACRO_FAILED` within 512 B, `actorUuid` and `tokenUuid` on a recorded scene created with
    `active: false` (a scene created while none is active becomes active), whose prior view is restored.
- Budget fixtures for all five tools are in `tests/unit/contextBudgetHarness.js`.
