// @vitest-environment jsdom

import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const queryState = vi.hoisted(() => ({
  refresh: vi.fn(),
  data: null as null | { suggestions: ReadonlyArray<{ id: string }> },
}));

vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : queryState.data,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: queryState.refresh,
  }),
}));
vi.mock("../../../studio/projectWorkspace", () => ({
  projectWorkspace: { starterSuggestions: (target: unknown) => ({ target }) },
}));

import {
  coordinatorPlaceholder,
  useCoordinatorPlaceholder,
  useStarterSuggestions,
} from "./StarterSuggestions";

type Input = { enabled: boolean; goal: string; hasMemory: boolean };

function Probe(props: Input & { onResult: (ids: string[]) => void }) {
  const result = useStarterSuggestions({
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("project-1"),
    kind: "code",
    enabled: props.enabled,
    goal: props.goal,
    hasMemory: props.hasMemory,
  });
  props.onResult(result.suggestions.map((s) => s.id));
  return null;
}

describe("useStarterSuggestions", () => {
  let root: ReturnType<typeof createRoot>;
  const render = (input: Input) =>
    act(() => root.render(<Probe {...input} onResult={() => undefined} />));

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    queryState.refresh.mockReset();
    queryState.data = { suggestions: [{ id: "explore" }] };
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => {
    act(() => root.unmount());
  });

  it("asks the host again when the goal is saved", () => {
    render({ enabled: true, goal: "", hasMemory: false });
    expect(queryState.refresh).not.toHaveBeenCalled();
    render({ enabled: true, goal: "Ship the beta", hasMemory: false });
    expect(queryState.refresh).toHaveBeenCalledTimes(1);
    // Same goal, re-rendered: no extra request.
    render({ enabled: true, goal: "Ship the beta", hasMemory: false });
    expect(queryState.refresh).toHaveBeenCalledTimes(1);
    render({ enabled: true, goal: "", hasMemory: false });
    expect(queryState.refresh).toHaveBeenCalledTimes(2);
  });

  it("asks the host again when project memory appears or goes", () => {
    render({ enabled: true, goal: "", hasMemory: false });
    render({ enabled: true, goal: "", hasMemory: true });
    expect(queryState.refresh).toHaveBeenCalledTimes(1);
    render({ enabled: true, goal: "", hasMemory: false });
    expect(queryState.refresh).toHaveBeenCalledTimes(2);
  });

  it("ignores whitespace-only goal edits", () => {
    render({ enabled: true, goal: "Ship", hasMemory: false });
    render({ enabled: true, goal: "Ship  ", hasMemory: false });
    expect(queryState.refresh).not.toHaveBeenCalled();
  });

  it("asks again when hidden cards are shown after a change", () => {
    render({ enabled: true, goal: "", hasMemory: false });
    render({ enabled: false, goal: "Ship", hasMemory: true });
    expect(queryState.refresh).not.toHaveBeenCalled();
    render({ enabled: true, goal: "Ship", hasMemory: true });
    expect(queryState.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("coordinatorPlaceholder", () => {
  const hint = 'Try "how does core.ts work?"';

  it("asks for a first task while the project has no threads", () => {
    expect(coordinatorPlaceholder({ hasThreads: false, hint: null, turn: 1 })).toBe(
      "Describe a task or ask a question",
    );
    expect(coordinatorPlaceholder({ hasThreads: false, hint, turn: 0 })).toBe(
      "Describe a task or ask a question",
    );
    expect(coordinatorPlaceholder({ hasThreads: false, hint, turn: 1 })).toBe(hint);
  });

  it("keeps the coordinator prompt once threads exist", () => {
    expect(coordinatorPlaceholder({ hasThreads: true, hint, turn: 1 })).toBe(
      "Ask the coordinator a question or start a task…",
    );
  });
});

describe("useCoordinatorPlaceholder", () => {
  const explain = {
    id: "explain",
    topic: "explore",
    origin: "repository",
    title: "Explain how core.ts works",
    detail: "src/core.ts is among the most changed files, in 4 recent commits.",
    prompt: 'Start a thread titled "Explain core.ts".',
  } as const;

  function Probe(props: { hasThreads: boolean; onResult: (text: string) => void }) {
    props.onResult(useCoordinatorPlaceholder(props.hasThreads, [explain]));
    return null;
  }

  function openViews(strict: boolean): string[] {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const seen: string[] = [];
    for (let view = 0; view < 4; view++) {
      const root = createRoot(document.createElement("div"));
      let text = "";
      const probe = <Probe hasThreads={false} onResult={(value) => (text = value)} />;
      act(() => root.render(strict ? <StrictMode>{probe}</StrictMode> : probe));
      seen.push(text);
      // The same view keeps its text while it re-renders.
      act(() => root.render(strict ? <StrictMode>{probe}</StrictMode> : probe));
      expect(text).toBe(seen[view]);
      act(() => root.unmount());
    }
    return seen;
  }

  it("takes turns between the plain prompt and the file hint across project views", () => {
    const seen = openViews(false);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[1]).not.toBe(seen[2]);
    expect(seen.slice(0, 2).toSorted()).toEqual([
      "Describe a task or ask a question",
      'Try "how does core.ts work?"',
    ]);
  });

  it("still takes turns under StrictMode, which renders and runs effects twice", () => {
    const seen = openViews(true);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[1]).not.toBe(seen[2]);
  });
});
