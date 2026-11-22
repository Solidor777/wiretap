# The context-budget test

Part of the wiretap-build-test skill; read it before changing `tests/unit/contextBudget.test.js` or
`tests/unit/contextBudgetHarness.js`.

- `contextBudget` (the real MCP server in-process with a fake GM client and the SDK client: per-tool name, definition and description sizes, tool count and total definition size from `shared/budgets.js` (hard breaches fail, warn breaches are printed with `console.warn`), a representative-result fixture for every listed tool run through the real enforcer and held to its budget constant (the harness's fake GM always registers every shipped script (`shippedScripts()` of `scriptFixtures.js`: copies of the definitions of the sixteen shipped scripts; it identifies with `allowMacroExecution` open so the `execute_macro` fixtures measure a macro result, not the sidecar's denial) through `bridge:registry` before the session starts, because the sidecar has no built-in script, and `registerTools(entries)` sends them again beside the entries (the ack counts them; `contextBudget.test.js` derives its counts from `SHIPPED_COUNT` and `RESERVED_SCRIPT_NAMES.length`); the registry path is covered too: a tool registered by the fake GM through `bridge:registry`), over-cap result to handle <= 256 B and `read_handle` slices within the cap, and tool names mentioned as `mcp__wiretap__<tool>` (letters, digits, underscores, hyphens between runs; trailing punctuation excluded) in the server `instructions` or any `.md` under a module-level `skills/` directory (`skills/wiretap/SKILL.md` ships; a missing directory is a no-op; the two tool-count boundary tests pass a missing skills root so they test only the count) must be listed; the `instructions` length is held to `INSTRUCTIONS_MAX_CHARS` (600); the tool-count and total-size budgets count the real and test-registered tools but not the harness helper tool `mock_big_document` (`totals` vs `helperTotals`), which still meets the per-tool budgets and has a fixture; also asserted: `ERROR_MAX_FAILURES`, `RESULT_HARD_CAP_MAX_BYTES`, `PATHS_PER_CALL_MAX` through the SDK client; `startHarness({ tools, instructions, registry, backups })` also returns `gm` and `setGmHandler(handler)` (the fake GM answers with the handler's ack after what it emits; `setGmAck` drops the handler; the backup fixtures stream pieces through it, and each fails with the error text when any of its calls returns an error result, so none measures a refusal instead of the result it names), its `backups` default is a new `scratchRoot('harness')` with `fakeTrash(<root>/bin)`, and it closes the sidecar, GM socket, MCP server and client when setup fails; negative tests register oversized description, name, schema, a 31st tool, an oversized total, a missing fixture, an oversized fixture result and an instructions text over the limit or naming an unknown tool and a skill naming an unknown tool, in a test-local registry through the `tools` option and assert the exact failure text; the support code, fixtures (`FIXTURES`, keyed by tool name, synthetic `MOCK_` data) and `collectReport` live in `contextBudgetHarness.js`, which vitest does not collect).

The pack fixtures use `withFittedLabel(row)` of the harness, which gives an ack row the longest ASCII label that keeps
its JSON at exactly `ACK_MAX_BYTES` (the worst case of the handlers' label cut): `create_pack` "dry run with a
64-character name and a label cut to fit", `delete_pack` "dry run with the largest count and a long label"
(`documents: Number.MAX_SAFE_INTEGER`) and "locked pack" (a `PACK_LOCKED` error held to `ERROR_MAX_BYTES`).

Which fixtures run: `collectReport({ runFixtures })` takes true (every fixture, the default, used by
`tests/measure/measureContext.mjs`), false (none) or the names of the tools whose fixtures run. A listed tool without a
fixture is a failure in every mode. The test file's `reportWith(extraTools, extraFixtures, skillsRoot, instructions,
runFixtures)` and `reportOn(fixtures, runFixtures)` default to false. "keeps the listed production tools and their
fixtures inside every budget" is the one test that runs every production fixture, with a 10 s limit (MEASURED: 0.4 to
0.6 s alone, 1.7 to 4.2 s in a default-worker `npm test`). "fails a fixture result over its budget" and the registry
tests that check fixture results run only their own tools' fixtures. "checks that every tool has a fixture without
running any when fixtures are not run" covers the option. Why: the backup fixtures write and read real files under
`test/tmp/`, and in a full parallel run those steps slow far more than tool calls do (MEASURED: a backup's median 2.5
to 24 ms, a 50-header listing 35 ms to 2.7 s). Repeating every fixture in each report pushed tests past 5 s.

The `list_backups` fixture "the most rows the budget holds, cut" makes `LIST_FIXTURE_BACKUPS` (17) backups, one more
than the 16 rows that fit in `BACKUP_LIST_MAX_BYTES`. It throws unless the listing has `cut: true`, so a format or budget
change that lets every row fit fails loudly. Its result is 1,971 B, the same as with 50 backups (MEASURED).
