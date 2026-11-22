# Strict arguments of the write tools

Definitions carry `additionalProperties: false` at the root; both validators REJECT an undeclared argument (client
`shared/schemaValidate.js`, sidecar zod `.strict()` via `argumentSchema` in `server/toolRegistry.ts`); the client's
`listedNode` emits that keyword so both sides measure the same bytes. A handler never sees an undeclared key inside an
entry (the sidecar's zod parse and the client's validated copy both drop it), so `batch` sets the definition flag
`strictNested: true`: every object below the root refuses an undeclared key on both validators, and the listed schema
omits the nested `additionalProperties` (strict entries would list at 880 B, plus `required` 915 B, plus an `op` enum
and `maxLength` about 70 B more, over 800 B). The flag is validated in `shared/scripts.js`, part of `schemaSignature`,
and the sidecar's zod objects are `.strict()` with the JSON key overridden to `undefined`. Tests: `batchHandler.test.js`,
`schemaValidate.test.js`, `schemaStrict.test.js`, `writeToolsB.test.js` ("undeclared keys in batch entries").
