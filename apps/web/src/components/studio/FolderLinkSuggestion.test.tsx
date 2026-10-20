// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { FolderCopyMatch } from "../../studio/folderLinkSuggestion";
import { FolderLinkSuggestion, type FolderLinkSuggestionRequest } from "./FolderLinkSuggestion";

const state = vi.hoisted(() => ({ clone: vi.fn() }));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: { cloneRepository: "clone" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.clone }));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (failure: { error: Error }) => failure.error,
}));

const copy = (environmentId: string, id: string, title: string) =>
  ({ environmentId, id, title, workspaceRoot: `/m/${id}` }) as unknown as EnvironmentProject;
const easychamp: FolderCopyMatch = {
  candidate: {
    project: copy("m4", "ec", "EasyChamp"),
    score: 0.9,
    rootMatches: true,
    summary: "Same root repository; 2 of 4 repositories match, 2 missing here.",
  },
  machine: "M4MAX",
  missing: [
    {
      path: "repositories/ec-ui",
      originKey: "github.com/team/ec-ui",
      destination: "/Users/a/ec/repositories/ec-ui",
      clone: { provider: "github", repository: "team/ec-ui" },
    },
    {
      path: "repositories/local",
      originKey: null,
      destination: "/Users/a/ec/repositories/local",
      clone: null,
    },
  ],
};
const other: FolderCopyMatch = {
  candidate: {
    project: copy("m1", "ec-old", "EasyChamp old"),
    score: 0.7,
    rootMatches: true,
    summary: "Same root repository; 1 of 1 repository match.",
  },
  machine: "M1Max",
  missing: [],
};
const added = copy("m3", "new", "ec");

let root: Root;
let container: HTMLDivElement;
let request: FolderLinkSuggestionRequest;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let onLink: ReturnType<typeof vi.fn<(project: EnvironmentProject, candidate: object) => void>>;

async function render(matches: ReadonlyArray<FolderCopyMatch> = [easychamp]) {
  request = { ...request, matches };
  await act(async () =>
    root.render(<FolderLinkSuggestion request={request} onClose={onClose} onLink={onLink} />),
  );
}
function button(label: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button ${label}: ${document.body.textContent}`);
  return element;
}
const buttons = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (node) => node.textContent?.trim() === label,
  );
async function click(element: HTMLElement) {
  await act(async () => element.click());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.clone.mockReset();
  onClose = vi.fn<() => void>();
  onLink = vi.fn<(project: EnvironmentProject, candidate: object) => void>();
  request = {
    folder: { environmentId: "m3" as never, workspaceRoot: "/Users/a/ec", title: "ec" },
    matches: [easychamp],
    addProject: vi.fn(async () => added),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("folder link suggestion", () => {
  it("names the copy, its match summary and the repositories missing here", async () => {
    await render();
    expect(document.querySelector("h2")?.textContent).toBe("Link as a copy of EasyChamp on M4MAX?");
    expect(document.body.textContent).toContain(easychamp.candidate.summary!);
    expect(document.body.textContent).toContain("Not in this folder (2)");
    const rows = [...document.querySelectorAll('[data-slot="folder-link-missing"]')];
    expect(rows.map((row) => row.textContent)).toEqual([
      "repositories/ec-uigithub.com/team/ec-uiClone from origin",
      "repositories/localNo origin to clone from",
    ]);
    expect(request.addProject).not.toHaveBeenCalled();
    expect(state.clone).not.toHaveBeenCalled();
  });

  it("clones a missing repository into its path only when asked, and shows the result", async () => {
    state.clone.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Permission denied") });
    await render();
    await click(button("Clone from origin"));
    expect(state.clone).toHaveBeenCalledExactlyOnceWith({
      environmentId: "m3",
      input: {
        provider: "github",
        repository: "team/ec-ui",
        destinationPath: "/Users/a/ec/repositories/ec-ui",
      },
    });
    expect(document.body.textContent).toContain("Permission denied");
    state.clone.mockResolvedValueOnce({ _tag: "Success", value: {} });
    await click(button("Clone from origin"));
    expect(document.body.textContent).toContain("Cloned");
    expect(buttons("Clone from origin")).toHaveLength(0);
    expect(request.addProject).not.toHaveBeenCalled();
  });

  it("adds the folder, then hands it to the link dialog with the chosen copy", async () => {
    await render([easychamp, other]);
    expect(document.querySelector("h2")?.textContent).toBe("This folder is a copy of a project");
    const radio = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) =>
      node.closest('[data-slot="folder-link-match"]')?.textContent?.includes("M1Max"),
    )!;
    await click(radio);
    expect(document.querySelector('[aria-label="Missing here"]')).toBeNull();
    await click(button("Link"));
    expect(request.addProject).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onLink).toHaveBeenCalledExactlyOnceWith(added, {
      environmentId: "m1",
      projectId: "ec-old",
    });
  });

  it("adds without linking, and never adds twice after a failed attempt", async () => {
    request = { ...request, addProject: vi.fn(async () => null) };
    await render();
    await click(button("Link"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "The folder could not be added.",
    );
    expect(onLink).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    request = { ...request, addProject: vi.fn(async () => added) };
    await render();
    await click(button("Add without linking"));
    expect(request.addProject).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onLink).not.toHaveBeenCalled();
  });
});
