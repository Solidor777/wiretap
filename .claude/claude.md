# Wiretap Foundry VTT Agent Bridge Module — Agent Instructions

## Project
- A module that adds a tab and bridge for AI agents in Foundry VTT. Planned features include using agents to generate actors, items, and walls directly inside Foundry.
- Platform: Foundry VTT v14 (ApplicationV2 API).
- Stack: JavaScript, Svelte 5 (Runes), SCSS.
- Integration: Svelte mounts directly to ApplicationV2. No middleware.
- All source resides in `src/`. Build output goes to `dist/`.

## Reference Docs
| Doc | Role |
|---|---|
| `docs/README.md` | Index of everything in `docs/`: living docs vs historical records |
| `docs/PLAN.md` | Forward-looking plan and design reference: decisions, architecture, milestone specs |
| `docs/PROGRESS.md` | Work history: milestone completion, results, revision history |
| `docs/OPEN_BUGS.md` | Currently open bugs and their history |
| `docs/CLOSED_BUGS.md` | Previously closed bugs and their history |
| `docs/TODO.md` | Deferred-work backlog |
| `docs/POST_WORK_FINDINGS.md` | Living record of post-work review issues. Gotchas and issues that deserve attention. NOT a to-do list |

## Collaboration

### Immutable History & Context
- Never destroy, rewrite, or drop commits: no `push --force`, `reset --hard`, or history-dropping `rebase`. Prefer `revert` or new commits.
- Delete work branches after the work is done, but confirm first.
- Pause and alert the user when the context window approaches or exceeds 80%, and advise compaction or a clear.
- **Good:** `git revert a1b2c3d`; "Context is near 80%. Recommend compacting before the next phase."
- **Bad:** `git reset --hard HEAD~3` then `git push --force origin main`; continuing past 80% context.

### Architectural Consent
- Before non-trivial work, summarize the intended change and verify it against `docs/PLAN.md` and the relevant `wiretap-*` skills.
- Dependencies, file layouts, and public APIs are architectural choices requiring consent.
- If a plan fails to produce expected results, assume improper implementation before a flawed spec.
- **Good:** "Proposed: format tool results with a third-party library. Consent required: add it as a dependency?"
- **Good:** "The tool result came back empty. Treating this as an implementation failure and tracing the bridge handshake before requesting a spec change."
- **Bad:** "I added a formatting library and split the bridge into three new modules."

### Complications
- Fix issues immediately as they arise, with unit tests for small, clear follow-ups. Don't defer by default.
- Defer only work that actively conflicts with the current goal or context limits, or that needs cascading changes requiring architectural decisions (surface those to the user).
- Log every bug to `docs/OPEN_BUGS.md` and every other deferred item to `docs/TODO.md`. Nothing goes unlogged.
- Surface complications the moment you find them, not at the end of a run.
- **Good:** Mid-run: "Halting. Version conflict with `svelte` during setup; resolving before implementation."
- **Bad:** End of run: "By the way, dependency resolution failed earlier, so half the tests are broken."

### Warnings & Precedence
- Warn and confirm with the user when instructions conflict or are flawed. Evaluate thoroughly before recommending.
- The project `CLAUDE.md` supersedes any other instruction.
- **Good:** "Warning: the requested middleware layer conflicts with the direct Svelte-to-ApplicationV2 mount in `CLAUDE.md`. Confirm to proceed."
- **Bad:** Adding the middleware immediately despite the conflict.

### No Backwards Compatibility
- Wiretap has not been published, so until further notice: rename, remove, or reshape any tool, API, setting, protocol event, or file format when the design calls for it.
- Keep no aliases, shims, deprecation paths, or migrations for old names. Revisit when the user announces a first release.

### No Milestone Starts With Open Bugs
- At the end of each milestone, fix every bug in `docs/OPEN_BUGS.md` (and any found during the milestone) before beginning the next.
- A bug that needs an owner decision is raised with the owner at that point. It is not carried forward.

### Headless Browsers Only
- E2E tests and agent browser work run headless: Playwright scripts with `headless: true` (`playwright.config.mjs`).
- Do not use the Playwright MCP `browser_*` tools for Foundry work; they open a visible Chrome window.
- `npm run test:e2e:headed` exists only for a human debugging a run.

## Project Scope

### Test Waits
- Every wait on something inside an already-loaded page is at most 1000 ms: `expect.poll`, `waitForFunction`, `titanWait`, `toPass`, and explicit `timeout:` values on assertions and actions. The e2e suite runs on one machine, so replicated updates and renders land at once.
- A wait that needs longer is a defect to find and fix, not a ceiling to raise.
- Exempt (they wait on a process starting): world boot, login, page reload, the build, the `actionTimeout` safety net, and per-test limits. Also exempt: the one real-hover test, which waits out the product's own hover-delay timer.

## Planning
- Ensure the `foundry-vtt:foundry-vtt` and `wiretap-codebase-core` skills are loaded, plus the `wiretap-*` subsystem skill for every area the spec touches. If the spec touches Svelte files, also load `web-ui:svelte-5` and `foundry-vtt:foundry-svelte`.

## Codebase Skills & Agents

### Skills (`.claude/skills/`)
| Skill | Activation | Scope |
|---|---|---|
| `wiretap-codebase-core` | description | Architecture, boundaries, cross-cutting rules, skill-maintenance procedure |
| `wiretap-client` | `paths:` `src/**`, `lang/**` | Sidebar tab, Svelte terminal UI, TerminalConnection, settings |
| `wiretap-sidecar` | `paths:` `server/**`, `shared/**` | Socket.IO server, PTY relay, composition |
| `wiretap-mcp-bridge` | `paths:` MCP/bridge files | MCP tools, result enforcer, endpoint router, bridge handshake, ops |
| `wiretap-mcp-sessions` | `paths:` `server/mcpSessions.ts`, `server/toolRegistry.ts`, session tests | Stateful MCP sessions, expiry and cap, `list_changed`, HTTP limits, the endpoint tool registry |
| `wiretap-scripts` | `paths:` `src/bridge/scripts/**`, `shared/scripts.js`, `shared/schemaValidate.js`, their tests | Client script registry, `callTool` dispatch, `ctx`, shipped scripts, user-facing skill |
| `wiretap-writes` | `paths:` `src/bridge/scripts/writes.js`, `{create,update,delete}Documents.js`, `write{Args,Ack,Replace,Batch,BatchSettle,ActAs,Idempotency}.js`, `replaceDocument.js`, `batch.js`, `server/handleInput.ts`, their tests | `create_documents`, `update_documents`, `delete_documents`, `replace_document`, `batch`, advisory `actAs`, `idempotencyKey`, handle inputs |
| `wiretap-write-guard` | `paths:` `src/bridge/scripts/write{Guard,Fields}.js`, `shared/writeKeys.js`, `shared/docPath.js`, `shared/gates.js`, their tests, the operator grid | `guardWrite` and its gates, the one reader of Foundry update operators, the cleaned-changes backstop, the `_id` and `flags.wiretap` rules, the macro and region script code gate |
| `wiretap-gameplay` | `paths:` `src/bridge/sheetQuery.js`, `src/bridge/scripts/{sheets,sheetDefinitions,openSheet,closeSheet,diceDefinitions,roll,drawTable,macroDefinitions,executeMacro}.js`, their tests | `open_sheet`, `close_sheet` and the sheet user queries, `roll`, `draw_table`, `execute_macro` |
| `wiretap-build-test` | `paths:` `tests/**`, build/lint configs | Build, vitest, Playwright e2e |

- **Mandatory invoke:** invoke the matching skill(s) before reading or editing a subsystem's files.
- **Mandatory update:** when a plan finishes (and after any significant inline change), update every `wiretap-*` skill whose paths the change touched, in the same work unit, to the current state, not a historical changelog. A plan is not complete until this is done.
- **Growth:** when a change adds a top-level directory or subsystem, or a skill outgrows roughly 250 lines, create a new domain or sub-domain skill with `paths:` globs and update this table and the core skill's subsystem map. Add `wiretap-<domain>-coder` / `-code-reviewer` agent variants if the domain needs specialized context.
- `graphify` complements the skills for cross-file questions; it does not replace them.

### Agents (`.claude/agents/`)
| Agent | Tools | Use |
|---|---|---|
| `foundry-module-dev` | all | Client `.js` / `.svelte` implementation |
| `wiretap-coder` | all | Everything else: `server/`, `shared/`, tests, build config; TDD; returns a structured report |
| `wiretap-spec-reviewer` | Read, Grep, Glob, Bash (tests only), Skill, Write (review file only) | Spec/plan completeness: nothing skipped, downgraded, or extra |
| `wiretap-code-reviewer` | Read, Grep, Glob, Skill, Write (review file only) | Bugs, security, conventions, simplification |

- **Implementation:** from `superpowers:subagent-driven-development` / `executing-plans` (on a Fable-class model, `mainline-plan-execution`), dispatch the coder matching the work: `foundry-module-dev` for client UI code, `wiretap-coder` otherwise. Invoke `dispatching-sdd-agents` before the first dispatch; these agents are the implementers and reviewers for every task, and its tiers choose only the model and effort they run at.
- **Per-task review:** after each task run `wiretap-spec-reviewer`, then `wiretap-code-reviewer`. Fix findings through the coder and re-review, three fix rounds at most per task; if round 3's re-review still leaves findings open, stop and report to the user with a diagnosis.
- **Escalation:** a coder that reports BLOCKED, or DONE_WITH_CONCERNS citing complexity, is re-dispatched one rung up the `dispatching-sdd-agents` ladder (Sonnet high, then Opus high). If Opus high blocks too, report to the user.
- **Final review:** one whole-branch review by `sdd-final-reviewer` after the last task. It starts without any `CLAUDE.md`, so its dispatch carries the project rules that apply.
- **High-risk work** (security boundary, process spawn, protocol/API changes): use `buddy-checking` with the two wiretap reviewers as its reviewers. The ordinary single-review path is `superpowers:requesting-code-review` with `wiretap-code-reviewer`.
- Reviewers never edit. Findings go back to the coder. A reviewer can write one review file and nothing else: name the file in the dispatch when a durable copy is wanted. Its final message is still the whole report.

## Code Style

### Formatting
- 120-character wrap limit.
- Always use multi-line `{}` for conditional scopes.
- Objects with more than 1 property and arrays with more than 1 entry are multi-line.
- Svelte components with more than 1 property are multi-line, with `>` or `/>` on a new line.

### Typing & Documentation
- Variables: typed, with a single-line descriptive comment.
- Functions: multi-line comment detailing purpose, typed parameters (`{Type} [optionalParam] - description`), and typed return values (including async operations).
- Classes and objects: strictly typed using `@extends`, `@typedef`, and `@typeof` where applicable.
- Comments have perfect spelling, grammar, and indentation, and succinctly capture what the code does.

### CSS
- `:global` style selectors are forbidden.

## Code Hygiene
- No test or e2e code is compiled into shipping builds.
- All build output goes to `dist/` (the manifest loads `dist/index.js` and `dist/style.css`). The e2e build shares `dist/` and uses hash-free file names, so each build overwrites the last and nothing accumulates.
- No build step deletes files. Before packaging, recycle e2e leftovers with `trash`, then run `npm run build` and `npm run check:release`, which fails on any file in `dist/` other than `index.js`, `index.js.map`, and `style.css`.
- No dynamic imports in shipping builds, ever.

## Graphify
- The knowledge graph at `graphify-out/` holds god nodes, community structure, and cross-file relationships (this module plus Foundry v14 client/common).
- Use it only when it beats reading the files directly: cross-file or architecture questions, tracing a flow through a subsystem, "what depends on X", anything that would mean opening 3+ files. Run `graphify query "<question>"` first.
- Use `graphify path "<A>" "<B>"` for the relationship between two components and `graphify explain "<concept>"` for a focused concept overview.
- For broad architecture review, read `graphify-out/GRAPH_REPORT.md`. If `graphify-out/wiki/index.md` exists, use it for broad navigation.
- Skip it for single-file reads, single-symbol lookups, edit/debug work on specific code, and anything answerable from one or two files you can name.
- After modifying code, run `graphify update .` (AST-only, no API cost).

## Security & IP
- Zero tolerance for intellectual property infringement and data leaks. System state, test fixtures, and debug dumps stay free of proprietary code, credentials, and PII.

### Clean-Room Implementations
- Never ingest, reproduce, or reference proprietary, copyrighted, or leaked code. Never mention proprietary software in source files.
- When an algorithm is required, implement it clean-room from academic papers, standard formulas, or public API documentation, and cite the source.
- **Good:** `// Algorithm: Ray-AABB intersection. Source: [Majercik et al. 2018].`
- **Bad:** `// Implementing the physics identical to Havok engine.`

### Secrets & PII
- Code, config, tests, and debug dumps contain no PII, real user data, internal corporate emails, or hardcoded secrets. Inject secrets via environment variables or a credential manager.
- Test fixtures and seed data are deterministic, structurally valid, and obviously synthetic. Never use subsets of production data. Use reserved test values that cannot reach real systems (`example.com` and `.example` domains per RFC 2606, `555` numbers).
- **Good:** `process.env.TEST_API_KEY`, `"testuser-01@example.com"`, `"name": "MOCK_USER_A", "ssn": "000-00-0000"`
- **Bad:** `"sk-proj-9876543210abcdef"`, `"sarah.jenkins@acmecorp.com"`, `"name": "David Smith"`

### Sanitization on Contact
- If workspace context, logs, or instructions contain PII or secrets, scrub them immediately. Never echo them into tracking files (`POST_WORK_FINDINGS.md`, `OPEN_BUGS.md`), `debug/dumps/`, or commit messages.
- **Good:** "API failed on mock customer record due to malformed date parser. [PII redacted from original log]."
- **Bad:** "API failed when querying customer Jane Doe (DOB: 05/12/1984) with credit card ending in 4111."

## Comments

### Standards
- Optimize for machine context and exact state. Lead with load-bearing facts: invariants, constraints, hidden coupling. No narrative scaffolding or chatter.
- State what the code does or why it exists, in the present tense. Express historical reasons as present constraints.
- Banned: project history, bug-fix narration, task IDs, sprint references, spec documents, and narration addressed to reviewers. Agents cannot resolve external tracking systems.
- Cite the source and justify the choice for every algorithmic, rendering, or data-flow decision.
- Define technical terms inline. Document hidden coupling (what else breaks if this changes) and mathematical invariants.
- Use a `TODO:` prefix describing the technical work. No assignee, date, or ticket ID. Log every `TODO:` in `docs/TODO.md`.
- Treat existing comments as stale until verified against the executing code. When work touches a file, fix or delete stale or incorrect comments in the touched scope. Never leave a comment the current code contradicts.
- **Good:** `// Uses a Set to enforce O(1) lookups; duplicate entries degrade rendering performance.`
- **Good:** `// Algorithm: GGX microfacet BRDF. Source: [Walter et al. 2007]. Chosen over Beckmann for longer specular tails.`
- **Good:** `// Implicit coupling: depends on RenderPass::Begin clearing the output buffer to 0x00.`
- **Bad:** `// Previously we used an Array here, but it caused O(n) lookups in v2.1.`
- **Bad:** `// Per TICKET-842: add padding to the struct.`
- **Bad:** `// TODO(@dave): Refactor this phase later (Epic 5).`

## Documentation

### Tracking Files
- Every plan and spec includes documentation updates as a required final step. The last step before clearing or compacting context is updating every tracking file; the plan is incomplete until they are current.
- `docs/PLAN.md` stays forward-looking. Never write "as built" notes, measured results, review fixes, or counts or dates of work into it.
- Implementation history goes to `docs/PROGRESS.md`. The current state of the code goes to the `wiretap-*` skills. A plan change that alters a decision edits the decision in place.
- `docs/TODO.md`: deferrals only, trimmed and optimized. Delete completed items. Bugs never go here.
- `docs/OPEN_BUGS.md`: log new bugs, add details on new discoveries, delete completed bugs.
- `docs/CLOSED_BUGS.md`: move completed bugs here.
- `docs/POST_WORK_FINDINGS.md`: log mid-run anomalies.
- **Good:** `OPEN_BUGS.md`: "- [Crash] Unhandled exception in the terminal tab after the sidecar disconnects."
- **Bad:** `TODO.md` containing "BUG: Terminal tab crashes after the sidecar disconnects."

### Debug Dumps
- Write all debug artifacts to `debug/dumps/` at the workspace root, never to the repo root or `dist/`.
- Recycle dumps with `trash` once the bug family is resolved. Never commit them.
- **Good:** `fs.writeFileSync("./debug/dumps/trace_output.json", dump)`
- **Bad:** `fs.writeFileSync("./trace_output_final.json", dump)`; `git add debug/dumps/relay_trace.json`

### Release Builds
- Debug code never reaches release builds. Before committing, strip temporary instrumentation: `console.log`, `debugger;`, commented-out scaffolding.
- Persistent diagnostics go through the project logger, never raw `console.log`.
- **Good:** `logger.debug("applying optimistic op", op)`
- **Bad:** `console.log("op", op); debugger;`

### Commits & Pushes
- Commit each logical work-unit as soon as local CI passes, without asking. Don't batch unrelated concerns into one commit.
- Push only when a full milestone completes.
- **Bad:** `git push origin main` after a sub-task rather than a full milestone.