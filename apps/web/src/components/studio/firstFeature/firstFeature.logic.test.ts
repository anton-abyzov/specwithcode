import type { ProjectBoardCard, ProjectBoardCardReview } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  FIRST_FEATURE_REQUEST,
  FIRST_FEATURE_REQUEST_NO_REVIEW,
  WAITING_ASK,
  WAITING_SPECWEAVE,
  askStatus,
  brandForFamily,
  featureCard,
  firstFeatureOffer,
  guideShown,
  guideView,
  reviewIsCrossFamily,
  reviewNote,
  type GuideInput,
} from "./firstFeature.logic";

const card = (over: Partial<ProjectBoardCard> = {}): ProjectBoardCard => ({
  incrementId: "0001-dark-mode-switch",
  title: "Dark mode switch",
  status: "active",
  column: "active",
  tasks: { total: 2, done: 0 },
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
const input = (over: Partial<GuideInput> = {}): GuideInput => ({
  specweave: "off",
  specweaveWaiting: false,
  cards: null,
  askWaiting: false,
  secondFamily: true,
  seenInReview: false,
  openedReview: false,
  skipped: [],
  ...over,
});

describe("the request (AC-22, AC-23)", () => {
  it("is AC-22's sentence word for word, and drops the review with no second family", () => {
    expect(FIRST_FEATURE_REQUEST).toBe(
      "Build a dark mode switch for this page as a new increment with no Review section: plan it, do every task, then verify, review and close it.",
    );
    expect(FIRST_FEATURE_REQUEST_NO_REVIEW.endsWith("then verify and close it.")).toBe(true);
    expect(guideView(input({ secondFamily: false })).request).toBe(FIRST_FEATURE_REQUEST_NO_REVIEW);
    expect(guideView(input({ secondFamily: null })).request).toBe(FIRST_FEATURE_REQUEST);
  });
});

describe("guideView: steps from live state", () => {
  it("starts on SpecWeave with three knots, the thread undrawn", () => {
    const view = guideView(input());
    expect(view.current).toBe("specweave");
    expect(view.knots.map((knot) => knot.state)).toEqual(["now", "later", "later"]);
    expect(view.progress).toBe(0);
  });

  it("moves to Ask when SpecWeave is on, and to the review once the card is in Done", () => {
    expect(guideView(input({ specweave: "on" })).current).toBe("ask");
    const done = guideView(input({ specweave: "on", cards: [card({ column: "done" })] }));
    expect(done.current).toBe("review");
    expect(done.knots.map((knot) => knot.state)).toEqual(["done", "done", "now"]);
    expect(done.progress).toBe(1);
  });

  it("reaches the end only when the review was opened from the guide", () => {
    const opened = input({ specweave: "on", cards: [card({ column: "done" })], openedReview: true });
    expect(guideView(opened).current).toBe("end");
    // Opening needs a card: the flag alone does not tie the knot.
    expect(guideView(input({ specweave: "on", openedReview: true })).current).toBe("ask");
  });

  it("completes in any order, and a step whose state goes back is current again", () => {
    // The card is in Done but SpecWeave reads off again: step 1 is current, step 2 stays tied.
    const back = guideView(input({ specweave: "unfinished", cards: [card({ column: "done" })] }));
    expect(back.current).toBe("specweave");
    expect(back.knots.map((knot) => knot.state)).toEqual(["now", "done", "later"]);
    // A card back in Active after Done unties step 2.
    expect(guideView(input({ specweave: "on", cards: [card({ column: "active" })] })).current).toBe(
      "ask",
    );
  });

  it("draws a skipped knot as skipped, never as done, and moves on", () => {
    const view = guideView(input({ skipped: ["specweave"] }));
    expect(view.current).toBe("ask");
    expect(view.knots[0]!.state).toBe("skipped");
    const all = guideView(input({ skipped: ["specweave", "ask", "review"] }));
    expect(all.current).toBe("end");
    expect(all.knots.every((knot) => knot.state === "skipped")).toBe(true);
  });

  it("says where to look when the current step is stuck, only on that step", () => {
    expect(guideView(input({ specweaveWaiting: true })).waiting).toBe(WAITING_SPECWEAVE);
    expect(guideView(input({ specweave: "on", askWaiting: true })).waiting).toBe(WAITING_ASK);
    expect(guideView(input({ askWaiting: true })).waiting).toBeNull();
  });
});

describe("featureCard and askStatus (step 2's line)", () => {
  it("follows the sample's first increment", () => {
    const first = card({ incrementId: "0001-a" });
    expect(featureCard([card({ incrementId: "0002-b" }), first])).toBe(first);
    expect(featureCard([])).toBeNull();
    expect(featureCard(null)).toBeNull();
  });

  it("reads Planning, Working, In review and Fixing from the card's place", () => {
    expect(askStatus(card({ column: "planned" }), false)).toEqual({ kind: "planning" });
    // A new increment starts in Active (T-11): with no tasks written yet it is still planning.
    expect(askStatus(card({ tasks: { total: 0, done: 0 } }), false)).toEqual({ kind: "planning" });
    expect(askStatus(card({ tasks: { total: 3, done: 1 } }), false)).toEqual({
      kind: "working",
      done: 1,
      total: 3,
    });
    expect(askStatus(card({ column: "review" }), false)).toEqual({ kind: "review" });
    // Back in Active after In review: a review round added a task.
    expect(askStatus(card(), true)).toEqual({ kind: "fixing" });
    expect(askStatus(card({ reviews: [review({ verdict: "fix first" })] }), false)).toEqual({
      kind: "fixing",
    });
    expect(askStatus(card({ column: "done" }), true)).toBeNull();
    expect(askStatus(null, false)).toBeNull();
  });
});

describe("step 3: the reviews", () => {
  it("lists every review newest first with its mark and verdict", () => {
    const view = guideView(
      input({
        specweave: "on",
        cards: [
          card({
            column: "done",
            reviews: [
              review(),
              review({ model: "claude-sonnet-5-5", family: "claude", verdict: null }),
            ],
          }),
        ],
      }),
    );
    expect(view.reviews.map((line) => [line.model, line.brand, line.verdict, line.crossFamily])).toEqual([
      ["Muse Wonder Full 1.0", "meta", "ship", true],
      ["Claude Sonnet 5.5", "claude", null, false],
    ]);
    expect(view.reviewNote).toBeNull();
  });

  it("says when no review is by another family, only when that is known", () => {
    const same = card({
      column: "done",
      reviews: [review({ model: "claude-sonnet-5-5", family: "claude", author: "claude" })],
    });
    expect(reviewNote(same, true)).toEqual({ kind: "same-family", model: "Claude Sonnet 5.5" });
    // An unknown family or author is not shown to be another family, and not the same either.
    const unknown = card({
      column: "done",
      reviews: [review({ model: null, family: "unknown", author: null })],
    });
    expect(reviewNote(unknown, true)).toBeNull();
    expect(reviewIsCrossFamily({ family: "unknown", author: "claude" })).toBe(false);
    expect(reviewIsCrossFamily({ family: "meta", author: null })).toBe(false);
  });

  it("says no review ran when no second family is ready, and none recorded on a Done card", () => {
    expect(reviewNote(card(), false)).toEqual({ kind: "no-second-family" });
    expect(reviewNote(card({ column: "done" }), true)).toEqual({ kind: "none-recorded" });
    expect(reviewNote(card(), true)).toBeNull();
  });

  it("draws a mark for known families only", () => {
    expect(brandForFamily("openai")).toBe("openai");
    expect(brandForFamily("meta")).toBe("meta");
    expect(brandForFamily("google")).toBe("gemini");
    expect(brandForFamily("xai")).toBe("grok");
    expect(brandForFamily("unknown")).toBeNull();
    expect(brandForFamily("other")).toBeNull();
    expect(brandForFamily(null)).toBeNull();
  });
});

describe("guideShown", () => {
  const sample = (ended?: string) => ({
    workspaceSettings: {
      sample: "first-feature",
      firstFeatureGuide: { started: "2026-11-18T10:00:00.000Z", ...(ended ? { ended } : {}) },
    },
  });
  it("shows on the sample only, keeps a finished end until it is closed here", () => {
    expect(guideShown({ workspaceSettings: {} }, false)).toBeNull();
    expect(guideShown(sample(), false)).toBe("running");
    expect(guideShown(sample("left"), false)).toBe("left");
    expect(guideShown(sample("finished"), false)).toBe("finished");
    expect(guideShown(sample("finished"), true)).toBe("closed");
    // An end this version does not know keeps the guide running.
    expect(guideShown(sample("paused"), false)).toBe("running");
  });
});

describe("firstFeatureOffer (AC-11, AC-12, AC-20)", () => {
  const sample = (id: string, guide: Record<string, string>, deletedAt?: string) => ({
    id,
    deletedAt: deletedAt ?? null,
    workspaceSettings: { sample: "first-feature", firstFeatureGuide: guide },
  });
  const base = { supported: true, finishedBefore: false, dismissed: false, agentReady: true };

  it("offers nothing without the server's key or once dismissed", () => {
    expect(firstFeatureOffer({ ...base, supported: false, projects: [] })).toEqual({ kind: "hidden" });
    expect(firstFeatureOffer({ ...base, dismissed: true, projects: [] })).toEqual({ kind: "hidden" });
  });

  it("asks for an agent first, then offers the sample", () => {
    expect(firstFeatureOffer({ ...base, agentReady: false, projects: [] })).toEqual({
      kind: "sign-in",
    });
    expect(firstFeatureOffer({ ...base, projects: [] })).toEqual({ kind: "start" });
  });

  it("continues the sample in progress, the newest started first", () => {
    const older = sample("older", { started: "2026-11-17T10:00:00.000Z" });
    const newer = sample("newer", { started: "2026-11-18T10:00:00.000Z" });
    const offer = firstFeatureOffer({ ...base, agentReady: false, projects: [older, newer] });
    expect(offer).toEqual({ kind: "continue", project: newer });
  });

  it("is gone for good after a guide finished, here or in a removed project", () => {
    expect(
      firstFeatureOffer({ ...base, projects: [sample("done", { ended: "finished" })] }),
    ).toEqual({ kind: "hidden" });
    // The removed sample is no longer listed: the server's key or this window's flag says it.
    expect(firstFeatureOffer({ ...base, finishedBefore: true, projects: [] })).toEqual({
      kind: "hidden",
    });
    // A left guide brings the offer back as a new sample.
    expect(firstFeatureOffer({ ...base, projects: [sample("left", { ended: "left" })] })).toEqual({
      kind: "start",
    });
  });
});
