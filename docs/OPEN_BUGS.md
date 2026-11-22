# Open bugs

- [Flaky test] `tests/unit/SuperviseServer.test.js` "process helpers > getAncestors starts with the real parent
  process" times out at the default 5000 ms inside a default-worker `npm test` and passes alone. Seen twice in M15a:
  once in a Task 4 full run, and at the M15a close (`debug/dumps/m15a-close-npmtest.txt`: 5,622 ms, "Test timed out
  in 5000ms"; 1 failed, 2957 passed, 2 skipped). Alone it took 1,466 ms (MEASURED, `npx vitest run
  tests/unit/SuperviseServer.test.js -t "getAncestors starts"`). Inferred, not measured: `getAncestors`
  (`scripts/lib/superviseServer.mjs`) runs `powershell -NoProfile -NonInteractive -Command` through `execFileSync` on
  Windows, and a PowerShell start under full-suite CPU and disk load can pass 5 s; not yet excluded: a slow CIM query
  or antivirus scanning of the spawned process. Not diagnosed further and not fixed.
