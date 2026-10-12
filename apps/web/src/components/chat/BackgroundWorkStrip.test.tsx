import {
  presentPendingBackgroundWork,
  type PendingBackgroundWorkPresentation,
} from "@specweave-studio/client-runtime/state/thread-execution";
import { ThreadId } from "@specweave-studio/contracts";
import type { OrchestrationV2PendingBackgroundTask } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  BackgroundWorkIcon,
  BackgroundWorkLabel,
  BackgroundWorkStopButton,
} from "./BackgroundWorkStrip";

function present(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): PendingBackgroundWorkPresentation {
  const presentation = presentPendingBackgroundWork(tasks);
  if (presentation === null) throw new Error("expected background work");
  return presentation;
}

const renderLabel = (presentation: PendingBackgroundWorkPresentation) =>
  renderToStaticMarkup(
    <BackgroundWorkLabel presentation={presentation} onOpenRelatedThread={() => undefined} />,
  );

/** The text a sighted person reads, without attributes. */
const visibleText = (html: string) => html.replace(/<[^>]*>/g, "");

const COMMAND =
  "ID=$(gh run list -R octo-org/example-api --branch feat/1234-example -L 1 --json databaseId)";

describe("BackgroundWorkLabel", () => {
  it("shows a lone shell command in short monospace form with no label in front", () => {
    const html = renderLabel(present([{ taskId: "watch", kind: "command", description: COMMAND }]));

    expect(visibleText(html)).toBe(
      "gh run list -R octo-org/example-api --branch feat/1234-example -L 1 --json databaseId",
    );
    expect(html).toContain("font-mono");
    expect(html).not.toContain(">Running");
    expect(html).not.toContain(">ID=");
    // The untruncated command stays in the accessible name.
    expect(html).toContain(`aria-label="Running: ${COMMAND.replaceAll('"', "&quot;")}"`);
    // The tooltip trigger takes keyboard focus, so a sighted keyboard user can read it.
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("focus-visible:outline-ring");
  });

  it("names the command that runs after a captured lookup", () => {
    const html = renderLabel(
      present([{ taskId: "watch", kind: "command", description: `${COMMAND}; gh run watch $ID` }]),
    );
    expect(visibleText(html)).toBe("gh run watch $ID");
  });

  it("reads unnamed work as a plain phrase, not as a command called by its noun", () => {
    const html = renderLabel(present([{ taskId: "a", kind: "command" }]));
    expect(visibleText(html)).toBe("Running a command");
    expect(html).not.toContain("font-mono");
    expect(html).not.toContain('tabindex="0"');
    expect(html).toContain('aria-label="Running a command"');

    expect(visibleText(renderLabel(present([{ taskId: "a", kind: "subagent" }])))).toBe(
      "Waiting on a subagent",
    );
  });

  it("opens a lone subagent's thread from its name", () => {
    const html = renderLabel(
      present([
        {
          taskId: "review",
          kind: "subagent",
          description: "Review src/math.ts",
          childThreadId: ThreadId.make("thread:review"),
        },
      ]),
    );

    expect(visibleText(html)).toBe("Review src/math.ts");
    expect(html).toContain('aria-label="Open subagent Review src/math.ts"');
    // A button is already focusable; no extra tab stop.
    expect(html).not.toContain('tabindex="0"');
    expect(html).toContain('aria-label="Waiting on subagent Review src/math.ts"');
    expect(html).not.toContain("font-mono");
  });

  it("counts several pieces of work and names each one for screen readers", () => {
    const html = renderLabel(
      present([
        { taskId: "a", kind: "command", description: "vp run dev" },
        { taskId: "b", kind: "command", description: "tailscale serve" },
        { taskId: "c", kind: "subagent", description: "Review src/math.ts" },
      ]),
    );

    expect(visibleText(html)).toBe("1 subagent · 2 commands");
    expect(html).toContain('aria-label="Show background work: 1 subagent · 2 commands"');
    expect(html).toContain(
      'aria-label="Waiting on 1 subagent and 2 commands: Review src/math.ts, vp run dev, tailscale serve"',
    );
  });
});

describe("BackgroundWorkIcon", () => {
  it("draws the kind and pulses while the work runs", () => {
    const command = renderToStaticMarkup(<BackgroundWorkIcon kind="command" running />);
    expect(command).toContain('data-background-work-kind="command"');
    expect(command).toContain("lucide-square-terminal");
    expect(command).toContain("animate-status-pulse");

    const still = renderToStaticMarkup(<BackgroundWorkIcon kind="subagent" running={false} />);
    expect(still).toContain("lucide-bot");
    expect(still).not.toContain("animate-status-pulse");

    expect(renderToStaticMarkup(<BackgroundWorkIcon kind="workflow" running />)).toContain(
      "lucide-workflow",
    );
    expect(renderToStaticMarkup(<BackgroundWorkIcon kind="monitor" running />)).toContain(
      "lucide-activity",
    );
    expect(renderToStaticMarkup(<BackgroundWorkIcon kind="background_task" running />)).toContain(
      "lucide-hourglass",
    );
  });
});

describe("BackgroundWorkStopButton", () => {
  it("is an icon button named for what it stops", () => {
    const html = renderToStaticMarkup(
      <BackgroundWorkStopButton stopping={false} disabled={false} onStop={() => undefined} />,
    );
    expect(html).toContain('aria-label="Stop background work"');
    expect(html).toMatch(/lucide-square[ "]/);
    expect(html).not.toContain("aria-disabled=");
    expect(visibleText(html)).toBe("");
  });

  it("spins and stays disabled while stopping", () => {
    const html = renderToStaticMarkup(
      <BackgroundWorkStopButton stopping disabled={false} onStop={() => undefined} />,
    );
    expect(html).toContain('aria-label="Stopping background work"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("lucide-loader-circle");
    expect(visibleText(html)).toBe("");
  });

  it("is inert but still hoverable when the thread cannot be operated", () => {
    const html = renderToStaticMarkup(
      <BackgroundWorkStopButton stopping={false} disabled onStop={() => undefined} />,
    );
    expect(html).toContain('aria-disabled="true"');
    // `disabled` would add pointer-events: none and hide the tooltip that names it.
    expect(html).not.toContain(' disabled=""');
  });
});
