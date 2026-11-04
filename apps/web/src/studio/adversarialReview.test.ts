import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { adversarialReviewNotice } from "./adversarialReview";

const codex = ProviderInstanceId.make("codex");
const copilot = ProviderInstanceId.make("copilot");
const providers = [
  {
    instanceId: codex,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    displayName: "Codex",
    models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }],
  },
  {
    instanceId: copilot,
    driver: ProviderDriverKind.make("copilot"),
    enabled: true,
    displayName: "GitHub Copilot",
    models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }],
  },
] as unknown as ServerProvider[];

describe("adversarialReviewNotice", () => {
  it("names the reviewer and offers the review thread", () => {
    expect(
      adversarialReviewNotice(
        {
          status: "started",
          threadId: ThreadId.make("review-thread"),
          reviewer: { instanceId: copilot, model: "gpt-6.1-sol" },
          skipped: [{ selection: { instanceId: codex, model: "gpt-6.1-sol" }, reason: "limited" }],
        },
        providers,
      ),
    ).toEqual({
      type: "success",
      title: "Adversarial review started on GitHub Copilot · GPT-6.1 Sol",
      description: "Skipped Codex · GPT-6.1 Sol: at its usage limit.",
      reviewThreadId: "review-thread",
    });
  });

  it("lists why every reviewer was passed over", () => {
    const notice = adversarialReviewNotice(
      {
        status: "no-reviewer",
        skipped: [
          { selection: { instanceId: codex, model: "gpt-6.1-sol" }, reason: "limited" },
          { selection: { instanceId: copilot, model: "gpt-6.1-sol" }, reason: "signed-out" },
        ],
      },
      providers,
    );
    expect(notice).toEqual({
      type: "warning",
      title: "No other model family can review now",
      description:
        "Codex · GPT-6.1 Sol: at its usage limit; GitHub Copilot · GPT-6.1 Sol: signed out.",
    });
  });

  it("folds a long list and explains an empty one", () => {
    const skip = {
      selection: { instanceId: codex, model: "gpt-6.1-sol" },
      reason: "full",
    } as const;
    expect(
      adversarialReviewNotice({ status: "no-reviewer", skipped: Array(6).fill(skip) }, providers)
        .description,
    ).toMatch(/; and 2 more\.$/);
    expect(
      adversarialReviewNotice({ status: "no-reviewer", skipped: [] }, providers).description,
    ).toBe("Enable or sign in to a provider from another model family, then try again.");
  });
});
