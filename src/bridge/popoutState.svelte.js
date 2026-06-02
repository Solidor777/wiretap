/**
 * Reactive flag shared between the docked sidebar tab and its pop-out. The pop-out sets `open = true`
 * while mounted; the docked tab observes it to yield the single live terminal to the pop-out.
 * @type {{ open: boolean }}
 */
export const popoutState = $state({ open: false });
