import * as DateTime from "effect/DateTime";
import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reviewDelegationBrief, reviewDelegationTarget } from "./reviewDelegation.ts";

const now = Date.parse("2026-11-13T21:00:00.000Z");
const fresh = DateTime.formatIso(DateTime.makeUnsafe(now));

function provider(
  id: string,
  driver: string,
  slugs: ReadonlyArray<string>,
  used: number | null,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: fresh,
    version: null,
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: fresh,
            windows: [
              {
                id: "seven_day",
                kind: "weekly",
                label: "Weekly",
                usedPercent: used,
                resetsAt: "2026-12-05T01:55:06.000Z",
              },
            ],
          },
        }),
    ...over,
  };
}

const sel = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const claude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"], 67);
const codexFull = provider("codex", "codex", ["gpt-6.1-sol", "gpt-6-luna"], 100);
const codexRoom = provider("codex", "codex", ["gpt-6.1-sol", "gpt-6-luna"], 3);
const grok = provider("grok", "grok", ["grok-4.7"], 10);
const author = sel("claudeAgent", "claude-opus-5-5");
const base = {
  author,
  named: null,
  tier: "regular" as const,
  nowMs: now,
};

describe("reviewDelegationTarget", () => {
  it("picks another family from the reviewer order, never the author's", () => {
    const decision = reviewDelegationTarget({
      ...base,
      providers: [claude, codexRoom],
      reviewers: [sel("claudeAgent", "claude-opus-5-5"), sel("codex", "gpt-6.1-sol")],
      policy: null,
    });
    expect(decision.kind).toBe("pick");
    if (decision.kind === "none") return;
    expect(decision.selection).toEqual(sel("codex", "gpt-6.1-sol"));
    expect(decision.reviewerFamily).toBe("openai");
    expect(decision.authorFamily).toBe("claude");
    expect(decision.skipped.map((skip) => skip.reason)).toEqual(["same model family as the work"]);
  });

  it("refuses with reasons instead of falling back to the author's family when OpenAI has no room", () => {
    const decision = reviewDelegationTarget({
      ...base,
      providers: [claude, codexFull],
      reviewers: [sel("codex", "gpt-6.1-sol"), sel("claudeAgent", "claude-sonnet-5-5")],
      policy: { family: "openai", model: "gpt-6.1-sol", depth: "deep", required: true },
    });
    expect(decision.kind).toBe("none");
    if (decision.kind !== "none") return;
    expect(decision.message).toContain("the review needs gpt-6.1-sol (OpenAI)");
    expect(decision.message).toContain("gpt-6.1-sol on codex is usage full");
    expect(decision.message).toContain("Nothing was started");
  });

  it("a cross-family policy moves on to the next other family with room", () => {
    const decision = reviewDelegationTarget({
      ...base,
      providers: [claude, codexFull, grok],
      reviewers: [sel("codex", "gpt-6.1-sol"), sel("grok", "grok-4.7")],
      policy: { family: "cross-family", required: true },
    });
    expect(decision.kind).toBe("pick");
    if (decision.kind === "none") return;
    expect(decision.selection).toEqual(sel("grok", "grok-4.7"));
    expect(decision.skipped).toEqual([
      {
        selection: sel("codex", "gpt-6.1-sol"),
        label: "gpt-6.1-sol on codex",
        reason: "usage full",
      },
    ]);
  });

  it("a policy model is found on whichever provider serves it, even outside the reviewer order", () => {
    const decision = reviewDelegationTarget({
      ...base,
      providers: [claude, codexRoom],
      reviewers: [sel("claudeAgent", "claude-sonnet-5-5")],
      policy: { family: "openai", model: "gpt-6.1-sol" },
    });
    expect(decision.kind === "pick" && decision.selection).toEqual(sel("codex", "gpt-6.1-sol"));
  });

  it("a named same-family model runs as asked, with a warning", () => {
    const decision = reviewDelegationTarget({
      ...base,
      named: sel("claudeAgent", "claude-sonnet-5-5"),
      providers: [claude, codexRoom],
      reviewers: [],
      policy: { family: "openai", required: true },
    });
    expect(decision.kind).toBe("named");
    if (decision.kind === "none") return;
    expect(decision.warning).toContain("same family as the author (Claude)");
    expect(decision.warning).toContain("asks for OpenAI");
  });

  it("the brief names reviewer, author and the record command", () => {
    const decision = reviewDelegationTarget({
      ...base,
      providers: [claude, codexRoom],
      reviewers: [],
      policy: { family: "openai", depth: "deep", required: true },
    });
    if (decision.kind === "none") throw new Error(decision.message);
    const brief = reviewDelegationBrief({
      decision,
      authorLabel: "claude-opus-5-5 on claudeAgent",
      policy: { family: "openai", depth: "deep", required: true },
    });
    expect(brief).toContain("reviewing work written by claude-opus-5-5 on claudeAgent (Claude)");
    expect(brief).toContain("OpenAI, deep depth, required to close");
    expect(brief).toContain(
      `specweave review --record <report.md> --model ${decision.selection.model}`,
    );
  });
});
