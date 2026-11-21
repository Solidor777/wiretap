# Wiretap M18: compendium pack tools — design

Status: approved for planning under the owner's delegation ("I'm going to bed so I'll trust you on the design doc
for this. Execute the milestone with paralell subagent development. Do the same with compendium tools"). Every call
below not quoted from the owner is the designer's call.

## Intent

The owner asked for compendium tools as the next milestone. `docs/PLAN.md` M18 and D30 define them: an agent can
create a world compendium pack and delete one, each with a dry run, behind GM gates, and deleting a pack always asks
the human. Earlier owner decisions (2026-10-13/14) fix the shape: any unlocked world pack; `delete_pack` always
prompts; a separate `allowPackDeletion` gate; every risky op behind a GM gate that is off by default.

## Goals

- `create_pack({ label, type, name?, dryRun? })` creates a world pack through Foundry's own call.
- `delete_pack({ id, dryRun? })` deletes an unlocked world pack through Foundry's own call.
- `delete_pack` carries `_meta["anthropic/requiresUserInteraction"]: true` on its MCP tool, so Claude Code always
  prompts the human, and no plugin, setting or client can list it without that field.
- Wiretap code never touches pack files (D34). The Foundry server removes them.

## Non-goals

- No pack folder, ownership, lock or rename arguments (`create_pack` takes only `label`, `type`, `name`).
- No unlocking: Wiretap never changes a pack's lock.
- No system or module packs, ever.
- No pack content copy or import (later script-library work).

## Anti-goals

- A pack deleted without the human seeing a prompt in Claude Code.
- Any permanent-delete API in Wiretap code.
- A GM-screen error notification from Foundry for input Wiretap could have refused first.

## Approaches

1. Two client scripts (chosen). Both tools are scripts in the GM client registry like the other write tools; the
   sidecar maps a definition flag to the tool's `_meta`. Fits the existing registry, gates and e2e machinery.
2. Sidecar built-ins like the backup tools. Rejected: pack creation and deletion are Foundry client calls that must
   run on a GM client; a built-in would only forward to the client and add a second path.
3. One `manage_pack` tool with an action. Rejected: the prompt must attach to deletion only, and `_meta` is per tool.

## Decisions

- **Foundry calls (read in the v14 source):** create with `CompendiumCollection.createCompendium({ label, type,
  name })` (GM only; the server refuses a name collision with `world.<name>`, a name not matching
  `^[A-Za-z0-9-_]+$`, a Windows-reserved name and a type outside `CONST.COMPENDIUM_DOCUMENT_TYPES`). Delete with
  `pack.deleteCompendium()` (the client throws when the pack is locked; the server rebuilds `world.<name>`, so it can
  only delete world packs, and removes the pack folder with its own file call).
- **Refuse before Foundry does** (designer's call): the handler checks `type` against
  `CONST.COMPENDIUM_DOCUMENT_TYPES`, `name` against Foundry's pattern and the reserved names, and a collision with an
  existing `world.<name>`, each as `ARGS_INVALID`, so Foundry never shows a GM-screen error for them. `name` defaults
  to Foundry's own slug of `label`.
- **`type` is a plain string** validated in the handler, not a schema enum (the 800-byte definition budget).
- **`delete_pack` takes `id`**, the pack's collection id (`world.<name>`). A pack that is not found is
  `PACK_NOT_FOUND`; a pack whose `metadata.packageType` is not `world` is `ARGS_INVALID` ("only world packs"); a
  locked pack is `PACK_LOCKED` (the owner's "any unlocked world pack"; the GM unlocks it in Foundry).
- **Gates:** `create_pack` needs `allowCompendiumWrites`; `delete_pack` needs the new `allowPackDeletion` (off by
  default, GM world setting like every gate). The gate is checked in the handler, so a dry run works with the gate
  closed, as every other write tool's dry run does.
- **Dry runs:** `create_pack` returns `{ dryRun: true, id, label, type }` after every check; `delete_pack` returns
  `{ dryRun: true, id, label, type, documents }` (`documents` is `pack.index.size`). Neither writes.
- **Results:** `create_pack` returns `{ id, label, type }`; `delete_pack` returns `{ id, deleted: true }`. Each at most
  256 bytes; `label` is cut to fit. The `delete_pack` description says deletion is irreversible.
- **The prompt carrier:** a script definition may set `requiresUserInteraction: true`; the sidecar maps it to the
  MCP tool's `_meta: { "anthropic/requiresUserInteraction": true }`. The sidecar also sets it for any tool named
  `delete_pack` whatever the definition says, so a client that omits the flag cannot list `delete_pack` without the
  prompt. The flag is not counted in the 800-byte definition size (the size counts name, description and schema).
  Residual risk, stated in the README: the prompt is enforced by Claude Code; another MCP client or a local process is
  not prompted, and the gate stays Wiretap's own control.
- **e2e:** the e2e registry learns to record a pack by its collection id, to sweep and count world packs whose label
  starts with the e2e prefix, and to tear one down (unlock in the test helper if needed, then delete). The spec
  creates and deletes a throwaway pack through the tools.

## Constraints

- Context budgets: each definition at most 800 bytes, all at most 16,000, at most 30 tools; acks at most 256 bytes.
- No permanent-delete API in Wiretap code (`tests/unit/noPermanentDelete.test.js`).
- e2e waits inside a loaded page at most 1000 ms; the live world is shared and left as found.

## Left to the builder

File layout of the two scripts, test names, the exact wording of descriptions and errors within the budgets.
