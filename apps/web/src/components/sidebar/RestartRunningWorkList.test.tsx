import type { ServiceUpdateBlocker } from "@specweave-studio/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/entities", () => ({
  useProjects: () => [{ id: "project-a", title: "specweave" }],
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => <span data-favicon /> }));

import { RestartRunningWorkList } from "./RestartRunningWorkList";

const blocker = (thread: number, project: "a" | "b") =>
  ({
    kind: "run",
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

describe("RestartRunningWorkList", () => {
  const blockers = [1, 2, 3, 4]
    .map((n) => blocker(n, "a"))
    .concat([1, 2, 3].map((n) => blocker(n, "b")));

  it("groups threads under projects and shows five until asked for all", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<RestartRunningWorkList blockers={blockers} />);
    });
    expect(text(renderer)).toContain("specweave|4 running");
    expect(text(renderer)).toContain("EasyChamp|3 running");
    expect(renderer.root.findAll((node) => node.type === "li").length).toBe(2 + 5);
    const showAll = renderer.root.find(
      (node) => node.type === "button" && node.children.includes("Show all 7 threads"),
    );
    act(() => showAll.props.onClick());
    expect(renderer.root.findAll((node) => node.type === "li").length).toBe(2 + 7);
    expect(renderer.root.findAll((node) => node.props["data-favicon"] !== undefined)).toHaveLength(
      1,
    );
  });

  it("opens a thread from its row", () => {
    const open = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<RestartRunningWorkList blockers={blockers} onOpenThread={open} />);
    });
    const row = renderer.root.find(
      (node) =>
        node.type === "button" &&
        node.findAll((child) => child.children.includes("Thread a1")).length > 0,
    );
    act(() => row.props.onClick());
    expect(open).toHaveBeenCalledWith("thread-a1");
  });
});
