# Raw-socket boundary (option B) analysis

Moved from `docs/PLAN.md` section 4.3. Option B is a raw Socket.IO client that bypasses the Foundry client; it is not built (D27). Measured results: `docs/experiments/2026-10-m0-results.md`.

**Per-operation boundary rule (D1).** An operation class may use B only if all of these hold:

1. E2 shows a zero diff against the client path for every subtype in the reference world.
2. Invalid input is rejected (or handled identically) on B.
3. The runtime fingerprint (§4.5) shows no client hook or `_pre*` override for that document class.
4. The operation needs nothing client-only: plugins, sheets, derived data (incl. `derived: true` path reads), rolls,
   macros, user queries, scripts with `requires: 'dom'`.

Everything else uses A (or a human tab).

**Result of M0 E2 (MEASURED (coord.), `docs/experiments/2026-10-m0-results.md`):**

| Operation class | Rule 1 (diff) | Rule 2 (invalid input) | Rule 3 (fingerprint) | B-eligible |
|---|---|---|---|---|
| Read stored source (`modifyDocument get`, `world`, `getJoinData`) | — (source data; no derived values; raw-created documents have sparse `system`) | — | — | **yes** |
| Create Actor (`player` 9/21 diff paths client/stored, `npc` 6/17) | fail | fail (server stores invalid `system`) | titan Actor `_preCreate` | no |
| Create Item, 7 subtypes (1–2 / 8–14) and embedded Item (1–2 / 12) | fail | fail | titan Item `_preCreate` | no |
| Create embedded ActiveEffect, 3 subtypes (1–2 / 1) | fail | fail | titan AE `_preCreate` | no |
| Create Scene (0 Levels; `view()` throws) and other classes with a core `_preCreate` | fail | — | core `_preCreate` | no |
| Update a system field with a valid value (player, npc) | pass (0 / 0) | **fail** (wrong type and 2.5-in-integer stored as sent; live clients diverge) | Actor/Item: no `_preUpdate`; AE: `_preUpdate` | no |
| Unknown subtype | — | server rejects | — | n/a |
| Delete | not measured | not measured | Cards, ActorDelta `_preDelete` | no |

Replaying the client's exact emitted create payload over B matched the client result except `flags.titan`, so B adds
nothing when a client must build the payload anyway.
