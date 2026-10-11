# Open bugs

## E2E build writes to the repo root, not `test/build/`

`.claude/CLAUDE.md` says test and e2e code builds to `test/build/` and stale built files are deleted after every build.
Measured on 2026-10-11: `tests/e2e/global-setup.js` runs `npm run build:e2e` (`vite build --mode e2e`), and
`vite.config.mjs` sets `build.outDir` to the repo root (`__dirname`) with `emptyOutDir: false`. `ls test` lists only
`state` and `tmp` (no `build`), and the repo root holds two `TerminalConnection.svelte-<hash>.js` and two
`registerProbe-<hash>.js` chunks from different builds (`ls *-????????.js`), so stale e2e chunks accumulate and the e2e
build shares its output directory with the shipping build. The chunks are gitignored (`/*-????????.js`). Not changed
by the risk-gate work.
