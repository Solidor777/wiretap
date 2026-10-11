---
name: wiretap-codebase-core
description: Use for any work in the Wiretap Foundry VTT module (terminal relay, sidecar, MCP bridge, sidebar UI, build/tests). Holds the high-level architecture, module boundaries, cross-cutting rules, and the procedure for keeping the wiretap-* codebase skills current and creating new ones as the project grows.
---

# Wiretap codebase — core

Current-state reference. Describes the code as it is now, not its history. If anything here contradicts the code, the
code wins: fix this file in the same change.

## What Wiretap is

A Foundry VTT v14 module (`module.json`, id `wiretap`, `esmodules: index.js`, `socket: true`) that adds a sidebar tab
hosting an AI-agent terminal and a bridge that lets agents act on the live world. Two processes:

| Process | Location | Role |
|---|---|---|
| Foundry client (browser) | `src/` → built to `index.js` + `style.css` at repo root by Vite | Svelte 5 (runes) mounted directly into ApplicationV2; xterm terminal; executes bridge ops on a GM client |
| Sidecar (Node) | `server/` run by `tsx` (`npm run server:start`, `start-wiretap.sh`) | Socket.IO server (default `:31416`, `WIRETAP_PORT`), node-pty terminal relay, MCP HTTP server (default `127.0.0.1:31417/mcp`, `WIRETAP_MCP_PORT`) |

`shared/protocol.js` holds the wire constants used by both sides (imported as `$shared/protocol.js` in the client and
`../shared/protocol.js` in the sidecar). The Foundry bridge speaks protocol v2: GM clients identify as `human` or
`agent` endpoints (acked after registration) and the sidecar routes each invocation through an endpoint registry and
router (`server/endpoints.ts`). The reserved error codes are `NO_ENDPOINT`, `ENDPOINT_TIMEOUT`, `ENDPOINT_GONE`,
`ENDPOINT_LIMIT`, `PROTOCOL_MISMATCH` and `NOT_GM`; a client ack cannot produce them (they become `OP_FAILED`). Limits:
`userId` 64 bytes, `userName` 128 bytes, 64 endpoints, 512 bytes of MCP error text.

## Subsystem map (one skill per subsystem)

| Subsystem | Skill | Paths |
|---|---|---|
| Client UI + terminal client | `wiretap-client` | `src/**`, `lang/**` |
| Sidecar terminal relay | `wiretap-sidecar` | `server/**` (except MCP/bridge files), `shared/**` |
| MCP + Foundry bridge | `wiretap-mcp-bridge` | `server/mcp.ts`, `server/endpoints.ts`, `server/foundryBridge.ts`, `src/bridge/foundryBridge.js`, `shared/protocol.js` |
| Build, lint, tests | `wiretap-build-test` | `tests/**`, `vite.config.mjs`, `vitest.config.mjs`, `playwright.config.mjs`, `eslint.config.js`, `package.json` |

Subsystem skills activate by `paths:`; this core skill activates by description. Invoke the matching subsystem skill
before touching its files.

## Cross-cutting rules (source: `.claude/claude.md`, authoritative)

- All source in `src/` (client) and `server/` (sidecar). Never hand-edit build output.
- No dynamic imports in shipping builds; no test/e2e code in shipping builds (e2e builds to `test/build/`).
- No `:global` CSS selectors. 120-column wrap; typed and commented declarations; multi-line `{}` scopes.
- No stub fixes. Bugs → `docs/OPEN_BUGS.md`; deferrals → the TODO file (`TODO.md` at the repo root; `.claude/claude.md` names `docs/TODO.md`, which does not exist); closed bugs → `docs/CLOSED_BUGS.md`.
- No e2e wait over 1000 ms inside a loaded page.
- The MCP HTTP endpoint and the sidecar Socket.IO server both bind `127.0.0.1` only (the Socket.IO server is attached
  to an `http.Server` listening on `127.0.0.1`; the bind address is not configurable). Both execute world mutations or
  spawn a PTY. Both also refuse a request whose `Origin` header is present and not in `ALLOWED_ORIGINS`
  (`server/origins.ts`: the Foundry page origins on :30000 and the Vite dev-server page origins on :30001), and `/mcp` refuses a `Host` other than `127.0.0.1:<boundMcpPort>` or
  `localhost:<boundMcpPort>`; a request with no `Origin` is accepted (same-machine processes are trusted).
- No file-deletion API (`fs.rm*`, `fs.unlink*`, `fs.rmdir*`, recursive removal helpers) appears in product code or
  tests. The MCP config is a fixed, overwritten file at `<module root>/.wiretap/mcp-<port>.json` (gitignored); its modes (0o700 directory, 0o600
  file) apply only on creation, `.wiretap` and the file are `lstat`-checked for symbolic links, and the lstat-then-write
  gap is a documented residual risk. Tests that write files use unique roots under the gitignored `test/tmp/` or mock
  `node:fs`.

## Keeping the skills current (mandatory)

1. After any plan finishes, and after any significant inline change, update every wiretap-* skill whose paths the
   change touched. Describe the current state only — no changelog. Do it in the same work unit as the code.
2. When a skill's claims are checked against code and found wrong, fix them immediately.
3. Growth: when a change adds a top-level directory, a new subsystem (for example a second tool family, a settings UI,
   a second transport), or pushes a subsystem skill past roughly 250 lines, evaluate the structure and create a new
   domain or sub-domain skill with its own `paths:` globs. Then update the subsystem table above, the
   `.claude/claude.md` skill list, and — if the domain is large enough to need specialized context — add
   `wiretap-<domain>-coder` / `wiretap-<domain>-code-reviewer` agent variants.
4. Do not record anything in a skill that was not read from the code or measured.

## Agents

`wiretap-coder` (implementation), `wiretap-spec-reviewer` (spec/plan completeness), `wiretap-code-reviewer` (quality
and security). `foundry-module-dev` remains the specialist for `.js` / `.svelte` client work. Reviewers are read-only.
