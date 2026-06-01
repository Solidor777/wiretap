<script>
   // Props supplied by WiretapSidebarTab when it mounts this component.
   let { foundryApp } = $props();

   // Reactive click counter proving Svelte 5 runes reactivity inside the Foundry mount.
   let count = $state(0);

   /**
    * Increment the demo counter.
    * @returns {void}
    */
   function increment() {
      count += 1;
   }
</script>

<section class="wiretap">
   <header class="wiretap__header">
      <i class="fa-solid fa-user-secret"></i>
      <h2>{game.i18n.localize('WIRETAP.Title')}</h2>
   </header>

   <p class="wiretap__placeholder">AI bridge coming soon.</p>

   <button
      type="button"
      class="wiretap__counter"
      onclick={increment}
   >
      Clicked {count} {count === 1 ? 'time' : 'times'}
   </button>
</section>

<style lang="scss">
   .wiretap {
      &__header {
         display: flex;
         align-items: center;
         gap: $wiretap-padding;

         i {
            color: $wiretap-accent;
         }
      }

      &__counter {
         border: 1px solid $wiretap-accent;
      }
   }
</style>
