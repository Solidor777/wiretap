<script>
   import { onMount } from 'svelte';
   import { Terminal } from '@xterm/xterm';
   import { FitAddon } from '@xterm/addon-fit';
   import '@xterm/xterm/css/xterm.css';
   import { connection } from '~/bridge/TerminalConnection.svelte.js';
   import { TERMINAL_THEMES, terminalTheme } from '~/components/terminalThemes.svelte.js';

   // The DOM node the xterm terminal mounts into.
   let viewport = $state(null);

   // The xterm instance and its fit addon, created on mount.
   /** @type {Terminal | null} */
   let term = null;
   /** @type {FitAddon | null} */
   let fit = null;

   onMount(() => {
      term = new Terminal({
         convertEol: false,
         cursorBlink: true,
         fontSize: 16,
         lineHeight: 1.3,
         fontFamily: "'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', Consolas, 'Courier New', monospace",
         theme: TERMINAL_THEMES[terminalTheme.id].theme,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(viewport);
      fit.fit();

      // Pipe PTY output into the terminal (replays buffered scrollback immediately).
      const detach = connection.attach((chunk) => term?.write(chunk));
      // Forward keystrokes to the PTY.
      term.onData((data) => connection.sendInput(data));
      // Keep the PTY sized to this viewport.
      term.onResize(({ cols, rows }) => connection.resize(cols, rows));

      // Refit on container resize.
      const observer = new ResizeObserver(() => fit?.fit());
      observer.observe(viewport);

      return () => {
         detach();
         observer.disconnect();
         term?.dispose();
         term = null;
         fit = null;
      };
   });

   // Clear the terminal display whenever the session ends, so a stale session is not left on screen.
   $effect(() => {
      if (!connection.running) {
         term?.reset();
      }
   });

   // The active theme's background, used to match the terminal panel padding to the palette.
   const terminalBackground = $derived(TERMINAL_THEMES[terminalTheme.id].theme.background);

   // Re-theme the terminal live when the dropdown setting changes.
   $effect(() => {
      if (term) {
         term.options.theme = TERMINAL_THEMES[terminalTheme.id].theme;
      }
   });
</script>

<div
   class="wiretap__terminal"
   bind:this={viewport}
   style:background={terminalBackground}
></div>

<style lang="scss">
   .wiretap {
      &__terminal {
         flex: 1;
         min-height: 0;
         padding: $wiretap-padding;
      }
   }
</style>
