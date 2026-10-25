import type { ModelChipFit, ModelChipFitWidths } from "./chat/modelChipFit";

export const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 620;
export const COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX = 780;
const RESTING_COMPOSER_IMAGE_THUMBNAIL_LIMIT = 3;

export function getRestingComposerImagePreviewCounts(imageCount: number): {
  visibleCount: number;
  overflowCount: number;
} {
  const visibleCount = Math.min(imageCount, RESTING_COMPOSER_IMAGE_THUMBNAIL_LIMIT);
  return {
    visibleCount,
    overflowCount: Math.max(0, imageCount - visibleCount),
  };
}

export function shouldUseCompactComposerFooter(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  const breakpoint = options?.hasWideActions
    ? COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
    : COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX;
  return width !== null && width < breakpoint;
}

export function shouldUseRestingComposerLayout(input: {
  isExistingThread: boolean;
  isMobileViewport: boolean;
  isScrollCollapsed: boolean;
  hasExpandedChrome: boolean;
  hasMultilinePrompt: boolean;
  /** Whether the timeline has more content than fits above the composer. */
  timelineOverflows: boolean;
}): boolean {
  // Multiline drafts stay readable. Resting only clamps a single prompt
  // line and overlays its actions; non-image attachment and context
  // rows keep their natural height above it while image previews move inline.
  // Banners and the tasks badge dock above the surface, so they are absent
  // too. The context strip is optional: collapsed controls use it when
  // present and otherwise occupy a compact row inside the composer.
  //
  // Only a timeline scroll rests the composer: the user asked for it with the
  // gesture, and it lifts on the next composer interaction. Losing focus never
  // rests it, so clicking a message, copying output, or selecting text for a
  // citation leaves the composer where it was.
  //
  // Resting exists to give reading space back to the timeline. A thread that
  // fits above the composer has nothing to reclaim, so it stays expanded and
  // never shows the collapsed row that a fresh thread would otherwise open on.
  return (
    input.isExistingThread &&
    !input.isMobileViewport &&
    input.timelineOverflows &&
    input.isScrollCollapsed &&
    !input.hasMultilinePrompt &&
    !input.hasExpandedChrome
  );
}

/**
 * How much taller the empty expanded composer is than its resting row on
 * desktop widths, from the layout classes in ChatComposer: the body loses
 * 8px of top padding, the prompt clamps from min-h-17.5 (70px) to 32px, and
 * the 48px footer leaves flow.
 */
export const COMPOSER_RESTING_EXPANSION_MIN_PX = 94;

/**
 * The space the timeline reserves at its end for the composer overlay.
 *
 * The overlay is measured live, but a resting composer is much shorter than
 * an expanded one. Reserving only the resting height lets a scroll to the end
 * land flush against the short composer, and the expansion that follows then
 * covers the last rows because the timeline never moves for footer growth.
 * While resting, keep the measured expanded height. Estimate the empty
 * expansion only before that measurement exists: strip mounting can otherwise
 * inflate the estimate mid-transition and move the timeline. An expanded
 * measurement is authoritative and may shrink the reservation.
 */
export function resolveComposerTimelineInset(input: {
  currentInset: number;
  overlayHeight: number;
  isResting: boolean;
  restingOnlyHeight?: number;
}): number {
  return input.isResting
    ? Math.max(
        input.currentInset,
        input.overlayHeight +
          (input.currentInset === 0
            ? COMPOSER_RESTING_EXPANSION_MIN_PX - (input.restingOnlyHeight ?? 0)
            : 0),
      )
    : input.overlayHeight;
}

/**
 * Whether the overlay's composer is resting. Only a mounted composer can be:
 * a status bar in its place (a native subagent thread) never is, even if the
 * composer it replaced last reported resting.
 */
export function overlayComposerIsResting(input: {
  composerMounted: boolean;
  composerReportedResting: boolean;
}): boolean {
  return input.composerMounted && input.composerReportedResting;
}

export function shouldAnimateComposerRestingTransition(input: {
  hasCompletedInitialLayout: boolean;
  stateChanged: boolean;
  hasInterruptedAnimation: boolean;
}): boolean {
  return input.hasCompletedInitialLayout && (input.stateChanged || input.hasInterruptedAnimation);
}

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX;
}

export interface RestingComposerControlsMeasurement {
  gap: number;
  naturalFixedWidth: number;
  minimumFixedWidth: number;
  blockWidths: readonly number[];
  overflowWidth: number;
  iconOnlyBlockWidths?: readonly number[];
  /** The model chip's width at every fit (with the separator), when the picker is a chip. */
  pickerFitWidths?: ModelChipFitWidths;
}

function restingComposerControlsWidth(
  input: RestingComposerControlsMeasurement,
  hiddenCount: number,
  fixedWidth = input.naturalFixedWidth,
  iconOnlyCount = 0,
): number {
  const { blockWidths, gap } = input;
  const visibleCount = blockWidths.length - hiddenCount;
  return (
    fixedWidth +
    blockWidths
      .slice(0, visibleCount)
      .reduce(
        (sum, width, index) =>
          sum +
          (index >= blockWidths.length - iconOnlyCount
            ? (input.iconOnlyBlockWidths?.[index] ?? width)
            : width),
        0,
      ) +
    (hiddenCount > 0 ? input.overflowWidth : 0) +
    gap * (visibleCount + (hiddenCount > 0 ? 1 : 0))
  );
}

/**
 * The width the resting controls take with nothing moved into overflow.
 *
 * The context strip reserves this much for the composer before deciding
 * whether its own labels may expand. Judging against the currently visible
 * controls instead lets the strip expand into space the composer just gave
 * up, which shrinks the host, hides the controls again, and repeats.
 */
export function resolveRestingComposerControlsNaturalWidth(
  input: RestingComposerControlsMeasurement,
): number {
  return restingComposerControlsWidth(input, 0);
}

/**
 * Fit footer controls using natural widths: remove trailing labels first,
 * then move trailing blocks into overflow. Resting and expanded share this
 * decision, including the slack needed to safely restore controls.
 *
 * A model chip gives up room in steps of its own (modelChipFit.ts): its provider
 * name and state words go after the trailing labels and before any block moves
 * into overflow, its state shrinks to a glyph once every block is in the overflow
 * menu, then its usage ring goes, and only then does its model name go. A picker that is not a chip may
 * contract to its minimum readable width instead. Below the last step the whole
 * cluster hides rather than clipping.
 */
const RESTING_CONTROLS_SLACK_PX = 1;

type RestingControlsStep = {
  readonly hiddenCount: number;
  readonly iconOnlyCount: number;
  readonly pickerFit: ModelChipFit | null;
};

function restingControlsSteps(
  input: RestingComposerControlsMeasurement,
): readonly RestingControlsStep[] {
  const blockCount = input.blockWidths.length;
  const iconSteps = input.iconOnlyBlockWidths ? blockCount : 0;
  const chip = input.pickerFitWidths !== undefined;
  const steps: RestingControlsStep[] = [];
  for (let iconOnlyCount = 0; iconOnlyCount <= iconSteps; iconOnlyCount += 1) {
    steps.push({ hiddenCount: 0, iconOnlyCount, pickerFit: chip ? "full" : null });
  }
  if (chip) steps.push({ hiddenCount: 0, iconOnlyCount: iconSteps, pickerFit: "model" });
  for (let hiddenCount = 1; hiddenCount <= blockCount; hiddenCount += 1) {
    steps.push({ hiddenCount, iconOnlyCount: iconSteps, pickerFit: chip ? "model" : null });
  }
  if (chip) {
    for (const pickerFit of ["short", "name", "icon"] as const) {
      steps.push({ hiddenCount: blockCount, iconOnlyCount: iconSteps, pickerFit });
    }
  }
  return steps;
}

export function resolveRestingComposerControlsLayout(
  input: RestingComposerControlsMeasurement & {
    hostWidth: number;
    previous?: {
      hiddenCount: number;
      iconOnlyCount?: number;
      visible: boolean;
      pickerFit?: ModelChipFit;
    };
  },
): { hiddenCount: number; iconOnlyCount?: number; visible: boolean; pickerFit?: ModelChipFit } {
  const { blockWidths, hostWidth, previous } = input;
  const steps = restingControlsSteps(input);
  const iconSteps = input.iconOnlyBlockWidths ? blockWidths.length : 0;
  const previousExact = previous
    ? steps.findIndex(
        (candidate) =>
          candidate.hiddenCount === previous.hiddenCount &&
          candidate.iconOnlyCount === Math.min(previous.iconOnlyCount ?? 0, iconSteps) &&
          (candidate.pickerFit === null || candidate.pickerFit === previous.pickerFit),
      )
    : -1;
  const previousStep = previous
    ? previousExact >= 0
      ? previousExact
      : steps.findIndex(
          (candidate) =>
            candidate.hiddenCount === Math.min(previous.hiddenCount, blockWidths.length) &&
            (previous.hiddenCount > 0 ||
              candidate.iconOnlyCount === Math.min(previous.iconOnlyCount ?? 0, iconSteps)),
        )
    : 0;
  const widthAtStep = (
    candidate: RestingControlsStep,
    fixedWidth = candidate.pickerFit
      ? input.pickerFitWidths![candidate.pickerFit]
      : input.naturalFixedWidth,
  ) =>
    restingComposerControlsWidth(input, candidate.hiddenCount, fixedWidth, candidate.iconOnlyCount);
  // Promotions need a pixel of slack: recovering a flexible picker's natural
  // width can jitter by a fraction of a pixel across renders. Demotions are
  // immediate so a threshold cannot clip or flip React between layouts.
  let index = 0;
  while (
    index < steps.length - 1 &&
    widthAtStep(steps[index]!) > hostWidth - (index < previousStep ? RESTING_CONTROLS_SLACK_PX : 0)
  ) {
    index += 1;
  }
  const step = steps[index]!;
  const minimumWidth = widthAtStep(step, input.minimumFixedWidth);
  const visible =
    previous && !previous.visible
      ? minimumWidth <= hostWidth - RESTING_CONTROLS_SLACK_PX
      : minimumWidth <= hostWidth;
  return {
    hiddenCount: step.hiddenCount,
    ...(input.iconOnlyBlockWidths ? { iconOnlyCount: step.iconOnlyCount } : {}),
    visible,
    ...(step.pickerFit ? { pickerFit: step.pickerFit } : {}),
  };
}

export function resolveScrollToEndClearance(input: {
  overlayHeight: number;
  mainSurfaceTop: number;
  button: { left: number; right: number };
  attachments: ReadonlyArray<{ top: number; left: number; right: number }>;
}): number {
  let contentTop = input.mainSurfaceTop;
  let top = contentTop;
  for (const attachment of input.attachments) {
    contentTop = Math.min(contentTop, attachment.top);
    if (attachment.left < input.button.right && attachment.right > input.button.left) {
      top = Math.min(top, attachment.top);
    }
  }
  return Math.ceil(input.overlayHeight - (top - contentTop));
}
