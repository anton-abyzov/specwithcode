// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProjectEnvironmentReadResult } from "@specweave-studio/contracts";
import { ProjectRepositoryList } from "./ProjectRepositoryList";
import { row } from "./projectRepositoryRows.logic.test";

vi.mock("./ProjectLocation", () => ({
  ProjectLocation: ({ path }: { path: string }) => <code>{path}</code>,
}));

const base: ProjectEnvironmentReadResult = {
  revision: 1,
  workspaceRoot: "/work/umb",
  additionalFolders: [],
  repositories: [],
  rootIsRepository: true,
  foundMore: 0,
  found: [
    row({ name: "specwithcode-dev", branch: null, threadWorktrees: 2 }),
    row({ name: "specweave", relativePath: "repositories/acme/specweave", inSpecweave: true }),
    row({ name: "local", relativePath: "repositories/acme/local", origin: null, noRemote: true }),
    row({
      name: "vskill",
      relativePath: "repositories/acme/vskill",
      state: "absent",
      inSpecweave: true,
      branch: null,
    }),
    row({
      name: "gone",
      relativePath: "elsewhere/gone",
      state: "missing",
      repositoryId: "gone-id",
      branch: null,
    }),
  ],
  skippedLinks: [{ path: "repositories/acme/studio", target: "repositories/acme/api" }],
  redundantEntries: [
    { repositoryId: "a", reason: "found_clone" },
    { repositoryId: "b", reason: "no_folder" },
  ],
};
const saved = [
  { id: "a", url: "https://github.com/acme/specwithcode-dev.git" },
  { id: "b", url: "https://github.com/acme/specwithcode.git" },
];

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

const handlers = () => ({
  onCheckAgain: vi.fn(),
  onClone: vi.fn(),
  onRemove: vi.fn(),
  onOpenGeneral: vi.fn(),
});
const render = (
  read: ProjectEnvironmentReadResult,
  options: { useWorktrees?: boolean | null; disabled?: boolean } = {},
) => {
  const fns = handlers();
  act(() =>
    root.render(
      <ProjectRepositoryList
        read={read}
        saved={saved}
        useWorktrees={options.useWorktrees ?? true}
        disabled={options.disabled ?? false}
        busyKey={null}
        checking={false}
        {...fns}
      />,
    ),
  );
  return fns;
};
const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent) === label,
  );

describe("ProjectRepositoryList", () => {
  it("lists what threads can use, read-only", () => {
    render(base);
    const text = host.textContent ?? "";
    expect(text).toContain("This folder holds 3 Git repositories. Threads can use any of them.");
    expect(text).toContain(
      "repositories/acme/api · acme/api · no branch checked out · 2 thread worktrees",
    );
    expect(text).toContain("no remote, so no pull request");
    expect(host.querySelectorAll(".project-repository-tag")).toHaveLength(2);
    expect(
      [...host.querySelectorAll(".project-repository-status")].map((node) => node.textContent),
    ).toEqual(["Available", "Available", "Available", "Not on this machine", "Folder missing"]);
    // Nothing to register or pick, and no clone controls on a repository that is here.
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    for (const gone of ["Add", "Match existing checkout", "Prepare checkout"])
      expect(button(gone)).toBeUndefined();
    expect(text).not.toMatch(/Checkout status unknown|Checkout: mismatch|workspace/iu);
    expect(host.querySelectorAll("details")).toHaveLength(3);
    expect(host.querySelector("[data-skipped-links]")?.textContent).toBe(
      "Skipped: studio is a link to api.",
    );
    expect(host.querySelector("[data-worktrees-off]")).toBeNull();
  });

  it("offers Clone only where a clone is needed, and removal only by a click", () => {
    const fns = render(base);
    act(() => button("Clone vskill")!.click());
    expect(fns.onClone).toHaveBeenCalledWith(expect.objectContaining({ name: "vskill" }));
    expect(host.textContent).toContain(
      "SpecWeave lists it at repositories/acme/vskill. Clone puts it there.",
    );
    act(() => button("Clone gone again")!.click());
    expect(fns.onClone).toHaveBeenCalledTimes(2);
    act(() => button("Remove gone from project")!.click());
    expect(fns.onRemove).toHaveBeenLastCalledWith(["gone-id"]);
    expect(host.querySelector("[data-redundant-entries]")?.textContent).toContain(
      "2 saved entries from before are no longer needed",
    );
    act(() => button("Remove both")!.click());
    expect(fns.onRemove).toHaveBeenLastCalledWith(["a", "b"]);
    act(() => button("Check again")!.click());
    expect(fns.onCheckAgain).toHaveBeenCalledOnce();
  });

  it("points at General while Use worktrees is off", () => {
    const fns = render(base, { useWorktrees: false });
    expect(host.querySelector("[data-worktrees-off]")?.textContent).toContain(
      "Use worktrees is off for this project, so threads work in the project folder.",
    );
    act(() => button("Open General")!.click());
    expect(fns.onOpenGeneral).toHaveBeenCalledOnce();
  });

  it("shows one repository as just that", () => {
    render({ ...base, found: [], skippedLinks: [], redundantEntries: [] });
    expect(host.textContent).toContain("This project is one Git repository: the project folder.");
    expect(host.querySelector(".project-repository-rows")).toBeNull();
    expect(host.querySelector("[data-redundant-entries]")).toBeNull();
  });
});
