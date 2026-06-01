<script>
   import { connection } from '~/bridge/WiretapConnection.svelte.js';

   /** @type {{ foundryApp: object }} */
   let { foundryApp } = $props();

   // The current draft message in the input box.
   let draft = $state('');

   /**
    * Send the trimmed draft to the sidecar and clear the input.
    * @returns {void}
    */
   function send() {
      const text = draft.trim();
      if (!text) {
         return;
      }
      connection.send(text);
      draft = '';
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
   </header>

   <ul class="wiretap__log">
      {#each connection.messages as entry, index (index)}
         <li
            class="wiretap__entry"
            data-direction={entry.direction}
         >
            {entry.text}
         </li>
      {/each}
   </ul>

   <form
      class="wiretap__compose"
      onsubmit={(event) => {
         event.preventDefault();
         send();
      }}
   >
      <input
         class="wiretap__input"
         type="text"
         placeholder="Message the sidecar…"
         bind:value={draft}
         disabled={connection.status !== 'connected'}
      />
      <button
         type="submit"
         class="wiretap__send"
         disabled={connection.status !== 'connected'}
      >
         Send
      </button>
   </form>
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

      &__log {
         flex: 1;
         overflow-y: auto;
         margin: 0;
         padding: 0;
         list-style: none;
      }

      &__entry {
         padding: 4px $wiretap-padding;

         &[data-direction='out'] {
            text-align: right;
         }
      }

      &__compose {
         display: flex;
         gap: $wiretap-padding;
      }

      &__input {
         flex: 1;
      }

      &__send {
         border: 1px solid $wiretap-accent;
      }
   }
</style>
