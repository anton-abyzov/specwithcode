import type { RestingComposerControlsMeasurement } from "../composerFooterLayout";
import {
  chipGroupSiblingsWidth,
  MODEL_CHIP_FITS,
  measureModelChipFitWidths,
  type ModelChipFitWidths,
} from "./modelChipFit";

function elementOuterWidth(element: HTMLElement): number {
  const width = element.getBoundingClientRect().width;
  if (width === 0) return 0;
  const style = getComputedStyle(element);
  return (
    width +
    (Number.parseFloat(style.marginInlineStart) || 0) +
    (Number.parseFloat(style.marginInlineEnd) || 0)
  );
}

function elementInlineMarginWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return (
    (Number.parseFloat(style.marginInlineStart) || 0) +
    (Number.parseFloat(style.marginInlineEnd) || 0)
  );
}

/** Padding, borders and margins of the boxes between the picker and the toolbar. */
function pickerWrapperWidth(picker: HTMLElement, controls: HTMLElement): number {
  let width = 0;
  for (let node = picker.parentElement; node && node !== controls; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "contents") continue;
    for (const side of ["Left", "Right"] as const) {
      width +=
        (Number.parseFloat(style[`padding${side}`]) || 0) +
        (Number.parseFloat(style[`border${side}Width`]) || 0) +
        (Number.parseFloat(style[`margin${side}`]) || 0);
    }
  }
  return width;
}

function providerModelPickerNaturalWidth(picker: HTMLElement): number {
  const renderedWidth = picker.getBoundingClientRect().width;
  if (renderedWidth === 0) return 0;
  const style = getComputedStyle(picker);
  const label = picker.querySelector<HTMLElement>('[data-chat-provider-model-picker-label="true"]');
  // Narrow composers deliberately collapse the label with w-0 and flex-none.
  // A flexible label squeezed to zero still needs its natural width recovered.
  const labelIsCollapsed = label?.clientWidth === 0 && getComputedStyle(label).flexGrow === "0";
  const hiddenLabelWidth =
    label && !labelIsCollapsed ? Math.max(0, label.scrollWidth - label.clientWidth) : 0;
  const maxWidth = Number.parseFloat(style.maxWidth);
  const naturalWidth = Math.min(
    renderedWidth + hiddenLabelWidth,
    Number.isFinite(maxWidth) ? maxWidth : Number.POSITIVE_INFINITY,
  );
  return naturalWidth + elementInlineMarginWidth(picker);
}

function providerModelPickerMinimumWidth(picker: HTMLElement): number {
  const minWidth = Number.parseFloat(getComputedStyle(picker).minWidth) || 0;
  return minWidth + elementInlineMarginWidth(picker);
}

function controlBlockWidths(block: HTMLElement): { natural: number; iconOnly: number } {
  const compact = block.dataset.composerBlockIconOnly === "true";
  let natural = elementOuterWidth(block);
  let iconOnly = natural;
  for (const label of block.querySelectorAll<HTMLElement>("[data-composer-control-label]")) {
    // Labels remain mounted at natural width when icons replace them. Reading
    // both variants from one tree avoids duplicate controls or write/read probes.
    const labelStyle = getComputedStyle(label);
    const inFlow = labelStyle.position !== "absolute";
    // Phone widths already hide the build label with sr-only. Its clipping
    // remains in effect even when compact styles replace its one-pixel width.
    if (!inFlow && (!compact || labelStyle.clip !== "auto")) continue;
    const labelWidth = label.scrollWidth;
    const renderedWidth = inFlow ? label.getBoundingClientRect().width : 0;
    const gap = Number.parseFloat(getComputedStyle(label.parentElement!).columnGap) || 0;
    natural += labelWidth - renderedWidth + (inFlow ? 0 : gap);
    iconOnly -= renderedWidth + (inFlow ? gap : 0);
  }
  for (const icon of block.querySelectorAll<HTMLElement>("[data-composer-control-compact-icon]")) {
    const width = elementOuterWidth(icon);
    const gap = Number.parseFloat(getComputedStyle(icon.parentElement!).columnGap) || 0;
    natural -= compact ? width + gap : 0;
    iconOnly += compact ? 0 : width + gap;
  }
  return { natural, iconOnly: Math.min(natural, iconOnly) };
}

/**
 * Read the natural widths of the resting composer controls from the DOM.
 *
 * Both the composer (deciding which blocks move into overflow) and the
 * context strip (deciding whether its labels may expand) read the same
 * numbers, so neither decision depends on what the other one hid last render.
 *
 * Hidden blocks and the unused overflow trigger stay mounted out of flow at
 * full size. The picker is the one flexible item: a model chip reports its
 * width at every fit, any other picker's intended width is recovered from the
 * truncated label.
 */
export function measureRestingComposerControls(
  controls: HTMLElement,
): RestingComposerControlsMeasurement | null {
  const gap = Number.parseFloat(getComputedStyle(controls).columnGap) || 0;
  const picker = controls.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
  const leadingControl =
    picker ?? controls.querySelector<HTMLElement>('[data-chat-provider-unavailable="true"]');
  if (!leadingControl) return null;
  // Separators are display:none on phone widths; a hidden one takes no gap.
  const separator = controls.querySelector<HTMLElement>("[data-resting-controls-separator]");
  const separatorWidth = separator ? elementOuterWidth(separator) : 0;
  const overflow = controls.querySelector<HTMLElement>("[data-resting-controls-overflow]");
  const separatorAndGapWidth = separatorWidth > 0 ? separatorWidth + gap : 0;
  const blocks = Array.from(controls.querySelectorAll<HTMLElement>("[data-resting-block]"));
  const widths = blocks.map(controlBlockWidths);
  // Controls that ride in the picker's own group, such as the coordinator's effort,
  // keep their width at every fit, as does the group's own padding; the toolbar's
  // blocks are counted on their own.
  const groupWidth = picker
    ? chipGroupSiblingsWidth(picker, controls, true) + pickerWrapperWidth(picker, controls)
    : 0;
  const chip = picker ? measureModelChipFitWidths(picker) : null;
  const pickerFitWidths = chip
    ? (Object.fromEntries(
        MODEL_CHIP_FITS.map((fit) => [
          fit,
          chip[fit] + elementInlineMarginWidth(picker!) + groupWidth + separatorAndGapWidth,
        ]),
      ) as unknown as ModelChipFitWidths)
    : null;
  return {
    gap,
    naturalFixedWidth:
      pickerFitWidths?.full ??
      (picker ? providerModelPickerNaturalWidth(picker) : elementOuterWidth(leadingControl)) +
        groupWidth +
        separatorAndGapWidth,
    minimumFixedWidth:
      pickerFitWidths?.icon ??
      (picker ? providerModelPickerMinimumWidth(picker) : elementOuterWidth(leadingControl)) +
        groupWidth +
        separatorAndGapWidth,
    blockWidths: widths.map((width) => width.natural),
    iconOnlyBlockWidths: widths.map((width) => width.iconOnly),
    overflowWidth: overflow ? elementOuterWidth(overflow) : 0,
    ...(pickerFitWidths ? { pickerFitWidths } : {}),
  };
}
