import path from 'node:path';

/**
 * File names of the e2e build: stable, with no content hash.
 * @returns {{ entryFileNames: string, chunkFileNames: string, assetFileNames: string }} The Rollup output names.
 */
export function e2eOutputNames() {
   return {
      entryFileNames: '[name].js',
      chunkFileNames: '[name].js',
      assetFileNames: '[name][extname]',
   };
}

/**
 * The output settings of the Vite build. Both modes write to `<root>/dist/` (the paths `module.json` names) and never
 * empty it, because nothing in this project deletes files. The e2e build has a code-split chunk (the gated probe
 * import) and shares dist/ with the production build, so it uses hash-free names: every build overwrites the previous
 * one and no stale chunk accumulates. The production build has no dynamic import, so it emits only index.js,
 * index.js.map and style.css under the bundler's default naming.
 * @param {string} mode - The Vite mode (`production` or `e2e`).
 * @param {string} root - The module root directory.
 * @returns {{ outDir: string, emptyOutDir: boolean, rollupOptions: object }} The `build` settings to merge.
 */
export function buildOutput(mode, root) {
   return {
      outDir: path.resolve(root, 'dist'),
      emptyOutDir: false,
      rollupOptions: mode === 'e2e' ? { output: e2eOutputNames() } : {},
   };
}
