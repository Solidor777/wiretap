# Wiretap

A Foundry VTT v14 module that adds a tab and a bridge for AI agents inside Foundry. Built with
Svelte 5 (runes), SCSS, and Vite.

## Development

- `npm run dev` — Vite dev server (proxies to Foundry on :30000)
- `npm run build` — production build (emits `index.js` + `style.css`)
- `npm test` — unit tests (Vitest)
- `npm run test:e2e` — end-to-end tests (Playwright)

## Running the sidecar

Wiretap's terminal needs a small local Node sidecar (it runs the real PTY; a browser can't). Start it with
a single action:

- **Windows:** double-click `start-wiretap.cmd` in the module folder.
- **macOS/Linux:** run `./start-wiretap.sh` from the module folder.

A console window opens and stays up while the sidecar runs — its log shows `listening on http://localhost:31416`.
**Close that window (or press Ctrl-C) to stop the sidecar.** The Wiretap tab (GM-only) connects automatically
once the sidecar is up; until then it shows a "Sidecar not running" panel.
