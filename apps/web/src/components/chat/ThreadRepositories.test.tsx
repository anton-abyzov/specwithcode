// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProjectFoundRepository, ThreadRepositories } from "@specweave-studio/contracts";

vi.mock("../../studio/projectWorkspace", () => ({ projectWorkspace: {} }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null, refresh() {} }) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: Error }) => failure.error,
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  PopoverPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { ThreadRepositoriesList, ThreadRepositoryEventRows } from "./ThreadRepositories";
import { threadRepositoryEvents } from "../BranchToolbar.logic";

const repository = (name: string, extra: object = {}) => ({
  relativePath: `repositories/acme/${name}`,
  name,
  path: `/threads/t/repositories/acme/${name}`,
  repository: `/work/repositories/acme/${name}`,
  baseRef: "origin/main",
  addedBy: "agent" as const,
  addedAt: "2026-11-12T10:00:00.000Z",
  dependencies: "installed" as const,
  changed: true,
  ...extra,
});
const thread: ThreadRepositories = {
  folder: "/threads/t",
  branch: "fix/environment-list",
  limit: 8,
  repositories: [
    repository("specwithcode-dev"),
    repository("specweave", {
      baseRef: "home-animated-story",
      dependencies: "not_installed",
      changed: false,
      addedBy: "user",
      addedAt: "2026-11-12T11:00:00.000Z",
    }),
  ],
};
const found = ["specwithcode-dev", "specweave", "vskill"].map(
  (name) =>
    ({
      relativePath: `repositories/acme/${name}`,
      path: `/work/repositories/acme/${name}`,
      name,
      origin: `acme/${name}`,
      state: "available",
    }) as ProjectFoundRepository,
);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent) === label,
  );

describe("ThreadRepositoriesList", () => {
  it("lists each repository with its base, changes, dependencies and pull request", () => {
    act(() =>
      root.render(
        <ThreadRepositoriesList
          thread={thread}
          found={found}
          pullRequests={[
            { repository: "acme/specwithcode-dev", number: 190, url: "https://x/190" },
          ]}
          adding={null}
          error={null}
          onAdd={() => {}}
        />,
      ),
    );
    const text = host.textContent ?? "";
    expect(text).toContain("fix/environment-list · 2 repositories");
    expect(text).toContain("worktree from origin/main · dependencies installed");
    expect(text).toContain("worktree from home-animated-story · dependencies not installed");
    expect(
      [...host.querySelectorAll("[data-thread-repository] span")].map((node) => node.textContent),
    ).toEqual(["Changed", "No changes"]);
    expect(host.querySelector("a")?.textContent).toBe("#190");
    expect(text).toContain("One pull request per repository with commits.");
  });

  it("adds a repository the thread does not hold through one click", () => {
    const onAdd = vi.fn();
    act(() =>
      root.render(
        <ThreadRepositoriesList
          thread={thread}
          found={found}
          adding={null}
          error={null}
          onAdd={onAdd}
        />,
      ),
    );
    act(() => button("Add repository")!.click());
    expect(button("Add specweave")).toBeUndefined();
    act(() => button("Add vskill")!.click());
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ name: "vskill" }));
  });

  it("hides Add repository on a server that does not find repositories, and shows a refusal", () => {
    act(() =>
      root.render(
        <ThreadRepositoriesList
          thread={{ ...thread, repositories: [] }}
          found={undefined}
          adding={null}
          error="Only 1.2 GB is free on this machine's disk"
          onAdd={() => {}}
        />,
      ),
    );
    expect(button("Add repository")).toBeUndefined();
    expect(host.textContent).toContain("No repository yet");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Only 1.2 GB is free");
  });
});

describe("ThreadRepositoryEventRows", () => {
  it("says the thread started with no repository and who added each one", () => {
    act(() => root.render(<ThreadRepositoryEventRows events={threadRepositoryEvents(thread)} />));
    expect(
      [...host.querySelectorAll("[data-thread-repository-event]")].map((node) => node.textContent),
    ).toEqual([
      "Started in its own folder with no repository. The agent reads the project folder and adds a repository before changing it.",
      "Agent added specwithcode-dev Worktree on fix/environment-list from origin/main. Dependencies installed.",
      "You added specweave Worktree on fix/environment-list from home-animated-story. Dependencies not installed.",
    ]);
  });
});
