<script>
   import { connection } from '~/bridge/TerminalConnection.svelte.js';

   // The sidecar URL this tab is attempting to reach, shown so the GM can confirm the target.
   const serverUrl = game.settings.get('wiretap', 'serverUrl');
</script>

<div class="wiretap__offline">
   {#if connection.status === 'connecting'}
      <p class="wiretap__offline-title">{game.i18n.localize('WIRETAP.Sidecar.Connecting')}</p>
   {:else}
      <p class="wiretap__offline-title">{game.i18n.localize('WIRETAP.Sidecar.OfflineTitle')}</p>
      <p class="wiretap__offline-hint">{game.i18n.localize('WIRETAP.Sidecar.OfflineHint')}</p>
   {/if}
   <p class="wiretap__offline-url">{game.i18n.format('WIRETAP.Sidecar.Trying', { url: serverUrl })}</p>
</div>

<style lang="scss">
   .wiretap {
      &__offline {
         flex: 1;
         display: flex;
         flex-direction: column;
         align-items: center;
         justify-content: center;
         gap: $wiretap-padding;
         padding: $wiretap-padding;
         text-align: center;
         opacity: 0.85;
      }

      &__offline-title {
         font-weight: bold;
      }

      &__offline-hint {
         max-width: 40ch;
         opacity: 0.85;
      }

      &__offline-url {
         font-size: 12px;
         opacity: 0.6;
      }
   }
</style>
