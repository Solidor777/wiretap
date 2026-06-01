import { svelte } from '@sveltejs/vite-plugin-svelte';
import { sveltePreprocess } from 'svelte-preprocess';
import path from 'path';
import { fileURLToPath } from 'url';
import autoprefixer from 'autoprefixer';

const __filename = fileURLToPath(import.meta.url); // Resolved path to this config file.
const __dirname = path.dirname(__filename); // Directory containing this config file.

// Foundry package path used for the base URL and dev-server proxy rules.
const s_PACKAGE_ID = 'modules/wiretap';

const s_COMPRESS = true; // Compress the module bundle with terser.
const s_SOURCEMAPS = true; // Generate sourcemaps for the bundle.

export default ({ mode }) => {
   /** @type {import('vite').UserConfig} */
   return {
      root: 'src/',
      base: `/${s_PACKAGE_ID}/`,
      publicDir: false,
      cacheDir: '../.vite-cache',

      resolve: {
         conditions: ['import', 'browser'],
         alias: {
            '~/': `${path.resolve(__dirname, 'src')}/`,
            '$fonts/': `${path.resolve(__dirname, 'fonts')}/`,
            '$shared/': `${path.resolve(__dirname, 'shared')}/`,
         },
      },

      esbuild: {
         target: ['es2022'],
      },

      css: {
         postcss: {
            plugins: [autoprefixer()],
         },
         preprocessorOptions: {
            scss: {
               api: 'modern-compiler',
            },
         },
      },

      define: {
         'process.env.NODE_ENV': JSON.stringify('production'),
         // Probe harness gate: true only under `vite build --mode e2e`.
         __WIRETAP_PROBE__: JSON.stringify(mode === 'e2e'),
      },

      server: {
         port: 30001,
         open: '/game',
         proxy: {
            [`^(/${s_PACKAGE_ID}/(assets|lang|packs|style.css))`]: 'http://localhost:30000',
            [`^(?!/${s_PACKAGE_ID}/)`]: 'http://localhost:30000',
            '/socket.io': { target: 'ws://localhost:30000', ws: true },
         },
      },

      build: {
         outDir: __dirname,
         emptyOutDir: false,
         sourcemap: s_SOURCEMAPS,
         brotliSize: true,
         minify: s_COMPRESS ? 'terser' : false,
         target: ['es2022'],
         terserOptions: s_COMPRESS ? { ecma: 2022 } : void 0,
         lib: {
            entry: './index.js',
            formats: ['es'],
            fileName: 'index',
            cssFileName: 'style',
         },
      },

      plugins: [
         svelte({
            configFile: false,
            preprocess: sveltePreprocess({
               scss: {
                  api: 'modern',
                  prependData: '@use "src/styles/Root.scss" as *;',
               },
               postcss: {
                  plugins: [autoprefixer()],
               },
            }),
            onwarn: (warning, handler) => {
               if (warning.code === 'vite-plugin-svelte-preprocess-many-dependencies') {
                  return;
               }
               handler(warning);
            },
         }),
      ],
   };
};
