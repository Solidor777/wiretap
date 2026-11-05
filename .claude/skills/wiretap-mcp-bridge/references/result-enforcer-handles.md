# Result enforcer and handles

Part of the wiretap-mcp-bridge skill; read it before changing result budgets, handles, read_handle or the files server/resultBudget.ts, server/handles.ts, server/handleInput.ts, server/utf8.ts.

## Result enforcer, handles and `read_handle`

Every registered tool runs through `withResultBudget(handler, { store, ownerKey, ownerLive?, budgetBytes? })`
(`server/resultBudget.ts`); `buildServer` applies it to `read_handle`, any `tools` entry and every registry script (`makeRegistryToolHandler`). Budgets
count raw UTF-8 text bytes, not JSON-escaped wire bytes.

- **Limit.** The hard cap is 8,000 bytes; a valid integer `maxBytes` in the call arguments (>= 1) replaces it, clamped to
  16,000 (an invalid `maxBytes` is ignored); the tool's own `budgetBytes` lowers it further (the smaller of the two).
  The SDK strips arguments a tool's `inputSchema` does not declare (measured), so `maxBytes` reaches the enforcer and
  handler only for a tool that declares an optional integer `maxBytes` (that adds to its definition size); `read_handle`
  declares it (128..16000). The measured size is the UTF-8 bytes of the text content items (other non-image items as their
  JSON, then `structuredContent` as JSON); at or below the limit the result is returned unchanged, one byte over becomes
  a handle. The write scripts declare `result.budgetBytes` = `ACK_BATCH_MAX_BYTES` (4,000); the script shapes its ack to fit, so a handle is the fallback only. `get_document` declares 16,000 and `maxBytes` (integer 128..16000), so a full read over 8,000 B is a handle unless the caller raises `maxBytes`; `list_document_types` declares `DOCUMENT_TYPES_MAX_BYTES` (3,000), `search_documents` `SEARCH_PAGE_MAX_BYTES` (4,000; it declares no `maxBytes`) and `describe_schema` `DESCRIBE_SCHEMA_MAX_BYTES` (8,000).
- **Over the limit.** When `ownerLive` is given and returns false (the owning MCP session ended), nothing is stored and the result is the error `SESSION_ENDED: ...`. Otherwise the parts are joined with `\n` and stored (`HandleStore.put`); the result is a single text item
  `{"handle","bytes","summary"}` (any image items are kept; `structuredContent` is dropped), at most 256 bytes
  (`ACK_MAX_BYTES`). `bytes` is the stored size (`put().bytes`, parts plus the joining newlines). `summarizeResult(text)`
  is deterministic: a JSON object gives `{kind:'object', n, keys (first 8 in JS property order, integer-like keys first,
  each <= 32 B), counts (array length or key count of those keys), omitted?, name?, type?}` (strings <= 32 B; a key
  that equals an earlier listed key once shortened is skipped and counted in `omitted`), a JSON array
  `{kind:'array', n}`, anything else `{kind:'text', n}` (characters). Only a single-part result without
  `structuredContent` is summarized from its JSON; multi-part or structured results are described as `{kind:'text', n}`.
  `formatHandleResponse` drops count entries, then keys, then `name`, then `type` until the text fits. A result over the
  entry cap or the whole store becomes an error (`HANDLE_TOO_LARGE: ...`); `summarizeResult` runs only after a
  successful `put`.
- **Never fails open.** A handler throw is caught: a `BridgeError` passes as `formatBridgeError` (`<code>: <message>`, capped to
  512 bytes), anything else becomes `Tool failed.` and the real message goes to `console.warn`
  (`Wiretap sidecar | tool failed: ...`; control characters, line breaks and U+2028/2029 replaced by spaces, cause cut to
  512 bytes). `makeRegistryToolHandler` returns only `BridgeError`s as results and rethrows anything else. Everything after the handler (shape check, image checks, serialization, `byteLength`, `put`) runs in
  one `try`; a result that is null, has no `content` array, has a content item without a string `type`, a text item
  without string text, or cannot be serialized becomes `Tool returned an invalid result.` (logged the same way).
- **Errors and images.** An `isError` result is rewritten as one text item capped to 512 bytes (`ERROR_MAX_BYTES`) and is
  never a handle. `IMAGE_LIMIT: ...` (an error result) is returned for: more than one image; a `mimeType` other than
  exactly `image/png`; `data` that is not a string, is longer than 1,000,000 characters (`IMAGE_DATA_MAX_BYTES`) or
  does not match `^[A-Za-z0-9+/]*={0,2}$` (whitespace is refused); a PNG header (IHDR, first 32 base64 characters) that
  cannot be read; a longest side over 1280 px. The result leaves the enforcer rebuilt (`rebuildItem`): image items as exactly
  `{type, data, mimeType}`, text items as exactly `{type, text}`, other item types whole (they are measured as their
  JSON), and the result as `{content, structuredContent?}` only (inline path) or the handle text plus rebuilt images
  (handle-ack path); `_meta`, `annotations` and unknown fields are dropped. `IMAGE_DEFAULT_MAX_PIXELS` (480,000 px) is a capture-time default and is
  not enforced here.
- **Store** (`server/handles.ts`, `createHandleStore({ now?, maxTotalBytes?, idleMs?, maxEntryBytes?, maxCount? })`; `releaseOwner(ownerKey)` removes every entry of that owner; `read(ownerKey, handle, maxBytes)` returns the whole stored text of an own, live handle, or `HANDLE_NOT_FOUND` / `HANDLE_TOO_LARGE`, and touches the entry).
- **Handle inputs** (`server/handleInput.ts`, `resolveHandleArgs`): `makeRegistryToolHandler` replaces a `handle:<22-char id>` text in a `handleArgs` argument with the stored text before `bridge:invoke`; see `wiretap-writes`.
  Memory only: no file-system import, no timers, no deletion API. Ids are 16 random bytes in base64url (22 characters).
  The default clock is `performance.now()`. Each entry is accounted as `max(UTF-8 bytes, 2 * length) + 256`
  (`HANDLE_ENTRY_OVERHEAD_BYTES`) inside the 64,000,000-byte total across all owners; a value over 8,000,000 UTF-8 bytes
  (`HANDLE_ENTRY_MAX_BYTES`) or over the total gets `HANDLE_TOO_LARGE`; at most 1,024 entries (`HANDLE_MAX_COUNT`). LRU
  eviction (global across owners, so one owner's puts can evict another's) frees
  count and bytes; a use (successful `slice`) re-inserts the entry last, so map order is `lastAccess`
  order and `purgeExpired` walks from the front and stops at the first live entry (`idle >= idleMs` expires; 30 minutes
  default; run on every `put` and `slice`). `slice(ownerKey, handle, { paths?, offset?, length?, maxBytes? })` checks
  ownership, then validates `offset`/`length`, and only a fully successful read touches the entry. It returns
  `{ok, text, offset, length, total, truncated?}` counted in UTF-16 code units; `maxBytes` (default 8,000, at most
  16,000) bounds the UTF-8 size of `text`. The window scan is O(maxBytes): it walks code points, never ends inside a
  surrogate pair, moves an `offset` on a low surrogate back one unit (the returned `offset` is the real start), and
  takes the whole pair for `length: 1` at a high surrogate; if not even the next character fits `maxBytes` it returns
  `HANDLE_WINDOW_TOO_SMALL`. With `paths` the entry is parsed again (nothing cached), `resolvePaths` runs, and
  `boundedStringify({values, missing}, maxBytes)` (iterative, stops once the output exceeds the limit) builds the view;
  a longer result is cut to the limit and `truncated: true` is returned, so a `paths` result is one window whose cut
  depends on the call's `maxBytes`; its tail is reachable only by narrowing `paths`. Measured cost of one `paths` read
  (parse plus 20 wildcard paths): ~17 ms for an 8 MB long-string document, ~185 ms for 7.7 MB of 106,000 small objects. Grammar
  errors keep their `PATH_*` codes, non-JSON text gives `HANDLE_NOT_JSON`. Unknown, expired, evicted and other-owner
  handles all give `HANDLE_NOT_FOUND: Handle not found or expired.` A bad `offset`/`length` gives `HANDLE_BAD_RANGE`.
- **Owner key.** Each MCP session owns its handles: `buildServer` passes the session id as `ownerKey` to both
  `makeReadHandleHandler` and `withResultBudget`, so a session reads only handles its own calls stored (another
  session's handle gives `HANDLE_NOT_FOUND`). `HandleStore.releaseOwner(ownerKey)` drops every handle of one owner; the
  session manager's `onEnd` calls it when a session ends (DELETE, idle expiry, cap eviction, dispose). Eviction by the
  count and byte limits stays global across owners (`docs/TODO.md`). `startMcpServer` creates the store once per server (or
  takes `options.handleStore`); `options.instructions` replaces `WIRETAP_INSTRUCTIONS`; `tools` are
  `ToolRegistration` entries (`name`, `description`, `inputSchema` zod shape, `handler`, `budgetBytes?`) registered on every
  session; tests use it for test-local tools (no production test tool exists).
- **`read_handle`** (`makeReadHandleHandler(store, ownerKey)`): args `handle` (string <= 64), `paths` (<= 20 strings),
  `offset`, `length`, `maxBytes` (128..16000, the whole result's limit, default 8,000; the handler also answers a smaller value with
  `HANDLE_WINDOW_TOO_SMALL`, so the result is always a window plus a footer within the limit). Result content: the window text,
  then a footer item `{"offset","length","total"}` (plus `"truncated":true` for a cut `paths` result); the window is
  limited to `maxBytes - 64` bytes so both items stay within the limit. A store failure is an `isError` result
  `<code>: <message>`. Its definition is inside the budgets (name 11 chars, description <= 160, definition <= 800 B;
  asserted in `tests/integration/resultHandles.test.js` and, with the other budgets, in `tests/unit/contextBudget.test.js`).
- **`server/utf8.ts`** holds `truncateUtf8`, shared by `endpoints.ts`, `resultBudget.ts`, `mcp.ts` and `server.ts`.
