import type { ServiceUpdateBlocker } from "@specweave-studio/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/entities", () => ({
  useThreadShells: () => [
    {
      id: "thread-a1",
      environmentId: "env-m1",
      title: "Thread a1",
      activeWork: { label: "Running npm test", startedAt: "2026-11-12T10:00:00Z" },
      source: {},
    },
  ],
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNicknames: () => (environmentId: string) =>
    environmentId === "env-m1" ? "M1" : environmentId === "env-m4" ? "M4" : environmentId,
}));

import { LiveRestartRunningWorkList, RestartRunningWorkList } from "./RestartRunningWorkList";
import { restartWorkCount, restartWorkRows } from "./restartRunningWork.logic";

const blocker = (
  thread: number,
  project: "a" | "b",
  kind: ServiceUpdateBlocker["kind"] = "run",
): ServiceUpdateBlocker =>
  ({
    kind,
    count: 1,
    threadId: `thread-${project}${thread}`,
    threadTitle: `Thread ${project}${thread}`,
    projectId: `project-${project}`,
    projectTitle: project === "a" ? "specweave" : "EasyChamp",
  }) as unknown as ServiceUpdateBlocker;

const text = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child): child is string => typeof child === "string"))
    .join("|");

const rows = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node) => node.props["data-testid"] === "restart-running-work-row");

describe("RestartRunningWorkList", () => {
  const blockers = [1, 2, 3, 4]
    .map((n) => blocker(n, "a"))
    .concat([1, 2, 3].map((n) => blocker(n, "b")));

  it("lists one row per thread with its current step and machine, five until asked for all", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <RestartRunningWorkList
          blockers={blockers}
          machine={{ environmentId: "env-m4", name: "M4" }}
        />,
      );
    });
    expect(text(renderer)).toContain("7 threads running");
    // A thread this window knows says what it does now and where it runs.
    expect(text(renderer)).toContain("Thread a1|Running npm test| · specweave");
    expect(text(renderer)).toContain("M1");
    // One the window does not know runs on the machine that reported it.
    expect(text(renderer)).toContain("Thread b1|Working| · EasyChamp");
    expect(text(renderer)).toContain("M4");
    expect(rows(renderer)).toHaveLength(5);
    const showAll = renderer.root.find(
      (node) => node.type === "button" && node.children.includes("Show all 7 threads"),
    );
    act(() => showAll.props.onClick());
    expect(rows(renderer)).toHaveLength(7);
  });

  it("opens a thread from its row, on the machine it lives on", () => {
    const open = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<RestartRunningWorkList blockers={blockers} onOpenThread={open} />);
    });
    const row = renderer.root.find(
      (node) =>
        node.type === "button" && String(node.props["aria-label"]).startsWith("Open Thread a1"),
    );
    expect(row.props["aria-label"]).toBe("Open Thread a1: Running npm test, on M1");
    act(() => row.props.onClick());
    expect(open).toHaveBeenCalledWith({ environmentId: "env-m1", threadId: "thread-a1" });
  });

  it("says all is quiet once nothing would be cut off", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<RestartRunningWorkList blockers={[]} />);
    });
    expect(text(renderer)).toContain("All quiet|Safe to restart");
    expect(rows(renderer)).toHaveLength(0);
  });
});

describe("LiveRestartRunningWorkList", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("follows what runs while the dialog is open", async () => {
    const answers: Array<ReadonlyArray<ServiceUpdateBlocker> | null> = [
      [blocker(1, "a"), blocker(2, "b")],
      null,
      [],
    ];
    const poll = vi.fn(async () => (answers.length > 0 ? answers.shift()! : []));
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LiveRestartRunningWorkList initial={[blocker(1, "a")]} poll={poll} intervalMs={1_000} />,
      );
    });
    expect(text(renderer)).toContain("1 thread running");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(text(renderer)).toContain("2 threads running");
    expect(rows(renderer)).toHaveLength(2);
    // No answer in time keeps the last list instead of emptying it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(rows(renderer)).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(text(renderer)).toContain("All quiet");
    act(() => renderer.unmount());
    const calls = poll.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(poll.mock.calls.length).toBe(calls);
  });
});

describe("restartWorkRows", () => {
  it("puts running threads first and says what waiting ones wait on", () => {
    const listed = restartWorkRows(
      [blocker(1, "a", "queued"), blocker(2, "a", "request"), blocker(3, "b")],
      () => null,
    );
    expect(listed.map((row) => [row.title, row.state, row.now])).toEqual([
      ["Thread b3", "running", "Working"],
      ["Thread a1", "queued", "1 message queued"],
      ["Thread a2", "question", "Waiting for your answer"],
    ]);
    expect(restartWorkCount(listed)).toBe("3 threads: 1 running");
    expect(restartWorkCount(listed.slice(1))).toBe("2 threads waiting");
  });
});
