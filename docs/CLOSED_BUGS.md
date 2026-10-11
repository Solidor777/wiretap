# Closed bugs

## Terminal socket handlers did not validate payloads

- **Was:** `server/terminal.ts` read `payload.data`, `payload.cols` and `payload.rows` from untrusted `TERMINAL_INPUT`,
  `TERMINAL_RESIZE` and `TERMINAL_LAUNCH` events without validation. Reading a property of an `undefined` payload throws
  inside a Socket.IO listener (inferred, not run against a live process, to terminate the sidecar), and a non-numeric
  size reached node-pty and the stored `size`.
- **Fix:** a payload that is not an object, input whose `data` is not a string, and a `cols` or `rows` that is not an
  integer within 1..`MAX_TERMINAL_DIMENSION` (1000) are ignored with one fixed `console.warn` line; a launch with an
  invalid size spawns nothing; an absent launch `cols`/`rows` keeps the stored size (default 80x24). Input `data` has no
  length cap: Socket.IO's `maxHttpBufferSize` (not overridden in `server/`; its default is inferred to be 1 MB) already
  bounds one event.
- **Measured:** `tests/unit/terminalPayloads.test.js` failed 48 of 50 tests before the fix (the 2 valid-input tests
  passed) and passes 50 of 50 after; removing the upper-bound check fails 4 of them (sizes 1001 and 1e9 for resize and
  launch).

## Sidecar Socket.IO server was not bound to loopback

- **Was:** `server/server.ts` passed no host to `new Server(port, { cors })`, so Node bound all interfaces; the
  unauthenticated terminal launch and bridge `isGM` identify events were reachable from the network.
- **Measured before the fix:** `server.io.httpServer.address()` returned `{ address: '::', family: 'IPv6' }`, and a TCP
  connection to this machine's non-loopback IPv4 address on the Socket.IO port was accepted
  (`tests/integration/serverModes.test.js`, both assertions failed).
- **Fix:** `createWiretapServer` creates an `http.Server`, calls `listen(port, '127.0.0.1')` and attaches Socket.IO to
  it; the bind address is not configurable.
- **Measured after the fix:** `address()` returns `{ address: '127.0.0.1', family: 'IPv4' }`; a loopback connection and
  a socket.io client connect; a connection to the non-loopback IPv4 address is refused (the test skips on a machine
  without one); `dispose()` stops the HTTP server and releases the port.

## `mcpConfigFile.test.js` failed when a process id was reused

- **Was:** `tests/unit/mcpConfigFile.test.js` `freshRoot(name)` named roots `test/tmp/mcpConfigFile/<pid>-<counter>`. One
  full `npm test` run (2026-10-11) failed 7 tests on the "scratch root must not exist yet" assertion while the file
  passed alone and in the next two full runs; `test/tmp/mcpConfigFile/` held 121 leftover directories that the
  no-deletion rule forbids removing, so a reused pid plus counter collided with an older run's directory.
- **Fix:** roots are now `<timestamp>-<pid>-<counter>`; the timestamp is taken once when the test module loads.
- **Measured after the fix:** three consecutive runs of the file passed (8 passed, 1 skipped on Windows), and the new
  directories have the `<13-digit timestamp>-<pid>-<counter>` form. The collision itself depends on pid reuse and was
  not reproduced on demand, so the fix is verified by construction, not by reproducing the failure.

