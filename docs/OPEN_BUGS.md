# Open bugs

## Terminal socket handlers do not validate payloads

- **Where:** `server/terminal.ts` input and resize handlers read `payload.data`, `payload.cols`, `payload.rows`
  without validating the payload (found by review; read, not run).
- **Inferred, not measured:** an undefined payload or a non-numeric size throws inside a Socket.IO listener, which
  likely terminates the sidecar as an uncaught exception.
- **Fix direction:** validate like the launch handler (R1.7).
