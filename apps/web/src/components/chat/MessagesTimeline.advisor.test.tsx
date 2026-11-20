// @vitest-environment jsdom

/**
 * The advisor branch of the timeline, end to end through MessagesTimeline: a
 * lone consult, a consult inside a work group, Claude's own advisor item, the
 * group header before the full result is read, and the row's open state
 * across a remount.
 */
import { EnvironmentId } from "@specweave-studio/contracts";
import { compactDynamicToolOutput } from "@specweave-studio/shared/toolOutput";
import { act, createRef, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { LegendListRef } from "@legendapp/list/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ expanded: false }));

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));
vi.mock("../ChatMarkdown", () => ({
  default: (props: { text: string }) => <div data-markdown="">{props.text}</div>,
}));
vi.mock("../../state/queries", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/queries")>();
  // The consults here carry their output inline; nothing is read from a server.
  return { ...original, useTurnItemDetail: () => ({ data: undefined }) };
});
vi.mock("./MessagesTimeline.logic", async (importOriginal) => {
  const logic = await importOriginal<typeof import("./MessagesTimeline.logic")>();
  return {
    ...logic,
    deriveMessagesTimelineRowsWithState(
      input: Parameters<typeof logic.deriveMessagesTimelineRowsWithState>[0],
      previous: Parameters<typeof logic.deriveMessagesTimelineRowsWithState>[1],
    ) {
      const projection = logic.deriveMessagesTimelineRowsWithState(input, previous);
      if (!harness.expanded) return projection;
      return logic.deriveMessagesTimelineRowsWithState({
        ...input,
        expandedWorkGroupIds: new Set(
          projection.rows.flatMap((row) =>
            row.kind === "work-toggle" || row.kind === "work-live" ? [row.groupId] : [],
          ),
        ),
      });
    },
  };
});
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  ),
}));

vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    configurable: true,
  });
});

import { MessagesTimeline } from "./MessagesTimeline";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-11-16T12:00:00.000Z";

beforeEach(() => {
  harness.expanded = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

function props() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    providerStatuses: [
      {
        driver: "claudeAgent",
        models: [{ slug: "claude-fable-5-2", name: "Claude Fable 5.2", isCustom: false }],
      },
    ] as never,
    runs: [],
    routeThreadKey: "environment-local:thread-advisor-test",
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    openingVideoAttachmentId: null,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function toolEntry(input: {
  readonly id: string;
  readonly toolName: string;
  readonly output: unknown;
  readonly title?: string | null;
}) {
  const item = {
    id: input.id,
    threadId: "thread-source",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: input.title ?? null,
    startedAt: null,
    completedAt: null,
    updatedAt: {},
    type: "dynamic_tool",
    toolName: input.toolName,
    input: {},
    output: input.output,
  };
  return {
    id: input.id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: {
      id: input.id,
      createdAt: CREATED_AT,
      runId: null,
      label: input.toolName,
      tone: "tool",
      itemType: "dynamic_tool",
      toolTitle: input.toolName,
      toolLifecycleStatus: "completed",
      toolData: { input: item.input, output: item.output },
      structuredPayload: item,
      projectedItem: {
        position: 0,
        visibility: "local",
        sourceThreadId: "thread-source",
        sourceItemId: input.id,
        item,
      },
    },
  };
}

const ADVICE = {
  status: "advice",
  message: "The advisor reviewed this thread's work.",
  advice: "Check the **budget** first.",
  advisor: "GPT 6 on Codex",
  consultsRemaining: 2,
};

const advisorEntry = (id: string, output: unknown) =>
  toolEntry({ id, toolName: "mcp__studio-code__advisor", output });

const otherEntry = (id: string) =>
  toolEntry({
    id,
    toolName: "mcp__studio-code__studio_thread_read",
    output: { messages: [] },
  });

function render(entries: ReadonlyArray<unknown>): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<MessagesTimeline {...props()} timelineEntries={entries as never} />);
  });
  return renderer;
}

function text(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function consultRows(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) => typeof node.type === "string" && node.props["data-advisor-consult"] !== undefined,
  );
}

describe("MessagesTimeline advisor consults", () => {
  it("renders a lone consult as the advisor row and opens it to the advice", () => {
    const renderer = render([advisorEntry("consult-lone", { structuredContent: ADVICE })]);
    try {
      const [row] = consultRows(renderer);
      expect(row?.props["data-advisor-consult"]).toBe("advice");
      const shown = text(renderer);
      expect(shown).toContain("Asked the advisor");
      expect(shown).toContain("GPT 6 on Codex");
      expect(shown).toContain("2 left this run");
      expect(shown).not.toContain("Check the **budget** first.");
      expect(shown).not.toContain('"status":"advice"');
      act(() => row!.props.onClick());
      expect(text(renderer)).toContain("Check the **budget** first.");
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("labels a collapsed group by the consult's status before the full result is read", () => {
    // What the wire carries: the compact output, with no advice or message.
    const refused = compactDynamicToolOutput({
      status: "refused",
      refusal: "off",
      message: "The advisor is off for this thread.",
    });
    const renderer = render([
      otherEntry("read-1"),
      advisorEntry("consult-refused", refused),
      otherEntry("read-2"),
    ]);
    try {
      const shown = text(renderer);
      expect(shown).toContain("Read threads 2 times and tried to ask the advisor");
      expect(shown).not.toMatch(/\band asked the advisor/);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("shows a consult inside an open group and keeps it open across a remount", () => {
    harness.expanded = true;
    const entries = [
      otherEntry("read-1"),
      advisorEntry("consult-grouped", { structuredContent: ADVICE }),
      otherEntry("read-2"),
    ];
    const renderer = render(entries);
    try {
      const [row] = consultRows(renderer);
      expect(row?.props["data-advisor-consult"]).toBe("advice");
      act(() => row!.props.onClick());
      expect(text(renderer)).toContain("Check the **budget** first.");

      // Closing the group unmounts its rows; opening it mounts them again.
      harness.expanded = false;
      act(() => {
        renderer.update(<MessagesTimeline {...props()} timelineEntries={[...entries] as never} />);
      });
      expect(consultRows(renderer)).toHaveLength(0);
      harness.expanded = true;
      act(() => {
        renderer.update(<MessagesTimeline {...props()} timelineEntries={[...entries] as never} />);
      });
      expect(consultRows(renderer)).toHaveLength(1);
      expect(text(renderer)).toContain("Check the **budget** first.");
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("names Claude's own advisor by the model's display name", () => {
    const renderer = render([
      toolEntry({
        id: "consult-claude",
        toolName: "advisor",
        title: "Asked the advisor (claude-fable-5-2)",
        output: "Advice applied (hidden by Claude)",
      }),
    ]);
    try {
      const [row] = consultRows(renderer);
      expect(row?.props["data-advisor-consult"]).toBe("hidden");
      const shown = text(renderer);
      expect(shown).toContain("Claude Fable 5.2");
      expect(shown).not.toContain("claude-fable-5-2");
      expect(shown).toContain("Advice applied (hidden by Claude)");
    } finally {
      act(() => renderer.unmount());
    }
  });
});
