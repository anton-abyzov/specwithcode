// @vitest-environment jsdom
import type { DesignSummary } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  navigated: [] as unknown[],
  copies: [] as unknown[],
  opened: [] as string[],
  designs: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: async (target: unknown) => {
      state.navigated.push(target);
    },
  }),
}));
vi.mock("../../../studio/design", () => ({
  design: { list: (key: unknown) => ({ query: "designs", key }), copy: { label: "copy" } },
}));
vi.mock("../../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    library: () => ({ query: "library" }),
    libraryAddArtifact: { label: "add" },
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (atom: { query: string }) => ({
    data:
      atom.query === "designs"
        ? { designs: state.designs, problems: [] }
        : {
            workspaceRoot: "/repo",
            specweave: true,
            hub: null,
            hubProblem: null,
            artifacts: [],
            folders: [],
          },
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => async (value: unknown) => {
    state.copies.push(value);
    return { _tag: "Success", value: { ref: { designId: "d_copy" } } };
  },
}));
vi.mock("../../../state/session", async (original) => ({
  ...(await original<object>()),
  useEnvironmentScope: () => true,
}));
vi.mock("../../files/useDirectoryEntries", () => ({
  useDirectoryEntries: () => ({
    directories: new Map(),
    error: null,
    load: async () => undefined,
    refresh: () => undefined,
  }),
}));
vi.mock("../../../browser/useOpenLink", () => ({ useOpenLink: () => async () => undefined }));
vi.mock("./ProjectPaneBar", () => ({ ProjectPaneBar: () => null }));
vi.mock("./LibraryFileViewer", () => ({
  LibraryFileViewer: ({ path }: { path: string }) => {
    state.opened.push(path);
    return <div data-testid="viewer">{path}</div>;
  },
}));

import { LibraryPane } from "./LibraryPane";

let container: HTMLDivElement;
let root: Root;

const summary = (id: string, title: string, minutes: number) =>
  ({
    ref: {
      owner: { kind: "project", environmentId: "host", projectId: "p1" },
      designId: id,
      path: `.specweave/design/${id}`,
    },
    kind: "design",
    title,
    revision: 2,
    updatedAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    pageCount: 1,
    designSystem: null,
    ownerLabel: "Atlas",
  }) as DesignSummary;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  state.navigated = [];
  state.copies = [];
  state.opened = [];
  state.designs = [summary("d_old", "Onboarding", 90), summary("d_new", "Pricing page", 3)];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () =>
    root.render(
      <LibraryPane
        environmentId={"host" as never}
        projectId={"p1" as never}
        workspaceRoot="/repo"
        canChange
        bar={{} as never}
      />,
    ),
  );
}
const labels = () =>
  [...container.querySelectorAll(".sws-library-row .sws-library-label")].map((n) => n.textContent);
async function choose(label: string) {
  const item = [...document.querySelectorAll('[data-slot="menu-item"]')].find(
    (node) => node.textContent === label,
  );
  await act(async () => (item as HTMLElement).click());
}

describe("Library Designs group", () => {
  it("lists the project's designs first, newest first", async () => {
    await render();
    expect(labels()).toEqual(["Designs", "Pricing page", "Onboarding", "Artifacts"]);
    const kinds = [...container.querySelectorAll('.sws-library-row[data-kind="design"]')].map(
      (row) => row.lastElementChild?.textContent,
    );
    expect(kinds).toEqual(["Design", "Design"]);
  });

  it("opens a design in the editor", async () => {
    await render();
    const row = [...container.querySelectorAll(".sws-library-name button")].find(
      (node) => node.textContent === "Pricing page",
    );
    await act(async () => (row as HTMLElement).click());
    expect(state.navigated).toEqual([
      { to: "/design/$designKey", params: { designKey: "p.p1.d_new" } },
    ]);
  });

  it("copies to the Playground and shows the design file", async () => {
    await render();
    const menu = container.querySelector('[data-testid="library-design-menu"]') as HTMLElement;
    await act(async () => menu.click());
    await choose("Copy to Playground");
    expect(state.copies).toEqual([
      {
        environmentId: "host",
        input: {
          owner: { kind: "project", projectId: "p1" },
          designId: "d_new",
          to: { kind: "playground" },
        },
      },
    ]);
    await act(async () => menu.click());
    await choose("Show file");
    expect(state.opened.at(-1)).toBe(".specweave/design/d_new/design.json");
  });

  it("narrows to designs with the Designs type", async () => {
    await render();
    await act(async () => (container.querySelector(".sws-library-filter") as HTMLElement).click());
    const item = [...document.querySelectorAll('[role="menuitemradio"]')].find((node) =>
      node.textContent?.startsWith("Designs"),
    );
    await act(async () => (item as HTMLElement).click());
    expect(labels()).toEqual(["Designs", "Pricing page", "Onboarding"]);
  });

  it("hides the group when the project has no designs", async () => {
    state.designs = [];
    await render();
    expect(labels()).not.toContain("Designs");
  });
});
