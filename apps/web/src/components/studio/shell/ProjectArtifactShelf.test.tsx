// @vitest-environment jsdom
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  navigate: vi.fn(),
  openLink: vi.fn(async () => undefined),
  viewer: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: runtime.navigate }) }));
vi.mock("../../../browser/useOpenLink", () => ({ useOpenLink: () => runtime.openLink }));
vi.mock("../../../assets/assetUrls", () => ({
  useAssetUrlState: (_env: unknown, resource: unknown) =>
    resource === null ? { _tag: "Initial" } : { _tag: "Success", url: "blob:shot" },
}));
vi.mock("./LibraryFileViewer", () => ({
  LibraryFileViewer: (props: { path: string }) => {
    runtime.viewer(props.path);
    return <div data-testid="viewer">{props.path}</div>;
  },
}));
vi.mock("../../files/projectFilesQueryState", () => ({
  useProjectFileQuery: (_env: unknown, _cwd: string, path: string | null) => ({
    data:
      path === ".specweave/reports/summary.md"
        ? {
            contents:
              "---\nid: x\n---\n# Shelf summary\n\nThe **shelf** ships [today](https://x).\n",
          }
        : null,
  }),
}));
vi.mock("./Tip", () => ({ Tip: ({ children }: { children: unknown }) => children }));

import { collectProjectArtifacts, type ProjectArtifact } from "../../../studio/projectArtifacts";
import { ProjectArtifactShelf } from "./ProjectArtifactShelf";

const env = "env" as EnvironmentId;
const NOW = Date.parse("2026-10-30T12:00:00.000Z");

function sample(pinned: ReadonlySet<string> = new Set()): ProjectArtifact[] {
  return collectProjectArtifacts({
    workspaceRoot: "/work/app",
    library: {
      workspaceRoot: "/work/app",
      specweave: true,
      hub: null,
      hubProblem: null,
      artifacts: [],
      folders: [],
      outputs: [
        {
          path: ".specweave/increments/1148/reports/light.png",
          byteLength: 10,
          modifiedAt: "2026-10-30T11:00:00.000Z",
          increment: "1148",
        },
        {
          path: ".specweave/reports/summary.md",
          byteLength: 10,
          modifiedAt: "2026-10-28T12:00:00.000Z",
          increment: null,
        },
      ],
    },
    designs: [],
    pullRequests: [
      {
        key: "k",
        number: 12,
        repository: "me/app",
        url: "https://github.com/me/app/pull/12",
        title: "Add the shelf",
        state: "open",
        updatedAt: "2026-10-30T11:30:00.000Z",
        threadId: "t1" as ThreadId,
        threadTitle: "Shelf thread",
      },
    ],
    threadArtifacts: [],
    threadOf: (id) => ({ environmentId: env, threadId: id as ThreadId, title: "Shelf thread" }),
    pinned,
  });
}

let root: Root, container: HTMLDivElement;
const render = (artifacts: ProjectArtifact[], handlers: Partial<Record<string, unknown>> = {}) =>
  act(async () =>
    root.render(
      <ProjectArtifactShelf
        environmentId={env}
        workspaceRoot="/work/app"
        artifacts={artifacts}
        now={NOW}
        onPin={(handlers.onPin as never) ?? vi.fn()}
        onViewAll={(handlers.onViewAll as never) ?? vi.fn()}
        onOpenThread={vi.fn()}
      />,
    ),
  );
const titles = () =>
  [
    ...container.querySelectorAll(
      ".sws-artifact-card:not(.sws-artifact-more-card) .sws-artifact-title",
    ),
  ].map((node) => node.textContent);

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows nothing when the project has no artifacts", async () => {
  await render([]);
  expect(container.querySelector(".sws-artifact-shelf")).toBeNull();
});

it("lists cards newest first, pinned first, with age, kind and the thread", async () => {
  await render(sample());
  expect(titles()).toEqual(["Add the shelf", "light.png", "summary.md"]);
  expect(container.querySelector(".sws-artifact-thumb-image")?.getAttribute("src")).toBe(
    "blob:shot",
  );
  const meta = [...container.querySelectorAll(".sws-artifact-meta")].map((n) => n.textContent);
  expect(meta[0]).toBe("30m · Open PR · Shelf thread");
  expect(meta[1]).toBe("1h · Image");
  expect(meta[2]).toBe("2d · Document");

  await render(sample(new Set(["file:.specweave/reports/summary.md"])));
  expect(titles()[0]).toBe("summary.md");
  expect(
    container.querySelector('[data-pinned] [aria-pressed="true"]')?.getAttribute("aria-label"),
  ).toBe("Pin summary.md");
});

it("pins, opens files in the viewer, links in the browser, and View all", async () => {
  const onPin = vi.fn();
  const onViewAll = vi.fn();
  await render(sample(), { onPin, onViewAll });
  const pin = container.querySelector<HTMLButtonElement>('[aria-label="Pin summary.md"]')!;
  await act(async () => pin.click());
  expect(onPin).toHaveBeenCalledWith("file:.specweave/reports/summary.md", true);

  const open = [...container.querySelectorAll<HTMLButtonElement>(".sws-artifact-open")];
  await act(async () => open[2]!.click());
  expect(runtime.viewer).toHaveBeenCalledWith(".specweave/reports/summary.md");
  await act(async () => open[0]!.click());
  expect(runtime.openLink).toHaveBeenCalledWith("https://github.com/me/app/pull/12");

  const viewAll = container.querySelector<HTMLButtonElement>(".sws-artifact-view-all-card")!;
  expect(viewAll.textContent).toBe("View all3 artifacts");
  await act(async () => viewAll.click());
  expect(onViewAll).toHaveBeenCalled();
});

it("previews a markdown report as a small page and folds the shelf", async () => {
  await render(sample());
  const page = container.querySelector(".sws-artifact-page");
  expect(
    [...(page?.querySelectorAll(".sws-artifact-page-line") ?? [])].map((n) => n.textContent),
  ).toEqual(["Shelf summary", "The shelf ships today."]);
  expect(page?.querySelector("[data-heading]")?.getAttribute("data-heading")).toBe("1");

  const toggle = container.querySelector<HTMLButtonElement>(".sws-artifact-shelf-toggle")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector<HTMLUListElement>(".sws-artifact-row")!.hidden).toBe(true);
  expect(localStorage.getItem("studio:project-artifacts-shelf-open:v1")).toBe("false");
});
