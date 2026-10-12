import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderSubagentBar } from "./ProviderSubagentBar";

const render = (
  status: "running" | "completed" | "failed" | "idle",
  step: string | null,
  onOpenParent: (() => void) | null = null,
) =>
  renderToStaticMarkup(
    <ProviderSubagentBar
      provider={null}
      showInstanceBadge={false}
      modelLabel="Claude Opus 5.5"
      effortLabel="Medium"
      status={{
        status,
        startedAt: "2026-10-11T16:00:00.000Z",
        completedAt: status === "completed" ? "2026-10-11T16:01:00.000Z" : null,
      }}
      step={step}
      onOpenParent={onOpenParent}
    />,
  );

describe("ProviderSubagentBar", () => {
  it("shows a working subagent's live step with a pulsing dot", () => {
    const html = render("running", "Running a command");
    expect(html).toContain("· Running a command");
    expect(html).toContain('data-subagent-status-glyph="live"');
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Runs on its own");
  });

  it("drops the step and the pulse once the subagent is done", () => {
    const html = render("completed", "Running a command");
    expect(html).not.toContain("Running a command");
    expect(html).not.toContain("animate-pulse");
    expect(html).toContain('data-subagent-status-glyph="done"');
    expect(html).toContain("Runs on its own");
  });

  it("marks a failed subagent with its own glyph", () => {
    expect(render("failed", null)).toContain('data-subagent-status-glyph="failed"');
  });

  it("names the model in an accessible label and announces the status", () => {
    const html = render("completed", null);
    expect(html).toContain('aria-label="Model: Claude Opus 5.5, Medium"');
    expect(html).toContain("Claude Opus 5.5, Medium subagent: Completed");
    // The model's name shows only when the bar is wide enough, the effort when wider.
    expect(html).toContain("@[36rem]/subagent-bar:inline");
    expect(html).toMatch(/@\[42rem\]\/subagent-bar:inline">Medium</);
  });

  it("lets keyboard users reach the model tooltip", () => {
    expect(render("completed", null)).toMatch(/role="img" tabindex="0" aria-label="Model: /);
  });

  it("shows an idle subagent with a still glyph, not a loader", () => {
    const html = render("idle", null);
    expect(html).toContain('data-subagent-status-glyph="idle"');
    expect(html).not.toContain('data-subagent-status-glyph="starting"');
  });

  it("spins the loader only while starting, and not with reduced motion", () => {
    const html = renderToStaticMarkup(
      <ProviderSubagentBar
        provider={null}
        showInstanceBadge={false}
        modelLabel="Claude Opus 5.5"
        effortLabel={null}
        status={null}
        onOpenParent={null}
      />,
    );
    expect(html).toContain('data-subagent-status-glyph="starting"');
    expect(html).toContain("animate-spin");
    expect(html).toContain("motion-reduce:animate-none");
  });

  it("opens the parent from an icon button with a label", () => {
    const html = render("completed", null, () => {});
    expect(html).toContain('aria-label="Open parent thread"');
    expect(html).not.toContain(">Open parent<");
  });

  it("offers no parent button without a parent", () => {
    expect(render("completed", null)).not.toContain("Open parent thread");
  });
});
