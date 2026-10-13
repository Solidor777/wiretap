/**
 * Write one line of e2e output to standard error. The e2e suite has no other log sink: this is the single place that
 * prints, so a run's notes (counts, skipped items, warnings) appear in the reporter output.
 * @param {string} line - One line of text without a line break.
 * @returns {void}
 */
export function e2eLog(line) {
   process.stderr.write(`Wiretap e2e | ${line}\n`);
}
