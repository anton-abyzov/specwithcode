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

import { RoutingDecisionChip, routingChipText } from "./RoutingDecisionChip";

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
});
