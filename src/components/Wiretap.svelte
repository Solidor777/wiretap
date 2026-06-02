<script>
   import { onMount } from 'svelte';
   import { Terminal } from '@xterm/xterm';
   import { FitAddon } from '@xterm/addon-fit';
   import '@xterm/xterm/css/xterm.css';
   import { connection } from '~/bridge/TerminalConnection.svelte.js';

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
      term = new Terminal({ convertEol: false, cursorBlink: true });
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
