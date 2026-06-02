<script>
   import { connection } from '~/bridge/TerminalConnection.svelte.js';
   import { terminalController } from '~/components/terminalController.js';
   import {
      terminalFontSize,
      clampFontSize,
      FONT_SIZE_MIN,
      FONT_SIZE_MAX,
      FONT_SIZE_STEP,
   } from '~/components/terminalFontSize.svelte.js';

   /**
    * Persist a new terminal font size; the setting's onChange updates the reactive store live.
    * @param {number} size - The desired size in pixels (clamped to the allowed range).
    * @returns {void}
    */
   function setFontSize(size) {
      game.settings.set('wiretap', 'terminalFontSize', clampFontSize(size));
   }

   /**
    * Restart the terminal with the configured command.
    * @returns {void}
    */
   function restart() {
      connection.restart(game.settings.get('wiretap', 'terminalCommand'));
   }
</script>

<div class="wiretap__toolbar">
   <button
      type="button"
      class="wiretap__tool"
      title={game.i18n.localize('WIRETAP.Toolbar.Clear')}
      aria-label={game.i18n.localize('WIRETAP.Toolbar.Clear')}
      disabled={!connection.running}
      onclick={() => terminalController.clear()}
   >
      <i class="fa-solid fa-eraser"></i>
   </button>
   <button
      type="button"
      class="wiretap__tool"
      title={game.i18n.localize('WIRETAP.Toolbar.Copy')}
      aria-label={game.i18n.localize('WIRETAP.Toolbar.Copy')}
      disabled={!connection.running}
      onclick={() => terminalController.copy()}
   >
      <i class="fa-solid fa-copy"></i>
   </button>
   <button
      type="button"
      class="wiretap__tool"
      title={game.i18n.localize('WIRETAP.Toolbar.FontDecrease')}
      aria-label={game.i18n.localize('WIRETAP.Toolbar.FontDecrease')}
      disabled={terminalFontSize.size <= FONT_SIZE_MIN}
      onclick={() => setFontSize(terminalFontSize.size - FONT_SIZE_STEP)}
   >
      <i class="fa-solid fa-magnifying-glass-minus"></i>
   </button>
   <button
      type="button"
      class="wiretap__tool"
      title={game.i18n.localize('WIRETAP.Toolbar.FontIncrease')}
      aria-label={game.i18n.localize('WIRETAP.Toolbar.FontIncrease')}
      disabled={terminalFontSize.size >= FONT_SIZE_MAX}
      onclick={() => setFontSize(terminalFontSize.size + FONT_SIZE_STEP)}
   >
      <i class="fa-solid fa-magnifying-glass-plus"></i>
   </button>
   <button
      type="button"
      class="wiretap__tool"
      title={game.i18n.localize('WIRETAP.Toolbar.Restart')}
      aria-label={game.i18n.localize('WIRETAP.Toolbar.Restart')}
      disabled={!connection.running}
      onclick={restart}
   >
      <i class="fa-solid fa-rotate-right"></i>
   </button>
</div>

<style lang="scss">
   .wiretap {
      &__toolbar {
         display: flex;
         align-items: center;
         gap: 4px;
         padding: 4px $wiretap-padding;
      }

      &__tool {
         flex: 0 0 auto;
         width: 24px;
         height: 24px;
         display: inline-flex;
         align-items: center;
         justify-content: center;
         border: 1px solid $wiretap-accent;

         &:disabled {
            opacity: 0.4;
         }
      }
   }
</style>
