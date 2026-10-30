import { createContext, useLayoutEffect, useState } from "react";

/**
 * How much of a model chip shows. The chip is a model control that names its provider
 * and model (`ProviderModelPicker` with `triggerParts`): provider mark, provider name,
 * model name, a state suffix (`ModelStateTag`) and the usage meter. It gives up room in
 * one order on every surface, so the model name stays readable for as long as it fits:
 *
 * - `full`: `Codex · GPT-6.1-Sol ↳ next: Opus 5.5 ◔ 27%`, and a spent limit's
 *   `Limit · resets in 5d 23h`
 * - `model`: the provider's name goes (its mark stays), the state shortens to a word
 *   and a spent limit's detail goes; the ring and the number stay
 * - `short`: the state is its glyph alone and the usage number goes (its ring stays)
 * - `name`: the usage ring and the provider mark go, so a narrow toolbar still names the
 *   model; the mark gives way before the name is cut short, and a long or custom name
 *   may end in an ellipsis here only once its first characters fit
 * - `icon`: the model name goes too; the mark comes back with the state glyph, and the usage
 *   ring wraps the mark (`ModelUsageMarkRing`) so it takes no room of its own
 *
 * The fit follows the room the chip really has, measured from its parts, never the
 * window width. The full identity stays in the accessible name and the tooltip at
 * every fit.
 */
export const MODEL_CHIP_FITS = ["full", "model", "short", "name", "icon"] as const;
export type ModelChipFit = (typeof MODEL_CHIP_FITS)[number];
export type ModelChipFitWidths = Readonly<Record<ModelChipFit, number>>;

/** The parts a fit may leave out; everything else always shows. */
export type ModelChipPart =
  | "mark"
  | "provider"
  | "model"
  | "state-full"
  | "state-short"
  | "usage-ring"
  | "usage-value"
  | "usage-detail";

const PARTS_BY_FIT: Readonly<Record<ModelChipFit, ReadonlySet<ModelChipPart>>> = {
  full: new Set([
    "mark",
    "provider",
    "model",
    "state-full",
    "usage-ring",
    "usage-value",
    "usage-detail",
  ]),
  model: new Set(["mark", "model", "state-short", "usage-ring", "usage-value"]),
  short: new Set(["mark", "model", "usage-ring"]),
  name: new Set(["model"]),
  icon: new Set(["mark"]),
};

export function modelChipShows(fit: ModelChipFit, part: ModelChipPart): boolean {
  return PARTS_BY_FIT[fit].has(part);
}

/**
 * The least of a long model name `name` shows before it gives way to `icon`, in ems. A
 * name under twice this needs its whole width: its first characters alone do not tell
 * the model apart, and `icon` keeps the usage ring.
 */
const MODEL_NAME_MIN_EM = 3;

/** Promotions need a pixel of slack so a fractional width cannot flip the fit back and forth. */
const PROMOTION_SLACK_PX = 1;

/**
 * The richest of `fits` (richest first) whose width is within `available`; the last,
 * leanest one when none is.
 */
export function chooseFit<Fit extends string>(
  fits: readonly Fit[],
  widths: Readonly<Record<Fit, number>>,
  available: number,
  previous?: Fit | null,
): Fit {
  // Only a fit richer than the one showing is a promotion.
  const previousIndex = previous ? fits.indexOf(previous) : 0;
  for (const [index, fit] of fits.entries()) {
    const slack = index < previousIndex ? PROMOTION_SLACK_PX : 0;
    if (widths[fit] <= available - slack) return fit;
  }
  return fits[fits.length - 1]!;
}

/** The richest fit whose width is within `available`; `icon` when none is. */
export function chooseModelChipFit(
  widths: ModelChipFitWidths,
  available: number,
  previous?: ModelChipFit | null,
): ModelChipFit {
  return chooseFit(MODEL_CHIP_FITS, widths, available, previous);
}

/** The box whose gap separates a part from its neighbours, past `display: contents` wrappers. */
function layoutParent(element: Element): Element | null {
  let parent = element.parentElement;
  while (parent && getComputedStyle(parent).display === "contents") parent = parent.parentElement;
  return parent;
}

function inlineMargins(style: CSSStyleDeclaration): number {
  return (
    (Number.parseFloat(style.marginInlineStart) || 0) +
    (Number.parseFloat(style.marginInlineEnd) || 0)
  );
}

/**
 * What one rendering of a fitted element costs: the width that always shows, and each
 * optional part (marked by the data attribute `key` names, `data-model-chip-part` for
 * `modelChipPart`) at its natural width. A part the current fit
 * leaves out stays mounted out of flow at its natural width (see the fit rules in
 * shell.css), so each part costs its natural width, its margins and one gap of the row it
 * sits in. `least` is each part at its first few characters when it is long, for a fit
 * that lets a long name end in an ellipsis; a short part counts whole. Null when there
 * are no parts or the element is not laid out.
 */
export function measureFitParts<Part extends string>(
  root: HTMLElement,
  key: "modelChipPart" | "rowPart",
): {
  readonly always: number;
  readonly costs: ReadonlyMap<Part, number>;
  readonly least: ReadonlyMap<Part, number>;
} | null {
  const attribute = `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  const parts = root.querySelectorAll<HTMLElement | SVGElement>(`[${attribute}]`);
  if (parts.length === 0) return null;
  const rendered = root.getBoundingClientRect().width;
  if (rendered === 0) return null;
  let always = rendered;
  const costs = new Map<Part, number>();
  const least = new Map<Part, number>();
  for (const part of parts) {
    const name = part.dataset[key] as Part;
    const style = getComputedStyle(part);
    const inFlow = style.position !== "absolute" && style.display !== "none";
    const box = part.getBoundingClientRect().width;
    const parent = layoutParent(part);
    const gap = parent ? Number.parseFloat(getComputedStyle(parent).columnGap) || 0 : 0;
    const margins = inlineMargins(style);
    // A safety truncation never hides the real width from the next decision.
    const natural = Math.max(box, part.scrollWidth || 0);
    if (inFlow) always -= box + margins + gap;
    costs.set(name, (costs.get(name) ?? 0) + natural + margins + gap);
    const first = (Number.parseFloat(style.fontSize) || 12) * MODEL_NAME_MIN_EM;
    least.set(
      name,
      (least.get(name) ?? 0) + (natural > 2 * first ? first : natural) + margins + gap,
    );
  }
  return { always, costs, least };
}

/** The chip's border-box width at every fit, read from one rendering; null when it is not a chip. */
export function measureModelChipFitWidths(trigger: HTMLElement): ModelChipFitWidths | null {
  const measured = measureFitParts<ModelChipPart>(trigger, "modelChipPart");
  if (!measured) return null;
  // At `name` a long model name counts only its first few characters, so it truncates
  // rather than vanishing.
  const widthAt = (fit: ModelChipFit) =>
    measured.always +
    [...measured.costs].reduce(
      (sum, [part, cost]) =>
        sum +
        (!modelChipShows(fit, part)
          ? 0
          : fit === "name" && part === "model"
            ? (measured.least.get(part) ?? cost)
            : cost),
      0,
    );
  return {
    full: widthAt("full"),
    model: widthAt("model"),
    short: widthAt("short"),
    name: widthAt("name"),
    icon: widthAt("icon"),
  };
}

/**
 * A host that fits the chip together with its other controls (the chat composer's
 * toolbar) passes the fit down; any chip inside follows it instead of measuring alone.
 */
export const ModelChipFitContext = createContext<ModelChipFit | null>(null);

/** The nearest size container around the chip (a composer's control row), else its parent. */
function chipHost(trigger: HTMLElement): HTMLElement | null {
  for (let node = trigger.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).containerType !== "normal") return node;
  }
  return trigger.parentElement;
}

/** A host toolbar's own controls, which it measures and gives up room for itself. */
const HOST_CONTROLS =
  "[data-resting-block], [data-resting-controls-separator], [data-resting-controls-overflow]";

/**
 * Controls that share the chip's unwrapping group, such as the coordinator's effort
 * beside its model. Empty when the chip sits straight in `boundary` or its group may wrap.
 * `hostMeasured` leaves out the toolbar's own controls, for a toolbar that counts them.
 */
export function chipGroupSiblings(
  trigger: HTMLElement,
  boundary: HTMLElement,
  hostMeasured = false,
): HTMLElement[] {
  const parent = trigger.parentElement;
  if (!parent || parent === boundary) return [];
  const style = getComputedStyle(parent);
  if (!style.display.includes("flex") || style.flexWrap !== "nowrap") return [];
  const siblings: HTMLElement[] = [];
  for (let node = trigger.nextElementSibling; node; node = node.nextElementSibling) {
    if (!(node instanceof HTMLElement)) continue;
    if (hostMeasured && (node.matches(HOST_CONTROLS) || node.querySelector(HOST_CONTROLS)))
      continue;
    siblings.push(node);
  }
  return siblings;
}

/** The room the chip leaves its group's other controls: natural width, labels included. */
export function chipGroupSiblingsWidth(
  trigger: HTMLElement,
  boundary: HTMLElement,
  hostMeasured = false,
): number {
  const siblings = chipGroupSiblings(trigger, boundary, hostMeasured);
  if (siblings.length === 0) return 0;
  const gap = Number.parseFloat(getComputedStyle(trigger.parentElement!).columnGap) || 0;
  let width = 0;
  for (const node of siblings) {
    const box = node.getBoundingClientRect().width;
    if (box === 0) continue;
    // What a squeezed control cut off: its own overflow, and labels that clip their own.
    let trimmed = Math.max(0, node.scrollWidth - node.clientWidth);
    for (const label of node.querySelectorAll<HTMLElement>("[data-composer-control-label]")) {
      trimmed += Math.max(0, label.scrollWidth - label.clientWidth);
    }
    width += box + trimmed + inlineMargins(getComputedStyle(node)) + gap;
  }
  return width;
}

/** From the chip's start edge to the end of its host's content box, less its group's other controls. */
function availableWidth(trigger: HTMLElement, host: HTMLElement): number {
  const hostBox = host.getBoundingClientRect();
  const hostStyle = getComputedStyle(host);
  const box = trigger.getBoundingClientRect();
  const margin = Number.parseFloat(getComputedStyle(trigger).marginInlineEnd) || 0;
  const room =
    hostStyle.direction === "rtl"
      ? box.right - hostBox.left - (Number.parseFloat(hostStyle.paddingLeft) || 0)
      : hostBox.right - (Number.parseFloat(hostStyle.paddingRight) || 0) - box.left;
  return room - margin - chipGroupSiblingsWidth(trigger, host);
}

/**
 * The fit for a chip that lays out on its own line, as the coordinator's wrapping
 * control row does. It measures again whenever the chip's parts or text change.
 */
export function useOwnModelChipFit(trigger: HTMLElement | null, enabled: boolean): ModelChipFit {
  const [fit, setFit] = useState<ModelChipFit>("full");
  useLayoutEffect(() => {
    if (!enabled || !trigger) return;
    const host = chipHost(trigger);
    if (!host) return;
    const measure = () => {
      const widths = measureModelChipFitWidths(trigger);
      if (!widths) return;
      const available = availableWidth(trigger, host);
      setFit((previous) => chooseModelChipFit(widths, available, previous));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    observer.observe(trigger);
    const observeParts = () => {
      for (const part of trigger.querySelectorAll("[data-model-chip-part]")) {
        observer.observe(part);
      }
      for (const sibling of chipGroupSiblings(trigger, host)) observer.observe(sibling);
    };
    observeParts();
    // A new model, state or usage reading swaps parts without resizing the host, and
    // a control can join the chip's group later, as effort does once a run ends.
    const mutations = new MutationObserver(() => {
      observeParts();
      measure();
    });
    mutations.observe(trigger, { childList: true, subtree: true, characterData: true });
    if (trigger.parentElement) mutations.observe(trigger.parentElement, { childList: true });
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [enabled, trigger]);
  return fit;
}
