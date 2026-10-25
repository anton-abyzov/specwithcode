// @vitest-environment jsdom
import type { DesignSummary, EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({ primary: "m4" as string | null }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }));
vi.mock("../../../state/environments", () => ({ usePrimaryEnvironmentId: () => runtime.primary }));
vi.mock("../../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../design/gallery/LiveThumbnail", () => ({ LiveThumbnail: () => null }));
vi.mock("../../design/gallery/LibraryDesignMenu", () => ({ LibraryDesignMenu: () => null }));
vi.mock("./useProjectDesignActions", () => ({
  designFile: () => ({ path: "design.json", name: "design.json" }),
  useProjectDesignActions: () => ({ openDesign: vi.fn(), copyToPlayground: vi.fn() }),
}));
vi.mock("./ProjectPaneBar", () => ({ ProjectPaneBar: () => null }));
vi.mock("./LibraryFileViewer", () => ({ LibraryFileViewer: () => null }));
vi.mock("./Tip", () => ({ Tip: ({ children }: { children: unknown }) => children }));

import { PROJECT_DESIGNS_SHOWN, ProjectDesignsPane } from "./ProjectDesignsPane";

let root: Root, container: HTMLDivElement;
const summary = (index: number) =>
  ({
    ref: {
      owner: { kind: "project", environmentId: "studio", projectId: "app" },
      designId: `d_${index}`,
      path: `.specweave/design/d_${index}`,
    },
    kind: "design",
    title: `Design ${index}`,
    pageCount: 1,
    updatedAt: "2026-10-24T00:00:00.000Z",
    revision: 1,
  }) as unknown as DesignSummary;
const render = (count: number) =>
  act(async () =>
    root.render(
      <ProjectDesignsPane
        environmentId={"studio" as EnvironmentId}
        projectId={"app" as ProjectId}
        projectTitle="App"
        workspaceRoot="/work/app"
        designs={{
          designs: Array.from({ length: count }, (_, index) => summary(index)),
          count,
          loaded: true,
          error: null,
          problems: [],
          byThreadId: new Map(),
          refresh: vi.fn(),
        }}
        threadTitle={() => null}
        onOpenThread={vi.fn()}
        bar={{} as never}
      />,
    ),
  );
const buttons = () => [...container.querySelectorAll("button")].map((node) => node.textContent);

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).IntersectionObserver ??= class {
    observe() {}
    disconnect() {}
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("offers New design and the gallery for a project on this machine", async () => {
  runtime.primary = "studio";
  await render(PROJECT_DESIGNS_SHOWN + 2);
  expect(buttons()).toContain("New design");
  expect(container.textContent).toContain("Open in Designs");
  expect(container.querySelectorAll('[data-testid="project-design-card"]')).toHaveLength(
    PROJECT_DESIGNS_SHOWN,
  );
});

it("lists every design of a project on another machine, without the gallery's actions", async () => {
  runtime.primary = "m4";
  await render(PROJECT_DESIGNS_SHOWN + 2);
  expect(buttons()).not.toContain("New design");
  expect(container.textContent).not.toContain("Open in Designs");
  expect(container.textContent).toContain("App is on another machine.");
  expect(container.querySelectorAll('[data-testid="project-design-card"]')).toHaveLength(
    PROJECT_DESIGNS_SHOWN + 2,
  );
  await render(0);
  expect(buttons()).not.toContain("New design");
});
