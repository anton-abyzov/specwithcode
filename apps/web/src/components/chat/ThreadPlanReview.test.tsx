import type { ThreadIncrementReview } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { reviewSummary, ThreadPlanReview } from "./ThreadPlanReview";

const policy = { family: "openai", model: "gpt-6.1-sol", depth: "deep", required: true };
const sol = {
  model: "gpt-6.1-sol",
  family: "openai",
  head: "3f9a2c1d00",
  verdict: "ship" as const,
  at: "2026-11-13T21:00:00Z",
  reportPath: "/inc/reports/reviews/review-gpt-6.1-sol-1.md",
};

function text(renderer: ReactTestRenderer): string {
  const flat = (node: unknown): string =>
    node === null || node === undefined
      ? ""
      : typeof node === "string"
        ? node
        : Array.isArray(node)
          ? node.map(flat).join("")
          : flat((node as { children?: unknown }).children);
  return flat(renderer.toJSON());
}

function render(review: ThreadIncrementReview | null, onOpenPath?: (path: string) => void) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ThreadPlanReview review={review} onOpenPath={onOpenPath ?? null} />);
  });
  return renderer;
}

describe("ThreadPlanReview", () => {
  it("shows who reviewed which commit and the verdict, and opens the report", () => {
    const open = vi.fn();
    const renderer = render(
      { policy, latest: sol, authorFamily: "claude", policySatisfied: true },
      open,
    );
    expect(text(renderer)).toBe("Reviewed by gpt-6.1-sol at 3f9a2c1 (OpenAI) · ship");
    act(() => renderer.root.findByType("button").props.onClick());
    expect(open).toHaveBeenCalledWith(sol.reportPath);
  });

  it("says the required family is missing and flags a same-family review", () => {
    const renderer = render({
      policy,
      latest: {
        ...sol,
        model: "claude-sonnet-5-5",
        family: "claude",
        head: "4444444",
        verdict: "ship",
      },
      authorFamily: "claude",
      policySatisfied: false,
    });
    expect(text(renderer)).toBe(
      "Reviewed by claude-sonnet-5-5 at 4444444 (Claude) · ship · same family as the author· OpenAI review required",
    );
  });

  it("asks for another family when the policy is cross-family and nothing is on file", () => {
    const renderer = render({
      policy: { family: "cross-family", model: null, depth: "standard", required: true },
      latest: null,
      authorFamily: "claude",
      policySatisfied: false,
    });
    expect(text(renderer)).toBe("Review by another model family required");
  });

  it("renders nothing without a review or a required policy", () => {
    expect(reviewSummary(null)).toBeNull();
    expect(
      reviewSummary({
        policy: { ...policy, required: false },
        latest: null,
        authorFamily: null,
        policySatisfied: false,
      }),
    ).toBeNull();
    expect(render(null).toJSON()).toBeNull();
  });
});
