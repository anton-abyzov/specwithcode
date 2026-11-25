/**
 * The guided tour (1486): fourteen stops that point at the real controls for
 * skills, other machines, model tracks and where settings live. Pure data and
 * helpers; the host in GuidedTour.tsx navigates, measures and draws.
 *
 * Labels the app already shows come from their own constants, so the tour
 * never names a section, group or track the app does not.
 */
import { MODEL_TRACK_LABELS } from "@specweave-studio/contracts";

import { SETTINGS_NAV_GROUPS, SETTINGS_SECTION_LABELS } from "../../settings/settingsSearch";

export type GuidedTourRoute =
  | "/"
  | "/settings/general"
  | "/settings/skills"
  | "/settings/models"
  | "/settings/machines";

export interface GuidedTourStep {
  readonly id: string;
  readonly route: GuidedTourRoute;
  /** CSS selectors tried in order; the first one on the page is spotlit. Empty: a centred card. */
  readonly targets: readonly string[];
  /** A required target missing at desktop width is a bug the verifier fails on. */
  readonly required: boolean;
  readonly title: string;
  readonly body: string;
  /** English labels filled into `{name}` slots; the host translates each before filling. */
  readonly labels?: Readonly<Record<string, string>>;
}

const group = (label: string) => {
  const found = SETTINGS_NAV_GROUPS.find((entry) => entry.label === label);
  if (!found) throw new Error(`Settings group ${label} is gone; update the guided tour`);
  return found.label;
};

/** Header row of a settings section found by its search anchor id. */
const sectionHeader = (id: string) => `#${id} > [data-settings-scroll-target]`;

export const GUIDED_TOUR_TITLE = "Guided tour";
export const GUIDED_TOUR_START = "Take the tour";
export const GUIDED_TOUR_SETTING_DESCRIPTION =
  "Fourteen short stops: skills, other machines, model tracks and where settings live.";
export const GUIDED_TOUR_STEP_COUNT = "Step {current} of {total}";
export const GUIDED_TOUR_NEXT = "Next";
export const GUIDED_TOUR_BACK = "Back";
export const GUIDED_TOUR_DONE = "Done";
export const GUIDED_TOUR_SKIP = "Skip tour";

export const GUIDED_TOUR_STEPS: readonly GuidedTourStep[] = [
  {
    id: "welcome",
    route: "/",
    targets: [],
    required: false,
    title: "A quick tour",
    body: "Fourteen stops show where skills, other machines, model tracks and settings live, and nothing changes while you look.",
  },
  {
    id: "projects",
    route: "/",
    targets: ["#sws-side-projects"],
    required: true,
    title: "Projects",
    body: "Each project keeps its chats here, and a chat's menu holds Project settings for it.",
  },
  {
    id: "project-settings",
    route: "/settings/general",
    targets: [`[data-settings-nav-group="${group("Project")}"]`],
    required: true,
    title: "Settings for one project",
    body: "Pages under {project} change only the project you pick at the top of Settings.",
    labels: { project: group("Project") },
  },
  {
    id: "app-settings",
    route: "/settings/general",
    targets: [`[data-settings-nav-group="${group("App")}"]`],
    required: true,
    title: "Global settings",
    body: "{app} and the groups below it apply to the whole app or one machine, and each section says This project, This machine or This device.",
    labels: { app: group("App") },
  },
  {
    id: "skills",
    route: "/settings/skills",
    targets: [sectionHeader("project-skills")],
    required: true,
    title: SETTINGS_SECTION_LABELS["/settings/skills"],
    body: "{skills} lists what each agent loads on one machine, and Across machines compares them.",
    labels: { skills: SETTINGS_SECTION_LABELS["/settings/skills"] },
  },
  {
    id: "skill-search",
    route: "/settings/skills",
    targets: ['[data-testid="skill-update-center"] > :first-child'],
    required: true,
    title: "Find and install a skill",
    body: "Search installed skills and connected repos, then press Install to add one on this machine.",
  },
  {
    id: "skill-switches",
    route: "/settings/skills",
    targets: ['[data-testid="skills-table"]', '[data-testid="skill-update-center"]'],
    required: false,
    title: "Turn skills on and share them",
    body: "Each skill turns on or off per agent, and after an install Also add on puts the same copy on your other machines.",
  },
  {
    id: "track-daily",
    route: "/settings/models",
    targets: ["#model-track-daily > header"],
    required: true,
    title: MODEL_TRACK_LABELS.daily,
    body: "{track} runs routine work on the top model and falls back down the list when a limit hits.",
    labels: { track: MODEL_TRACK_LABELS.daily },
  },
  {
    id: "track-complex",
    route: "/settings/models",
    targets: ["#model-track-complex > header"],
    required: true,
    title: MODEL_TRACK_LABELS.complex,
    body: "{track} takes hard, open-ended work, so put your strongest model at the top.",
    labels: { track: MODEL_TRACK_LABELS.complex },
  },
  {
    id: "track-review",
    route: "/settings/models",
    targets: ["#model-track-review > header"],
    required: true,
    title: MODEL_TRACK_LABELS.review,
    body: "{track} has a different model family check finished work before it ships.",
    labels: { track: MODEL_TRACK_LABELS.review },
  },
  {
    id: "chat-model",
    route: "/",
    targets: ['[data-guided-tour="new-chat"]'],
    required: true,
    title: "One chat's model",
    body: "In a chat, the model chip under the message box changes that chat only, and Switch model and continue… in its menu moves one that is running.",
  },
  {
    id: "machines",
    route: "/settings/machines",
    targets: [sectionHeader("machines")],
    required: true,
    title: SETTINGS_SECTION_LABELS["/settings/machines"],
    body: "{machines} lists this machine and any you join; with one machine, nothing here needs setting until you join another.",
    labels: { machines: SETTINGS_SECTION_LABELS["/settings/machines"] },
  },
  {
    id: "hand-off",
    route: "/settings/machines",
    targets: [sectionHeader("handoff-mode")],
    required: true,
    title: "Moving work between machines",
    body: "Move thread… in a chat's menu runs it on another machine, and Move running threads… hands off everything unfinished.",
  },
  {
    id: "again",
    route: "/settings/general",
    targets: [sectionHeader("guided-tour"), "#guided-tour"],
    required: true,
    title: "Take it again",
    body: "Start this tour again here or from Quick guides on Overview.",
  },
];

/** Every phrase the tour shows, for the catalog test. */
export const GUIDED_TOUR_PHRASES: readonly string[] = [
  ...new Set([
    GUIDED_TOUR_TITLE,
    GUIDED_TOUR_START,
    GUIDED_TOUR_SETTING_DESCRIPTION,
    GUIDED_TOUR_STEP_COUNT,
    GUIDED_TOUR_NEXT,
    GUIDED_TOUR_BACK,
    GUIDED_TOUR_DONE,
    GUIDED_TOUR_SKIP,
    ...GUIDED_TOUR_STEPS.flatMap((step) => [
      step.title,
      step.body,
      ...Object.values(step.labels ?? {}),
    ]),
  ]),
];

export function nextStepIndex(index: number, total = GUIDED_TOUR_STEPS.length): number | null {
  return index + 1 < total ? index + 1 : null;
}

export function backStepIndex(index: number): number {
  return Math.max(0, index - 1);
}

export interface TourRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface CardPlacement {
  readonly top: number;
  readonly left: number;
  readonly side: "below" | "above" | "right" | "center";
}

const GAP = 12;
const MARGIN = 12;

/**
 * Where the card goes: beside a tall narrow target (a sidebar group), else
 * below it, else above it, else centred; always inside the viewport.
 */
export function placeCard(
  target: TourRect | null,
  card: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): CardPlacement {
  const clampLeft = (left: number) =>
    Math.min(Math.max(MARGIN, left), Math.max(MARGIN, viewport.width - card.width - MARGIN));
  const clampTop = (top: number) =>
    Math.min(Math.max(MARGIN, top), Math.max(MARGIN, viewport.height - card.height - MARGIN));
  const center = {
    top: clampTop((viewport.height - card.height) / 2),
    left: clampLeft((viewport.width - card.width) / 2),
    side: "center" as const,
  };
  if (target === null) return center;
  const right = target.left + target.width + GAP;
  if (target.width < viewport.width / 3 && right + card.width + MARGIN <= viewport.width) {
    return { top: clampTop(target.top), left: right, side: "right" };
  }
  const below = target.top + target.height + GAP;
  if (below + card.height + MARGIN <= viewport.height) {
    return { top: below, left: clampLeft(target.left), side: "below" };
  }
  const above = target.top - GAP - card.height;
  if (above >= MARGIN) return { top: above, left: clampLeft(target.left), side: "above" };
  return center;
}
