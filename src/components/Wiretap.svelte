<script>
   import { onMount } from 'svelte';
   import { Terminal } from '@xterm/xterm';
   import { FitAddon } from '@xterm/addon-fit';
   import '@xterm/xterm/css/xterm.css';
   import { connection } from '~/bridge/TerminalConnection.svelte.js';
   import { TERMINAL_THEMES, terminalTheme } from '~/components/terminalThemes.svelte.js';

   /** @type {{ foundryApp: object }} */
   let { foundryApp } = $props();

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
      // Keep the PTY sized to the viewport.
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

   // Re-theme any open terminal live when the dropdown setting changes (runs in docked + pop-out instances).
   $effect(() => {
      if (term) {
         term.options.theme = TERMINAL_THEMES[terminalTheme.id].theme;
      }
   });

   /**
    * Toggle the terminal: launch the configured command if idle, otherwise close it.
    * @returns {void}
    */
   function toggle() {
      if (connection.running) {
         connection.close();
      } else {
         const command = game.settings.get('wiretap', 'terminalCommand');
         connection.launch(command, term?.cols ?? 80, term?.rows ?? 24);
      }
   }
</script>

<section class="wiretap">
   <header class="wiretap__header">
      <i class="fa-solid fa-user-secret"></i>
      <h2>{game.i18n.localize('WIRETAP.Title')}</h2>
      <span
         class="wiretap__status"
         data-status={connection.status}
      >
         {connection.status}
      </span>
      <button
         type="button"
         class="wiretap__toggle"
         disabled={connection.status !== 'connected'}
         onclick={toggle}
      >
         {connection.running ? game.i18n.localize('WIRETAP.Close') : game.i18n.localize('WIRETAP.Launch')}
      </button>
   </header>

   <div
      class="wiretap__terminal"
      bind:this={viewport}
      style:background={terminalBackground}
   ></div>
</section>

<style lang="scss">
   .wiretap {
      display: flex;
      flex-direction: column;
      height: 100%;

      &__header {
         display: flex;
         align-items: center;
         gap: $wiretap-padding;

         i {
            color: $wiretap-accent;
         }
      }

      &__status {
         margin-left: auto;
         font-size: 12px;
      }

      &__toggle {
         border: 1px solid $wiretap-accent;
      }

      &__terminal {
         flex: 1;
         min-height: 0;
         padding: $wiretap-padding;
      }
   }
</style>
