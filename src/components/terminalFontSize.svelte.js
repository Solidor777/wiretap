/**
 * Terminal font size for the embedded xterm terminal, controlled by the `terminalFontSize` setting and the
 * toolbar +/- buttons. One module owns the bounds, the reactive size store, and the clamp helper.
 */

/**
 * Smallest allowed terminal font size, in pixels.
 * @type {number}
 */
export const FONT_SIZE_MIN = 8;

/**
 * Largest allowed terminal font size, in pixels.
 * @type {number}
 */
export const FONT_SIZE_MAX = 32;

/**
 * Step between adjacent font sizes, in pixels.
 * @type {number}
 */
export const FONT_SIZE_STEP = 2;

/**
 * Default terminal font size, in pixels.
 * @type {number}
 */
export const FONT_SIZE_DEFAULT = 16;

/**
 * Reactive holder for the active terminal font size (px). The setting onChange and the toolbar both mutate
 * `terminalFontSize.size`, which the terminal component observes to re-apply live.
 * @type {{ size: number }}
 */
export const terminalFontSize = $state({ size: FONT_SIZE_DEFAULT });

/**
 * Clamp a candidate font size to the allowed range.
 * @param {number} size - The desired size in pixels.
 * @returns {number} The size constrained to [FONT_SIZE_MIN, FONT_SIZE_MAX].
 */
export function clampFontSize(size) {
   return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size));
}
