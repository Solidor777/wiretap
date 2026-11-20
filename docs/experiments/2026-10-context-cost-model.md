# Context cost model measurements (planning session)

Moved from `docs/PLAN.md` section 2.1. Evidence labels: MEASURED (command or run named), INFERRED (not verified). "MEASURED (coord.)" = measured by the coordinator's experiment agents in the planning session (claude 2.1.296).

## Method and results

**Method (MEASURED (coord.), 2026-10-10).** A throwaway loopback MCP server in the session scratchpad (raw
JSON-Schema tools, canned results, `@modelcontextprotocol/sdk` 1.29.0 from the repo's `node_modules`, stateless like
`server/mcp.ts`) was driven by `claude -p --model haiku --output-format stream-json --verbose --strict-mcp-config
--mcp-config <cfg>` (claude 2.1.296; the run reports model `claude-haiku-5-5`). Six invocations (R1–R6). Context per
turn = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of each assistant message; the delta
between consecutive turns = the previous `tool_use` block plus its result. Payloads came from real dnd5e pack sources
(`Data/systems/dnd5e/packs/_source`, YAML → minified JSON) as a stand-in for a canonical actor export; titan exports
were not measured (M0 E9). Each figure is one run; token counts depend on input only, but only this one model's
tokenizer was measured.

| Item | Bytes | Context tokens | Run |
|---|---|---|---|
| Session baseline in this environment, 1 MCP tool | — | 44,216 | R1 |
| 16 MCP tools, none loaded (deferred) | 6,507 of schema not sent | 44,399 (+183, ≈12 per tool) | R2 vs R1 |
| 40 MCP tools, none loaded (deferred) | 12,717 of schema not sent | 44,736 (+337 for 24 more, ≈14 per tool) | R3 vs R2 |
| Load 16 core + meta schemas (one ToolSearch) | 6,507 | +3,113 (≈195 per tool) | R6 |
| Load 24 per-script schemas (one ToolSearch) | 6,210 | +3,542 (≈148 per tool) | R6 |
| Load 3 schemas (`get_document`, `run_script`, `update_documents`) | ≈1,500 | +801 | R4 |
| Smallest round trip: `element_size` numbers | 71 | +172 | R4, R5 |
| Ack-only write result | 84 | +172 | R4 |
| Projected view (10 fields) | 301 | +266 | R4 |
| Compact view (id, name, type, 31 item tuples) | 1,484 | +1,037 | R4 |
| Full export, median dnd5e humanoid monster (of 40) | 18,343 | +8,954 | R5 |
| Full export, median dnd5e premade hero (of 12; 31 items) | 84,564 | Not delivered: Claude Code replaced it with a 1.7 KB "exceeds maximum allowed tokens; output saved to file" notice (+895) | R4 |
| Screenshot PNG 800×600 (596 KB base64) | — | +972 | R5 |
| Same layout question answered as numbers | 71 | +172 | R5 |

Byte sizes of the sources (MEASURED (coord.), `payloads.mjs` in the scratchpad): dnd5e heroes min/median/max 56,966 /
84,564 / 118,811 bytes; dnd5e `monsters/humanoid` 8,587 / 18,343 / 85,190 bytes. Drafted core tool definitions:
170–787 bytes each, 5,729 bytes for 13.

Path-scoped slices of the same two documents (MEASURED (coord.) 2026-10-11, `pathsizes.mjs`, bytes of minified JSON;
tokens ≈ bytes / 2, INFERRED from the ratio below):

| Path | Median hero | Median monster |
|---|---|---|
| (whole document) | 84,564 | 18,343 |
| `items` | 77,115 (91 %) | 12,247 (67 %) |
| `system` | 5,817 | 4,522 |
| `system.skills` | 1,981 | 1,981 |
| `system.attributes` | 696 | 641 |
| `system.abilities` | 468 | 468 |
| `system.attributes.hp` | 86 | 62 |
| `prototypeToken` | 1,149 | 1,135 |
| One embedded item, median of the actor's items | 2,113 (31 items, max 17,615) | 1,756 (7 items) |

**Shipped-surface calibration table (MEASURED 2026-10-11, `npx tsx tests/measure/measureContext.mjs`):** moved to
[`docs/PROGRESS.md`](PROGRESS.md) (section "M13 calibration"); the budgets it is held to are §2.6.
