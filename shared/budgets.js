/**
 * Context budgets for everything Wiretap sends to an MCP client (tool definitions, results, errors, images). Plain
 * JS with no dependencies because the client and the sidecar both import it. Bytes are the enforced unit because
 * they are deterministic and need no tokenizer; tokens are estimated as bytes / 2. 1 KB is 1000 bytes.
 */

/**
 * @typedef {'hard' | 'warn'} BudgetSeverity
 * `hard`: exceeding it fails CI or is refused at registration or runtime. `warn`: exceeding it is reported only.
 */

/**
 * @typedef {'bytes' | 'chars' | 'count' | 'pixels'} BudgetUnit
 * What a budget value counts: `bytes` are UTF-8 bytes of serialized text, `chars` are string characters (UTF-16 code
 * units), `count` is a number of items, and `pixels` is image area or side length in pixels.
 */

/**
 * @typedef {object} Budget
 * @property {string} name - The constant name, equal to its key in `BUDGETS`.
 * @property {number} value - The limit, in `unit`.
 * @property {BudgetUnit} unit - What `value` counts.
 * @property {BudgetSeverity} severity - Whether exceeding the limit is a failure or a warning.
 */

/**
 * The two severities.
 * @type {Readonly<{HARD: 'hard', WARN: 'warn'}>}
 */
export const BUDGET_SEVERITY = Object.freeze({
   HARD: 'hard',
   WARN: 'warn',
});

/**
 * Creates one frozen budget entry.
 * @param {string} name - The constant name.
 * @param {number} value - The limit.
 * @param {BudgetUnit} unit - What the limit counts.
 * @param {BudgetSeverity} severity - Failure or warning.
 * @returns {Readonly<Budget>} The frozen entry.
 */
function budget(name, value, unit, severity) {
   return Object.freeze({
      name,
      value,
      unit,
      severity,
   });
}

/**
 * Builds the frozen budget table from entries, keyed by each entry's name.
 * @param {Readonly<Budget>[]} entries - The budget entries.
 * @returns {Readonly<Record<string, Readonly<Budget>>>} The frozen table.
 */
function table(entries) {
   /** @type {Array<[string, Readonly<Budget>]>} The name-keyed pairs for `Object.fromEntries`. */
   const pairs = entries.map((entry) => [
      entry.name,
      entry,
   ]);
   return Object.freeze(Object.fromEntries(pairs));
}

/**
 * Every budget, keyed by name.
 * @type {Readonly<Record<string, Readonly<Budget>>>}
 */
export const BUDGETS = table([
   // Core and shipped tool name length. Names are always in the client's context.
   budget('CORE_TOOL_NAME_MAX_CHARS', 32, 'chars', BUDGET_SEVERITY.HARD),
   // Plugin and agent-saved tool name length. Module ids are outside Wiretap's control, so the limit is looser.
   budget('PLUGIN_TOOL_NAME_MAX_CHARS', 64, 'chars', BUDGET_SEVERITY.HARD),
   // Serialized `{name, description, inputSchema}` of one tool.
   budget('DEFINITION_MAX_BYTES', 800, 'bytes', BUDGET_SEVERITY.HARD),
   // Description length above which a warning is reported; descriptions are paid for on every load.
   budget('DESCRIPTION_TARGET_CHARS', 160, 'chars', BUDGET_SEVERITY.WARN),
   // Description length above which the definition is refused.
   budget('DESCRIPTION_MAX_CHARS', 240, 'chars', BUDGET_SEVERITY.HARD),
   // Server `instructions` text sent to the client at session start; it names the tool families.
   budget('INSTRUCTIONS_MAX_CHARS', 600, 'chars', BUDGET_SEVERITY.HARD),
   // MCP sessions held at once; an initialize beyond it is refused until the idle sweep frees a slot.
   budget('MCP_SESSIONS_MAX', 32, 'count', BUDGET_SEVERITY.HARD),
   // Request body bytes the MCP endpoint reads; a larger body is refused with 413 and the request is destroyed.
   budget('MCP_BODY_MAX_BYTES', 1_048_576, 'bytes', BUDGET_SEVERITY.HARD),
   // Tools listed to the client at all times (core plus shipped).
   budget('ALWAYS_LISTED_TOOLS_MAX', 30, 'count', BUDGET_SEVERITY.HARD),
   // Serialized size of all core and shipped definitions together (16 KB).
   budget('ALL_DEFINITIONS_MAX_BYTES', 16000, 'bytes', BUDGET_SEVERITY.HARD),
   // Acknowledgement of a write, per document.
   budget('ACK_MAX_BYTES', 256, 'bytes', BUDGET_SEVERITY.HARD),
   // Default compact view of one document (2 KB).
   budget('COMPACT_VIEW_MAX_BYTES', 2000, 'bytes', BUDGET_SEVERITY.HARD),
   // Embedded tuples in a compact view; a total count follows, so the size bound is independent of the data.
   budget('COMPACT_EMBEDDED_TUPLES_MAX', 40, 'count', BUDGET_SEVERITY.HARD),
   // Projection fixture target per 10 requested fields (1 KB); the size of a projection is the agent's request.
   budget('PROJECTION_BYTES_PER_10_FIELDS', 1000, 'bytes', BUDGET_SEVERITY.WARN),
   // One page of search rows (4 KB).
   budget('SEARCH_PAGE_MAX_BYTES', 4000, 'bytes', BUDGET_SEVERITY.HARD),
   // Search rows per page when the caller gives no limit.
   budget('SEARCH_DEFAULT_LIMIT', 20, 'count', BUDGET_SEVERITY.HARD),
   // Largest search page size a caller may request.
   budget('SEARCH_MAX_LIMIT', 100, 'count', BUDGET_SEVERITY.HARD),
   // One error text.
   budget('ERROR_MAX_BYTES', 512, 'bytes', BUDGET_SEVERITY.HARD),
   // Failures listed in one error before a count of the rest.
   budget('ERROR_MAX_FAILURES', 10, 'count', BUDGET_SEVERITY.HARD),
   // Text result size above which the runtime enforcer returns a handle instead (8 KB).
   budget('RESULT_HARD_CAP_DEFAULT_BYTES', 8000, 'bytes', BUDGET_SEVERITY.HARD),
   // Largest hard cap a caller may request per call (16 KB).
   budget('RESULT_HARD_CAP_MAX_BYTES', 16000, 'bytes', BUDGET_SEVERITY.HARD),
   // Serialized sheet layout tree (4 KB).
   budget('SHEET_LAYOUT_MAX_BYTES', 4000, 'bytes', BUDGET_SEVERITY.HARD),
   // Default screenshot area, the 800x600 area; aspect ratio is kept. A capture-time default: the result enforcer
   // checks only the longest side and the data size, never this area.
   budget('IMAGE_DEFAULT_MAX_PIXELS', 480000, 'pixels', BUDGET_SEVERITY.HARD),
   // Longest side of any returned image.
   budget('IMAGE_MAX_SIDE_PIXELS', 1280, 'pixels', BUDGET_SEVERITY.HARD),
   // Images in one result.
   budget('IMAGE_MAX_PER_RESULT', 1, 'count', BUDGET_SEVERITY.HARD),
   // Base64 characters of one returned image; a larger payload is refused whatever its header claims.
   budget('IMAGE_DATA_MAX_BYTES', 1000000, 'chars', BUDGET_SEVERITY.HARD),
   // One stored result, in UTF-8 bytes; a larger value is refused instead of stored.
   budget('HANDLE_ENTRY_MAX_BYTES', 8000000, 'bytes', BUDGET_SEVERITY.HARD),
   // Stored results held at once; the least recently used is evicted beyond it.
   budget('HANDLE_MAX_COUNT', 1024, 'count', BUDGET_SEVERITY.HARD),
   // Live calibration runs of the manual measurement script; the script reports, it never fails a build.
   budget('LIVE_RECALIBRATION_MAX_RUNS', 6, 'count', BUDGET_SEVERITY.WARN),
   // Paths in one path-scoped read or write call.
   budget('PATHS_PER_CALL_MAX', 20, 'count', BUDGET_SEVERITY.HARD),
   // A path-grammar error text.
   budget('PATH_ERROR_MAX_BYTES', 256, 'bytes', BUDGET_SEVERITY.HARD),
   // A path string, in UTF-8 bytes; longer paths are refused before they are split.
   budget('PATH_BYTES_MAX', 512, 'bytes', BUDGET_SEVERITY.HARD),
   // Segments in one path.
   budget('PATH_SEGMENTS_MAX', 16, 'count', BUDGET_SEVERITY.HARD),
]);

/**
 * Looks up a budget and its severity.
 * @param {string} name - The budget constant name, for example `ACK_MAX_BYTES`.
 * @returns {Readonly<Budget>} The frozen entry with `value`, `unit` and `severity`.
 * @throws {Error} When no budget has that name; inherited object properties are not budgets.
 */
export function getBudget(name) {
   if (!Object.hasOwn(BUDGETS, name)) {
      throw new Error(`Unknown budget: ${name}`);
   }
   return BUDGETS[name];
}
