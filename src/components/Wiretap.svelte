<script>
   import { onMount } from 'svelte';
   import { connection } from '~/bridge/TerminalConnection.svelte.js';
   import { popoutState } from '~/bridge/popoutState.svelte.js';
   import TerminalView from '~/components/TerminalView.svelte';
   import SidecarOffline from '~/components/SidecarOffline.svelte';

   /** @type {{ foundryApp: { isPopout?: boolean } }} */
   let { foundryApp } = $props();

   // Announce the pop-out's presence so the docked tab yields the single live terminal to it.
   onMount(() => {
      if (!foundryApp.isPopout) {
         return undefined;
      }
      popoutState.open = true;
      return () => {
         popoutState.open = false;
      };
   });

   // The pop-out always shows the terminal; the docked tab shows it only when no pop-out is open.
   const showTerminal = $derived(foundryApp.isPopout || !popoutState.open);

   /**
    * Toggle the terminal: launch the configured command if idle, otherwise close it.
    * @returns {void}
    */
   function toggle() {
      if (connection.running) {
         connection.close();
      } else {
         connection.launch(game.settings.get('wiretap', 'terminalCommand'));
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

   {#if !showTerminal}
      <p class="wiretap__popped-out">{game.i18n.localize('WIRETAP.PoppedOut')}</p>
   {:else if connection.status === 'connected'}
      <TerminalView />
   {:else}
      <SidecarOffline />
   {/if}
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

      &__popped-out {
         flex: 1;
         display: flex;
         align-items: center;
         justify-content: center;
         opacity: 0.7;
      }
   }
</style>
