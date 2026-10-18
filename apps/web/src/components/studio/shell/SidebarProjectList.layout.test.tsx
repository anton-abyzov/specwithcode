// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import type { ArrangedProjects } from "../../../studio/projectOrder";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...(rest as object)}>{children}</a>
  ),
  useRouter: () => ({ routesById: {} }),
}));
vi.mock("../../ProjectFavicon", () => ({ ProjectFavicon: () => null }));

const { SidebarProjectList } = await import("./SidebarProjectList");

const PROJECTS = 30;

function project(index: number) {
  return {
    projectKey: `project-${index}`,
    displayName: `Project ${index}`,
    memberProjects: [],
  } as unknown as SidebarProjectSnapshot;
}

describe("SidebarProjectList layout reads", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let layoutReads = 0;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")!;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // Row motion needs matchMedia; jsdom has none.
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    // Each offsetTop read forces the browser to lay the window out.
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() {
        layoutReads += 1;
        return 0;
      },
    });
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    Object.defineProperty(HTMLElement.prototype, "offsetTop", descriptor);
    vi.unstubAllGlobals();
  });

  function render(visible: ArrangedProjects<SidebarProjectSnapshot>, current: string) {
    const listedKeys = {
      pinned: visible.pinned.map((group) => group.projectKey),
      unpinned: visible.unpinned.map((group) => group.projectKey),
    };
    root!.render(
      <SidebarProjectList
        visible={visible}
        listedKeys={listedKeys}
        // A new function each time, as the sidebar passes it.
        rowState={(group) => ({
          displayedProject: undefined,
          archived: false,
          waiting: 0,
          current: group.projectKey === current,
        })}
        onOpen={() => {}}
        onMove={() => {}}
        onStep={() => {}}
        canStep={() => true}
        onPin={() => {}}
        onArchive={() => {}}
      />,
    );
  }

  it("measures the rows only when their order changes", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const groups = Array.from({ length: PROJECTS }, (_, index) => project(index));
    const visible = { pinned: [], unpinned: groups };
    await act(async () => render(visible, "project-0"));

    // Opening other projects re-renders the list without moving a row.
    layoutReads = 0;
    for (let index = 1; index <= 10; index += 1) {
      await act(async () => render(visible, `project-${index}`));
    }
    const readsWhileStill = layoutReads;

    // A reorder still measures, so the rows can glide to their new places.
    layoutReads = 0;
    await act(async () => render({ pinned: [], unpinned: [...groups].reverse() }, "project-10"));
    const readsOnReorder = layoutReads;

    const report = process.env.STUDIO_RENDER_COST_REPORT;
    if (report) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(report, JSON.stringify({ readsWhileStill, readsOnReorder }));
    }
    expect(readsWhileStill).toBe(0);
    expect(readsOnReorder).toBeGreaterThan(0);
  });
});
