# World compendium packs in the e2e running list

Part of the wiretap-build-test skill; read it before changing the pack handling of `tests/e2e/registryCore.js` or
writing an e2e that creates a pack.

- `Compendium` is the last entry of `ALLOWED_DOCUMENT_NAMES` (after `Folder`): the documents inside a pack are
  removed with it, so no pack content is ever recorded.
- An entry is `{ documentName: 'Compendium', id: 'world.<name>', uuid: 'Compendium.world.<name>', createdBy }`.
  `entryProblem` checks the id against `/^world\.[A-Za-z0-9_-]{1,64}$/` ("a Compendium entry id is not a world pack
  id") and the uuid against `<documentName>.<id>`, like every other entry. Record a pack with `recordDocument` right
  after it is created; its label starts with `Wiretap E2E `.
- A pack is resolved by its id with `game.packs.get`, never with `fromUuid`. It is safe to delete only while it is a
  world pack (`metadata.packageType === 'world'`) whose `title` starts with the e2e prefix. `inspectRecorded` reports
  any other recorded pack as a violation (nothing is deleted then); a pack that no longer exists is skipped.
- `deleteRecorded` repeats the same test just before each pack is deleted, unlocks a locked pack with
  `pack.configure({ locked: false })` (because `deleteCompendium` throws for a locked one), then calls
  `pack.deleteCompendium()`. The Foundry server removes the pack's files; the registry touches no file.
- `sweepPrefixed` scans `game.packs` for titles that start with the prefix: a world pack is deleted after every
  prefixed document (unlocked first when locked) and reported as `Compendium <title>`; a system or module pack with
  such a title is a violation and the sweep deletes nothing.
- The core world setting `compendiumConfiguration` (`PACK_CONFIG_SETTING`) holds a key per pack id, and
  `deleteCompendium` leaves it. After deleting, `deleteRecorded` removes the key of each recorded pack it deleted or
  found already gone, and `sweepPrefixed` the key of each pack it deleted; no other key is touched, and the setting is
  written only when one of those keys is present.
- `countLeftovers` (behind `censusPrefixed`) lists every world pack titled with the prefix as `Compendium <title>`,
  and every `compendiumConfiguration` key that starts with `world.wiretap-e2e-` (`E2E_PACK_ID_PREFIX`) and whose pack
  no longer exists as `compendiumConfiguration <pack id>`.
- `tests/e2e/packTools.spec.js` sends the malformed `create_pack` dry runs and the system-pack and missing-pack
  `delete_pack` dry runs with their gate closed.
- The only code that calls `deleteCompendium` is `src/bridge/scripts/deletePack.js` and this teardown and sweep.
- Unit tests: `tests/unit/e2eRegistry.test.js` (a mocked `game.packs` beside the mocked document layer). The live use is
  `tests/e2e/packTools.spec.js` (see `wiretap-packs`).
