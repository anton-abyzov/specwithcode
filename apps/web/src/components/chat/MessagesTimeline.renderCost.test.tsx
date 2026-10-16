// @vitest-environment jsdom

import { EnvironmentId, MessageId } from "@specweave-studio/contracts";
import { act, createRef, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

// Counts the components React actually called in each commit. Installed before
// the renderer loads, which is the only time React looks for the hook.
const renderCost = vi.hoisted(() => {
  const state = { components: 0, byName: new Map<string, number>() };
  // Function, class, forwardRef and simple memo components; the PerformedWork
  // flag marks the ones whose render ran in this commit.
  const COMPONENT_TAGS = new Set([0, 1, 11, 15]);
  type Fiber = {
    tag: number;
    flags: number;
    type: { displayName?: string; name?: string; render?: { name?: string } } | null;
    alternate: Fiber | null;
    child: Fiber | null;
    sibling: Fiber | null;
  };
  // A subtree React bailed out of keeps its old fiber objects, flags and all;
  // only a parent whose child list was cloned this commit has fresh children.
  const visit = (parent: Fiber) => {
    if (parent.alternate !== null && parent.child === parent.alternate.child) return;
    for (let node = parent.child; node !== null; node = node.sibling) {
      if (COMPONENT_TAGS.has(node.tag) && (node.flags & 1) === 1) {
        state.components += 1;
        const name =
          node.type?.displayName ?? node.type?.name ?? node.type?.render?.name ?? "anonymous";
        state.byName.set(name, (state.byName.get(name) ?? 0) + 1);
      }
      visit(node);
    }
  };
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => visit(root.current),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  });
  return state;
});

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));

// Every row mounts, as a list scrolled through end to end would.
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

const { MessagesTimeline } = await import("./MessagesTimeline");

const CREATED_AT = "2026-03-17T19:12:28.000Z";
const TURNS = 60;
const TOKENS = 30;

function message(index: number, role: "user" | "assistant", text: string, streaming = false) {
  return {
    id: `entry-${index}`,
    kind: "message" as const,
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(`message-${index}`),
      role,
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming,
    },
  };
}

const history = Array.from({ length: TURNS * 2 }, (_, index) =>
  message(
    index,
    index % 2 === 0 ? "user" : "assistant",
    index % 2 === 0
      ? `Question ${index}: what does the build do?`
      : `Answer ${index}. It runs **three** steps:\n\n- compile\n- test\n- package\n\nSee \`build.ts\`.`,
  ),
);

// The turn being answered keeps its message object, as the server projection does.
const question = message(TURNS * 2, "user", "And the release step?");

const props = {
  isWorking: true,
  activeTurnInProgress: true,
  listRef: createRef<LegendListRef | null>(),
  latestRun: null,
  turnDiffSummaries: [],
  providerStatuses: [],
  runs: [],
  recoveryRuns: [],
  recoveryItems: [],
  routeThreadKey: "environment-local:thread-1",
  onOpenTurnDiff: () => {},
  onOpenThread: () => {},
  onForkFromRun: async () => {},
  onRollbackCheckpoint: () => {},
  supportsConversationRollback: false,
  onRevertToTurnCount: () => {},
  isRevertingCheckpoint: false,
  openingVideoAttachmentId: null,
  onImageExpand: () => {},
  activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
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

describe("MessagesTimeline render cost", () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(async () => {
    await act(() => renderer?.unmount());
    renderer = undefined;
  });

  it("re-renders only the streaming row's subtree per token", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const streamed = (tokens: number) => [
      ...history,
      question,
      message(TURNS * 2 + 1, "assistant", `Streaming ${"token ".repeat(tokens)}`, true),
    ];
    await act(() => {
      renderer = create(<MessagesTimeline {...props} timelineEntries={streamed(0)} />);
    });
    renderCost.components = 0;
    renderCost.byName.clear();
    const started = performance.now();
    for (let token = 1; token <= TOKENS; token += 1) {
      await act(() => {
        renderer!.update(
          <MessagesTimeline
            {...props}
            contentInsetEndAdjustment={process.env.INSET ? token % 2 : 0}
            timelineEntries={streamed(token)}
          />,
        );
      });
    }
    const elapsed = performance.now() - started;
    const perToken = renderCost.components / TOKENS;
    // STUDIO_RENDER_COST_REPORT=<file> writes the numbers behind this check.
    const report = process.env.STUDIO_RENDER_COST_REPORT;
    if (report) {
      const top = [...renderCost.byName].sort((a, b) => b[1] - a[1]).slice(0, 25);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        report,
        JSON.stringify({ perToken, msPerToken: elapsed / TOKENS, rows: TURNS * 2, top }),
      );
    }
    // The finished rows above the stream must not render again per token.
    expect(perToken).toBeLessThan(TURNS);
    // Nor the minimap's buttons: their rows have not moved.
    expect(renderCost.byName.get("TimelineMinimapNavigationButton") ?? 0).toBe(0);
  });
});
