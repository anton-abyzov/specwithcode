/**
 * While a model picker is open the page behind it must not scroll, but every
 * view inside the picker must: the model list, the front view and secondary
 * views such as "Limits by account".
 */
const PICKER_SCROLLABLE_SELECTOR =
  "[data-model-picker-popup], [data-model-picker-content], [data-project-models-popover]";

/** True when a wheel or touch event on this target may scroll. */
export function allowsPickerOverlayScroll(target: EventTarget | null): boolean {
  return (
    typeof Element !== "undefined" &&
    target instanceof Element &&
    target.closest(PICKER_SCROLLABLE_SELECTOR) !== null
  );
}
