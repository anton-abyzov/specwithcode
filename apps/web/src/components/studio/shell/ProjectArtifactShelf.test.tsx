// @vitest-environment jsdom
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  navigate: vi.fn(),
  openLink: vi.fn(async () => undefined),
  viewer: vi.fn(),
  reads: vi.fn(),
  answer: vi.fn(),
  createUrl: vi.fn(async () => "blob:shot"),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: runtime.navigate }) }));
vi.mock("../../../browser/useOpenLink", () => ({ useOpenLink: () => runtime.openLink }));
vi.mock("../../../assets/assetUrls", () => ({
  useAssetUrlState: (_env: unknown, resource: unknown) =>
    resource === null ? { _tag: "Initial" } : { _tag: "Success", url: "blob:shot" },
  useAssetUrlRefresh: () => runtime.createUrl,
}));
vi.mock("./LibraryFileViewer", () => ({
  LibraryFileViewer: (props: { path: string }) => {
    runtime.viewer(props.path);
    return <div data-testid="viewer">{props.path}</div>;
  },
}));
vi.mock("../../files/projectFilesQueryState", () => ({
  useProjectFileReader: () => async (_env: unknown, _cwd: string, path: string) => {
    runtime.reads(path);
    return runtime.answer(path);
  },
}));
vi.mock("./Tip", () => ({ Tip: ({ children }: { children: unknown }) => children }));

import { artifactPreviewCache } from "../../../studio/artifactPreview";
import { collectProjectArtifacts, type ProjectArtifact } from "../../../studio/projectArtifacts";
import { ArtifactCard, ProjectArtifactShelf } from "./ProjectArtifactShelf";

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

// Past the time a card must stay near the view before it reads.
const dwell = () => act(async () => new Promise((done) => setTimeout(done, 160)));

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
  artifactPreviewCache.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.clearAllMocks();
  runtime.answer.mockImplementation(async () => ({
    _tag: "contents",
    contents: "---\nid: x\n---\n# Shelf summary\n\nThe **shelf** ships [today](https://x).\n",
  }));
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
  await dwell();
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
  await dwell();
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

it("gives a pull request a sheet of its state, number, title and repository", async () => {
  await render(sample());
  const card = container.querySelector('.sws-artifact-card[data-kind="pullRequest"]')!;
  expect(card.querySelector(".sws-artifact-thumb")?.getAttribute("data-state")).toBe("open");
  expect(card.querySelector(".sws-artifact-facts-label")?.textContent).toBe("Open");
  expect(card.querySelector(".sws-artifact-facts-detail")?.textContent).toBe("#12");
  expect(card.querySelector(".sws-artifact-facts-title")?.textContent).toBe("Add the shelf");
  expect(card.querySelector(".sws-artifact-facts-foot")?.textContent).toBe("me/app");
});

describe("with an observer", () => {
  let notify: (near: boolean) => void;
  const observed: Element[] = [];
  beforeEach(() => {
    observed.length = 0;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = (isIntersecting) =>
            callback(
              observed.map((target) => ({ target, isIntersecting })) as never,
              this as never,
            );
        }
        observe(target: Element) {
          observed.push(target);
        }
        unobserve() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("treats no answer as temporary and a server refusal as final", async () => {
    runtime.answer.mockImplementation(async () => ({ _tag: "unavailable" }));
    await render(sample());
    await act(async () => notify(true));
    await dwell();
    expect(runtime.reads).toHaveBeenCalledTimes(1);
    const key = [...container.querySelectorAll(".sws-artifact-facts-title")].map(
      (node) => node.textContent,
    );
    expect(key).toContain("summary.md");
    // Not remembered: another mount tries again.
    await act(async () => root.render(<div />));
    runtime.reads.mockClear();
    runtime.answer.mockImplementation(async () => ({ _tag: "gone" }));
    await render(sample());
    await act(async () => notify(true));
    await dwell();
    expect(runtime.reads).toHaveBeenCalledTimes(1);
    // Remembered: the next mount does not read.
    await act(async () => root.render(<div />));
    runtime.reads.mockClear();
    await render(sample());
    await act(async () => notify(true));
    await dwell();
    expect(runtime.reads).not.toHaveBeenCalled();
  });

  it("asks for a new image URL on each try, and does not remember a failure", async () => {
    runtime.createUrl.mockRejectedValueOnce(new Error("no") as never);
    await render(sample());
    await act(async () => notify(true));
    await dwell();
    expect(runtime.createUrl).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".sws-artifact-thumb-image")).toBeNull();
    await act(async () => root.render(<div />));
    await render(sample());
    await act(async () => notify(true));
    await dwell();
    expect(runtime.createUrl).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".sws-artifact-thumb-image")?.getAttribute("src")).toBe(
      "blob:shot",
    );
  });

  it("keeps a focused windowed card rendered when it leaves the view", async () => {
    await act(async () =>
      root.render(
        <ul>
          <ArtifactCard
            artifact={sample()[0]!}
            environmentId={env}
            workspaceRoot="/work/app"
            meta="30m"
            onOpen={vi.fn()}
            onPin={vi.fn()}
            windowed
          />
        </ul>,
      ),
    );
    await act(async () => notify(true));
    const pin = container.querySelector<HTMLButtonElement>(".sws-artifact-pin")!;
    await act(async () => pin.focus());
    await act(async () => notify(false));
    expect(pin.isConnected).toBe(true);
    expect(document.activeElement).toBe(pin);
    await act(async () => pin.blur());
    expect(container.querySelector(".sws-artifact-pin")).toBeNull();
  });

  it("keeps a windowed card's size and name, and renders the rest only near the view", async () => {
    const artifact = sample()[0]!;
    const card = (
      <ul>
        <ArtifactCard
          artifact={artifact}
          environmentId={env}
          workspaceRoot="/work/app"
          meta="30m"
          onOpen={vi.fn()}
          onPin={vi.fn()}
          windowed
        />
      </ul>
    );
    await act(async () => root.render(card));
    const item = container.querySelector(".sws-artifact-card")!;
    expect(item.hasAttribute("data-far")).toBe(true);
    expect(item.querySelector(".sws-artifact-open")?.getAttribute("aria-label")).toBe(
      "Add the shelf",
    );
    expect(item.querySelector(".sws-artifact-title")).toBeNull();
    expect(item.querySelector(".sws-artifact-actions")).toBeNull();

    await act(async () => notify(true));
    expect(item.hasAttribute("data-far")).toBe(false);
    expect(item.querySelector(".sws-artifact-title")?.textContent).toBe("Add the shelf");
    expect(item.querySelector(".sws-artifact-facts-detail")?.textContent).toBe("#12");
    expect(item.querySelector(".sws-artifact-actions")).not.toBeNull();
  });

  it("reads nothing until a card stays near the view, and nothing again after", async () => {
    await render(sample());
    await dwell();
    expect(runtime.reads).not.toHaveBeenCalled();
    expect(container.querySelector(".sws-artifact-page")).toBeNull();
    expect(container.querySelector(".sws-artifact-facts-title")).not.toBeNull();

    // Passing through the view inside the rest time reads nothing.
    await act(async () => notify(true));
    await act(async () => notify(false));
    await dwell();
    expect(runtime.reads).not.toHaveBeenCalled();

    // While the row scrolls nothing reads; once it rests, the card does.
    await act(async () => notify(true));
    const row = container.querySelector(".sws-artifact-row")!;
    for (let step = 0; step < 3; step += 1) {
      await act(async () => new Promise((done) => setTimeout(done, 70)));
      row.dispatchEvent(new Event("scroll"));
    }
    expect(runtime.reads).not.toHaveBeenCalled();
    // A scroll elsewhere, such as a streaming chat, does not hold it back.
    const chat = document.createElement("div");
    document.body.append(chat);
    for (let step = 0; step < 3; step += 1) {
      chat.dispatchEvent(new Event("scroll"));
      await act(async () => new Promise((done) => setTimeout(done, 70)));
    }
    chat.remove();
    expect(runtime.reads).toHaveBeenCalledWith(".specweave/reports/summary.md");
    expect(container.querySelector(".sws-artifact-page-line")?.textContent).toBe("Shelf summary");

    // Scrolled away the page leaves the DOM; coming back paints it from the cache.
    await act(async () => notify(false));
    expect(container.querySelector(".sws-artifact-page")).toBeNull();
    runtime.reads.mockClear();
    await act(async () => notify(true));
    expect(container.querySelector(".sws-artifact-page-line")?.textContent).toBe("Shelf summary");
    await dwell();
    expect(runtime.reads).not.toHaveBeenCalled();
  });
});
