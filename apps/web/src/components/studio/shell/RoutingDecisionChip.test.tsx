const mocks = vi.hoisted(() => ({ writeMode: "per-key" as "per-key" | "entry" | null }));
vi.mock("../../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ projectSettingsOverrides: {} }),
  useProjectOverrideWriteMode: () => mocks.writeMode,
}));
vi.mock("../../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "env-1" }] }),
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));
import { ProviderInstanceId, type TaskRoutingDecision } from "@specweave-studio/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// The popover renders its content inline here, so the markup holds both faces.
vi.mock("../../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  PopoverPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { feedbackPreference, RoutingDecisionChip, routingChipText } from "./RoutingDecisionChip";

const claude = ProviderInstanceId.make("claudeAgent");
const decision: TaskRoutingDecision = {
  taskClass: "translation",
  confidence: "high",
  moved: true,
  tier: "standard",
  selection: { instanceId: claude, model: "claude-sonnet-5-5" },
  baseline: { instanceId: claude, model: "claude-opus-5-5" },
  escalation: { instanceId: claude, model: "claude-opus-5-5" },
  billing: "subscription",
  reason: "Translation fits Standard: Claude Sonnet 5.5 on Claude Code instead of Claude Opus 5.5.",
  signals: ["translate"],
  decidedAt: "2026-10-20T20:00:00.000Z",
};

describe("RoutingDecisionChip", () => {
  it("renders nothing for a thread Auto did not route", () => {
    expect(renderToStaticMarkup(<RoutingDecisionChip routing={null} entries={undefined} />)).toBe(
      "",
    );
    expect(
      renderToStaticMarkup(<RoutingDecisionChip routing={undefined} entries={undefined} />),
    ).toBe("");
  });

  it("shows the class on its face and the provider, model, reason, cost and escalation inside", () => {
    expect(routingChipText(decision)).toBe("Auto · Translation");
    const html = renderToStaticMarkup(
      <RoutingDecisionChip routing={decision} entries={undefined} />,
    );
    expect(html).toContain("Auto · Translation");
    expect(html).toContain('data-moved="true"');
    expect(html).toContain("Moved");
    expect(html).toContain("Claude Code · Sonnet 5.5 · Standard");
    expect(html).toContain("Instead of");
    expect(html).toContain("Subscription usage");
    expect(html).toContain(decision.reason);
    expect(html).toContain("One retry on");
  });

  it("lists the long-audio steps and marks an unmoved, uncertain decision", () => {
    const html = renderToStaticMarkup(
      <RoutingDecisionChip
        routing={{
          ...decision,
          taskClass: "transcript",
          confidence: "uncertain",
          moved: false,
          escalation: null,
          billing: "api",
          pipeline: ["Transcribe the audio", "Split into 1 chunk", "Process each chunk"],
        }}
        entries={undefined}
      />,
    );
    expect(html).toContain("Kept");
    expect(html).toContain("(uncertain)");
    expect(html).not.toContain("Instead of");
    expect(html).not.toContain("One retry on");
    expect(html).toContain("Billed per token (API)");
    expect(html).toContain("<li>Transcribe the audio</li>");
  });

  it("names OpenRouter billing from the detailed value", () => {
    const html = renderToStaticMarkup(
      <RoutingDecisionChip
        routing={{ ...decision, billing: "api", modelBilling: "paid-router" }}
        entries={undefined}
      />,
    );
    expect(html).toContain("Billed per token (OpenRouter)");
  });

  it("renders model lane, skipped models, and learned preference in popover", () => {
    const laneDecision: TaskRoutingDecision = {
      ...decision,
      lane: "complex",
      skipped: ["Copilot managed · Opus 5.5: at its usage limit"],
      preferenceId: "pref-custom-123",
    };
    expect(routingChipText(laneDecision)).toBe("Lanes · Complex · Translation");
    const html = renderToStaticMarkup(
      <RoutingDecisionChip
        routing={laneDecision}
        entries={undefined}
        projectId={"proj-1" as any}
      />,
    );
    expect(html).toContain("Model lane routing");
    expect(html).toContain("Model lane");
    expect(html).toContain("Complex and creative");
    expect(html).toContain("Skipped in lane");
    expect(html).toContain("Copilot managed · Opus 5.5: at its usage limit");
    expect(html).toContain("Applied rule pref-custom-123");
    expect(html).toContain("Teach this project:");
    expect(html).toContain("Prefer this model");
    expect(html).toContain("Avoid this model");
  });

  it("keeps project feedback disabled until the machine's settings load", () => {
    const feedbackButtons = (html: string) =>
      [...html.matchAll(/<button[^>]*>(Prefer|Avoid) this model<\/button>/g)].map((match) =>
        /\sdisabled=""/.test(match[0]),
      );
    const render = () =>
      renderToStaticMarkup(
        <RoutingDecisionChip routing={decision} entries={undefined} projectId={"proj-1" as any} />,
      );
    expect(feedbackButtons(render())).toEqual([false, false]);
    mocks.writeMode = null;
    try {
      expect(feedbackButtons(render())).toEqual([true, true]);
    } finally {
      mocks.writeMode = "per-key";
    }
  });

  it("records Prefer this model as the person's own rule", () => {
    const now = new Date("2026-10-25T00:00:00.000Z");
    expect(feedbackPreference(decision, "prefer", now)).toMatchObject({
      action: { kind: "prefer", model: decision.selection },
      recordedBy: "person",
      createdAt: "2026-10-25T00:00:00.000Z",
    });
  });
});
