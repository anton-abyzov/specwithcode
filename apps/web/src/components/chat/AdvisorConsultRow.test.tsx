import type { OrchestrationV2ProjectedTurnItem } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const reads = vi.hoisted(() => ({ targets: [] as unknown[], item: null as unknown }));

vi.mock("../ChatMarkdown", () => ({
  default: (props: { text: string }) => <div data-markdown>{props.text}</div>,
}));
vi.mock("../../state/queries", () => ({
  useTurnItemDetail: (target: unknown) => {
    reads.targets.push(target);
    return { data: target && reads.item ? { item: reads.item } : undefined };
  },
}));

// The draft store first: loading lib/utils first meets an import cycle.
import "../../composerDraftStore";
import { compactDynamicToolOutput } from "@specweave-studio/shared/toolOutput";
import { AdvisorConsultRow, advisorDisplayName } from "./AdvisorConsultRow";

const at = DateTime.makeUnsafe("2026-11-16T12:00:00.000Z");

function projected(overrides: Record<string, unknown>): OrchestrationV2ProjectedTurnItem {
  return {
    sourceThreadId: "thread-1",
    sourceItemId: "item-1",
    visibility: "visible",
    item: {
      id: "item-1",
      threadId: "thread-1",
      runId: "run-1",
      type: "dynamic_tool",
      toolName: "mcp__studio-code__advisor",
      title: null,
      status: "completed",
      input: {},
      startedAt: at,
      completedAt: at,
      createdAt: at,
      updatedAt: at,
      ...overrides,
    },
  } as never;
}

function render(item: OrchestrationV2ProjectedTurnItem) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AdvisorConsultRow
        projectedItem={item}
        environmentId={"env-1" as never}
        cwd={undefined}
        threadRef={null}
      />,
    );
  });
  return renderer;
}

function textOf(renderer: ReturnType<typeof create>): string {
  const walk = (node: unknown): string =>
    typeof node === "string"
      ? node
      : Array.isArray(node)
        ? node.map(walk).join(" ")
        : node && typeof node === "object" && "children" in node
          ? walk((node as { children: unknown }).children ?? [])
          : "";
  return walk(renderer.toJSON());
}

const result = (value: Record<string, unknown>) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

describe("AdvisorConsultRow", () => {
  it("names the advisor and opens to the advice as Markdown, never JSON", () => {
    const renderer = render(
      projected({
        output: result({
          status: "advice",
          message: "The advisor answered.",
          advice: "**Check** the brief budget first.",
          advisor: "Claude Fable 5.2 on Claude",
          consultsRemaining: 2,
        }),
      }),
    );
    expect(textOf(renderer)).toContain("Asked the advisor");
    expect(textOf(renderer)).toContain("Claude Fable 5.2 on Claude");
    expect(textOf(renderer)).toContain("2 left this run");
    const row = renderer.root.findByProps({ "data-advisor-consult": "advice" });
    act(() => row.props.onClick());
    const markdown = renderer.root.findByProps({ "data-markdown": true });
    expect(markdown.props.children).toBe("**Check** the brief budget first.");
    expect(textOf(renderer)).not.toContain("{");
    expect(textOf(renderer)).not.toContain("structuredContent");
  });

  it("says the advisor is still working", () => {
    const renderer = render(
      projected({
        output: result({ status: "working", message: "The advisor is still thinking." }),
      }),
    );
    expect(textOf(renderer)).toContain("Still working");
    act(() => renderer.root.findByProps({ "data-advisor-consult": "working" }).props.onClick());
    expect(textOf(renderer)).toContain("The advisor is still thinking.");
  });

  it.each([
    ["refused", "Did not ask the advisor", "The advisor is off for this thread."],
    ["failed", "The advisor gave no advice", "The advisor's run failed before it gave advice."],
  ])("shows the message of a %s consult", (status, label, message) => {
    const renderer = render(projected({ output: result({ status, message }) }));
    expect(textOf(renderer)).toContain(label);
    act(() => renderer.root.findByProps({ "data-advisor-consult": status }).props.onClick());
    expect(textOf(renderer)).toContain(message);
  });

  it("reads Asking the advisor while it runs", () => {
    const renderer = render(projected({ status: "running", completedAt: null }));
    expect(textOf(renderer)).toContain("Asking the advisor");
  });

  it("shows Claude's own advisor: advice, hidden and unavailable", () => {
    const advice = render(
      projected({
        toolName: "advisor",
        title: "Asked the advisor (claude-fable-5-2)",
        output: "Split the migration first.",
      }),
    );
    expect(textOf(advice)).toContain("claude-fable-5-2");
    act(() => advice.root.findByProps({ "data-advisor-consult": "advice" }).props.onClick());
    expect(advice.root.findByProps({ "data-markdown": true }).props.children).toBe(
      "Split the migration first.",
    );

    const hidden = render(
      projected({ toolName: "advisor", output: "Advice applied (hidden by Claude)" }),
    );
    expect(textOf(hidden)).toContain("Asked the advisor");
    expect(textOf(hidden)).toContain("Claude built-in");
    expect(textOf(hidden)).toContain("Advice applied (hidden by Claude)");

    const unavailable = render(
      projected({
        toolName: "advisor",
        status: "failed",
        output: "Advisor unavailable (overloaded)",
      }),
    );
    expect(textOf(unavailable)).toContain("Advisor unavailable");
    expect(textOf(unavailable)).toContain("overloaded");
  });

  it("labels a closed row from the wire's short fields before the full result is read", () => {
    reads.item = null;
    const refused = render(
      projected({
        output: compactDynamicToolOutput(
          result({ status: "refused", refusal: "off", message: "Off for this thread." }),
        ),
        outputOmitted: true,
      }),
    );
    refused.root.findByProps({ "data-advisor-consult": "refused" });
    expect(textOf(refused)).toContain("Did not ask the advisor");
    expect(textOf(refused)).not.toContain("Asked the advisor");

    const advice = render(
      projected({
        output: compactDynamicToolOutput(
          result({
            status: "advice",
            message: "Answered.",
            advice: "Private advice.",
            advisor: "GPT 6 on Codex",
            consultsRemaining: 1,
          }),
        ),
        outputOmitted: true,
      }),
    );
    advice.root.findByProps({ "data-advisor-consult": "advice" });
    expect(textOf(advice)).toContain("GPT 6 on Codex");
    expect(textOf(advice)).toContain("1 left this run");
    expect(textOf(advice)).not.toContain("Private advice.");
  });

  it("names Claude's own advisor by its display name, and anything unknown as given", () => {
    const providers = [
      { driver: "codex", models: [{ slug: "gpt-6", name: "GPT 6" }] },
      { driver: "claudeAgent", models: [{ slug: "claude-fable-5-2", name: "Claude Fable 5.2" }] },
    ] as never;
    expect(advisorDisplayName({ advisor: "claude-fable-5-2", builtIn: true }, providers)).toBe(
      "Claude Fable 5.2",
    );
    expect(advisorDisplayName({ advisor: "claude-mystery-9", builtIn: true }, providers)).toBe(
      "claude-mystery-9",
    );
    // The studio-code tool already names the model and provider in words.
    expect(advisorDisplayName({ advisor: "gpt-6", builtIn: false }, providers)).toBe("gpt-6");
    expect(advisorDisplayName({ advisor: null, builtIn: true }, providers)).toBeNull();
  });

  it("reads the withheld result before it shows the consult", () => {
    reads.targets = [];
    reads.item = projected({
      output: result({ status: "advice", message: "ok", advice: "Fetched advice." }),
    }).item;
    const renderer = render(projected({ output: {}, outputOmitted: true }));
    expect(reads.targets.at(-1)).toMatchObject({ threadId: "thread-1", itemId: "item-1" });
    act(() => renderer.root.findByProps({ "data-advisor-consult": "advice" }).props.onClick());
    expect(renderer.root.findByProps({ "data-markdown": true }).props.children).toBe(
      "Fetched advice.",
    );
    reads.item = null;
  });
});
