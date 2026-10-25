// @vitest-environment jsdom
import type { DesignSummary, ProjectId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AddFromPlayground, playgroundDesigns } from "./AddFromPlayground";
import type { GalleryProject } from "./DesignActions";
import type { GalleryScope } from "./galleryModel";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const design = (designId: string, owner: unknown, title: string, updatedAt: string) =>
  ({
    ref: { owner, designId, path: `${designId}/design.json` },
    kind: "design",
    title,
    revision: 1,
    updatedAt,
    pageCount: 1,
    designSystem: null,
    ownerLabel: "Playground",
  }) as DesignSummary;
const playground = { kind: "playground", environmentId: "host" };
const atlas = { kind: "project", environmentId: "host", projectId: "atlas-web" };
const DESIGNS = [
  design("d_old", playground, "Moodboard", "2026-10-20T12:00:00.000Z"),
  design("d_new", playground, "Pricing page", "2026-10-23T11:00:00.000Z"),
  design("d_atlas", atlas, "Atlas home", "2026-10-23T11:30:00.000Z"),
];
const PROJECTS: GalleryProject[] = [
  { id: "atlas-web" as ProjectId, title: "Atlas web" },
  { id: "old-site" as ProjectId, title: "Old site", unavailable: "Archived" },
];
const projectScope = (projectId: string): GalleryScope => ({
  kind: "project",
  projectId: projectId as ProjectId,
});

function render(scope: GalleryScope, onConnect: ((...args: never[]) => void) | null) {
  act(() =>
    root.render(
      <AddFromPlayground
        scope={scope}
        designs={DESIGNS}
        projects={PROJECTS}
        canWrite
        now={NOW}
        onConnect={onConnect as never}
      />,
    ),
  );
  return container.querySelector<HTMLButtonElement>("[data-testid=design-add-from-playground]");
}

describe("AddFromPlayground", () => {
  it("lists the Playground's designs, newest first", () => {
    expect(playgroundDesigns(DESIGNS).map((summary) => summary.ref.designId)).toEqual([
      "d_new",
      "d_old",
    ]);
  });

  it("connects the chosen design to the board's project", async () => {
    const onConnect = vi.fn();
    const trigger = render(projectScope("atlas-web"), onConnect)!;
    expect(trigger.textContent).toBe("Add from Playground…");
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.click();
    });
    const items = [
      ...document.querySelectorAll<HTMLElement>("[data-testid=design-add-from-playground-item]"),
    ];
    expect(items.map((item) => item.textContent)).toEqual([
      "Pricing page1 h ago",
      "Moodboard3 days ago",
    ]);
    await act(async () => items[0]!.click());
    expect(onConnect).toHaveBeenCalledWith(DESIGNS[1], "atlas-web");
  });

  it("shows only on a project board that can take designs, where designs can move", () => {
    expect(render({ kind: "all" }, vi.fn())).toBeNull();
    expect(render({ kind: "playground" }, vi.fn())).toBeNull();
    expect(render(projectScope("old-site"), vi.fn())).toBeNull();
    expect(render(projectScope("atlas-web"), null)).toBeNull();
  });
});
