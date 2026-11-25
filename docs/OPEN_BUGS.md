# Open bugs

- [Comment] `src/bridge/foundryBridge.js` (`sendRegistry` JSDoc, about lines 250-251) says plugin definitions are left
  out of an over-size registry push "newest first"; `buildRegistryPayload` (`src/bridge/scripts/registryPayload.js`)
  leaves out the largest listed definition first, the later registration first only among equal sizes. Found while
  writing the plugin-author guide; not fixed (outside the docs task's files).
- [Comment] `shared/gates.js` (`denyWiretapSettingWrite` JSDoc, about line 315) says "so no skill can change a gate";
  "skill" means only a guide folder, and the rule is that no Wiretap tool can change a gate. Found in M7 (also listed by
  the first builder); not fixed (outside the docs task's files).
