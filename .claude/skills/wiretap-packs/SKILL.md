---
name: wiretap-packs
description: Wiretap compendium pack tools - create_pack and delete_pack (src/bridge/scripts/packDefinitions.js, packCommon.js, createPack.js, deletePack.js), the order of their checks, the gate checked on a real run only, the codes ARGS_INVALID, PACK_NOT_FOUND, PACK_LOCKED and GATE_DENIED, the 256-byte ack bound with the label cut, the Foundry calls createCompendium and deleteCompendium, the requiresUserInteraction flag of delete_pack, and their tests. Use when reading or editing the pack scripts or their tests.
paths:
  - "src/bridge/scripts/packDefinitions.js"
  - "src/bridge/scripts/packCommon.js"
  - "src/bridge/scripts/createPack.js"
  - "src/bridge/scripts/deletePack.js"
  - "tests/unit/packDefinitions.test.js"
  - "tests/unit/packCommon.test.js"
  - "tests/unit/createPack.test.js"
  - "tests/unit/deletePack.test.js"
  - "tests/integration/packTools.test.js"
  - "tests/e2e/packTools.spec.js"
---

# Wiretap compendium pack tools

Current-state reference; verify against code before relying on a detail. Core context: `wiretap-codebase-core`; the
script runtime (registry, `callTool`, `ScriptError`, argument validation) is in `wiretap-scripts`; the
`requiresUserInteraction` flag and the sidecar's `_meta` entry are in `wiretap-mcp-sessions`; the gates are in
`wiretap-write-guard`; the e2e running list's pack entries are in `wiretap-build-test`
(`references/e2e-pack-registry.md`).

Both tools are shipped client scripts (`SHIPPED_SCRIPTS` in `src/bridge/scripts/index.js`), run on a GM client only
(the bridge runs scripts on GM clients, so the handlers make no `isGM` check), and act only on world packs.

## Files

| File | Role |
|---|---|
| `packDefinitions.js` | `createPackDefinition`, `deletePackDefinition`; relative imports only, so the `tsx`-run measurement loads them through `tests/unit/scriptFixtures.js` |
| `packCommon.js` | `requireOpenGate(name)`: `requireGate` of `src/bridge/gates.js` from this client's world settings, throws `ScriptError(GATE_DENIED, <denial text naming the gate>)` while closed (an unreadable gate is closed). `fitPackAck(row)`: holds an ack row to `ACK_MAX_BYTES` (256) |
| `createPack.js` | `createPackHandler(args, ctx)` |
| `deletePack.js` | `deletePackHandler(args, ctx)` |

## Definitions

Both are `version: '1.0.0'`, `requires: 'api'`, `mutates: true`, `result.budgetBytes` = `ACK_MAX_BYTES` (256),
`additionalProperties: false`, and declare **no `gate`**: the `callTool` dispatcher judges a definition gate before
the handler, which would block the dry run, so each handler checks its gate itself on a real run only.

- `create_pack`: `label` (string, 1 to 128 characters, required), `type` (string, required; unbounded in the schema,
  checked against `CONST.COMPENDIUM_DOCUMENT_TYPES` in the handler, which lists fewer bytes than an enum), `name`
  (string, 1 to 64 characters), `dryRun` (boolean). Listed size 500 B.
- `delete_pack`: `id` (string, 1 to 128 characters, required), `dryRun` (boolean), and `requiresUserInteraction: true`,
  so the sidecar lists it with `_meta: { 'anthropic/requiresUserInteraction': true }` (the sidecar forces it for the name
  `delete_pack` too, through `USER_INTERACTION_TOOLS` of `shared/scripts.js`). The description says it is irreversible.
  Listed size 404 B.

## `create_pack` (`createPack.js`), checks in order

1. A real run (`dryRun !== true`): `requireOpenGate('allowCompendiumWrites')` before anything else, so a closed gate
   reveals nothing about the world's packs. A dry run skips the gate.
2. `label.trim() === ''`: `ARGS_INVALID` "label must not be blank."
3. `type` not in `CONST.COMPENDIUM_DOCUMENT_TYPES`: `ARGS_INVALID` naming the allowed list and the given type
   (`cleanForLog`, 64 B).
4. `name = args.name ?? label.slugify({ strict: true })` (Foundry's own slug, the server's default), then `checkName`:
   empty (a label with no letters or digits) is `ARGS_INVALID` "...give a name." (Foundry would pick
   `<type>-<randomID>`, which a dry run could not report); over 64 characters (`PACK_NAME_MAX_CHARS`, derived or
   given); not matching `PACK_NAME_PATTERN` `/^[A-Za-z0-9-_]+$/`; or matching `RESERVED_NAME_PATTERN`
   `/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i`. Both patterns are copies of Foundry's `BasePackage.validateId`
   (`common/packages/base-package.mjs:583-590`), which is not exposed to modules. Echoed names go through
   `cleanForLog` at 64 B.
5. Collision: `id = world.<name>`; any key of `game.packs` equal to `id` ignoring case is `ARGS_INVALID`
   "The pack <existing id> already exists." The server compares names with case but stores the pack in
   `packs/<name>`, and Windows folder names ignore case. A system or module pack of the same bare name is not a
   collision (its id has another prefix).
6. Dry run: returns `fitPackAck({ dryRun: true, id, label, type })`; nothing is created.
7. Real run: `foundry.documents.collections.CompendiumCollection.createCompendium({ label, type, name })`, then
   `fitPackAck({ id: pack.collection, label: pack.metadata.label, type: pack.documentName })`.

Every refusal is made before Foundry is called, so it shows no error notification on the GM screen.

## `delete_pack` (`deletePack.js`), checks in order

1. A real run: `requireOpenGate('allowPackDeletion')` before any pack lookup. A dry run skips the gate.
2. `game.packs.get(args.id)` undefined: `PACK_NOT_FOUND` "No pack with that id. Id: '<id, cleanForLog 64 B>'."
3. `pack.metadata.packageType !== 'world'`: `ARGS_INVALID` "Only world packs can be deleted." (`deleteCompendium`
   sends the bare name and the server rebuilds `world.<name>`, `client/documents/collections/compendium-collection.mjs:806-815`.)
4. `pack.locked`: `PACK_LOCKED` "The pack is locked; unlock it in Foundry first." (for a world pack the getter is true
   only when the GM locked it, `compendium-collection.mjs:225-227`). Wiretap never changes a lock.
5. Dry run (the same three checks ran): returns `fitPackAck({ dryRun: true, id: pack.collection, label: pack.title,
   type: pack.documentName, documents: pack.index.size })`; nothing is deleted.
6. Real run: `await pack.deleteCompendium()`, then `{ id: args.id, deleted: true }`. The Foundry server removes the
   pack's files (`dist/database/backend/server-compendium.mjs`); Wiretap removes no file (D34). This and the e2e
   registry teardown in `tests/e2e/registryCore.js` are the only callers of `deleteCompendium`.

## Ack bound (`fitPackAck`)

Returns a copy of the row when its JSON is at most `ACK_MAX_BYTES`. Otherwise only `label` is cut (a pack title has no
length limit in Foundry; `id`, `type` and `documents` are never cut): from `min(utf8Bytes(label) - 1, labelBudget - 2)`
downward it tries `truncateUtf8(label, limit)` until the row JSON fits, counting the label's JSON escapes; an empty
label when nothing fits. Error messages stay within 256 B (`ScriptError`).

## Tests

- `tests/unit/packDefinitions.test.js`: pinned names, versions, flags and budgets; `requiresUserInteraction` on
  `delete_pack` only; the shared validator keeps the flag; each listed within 800 B and 160 description characters;
  the description names the gate (and for `delete_pack` the irreversibility); the schema bounds.
- `tests/unit/packCommon.test.js`: `requireOpenGate` closed and open; `fitPackAck` with a fitting row, a 128-character
  label of 4-byte characters, JSON escapes, and every other field kept.
- `tests/unit/createPack.test.js` (mocked `game`, `CONST`, `foundry` and `String.prototype.slugify` stand-in): the
  create with a derived and an explicit name; the gate denial calling Foundry zero times; the dry run with the gate
  closed; blank labels, bad types, bad and reserved names, empty slugs, the 64-character bound; the exact and the
  case-ignoring collision on both runs; a system pack of the same bare name is free; every refusal calls
  `createCompendium` zero times; the ack and refusal byte bounds.
- `tests/unit/deletePack.test.js`: the delete; the gate denial before the lookup; the dry run with the gate closed and
  the document count; `PACK_LOCKED` without deleting or changing the lock; a dry run still refusing a missing, a
  non-world and a locked pack; the system check before the lock; the preview and refusal byte bounds; no pack method
  but `deleteCompendium` is called.
- `tests/integration/packTools.test.js` (real sidecar and SDK client, fake GM): both listed as mutating tools; the
  `_meta` entry on `delete_pack` even when the client registers it without the flag; arguments forwarded as a
  `callTool` op with `dryRun` passed through; an undeclared argument, a missing id and an over-long field refused
  before sending; a client error code reaching the agent as `<code>: <message>`.
- `tests/e2e/packTools.spec.js` (live world, headless, gate sidecar; every pack labelled `Wiretap E2E Pack <time>`,
  type `JournalEntry`, recorded as `Compendium` right after creation): only `delete_pack` carries the meta entry; a
  `create_pack` dry run and a denied real run with the gate closed create nothing; a real create (ack keys `id`,
  `label`, `type`, at most 256 B) and four dry-run refusals (collision, `con`, type `Wall`, name `a b`) that raise no
  `ui.notifications.error`; a `delete_pack` dry run with one document in the pack; the denied delete, a system pack and
  an unknown id refused in dry runs, `PACK_LOCKED` with no GM-screen error, then the real delete after unlocking.
