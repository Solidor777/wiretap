# Wiretap documentation index

Living documents are updated as the work changes; historical records are kept as written and are not edited to track
the current code (the `wiretap-*` skills under `.claude/skills/` describe the current code).

## Living documents

| File | Contents |
|---|---|
| [`PLAN.md`](PLAN.md) | Forward-looking plan: goals, context-budget design, decisions log, architecture, risk gates, milestone specifications, risks, deferrals. |
| [`PROGRESS.md`](PROGRESS.md) | Work history: milestone completion table (dates, commits, results), M0 outcomes and deviations, calibration results, plan revision history. |
| [`TODO.md`](TODO.md) | Deferred-work backlog. Bugs never go here. |
| [`OPEN_BUGS.md`](OPEN_BUGS.md) | Currently open bugs. |
| [`POST_WORK_FINDINGS.md`](POST_WORK_FINDINGS.md) | Gotchas and anomalies found in post-work review. Not a to-do list. |

## Historical records

| Path | Contents |
|---|---|
| [`CLOSED_BUGS.md`](CLOSED_BUGS.md) | Fixed bugs with their cause, fix and measurements. |
| [`specs/`](specs/) | Design specs, one per feature (dated `YYYY-MM-DD-wiretap-<topic>-design.md`); the source for the matching plan. |
| [`plans/`](plans/) | Step-by-step implementation plans written from the specs (dated `YYYY-MM-DD-wiretap-<topic>.md`). |
| [`experiments/`](experiments/) | Measured results of experiments and live checks: `2026-10-m0-results.md` (M0, Foundry behaviour), `2026-10-m3-results.md` (M3, live MCP sessions with `claude`). |
