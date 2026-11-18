// The first feature guide and its Overview offer in every state, over synthetic data (1398 T-07).
// `state=<name>` picks one of STATES below, `theme=dark` the dark theme. Nothing here reaches a
// server: the views are the app's own, fed the state the hosts would read.
import type { ProjectBoardCard, ProjectBoardCardReview } from "@specweave-studio/contracts";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { FirstFeatureGuideView } from "../../src/components/studio/firstFeature/FirstFeatureGuideView";
import { FirstFeatureOfferCard } from "../../src/components/studio/firstFeature/FirstFeatureOfferCard";
import {
  SAMPLE_REVIEW_WARNING_TITLE,
  firstFeatureOffer,
  guideView,
  type GuideInput,
} from "../../src/components/studio/firstFeature/firstFeature.logic";
import { stackedThreadToast, toastManager, ToastProvider } from "../../src/components/ui/toast";
import { txNow } from "../../src/i18n";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const card = (over: Partial<ProjectBoardCard> = {}): ProjectBoardCard => ({
  incrementId: "0001-dark-mode-switch",
  title: "Dark mode switch",
  status: "active",
  column: "active",
  tasks: { total: 4, done: 2 },
  blocked: false,
  updatedAt: "2026-11-18T17:00:00.000Z",
  pullRequests: [],
  specPath: null,
  ...over,
});
const review = (over: Partial<ProjectBoardCardReview> = {}): ProjectBoardCardReview => ({
  model: "muse-wonder-full-1.0",
  family: "meta",
  author: "claude",
  verdict: "ship",
  at: "2026-11-18T17:20:00.000Z",
  ...over,
});
const base: GuideInput = {
  specweave: "off",
  specweaveWaiting: false,
  cards: null,
  askWaiting: false,
  secondFamily: true,
  seenInReview: false,
  openedReview: false,
  skipped: [],
};
const on = { ...base, specweave: "on" };
const done = (reviews?: ProjectBoardCardReview[]) => [
  card({ column: "done", tasks: { total: 4, done: 4 }, ...(reviews ? { reviews } : {}) }),
];
const atEnd = { ...on, cards: done([review()]), openedReview: true };

type Guide = { kind: "guide"; input: GuideInput; extra?: Record<string, unknown> };
type Project = Parameters<typeof firstFeatureOffer>[0]["projects"][number] & {
  readonly title?: string;
};
type Offer = {
  kind: "offer";
  offer: Omit<Parameters<typeof firstFeatureOffer>[0], "projects"> & {
    readonly projects: ReadonlyArray<Project>;
  };
  starting?: boolean;
};
const offerBase = {
  supported: true,
  finishedBefore: false,
  dismissed: false,
  agentReady: true,
  projects: [],
};
const continuing = [
  {
    title: "First feature",
    workspaceSettings: {
      sample: "first-feature",
      firstFeatureGuide: { started: "2026-11-18T10:00:00.000Z" },
    },
  },
];

export const STATES: Record<string, Guide | Offer | { kind: "toast" }> = {
  "offer-start": { kind: "offer", offer: offerBase },
  "offer-sign-in": { kind: "offer", offer: { ...offerBase, agentReady: false } },
  "offer-starting": { kind: "offer", offer: offerBase, starting: true },
  "offer-continue": { kind: "offer", offer: { ...offerBase, projects: continuing } },
  "offer-absent-no-key": { kind: "offer", offer: { ...offerBase, supported: false } },
  "offer-absent-finished": { kind: "offer", offer: { ...offerBase, finishedBefore: true } },
  "offer-absent-dismissed": { kind: "offer", offer: { ...offerBase, dismissed: true } },
  "sample-review-warning": { kind: "toast" },
  "step1-specweave": { kind: "guide", input: base },
  "step1-waiting": { kind: "guide", input: { ...base, specweaveWaiting: true } },
  "step2-ask": { kind: "guide", input: on },
  "step2-ask-no-second-family": { kind: "guide", input: { ...on, secondFamily: false } },
  "step2-planning": {
    kind: "guide",
    input: { ...on, cards: [card({ tasks: { total: 0, done: 0 } })] },
  },
  "step2-working": { kind: "guide", input: { ...on, cards: [card()] } },
  "step2-in-review": {
    kind: "guide",
    input: { ...on, cards: [card({ column: "review", tasks: { total: 4, done: 4 } })] },
  },
  "step2-fixing": {
    kind: "guide",
    input: { ...on, cards: [card({ tasks: { total: 5, done: 4 } })], seenInReview: true },
  },
  "step2-waiting": { kind: "guide", input: { ...on, cards: [card()], askWaiting: true } },
  "step3-reviews": {
    kind: "guide",
    input: {
      ...on,
      cards: done([
        review(),
        review({
          model: "gpt-6.1-sol",
          family: "openai",
          verdict: "fix first",
          at: "2026-11-18T17:10:00.000Z",
        }),
      ]),
    },
  },
  "step3-same-family": {
    kind: "guide",
    input: {
      ...on,
      cards: done([review({ model: "claude-sonnet-5-5", family: "claude", verdict: "ship" })]),
    },
  },
  "step3-no-second-family": { kind: "guide", input: { ...on, secondFamily: false, cards: done() } },
  "step3-none-recorded": { kind: "guide", input: { ...on, cards: done() } },
  "skipped-knot": { kind: "guide", input: { ...base, skipped: ["specweave"] } },
  "guide-error": {
    kind: "guide",
    input: on,
    extra: { error: "The guide could not be updated. Try again." },
  },
  end: { kind: "guide", input: atEnd },
  "end-finished-stored": { kind: "guide", input: atEnd, extra: { finishedStored: true } },
  "end-review-all-done": {
    kind: "guide",
    input: atEnd,
    extra: { finishedStored: true, reviewAll: "done" },
  },
  "end-review-all-saving": {
    kind: "guide",
    input: atEnd,
    extra: { finishedStored: true, reviewAll: "saving" },
  },
  "end-review-all-not-allowed": {
    kind: "guide",
    input: atEnd,
    extra: { finishedStored: true, reviewAll: "not-allowed" },
  },
  "end-removing": {
    kind: "guide",
    input: atEnd,
    extra: { finishedStored: true, removing: "removing" },
  },
  "end-remove-confirm": {
    kind: "guide",
    input: atEnd,
    extra: { finishedStored: true, removing: "confirm" },
  },
};

const noop = () => {};
const handlers = {
  onShowMe: noop,
  onWriteRequest: noop,
  onOpenThread: noop,
  onOpenReview: noop,
  onAddReviewer: noop,
  onSkip: noop,
  onLeave: noop,
  onReviewAll: noop,
  onRemove: noop,
  onRemoveConfirm: noop,
  onRemoveCancel: noop,
};

function Toast() {
  useEffect(() => {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        timeout: 0,
        title: txNow(SAMPLE_REVIEW_WARNING_TITLE),
        description:
          "Automatic review could not be turned off for this project: the settings file is read-only.",
      }),
    );
  }, []);
  return null;
}

function Fixture() {
  const state = STATES[params.get("state") ?? "step1-specweave"];
  if (state === undefined) return <p data-fixture-missing="">Unknown state</p>;
  return (
    <ToastProvider>
      <main data-fixture-ready="" className="mx-auto max-w-3xl p-4">
        {state.kind === "offer" ? (
          <FirstFeatureOfferCard
            offer={firstFeatureOffer<Project>(state.offer)}
            starting={state.starting ?? false}
            onStart={noop}
            onDismiss={noop}
          />
        ) : state.kind === "guide" ? (
          <FirstFeatureGuideView
            view={guideView(state.input)}
            projectTitle="First feature"
            finishedStored={false}
            {...handlers}
            {...state.extra}
          />
        ) : (
          <Toast />
        )}
      </main>
    </ToastProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
