/**
 * Manual context-budget calibration. Starts the real MCP server in-process (no Foundry needed), lists its real tools
 * and runs every tool's representative-result fixture, then prints the byte sizes against the budgets. It only reports:
 * it never fails a build, is not run by `npm test`, writes no file and deletes nothing. To keep a run, redirect the
 * output into the `debug/dumps/` sink.
 *
 * Run it with `npx tsx tests/measure/measureContext.mjs`.
 *
 * Comparing with token counts: budgets are bytes and tokens are estimated as bytes / 2. To check the estimate, start a
 * Claude Code session with the Wiretap MCP server connected (`claude mcp add --transport http wiretap
 * http://127.0.0.1:31417/mcp`), run `/context` before and after one call of a tool whose fixture is listed below, and
 * divide the byte size printed here by the token difference. Use at most `LIVE_RECALIBRATION_MAX_RUNS` live runs;
 * tokenizers and Claude Code behaviour change between versions.
 */
import { getBudget } from '../../shared/budgets.js';
import { FIXTURES, HELPER_TOOL_NAME, collectReport, startHarness } from '../unit/contextBudgetHarness.js';

/**
 * Pad a value to a column width.
 * @param {string | number} value - The cell content.
 * @param {number} width - The column width.
 * @returns {string} The padded text.
 */
function cell(value, width) {
   return String(value).padEnd(width);
}

/** @type {Awaited<ReturnType<typeof startHarness>>} The running server, its client and its teardown. */
const harness = await startHarness();
try {
   /** @type {import('../unit/contextBudgetHarness.js').BudgetReport} The measurements. */
   const report = await collectReport({
      client: harness.client,
      setGmAck: harness.setGmAck,
      fixtures: FIXTURES,
   });
   // The helper tool is test-local, so the listing shows only the tools the module ships.
   /** @type {typeof report.listing} The shipped tools. */
   const shipped = report.listing.filter((tool) => tool.name !== HELPER_TOOL_NAME);
   /** @type {number} The summed definition size of the shipped tools. */
   const shippedBytes = shipped.reduce((sum, tool) => sum + tool.definitionBytes, 0);
   console.log('Tool definitions (JSON of {name, description, inputSchema}); tokens estimated as bytes / 2');
   console.log(
      `${cell('tool', 24)}${cell('name chars', 12)}${cell('desc chars', 12)}${cell('def bytes', 11)}est tokens`,
   );
   for (const tool of shipped) {
      console.log(
         `${cell(tool.name, 24)}${cell(tool.nameChars, 12)}${cell(tool.descriptionChars, 12)}` +
            `${cell(tool.definitionBytes, 11)}${Math.round(tool.definitionBytes / 2)}`,
      );
   }
   console.log(
      `total: ${shipped.length} tools (max ${getBudget('ALWAYS_LISTED_TOOLS_MAX').value}), ${shippedBytes} bytes ` +
         `(max ${getBudget('ALL_DEFINITIONS_MAX_BYTES').value}), about ${Math.round(shippedBytes / 2)} tokens`,
   );
   console.log('');
   console.log('Fixture results against their budgets');
   console.log(`${cell('tool', 20)}${cell('fixture', 48)}${cell('bytes', 8)}${cell('budget', 8)}est tokens  constant`);
   for (const run of report.fixtureRuns) {
      console.log(
         `${cell(run.tool, 20)}${cell(run.label, 48)}${cell(run.bytes, 8)}${cell(run.limit, 8)}` +
            `${cell(Math.round(run.bytes / 2), 12)}${run.budget}`,
      );
   }
   console.log('');
   console.log(`Hard failures: ${report.failures.length}`);
   for (const failure of report.failures) {
      console.log(`  ${failure}`);
   }
   console.log(`Warnings: ${report.warnings.length}`);
   for (const warning of report.warnings) {
      console.log(`  ${warning}`);
   }
} finally {
   await harness.close();
}
