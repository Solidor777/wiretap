# M4 compact-view key-field lists: provenance (2026-10-13)

The reviewed lists are committed as `src/bridge/scripts/keyFields.json`: `{ "<system id>": { "<documentName>.<type>":
[<dotted path below system>] } }`. This record states how they were produced and what was changed in review. A system
or subtype without a list is shown by the default key-name pattern of `ctx.shape` (`DEFAULT_KEY_PATTERN`).

## Measurement (MEASURED)

- Command: `WIRETAP_MEASURE_KEYFIELDS=1 npx playwright test tests/e2e/keyFields.measure.spec.js` (headless; reads the
  live world, writes nothing to it; the rules are in the spec header).
- Run: 2026-10-13, world `test-titan`, system `titan`, Foundry on :30000. Output: `debug/dumps/keyfields-candidates.json`
  (the ranked candidates: 50 document/subtype pairs with a system data model) and `debug/dumps/keyfields-reviewed.json`
  (after the review filter: 32 lists).
- The reviewed output of the run is byte-identical to the committed `keyFields.json` (`diff` after removing carriage
  returns, MEASURED).

## Selection rules (applied to the blank in-memory export of each subtype)

1. Candidates are scalar leaves: numbers, booleans and strings whose blank value is non-empty and at most 24 bytes.
2. `documentVersion` leaves are dropped.
3. An object node with 8 or more object children (for example the `skill` table of an Actor) is skipped as a table of
   look-alike rows.
4. Candidates are ranked by depth, then schema order; the first 24 are kept.

## Review (what was changed)

- Leaves ending in `mod.static` were dropped: 23 leaves over `Actor.player` (11) and `Actor.npc` (12). They are static
  modifier bookkeeping that is 0 on a blank document and filled the Actor lists to 24 with noise.
- `RegionBehavior.*` was left out: the behavior subtypes are core-defined, not the system's.
- Subtypes with no remaining leaf (for example `ActiveEffect.condition`, `ChatMessage.shortRestReport`) get no list.
- Not changed: the order of the paths, the 24 limit, the `ChatMessage` lists (system-defined; kept as generated).

## Result sizes on the live titan world (MEASURED, `tests/e2e/readTools.spec.js`)

| Document | Compact bytes |
|---|---|
| Actor `player` (existing, 4 embedded items) | 999 |
| Actor `npc` (existing) | 585 |
| Actor created by the e2e with 10 items | 1,191 |
| Item `armor`, `ability`, `weapon`, `spell` (embedded) | 211, 241, 219, 377 |
| ActiveEffect `effect` | 231 |
| Scene | 429 |
| Playlist, PlaylistSound, Folder, Level, Token, Setting, User | 161, 83, 105, 71, 82, 60, 75 |

Every value is below the 2,000-byte budget. `list_document_types` returned 1,522 bytes (budget 3,000). The subtypes the
world holds no document of are covered only by the synthetic bound test in `tests/unit/getDocument.test.js`
(`docs/TODO.md`).
