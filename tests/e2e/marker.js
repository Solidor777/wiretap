// Long-lived marker process for terminal e2e: prints a stable marker, then ticks forever so the session
// persists for assertions. Launched as `node tests/e2e/marker.js` (no nested quotes — node-pty's Windows
// arg-escaping mangles inline `node -e "..."`, which dropped the keep-alive and flaked the suite).
// Print the marker on its own line so xterm's clear() (which keeps the cursor line) removes it; the dots
// then tick on the following line, keeping the session alive.
process.stdout.write('READY-MARK\r\n');
setInterval(() => process.stdout.write('.'), 300);
