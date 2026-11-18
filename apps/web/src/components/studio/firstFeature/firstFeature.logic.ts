/**
 * The first feature guide's three steps (1398 AC-22), read from live state.
 * Nothing here is stored except what the caller passes in: the server keeps
 * the guide's start and end, and this window keeps its skips and whether the
 * review was opened from the guide. A step is done when the app sees it,
 * never because the guide was pressed, and a step whose state goes back is
 * current again.
 *
 * Pure: the guide and its fixture render what these functions return.
 */
import {
  activeFirstFeatureSample,
  firstFeatureGuideEnd,
  firstFeatureGuideFinishedIn,
  isFirstFeatureSample,
  type FirstFeatureGuide,
  type ProjectBoardCard,
  type ProjectBoardCardReview,
} from "@specweave-studio/contracts";
import { canonicalReviewFamily } from "@specweave-studio/shared/reviewPolicy";

import type { ProviderBrand } from "../../ProviderLogo";
import { modelLabel } from "../../../studio/projectUsageInsights";

export { activeFirstFeatureSample, firstFeatureGuideFinishedIn, isFirstFeatureSample };

// ── Wording (AC-20, AC-22, AC-23, AC-05) ─────────────────────────────────
// Every string goes through `tx` where it is shown, so each is a plain literal.

/** AC-22 step 2's request, word for word. */
export const FIRST_FEATURE_REQUEST =
  "Build a dark mode switch for this page as a new increment with no Review section: plan it, do every task, then verify, review and close it.";
/** AC-23: with no model of a second family ready there is nobody to review it. */
export const FIRST_FEATURE_REQUEST_NO_REVIEW =
  "Build a dark mode switch for this page as a new increment with no Review section: plan it, do every task, then verify and close it.";

export const GUIDE_TITLE = "Your first feature";
export const GUIDE_STEP_SPECWEAVE = "Turn SpecWeave on";
export const GUIDE_STEP_ASK = "Ask for it whole";
export const GUIDE_STEP_REVIEW = "Read the review";
export const SPECWEAVE_SENTENCE = "This project has no plans or board yet. Turn SpecWeave on.";
export const SHOW_ME = "Show me";
export const ASK_SENTENCE =
  "Ask for the whole feature in one request. Your agents plan it, build it, review it and close it.";
export const ASK_SENTENCE_NO_REVIEW =
  "Ask for the whole feature in one request. Your agents plan it, build it and close it.";
export const WRITE_IT_FOR_ME = "Write it for me";
export const OPEN_THE_THREAD = "Open the thread";
export const ASK_PLANNING = "Planning";
export const ASK_WORKING = "Working: {done} of {total} tasks";
export const ASK_IN_REVIEW = "In review";
export const ASK_FIXING = "Fixing what the review found";
export const REVIEW_SENTENCE = "When the card is in Done, open it and read what the review found.";
export const OPEN_THE_REVIEW = "Open the review";
export const REVIEW_SHIP = "Ship";
export const REVIEW_FIX_FIRST = "Fix first";
export const REVIEW_NO_VERDICT = "No verdict";
export const REVIEW_UNNAMED = "A reviewer";
export const REVIEW_SAME_FAMILY = "Reviewed by {model}, the same family that built it.";
export const REVIEW_NONE_NO_FAMILY =
  "No review ran. A review needs a model from a second family, such as {codex} or {muse}.";
export const REVIEW_NONE_RECORDED = "No review is recorded for this feature.";
export const ADD_ONE = "Add one";
export const SKIP_THIS_STEP = "Skip this step";
export const LEAVE_THE_GUIDE = "Leave the guide";
export const WAITING_SPECWEAVE = "Waiting on this step. The Board tab says what went wrong.";
export const WAITING_ASK = "Waiting on this step. The coordinator's last message says why.";
export const END_SENTENCE = "That is the loop: plan, board, work, review, done.";
export const END_REVIEW_ALL = "Review finished features in all projects on this Mac";
export const END_REVIEW_ALL_NOTE = "Each review uses the reviewer's plan.";
export const END_REVIEW_ALL_DONE =
  "On for all projects on this Mac. Each review uses the reviewer's plan.";
export const END_REMOVE = "Remove the sample project";
export const END_REMOVE_CONFIRM =
  "Remove {name} from SpecWithCode? Its folder and files stay on disk.";
export const END_REMOVE_YES = "Remove";
export const END_CANCEL = "Cancel";

// ── Steps ─────────────────────────────────────────────────────────────────

export const GUIDE_STEPS = ["specweave", "ask", "review"] as const;
export type GuideStepId = (typeof GUIDE_STEPS)[number];
export const GUIDE_STEP_LABELS: Readonly<Record<GuideStepId, string>> = {
  specweave: GUIDE_STEP_SPECWEAVE,
  ask: GUIDE_STEP_ASK,
  review: GUIDE_STEP_REVIEW,
};

/** A knot: tied (done), hollow with a dash (skipped), the current one, or one still ahead. */
export type GuideKnotState = "done" | "skipped" | "now" | "later";

/** Where the card is while step 2 runs, read from `projects.board`. */
export type GuideAskStatus =
  | { readonly kind: "planning" }
  | { readonly kind: "working"; readonly done: number; readonly total: number }
  | { readonly kind: "review" }
  | { readonly kind: "fixing" };

/** One recorded review as step 3 lists it, newest first. */
export interface GuideReviewLine {
  /** The reviewer's readable name, or null when the record names none. */
  readonly model: string | null;
  /** The mark to draw; null for a family the app has no mark for. */
  readonly brand: ProviderBrand | null;
  readonly verdict: ProjectBoardCardReview["verdict"];
  /** Known to be another family than the one that built it. */
  readonly crossFamily: boolean;
  readonly at: string;
}

/** What step 3 says under its list, if anything. */
export type GuideReviewNote =
  | { readonly kind: "same-family"; readonly model: string }
  | { readonly kind: "no-second-family" }
  | { readonly kind: "none-recorded" };

export interface GuideInput {
  /** The project's SpecWeave state (`specweaveStateOf`); undefined until it is read. */
  readonly specweave: string | undefined;
  /** SpecWeave's setup failed or needs Node.js (1396 AC-05): step 1 waits on the Board tab. */
  readonly specweaveWaiting: boolean;
  /** The board's cards; null until the board is read, or without SpecWeave. */
  readonly cards: ReadonlyArray<ProjectBoardCard> | null;
  /** The coordinator's last run failed or hit a limit: step 2 waits on its message. */
  readonly askWaiting: boolean;
  /** A model of another family than the builder's can review: null while unknown. */
  readonly secondFamily: boolean | null;
  /** This window saw the feature's card in In review (it may since have gone back to Active). */
  readonly seenInReview: boolean;
  /** The review was opened from step 3. */
  readonly openedReview: boolean;
  readonly skipped: ReadonlyArray<GuideStepId>;
}

export interface GuideView {
  readonly knots: ReadonlyArray<{ readonly id: GuideStepId; readonly state: GuideKnotState }>;
  /** The step shown, or the end once every step is done or skipped. */
  readonly current: GuideStepId | "end";
  /** How far the thread is drawn, 0 to 1, as the first-run stage bar draws it. */
  readonly progress: number;
  /** The feature's card: the sample's first increment. */
  readonly card: ProjectBoardCard | null;
  readonly askStatus: GuideAskStatus | null;
  readonly request: string;
  readonly reviews: ReadonlyArray<GuideReviewLine>;
  readonly reviewNote: GuideReviewNote | null;
  /** The current step is stuck on something the guide cannot fix; says where to look. */
  readonly waiting: string | null;
}

/**
 * The feature's card: the sample's first increment. The request makes one,
 * and a person who asks for more keeps the guide on the first.
 */
export function featureCard(
  cards: ReadonlyArray<ProjectBoardCard> | null,
): ProjectBoardCard | null {
  if (cards === null || cards.length === 0) return null;
  return cards.toSorted((left, right) => left.incrementId.localeCompare(right.incrementId))[0]!;
}

/** Where the card is while it runs. A new increment starts in Active, so Planning is also "no tasks yet". */
export function askStatus(
  card: ProjectBoardCard | null,
  seenInReview: boolean,
): GuideAskStatus | null {
  if (card === null || card.column === "done") return null;
  if (card.column === "review") return { kind: "review" };
  if (card.column === "planned" || card.tasks.total === 0) return { kind: "planning" };
  // Back in Active after a review: a review round added a task (T-11 runs 2 and 3).
  if (seenInReview || (card.reviews?.length ?? 0) > 0) return { kind: "fixing" };
  return { kind: "working", done: card.tasks.done, total: card.tasks.total };
}

const BRAND_BY_FAMILY: Readonly<Record<string, ProviderBrand>> = {
  claude: "claude",
  openai: "openai",
  meta: "meta",
  google: "gemini",
  xai: "grok",
};

/** The mark for a canonical family; none for `unknown`, `other` or a family the app has no mark for. */
export function brandForFamily(family: string | null | undefined): ProviderBrand | null {
  const canonical = canonicalReviewFamily(family);
  return canonical === null ? null : (BRAND_BY_FAMILY[canonical] ?? null);
}

/** Known to be by another family than the author's; an unknown side never counts. */
export function reviewIsCrossFamily(review: Pick<ProjectBoardCardReview, "family" | "author">) {
  const reviewer = canonicalReviewFamily(review.family);
  const author = canonicalReviewFamily(review.author);
  return reviewer !== null && author !== null && reviewer !== author;
}

/** Known to be by the author's own family. */
function reviewIsSameFamily(review: Pick<ProjectBoardCardReview, "family" | "author">) {
  const reviewer = canonicalReviewFamily(review.family);
  return reviewer !== null && reviewer === canonicalReviewFamily(review.author);
}

export function reviewLines(card: ProjectBoardCard | null): ReadonlyArray<GuideReviewLine> {
  return (card?.reviews ?? []).map((review) => ({
    model: review.model === null ? null : modelLabel(review.model),
    brand: brandForFamily(review.family),
    verdict: review.verdict,
    crossFamily: reviewIsCrossFamily(review),
    at: review.at,
  }));
}

/**
 * Step 3's one line under the list (AC-22, AC-23). Same family only when it is
 * known: a review whose family or author is unknown is neither.
 */
export function reviewNote(
  card: ProjectBoardCard | null,
  secondFamily: boolean | null,
): GuideReviewNote | null {
  const reviews = card?.reviews ?? [];
  if (reviews.length === 0) {
    if (secondFamily === false) return { kind: "no-second-family" };
    return card?.column === "done" ? { kind: "none-recorded" } : null;
  }
  if (reviews.some(reviewIsCrossFamily)) return null;
  const same = reviews.find(reviewIsSameFamily);
  if (same === undefined) return null;
  return {
    kind: "same-family",
    model: same.model === null ? REVIEW_UNNAMED : modelLabel(same.model),
  };
}

/** Whether each step is done by what the app sees. */
export function stepsDone(input: GuideInput): Readonly<Record<GuideStepId, boolean>> {
  const card = featureCard(input.cards);
  return {
    specweave: input.specweave === "on",
    ask: card?.column === "done",
    review: input.openedReview && card !== null,
  };
}

export function guideView(input: GuideInput): GuideView {
  const done = stepsDone(input);
  const skipped = new Set(input.skipped);
  // The first step neither done nor skipped; any order of completion lands here.
  const current = GUIDE_STEPS.find((id) => !done[id] && !skipped.has(id)) ?? "end";
  const currentIndex = current === "end" ? GUIDE_STEPS.length - 1 : GUIDE_STEPS.indexOf(current);
  const knots = GUIDE_STEPS.map((id) => ({
    id,
    state: (done[id]
      ? "done"
      : skipped.has(id)
        ? "skipped"
        : id === current
          ? "now"
          : "later") satisfies GuideKnotState as GuideKnotState,
  }));
  const card = featureCard(input.cards);
  const waiting =
    current === "specweave" && input.specweaveWaiting
      ? WAITING_SPECWEAVE
      : current === "ask" && input.askWaiting
        ? WAITING_ASK
        : null;
  return {
    knots,
    current,
    progress: current === "end" ? 1 : currentIndex / (GUIDE_STEPS.length - 1),
    card,
    askStatus: askStatus(card, input.seenInReview),
    request: input.secondFamily === false ? FIRST_FEATURE_REQUEST_NO_REVIEW : FIRST_FEATURE_REQUEST,
    reviews: reviewLines(card),
    reviewNote: reviewNote(card, input.secondFamily),
    waiting,
  };
}

// ── Whether the guide shows ──────────────────────────────────────────────

/** The guide on a sample project: running, left (back from the menu), or finished (its end stays until closed). */
export type GuideShown = "running" | "left" | "finished" | "closed";

export function guideShown(
  project: {
    readonly workspaceSettings?:
      | { readonly sample?: string; readonly firstFeatureGuide?: FirstFeatureGuide }
      | null
      | undefined;
  },
  closedHere: boolean,
): GuideShown | null {
  if (!isFirstFeatureSample(project)) return null;
  const end = firstFeatureGuideEnd(project.workspaceSettings?.firstFeatureGuide);
  if (end === "left") return "left";
  if (end === "finished") return closedHere ? "closed" : "finished";
  return "running";
}

// ── The offer (AC-11, AC-12, AC-20) ──────────────────────────────────────

export const OFFER_TITLE = "Build a first feature";
export const OFFER_TEXT =
  "Your agents plan and build one small feature and another model reviews it, on your own plans.";
export const OFFER_START = "Try a first feature";
export const OFFER_SIGN_IN = "Sign in an agent first";
export const OFFER_CONTINUE_TITLE = "Continue your first feature";
export const OFFER_CONTINUE_TEXT = "Your sample project is where you left it.";
export const OFFER_CONTINUE = "Open it";
export const OFFER_DISMISS = "Dismiss Build a first feature";
export const PALETTE_TITLE = "First feature guide";
export const SAMPLE_REVIEW_WARNING_TITLE = "Automatic review is still on for the sample";

export type FirstFeatureOffer<P> =
  | { readonly kind: "hidden" }
  | { readonly kind: "sign-in" }
  | { readonly kind: "start" }
  | { readonly kind: "continue"; readonly project: P };

/**
 * What Overview offers. Nothing without the server's `firstFeatureSample` or
 * after the card was dismissed. A sample in progress is always "Continue".
 * After a guide finished, here or in a project since removed, the offer is
 * gone for good; the command palette can still make a new sample.
 */
export function firstFeatureOffer<
  P extends Parameters<typeof activeFirstFeatureSample>[0][number],
>(input: {
  readonly supported: boolean;
  /** The server's `firstFeatureFinished`, or this window saw a guide finish. */
  readonly finishedBefore: boolean;
  readonly dismissed: boolean;
  readonly agentReady: boolean;
  /** This machine's projects only. */
  readonly projects: ReadonlyArray<P>;
}): FirstFeatureOffer<P> {
  if (!input.supported || input.dismissed) return { kind: "hidden" };
  const active = activeFirstFeatureSample(input.projects);
  if (active !== undefined) return { kind: "continue", project: active };
  if (input.finishedBefore || firstFeatureGuideFinishedIn(input.projects))
    return { kind: "hidden" };
  return input.agentReady ? { kind: "start" } : { kind: "sign-in" };
}
