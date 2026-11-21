# Script definition (`shared/scripts.js`)

Plain JS with JSDoc, imported by both sides: `server/toolRegistry.ts`, `server/mcp.ts` (`RESERVED_SCRIPT_NAMES`), `src/bridge/foundryBridge.js` (`SCRIPT_API_VERSION`) and `src/bridge/scripts/registry.js`. The module header documents every
field of a script definition `{ name, version, description, inputSchema, result: { budgetBytes }, requires, mutates, gate?,
moduleId? }`. Exports: `SCRIPT_API_VERSION` (1), `SCRIPT_SOURCES` (`shipped`, `plugin`, `agent`), `SCRIPT_REQUIRES` (`none`, `api`,
`dom`), `RESERVED_SCRIPT_NAMES` (`read_handle`, `backup_documents`, `list_backups`, `restore_backup`, `delete_backup`:
the sidecar's own tools), `definitionBytes(name, description, inputSchema)`,
`validateScriptDefinition(input, source)` and `parseRegistryPayload(payload)`.

- `validateScriptDefinition` returns `{ ok: true, definition, warnings }` (a fresh copy of the known fields; a description over the
  160-character target warns) or `{ ok: false, reason }`; it never throws (own properties only, a throwing getter or an
  unserializable schema is a refusal). `source` is implied by the registering route and is not a field: an unknown source is a
  refusal, `shipped` names are 1 to 32 characters (`[a-z][a-z0-9_-]*`), `plugin` names are `<moduleId>__<skill>` and `agent` names
  `agent__<name>` of at most 64 characters, and every field is checked for every source before a valid plugin or agent definition is
  refused as "not supported by this version of Wiretap". `mutates` (boolean) and `requires` are required and never defaulted;
  `version` is `MAJOR.MINOR.PATCH` with optional `-prerelease` and `+build` within `SCRIPT_VERSION_MAX_CHARS` (32); `result.budgetBytes` is
  an integer 1 to `RESULT_HARD_CAP_MAX_BYTES`; `gate` is a name in `GATES` except `allowedPluginModules`; `moduleId` exists on
  plugin scripts only; `{name, description, inputSchema}` is held to `DEFINITION_MAX_BYTES` in UTF-8 bytes. The JSON Schema subset check
  and the conversion to zod are sidecar-only (`server/toolRegistry.ts`).
- `parseRegistryPayload` opens `{ apiVersion, scripts }` and refuses everything else (a plain array included) with a reason that
  names `apiVersion`.

Tests: `tests/unit/scripts.test.js`.
