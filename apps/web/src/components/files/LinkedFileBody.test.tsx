// @vitest-environment jsdom

import type { EnvironmentId, ScopedThreadRef } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";

const minted: Array<{ _tag: string; path: string }> = [];

vi.mock("~/i18n", () => ({
  useTx: () => (text: string) => text,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: (_environmentId: unknown, resource: { _tag: string; path: string } | null) => {
    if (resource === null) return { _tag: "Loading" };
    minted.push(resource);
    return { _tag: "Success", url: `https://assets.test/${resource._tag}/${resource.path}` };
  },
}));
vi.mock("./BrowserDocumentFrame", () => ({
  BrowserDocumentFrame: (props: { src: string; pdf: boolean }) => (
    <iframe title="frame" src={props.src} data-pdf={String(props.pdf)} />
  ),
}));
vi.mock("../chat/ViewerImageStage", () => ({
  ViewerImageStage: (props: { src: string; name: string }) => (
    <img alt={props.name} src={props.src} data-viewer-image-stage="true" />
  ),
}));
vi.mock("./AudioPreview", () => ({
  AudioPreview: (props: { src: string }) => <audio src={props.src} />,
}));
vi.mock("./DeckPreview", () => ({
  HostDeckPreview: (props: { path: string }) => <div data-host-deck={props.path} />,
  FilePreviewCard: (props: { reason: string }) => <p data-file-card="">{props.reason}</p>,
}));
vi.mock("./OfficeDocumentPreview", () => ({
  HostWorkbookPreview: (props: { path: string }) => <div data-host-workbook={props.path} />,
  HostDocumentPreview: (props: { path: string }) => <div data-host-document={props.path} />,
}));
vi.mock("./AttachmentFilePreview", () => ({
  ReadOnlySourcePreview: (props: { name: string; text: string; revealLine?: number }) => (
    <pre data-source={props.name} data-line={props.revealLine ?? ""}>
      {props.text}
    </pre>
  ),
}));
vi.mock("../chat/ReportReader", () => ({
  MarkdownDocumentView: (props: { renderMarkdown: (text: string) => unknown; text: string }) => (
    <article data-markdown="">{props.renderMarkdown(props.text) as never}</article>
  ),
}));

import { HtmlSourceModeProvider, HtmlSourceSwitch, LinkedFileBody } from "./LinkedFileBody";

const environmentId = "env" as EnvironmentId;
const threadRef = { environmentId, threadId: "thread-1" } as ScopedThreadRef;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  minted.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

function renderBody(props: {
  name: string;
  absolutePath: string;
  pathKey?: string;
  text?: string | null;
  threadRef?: ScopedThreadRef | null;
  cwd?: string;
  revealLine?: number;
  initialSource?: boolean;
}) {
  const pathKey = props.pathKey ?? props.name;
  return act(() =>
    root.render(
      <HtmlSourceModeProvider path={pathKey} initialSource={props.initialSource ?? false}>
        <HtmlSourceSwitch path={pathKey} enabled={props.threadRef !== null} />
        <LinkedFileBody
          name={props.name}
          absolutePath={props.absolutePath}
          pathKey={pathKey}
          text={props.text ?? null}
          environmentId={environmentId}
          threadRef={props.threadRef === undefined ? threadRef : props.threadRef}
          cwd={props.cwd ?? "/repo"}
          revealLine={props.revealLine}
          renderMarkdown={(markdown) => <div data-rendered-markdown="">{markdown}</div>}
        />
      </HtmlSourceModeProvider>,
    ),
  );
}

it("renders an html file and switches to its source", async () => {
  await renderBody({
    name: "page.html",
    absolutePath: "/repo/page.html",
    text: "<h1>Hi</h1>",
    cwd: "/repo",
  });
  const frame = container.querySelector("iframe");
  expect(frame?.getAttribute("src")).toContain("workspace-file");
  expect(frame?.getAttribute("src")).toContain("/repo/page.html");
  expect(container.querySelector("[data-source]")).toBeNull();
  await act(() => container.querySelector<HTMLButtonElement>("[data-html-source-switch]")!.click());
  expect(container.querySelector("[data-source]")?.textContent).toBe("<h1>Hi</h1>");
  expect(container.querySelector("[data-html-source-switch]")?.textContent).toBe("Preview");
});

it("opens source when the link names a line", async () => {
  await renderBody({
    name: "page.html",
    absolutePath: "/tmp/page.html",
    text: "<p>x</p>",
    initialSource: true,
    revealLine: 4,
    cwd: "/repo",
  });
  expect(container.querySelector("[data-source]")?.getAttribute("data-line")).toBe("4");
  expect(container.querySelector("iframe")).toBeNull();
});

it("uses a host file url for a page outside the project", async () => {
  await renderBody({
    name: "page.html",
    absolutePath: "/tmp/scratch/page.html",
    text: "<p>x</p>",
    cwd: "/repo",
  });
  expect(container.querySelector("iframe")?.getAttribute("src")).toContain("media-file");
  expect(minted[0]?._tag).toBe("media-file");
});

it("plays a video and shows an image and a pdf", async () => {
  await renderBody({ name: "clip.mp4", absolutePath: "/tmp/clip.mp4" });
  expect(container.querySelector("video")?.getAttribute("src")).toContain("/tmp/clip.mp4");
  await renderBody({ name: "shot.png", absolutePath: "/repo/shot.png", cwd: "/repo" });
  expect(container.querySelector("[data-viewer-image-stage]")?.getAttribute("src")).toContain(
    "workspace-file",
  );
  await renderBody({ name: "notes.pdf", absolutePath: "/tmp/notes.pdf" });
  expect(container.querySelector("iframe")?.getAttribute("data-pdf")).toBe("true");
});

it("tells a file with no thread to be opened from one", async () => {
  await renderBody({
    name: "page.html",
    absolutePath: "/repo/page.html",
    text: "<p>x</p>",
    threadRef: null,
  });
  expect(container.querySelector("[data-file-card]")?.textContent).toBe(
    "Open this file from a thread to preview it.",
  );
  expect(container.querySelector("[data-html-source-switch]")).toBeNull();
});

it("renders markdown, a csv table, a deck and source", async () => {
  await renderBody({ name: "notes.md", absolutePath: "/repo/notes.md", text: "# Notes" });
  expect(container.querySelector("[data-rendered-markdown]")?.textContent).toBe("# Notes");
  await renderBody({ name: "rows.csv", absolutePath: "/repo/rows.csv", text: "a,b\n1,2" });
  expect(container.querySelector("table")).not.toBeNull();
  await renderBody({ name: "deck.pptx", absolutePath: "/repo/deck.pptx", text: null });
  expect(container.querySelector("[data-host-deck]")?.getAttribute("data-host-deck")).toBe(
    "/repo/deck.pptx",
  );
  await renderBody({ name: "budget.xlsx", absolutePath: "/repo/budget.xlsx", text: null });
  expect(container.querySelector("[data-host-workbook]")?.getAttribute("data-host-workbook")).toBe(
    "/repo/budget.xlsx",
  );
  await renderBody({ name: "brief.docx", absolutePath: "/repo/brief.docx", text: null });
  expect(container.querySelector("[data-host-document]")?.getAttribute("data-host-document")).toBe(
    "/repo/brief.docx",
  );
  await renderBody({
    name: "permissionWatcher.ts",
    absolutePath: "/repo/src/permissionWatcher.ts",
    text: "export const watcher = true;\n",
  });
  expect(container.querySelector("[data-source]")?.textContent).toContain("watcher");
});
