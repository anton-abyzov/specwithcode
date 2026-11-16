// @vitest-environment jsdom

/**
 * A consult's subagent card reads "Advisor consult", not as delegated work.
 */
import * as DateTime from "effect/DateTime";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ purpose: "advisor" as "advisor" | undefined }));

vi.mock("@effect/atom-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...original,
    // The parent's projection, with the one subagent this card shows.
    useAtomValue: (_atom: unknown, select?: (thread: unknown) => unknown) => {
      const thread = {
        projection: {
          subagents: [
            {
              id: "subagent-1",
              childThreadId: "thread-child",
              status: "completed",
              purpose: state.purpose,
              model: null,
              startedAt: null,
              completedAt: null,
            },
          ],
        },
      };
      return select ? select(thread) : thread;
    },
  };
});
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => "thread-atom" },
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => null,
  useProject: () => null,
}));
vi.mock("./AgentElapsed", () => ({ AgentElapsed: () => null }));
vi.mock("@specweave-studio/client-runtime/state/subagentRuntime", () => ({
  projectedSubagentsToRuntime: (agents: ReadonlyArray<unknown>) => agents,
}));
vi.mock("./SubagentTooltipContent", () => ({
  SubagentTooltipContent: (props: { title: string }) => <div data-tooltip-title={props.title} />,
}));
vi.mock("../ThreadHoverCard", () => ({
  ThreadHoverCard: (props: { children: unknown }) => props.children,
  ThreadHoverCardTrigger: (props: { children: unknown }) => props.children,
  ThreadHoverCardPopup: (props: { children: unknown }) => props.children,
}));

// The draft store first: loading lib/utils first meets an import cycle.
import "../../composerDraftStore";
import { V2LifecycleRow } from "./V2LifecycleRow";

const at = DateTime.makeUnsafe("2026-11-16T12:00:00.000Z");

function render() {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <V2LifecycleRow
        item={
          {
            id: "item-1",
            threadId: "thread-1",
            type: "subagent",
            subagentId: "subagent-1",
            providerInstanceId: "codex",
            origin: "app_owned",
            driver: "codex",
            title: "Advisor for Fix the login form",
            status: "completed",
            result: null,
            progress: undefined,
            startedAt: at,
            completedAt: at,
            childThreadId: "thread-child",
          } as never
        }
        environmentId={"env-1" as never}
        createdAt="2026-11-16T12:00:00.000Z"
        timestampFormat="locale"
        providerStatuses={[]}
        runs={[]}
        onOpenThread={() => {}}
      />,
    );
  });
  return renderer;
}

describe("V2LifecycleRow advisor consult", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.purpose = "advisor";
  });

  it("labels the consult's subagent card and its open button", () => {
    const renderer = render();
    const shown = JSON.stringify(renderer.toJSON());
    expect(shown).toContain("Advisor consult");
    expect(shown).not.toContain("Fix the login form");
    expect(
      renderer.root.findAll((node) => node.props["data-advisor-consult"] === "subagent"),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAll((node) => node.props["aria-label"] === "Open Advisor consult"),
    ).not.toHaveLength(0);
    act(() => renderer.unmount());
  });

  it("keeps a delegated task's own title", () => {
    state.purpose = undefined;
    const renderer = render();
    const shown = JSON.stringify(renderer.toJSON());
    expect(shown).not.toContain("Advisor consult");
    expect(shown).toContain("Fix the login form");
    act(() => renderer.unmount());
  });
});
