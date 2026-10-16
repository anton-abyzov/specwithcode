import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  messages: [] as Array<{ id: string; role: string; text: string; createdAt?: unknown }>,
  turnItems: [] as unknown[],
  minted: [] as unknown[],
  openExternal: vi.fn(),
  pullRequests: [] as unknown[],
  missing: new Set<string>(),
}));

const overlay = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock("~/viewerOverlayStore", () => ({
  // The overlay's header is the host's; the viewer's actions portal into it.
  useViewerOverlay: (options: Record<string, unknown> & { open: boolean }) => {
    overlay.last = options;
    return options.open ? { content: {} as HTMLElement, actions: {} as HTMLElement } : null;
  },
}));
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (node: unknown) => node,
}));
vi.mock("../ui/dialog", () => ({
  Dialog: (props: { open: boolean; children: unknown }) =>
    props.open ? <div data-dialog="open">{props.children as never}</div> : null,
  DialogDockedPopup: (props: Record<string, unknown>) => <div {...props} />,
  DialogTitle: (props: { children: unknown }) => <h2>{props.children as never}</h2>,
}));
vi.mock("../ui/menu", () => ({
  Menu: (props: { children: unknown }) => <div>{props.children as never}</div>,
  MenuTrigger: (props: { children: unknown }) => (
    <span data-menu-trigger="true">{props.children as never}</span>
  ),
  MenuPopup: (props: { children: unknown }) => <div>{props.children as never}</div>,
  MenuSeparator: () => <hr />,
  MenuItem: (props: Record<string, unknown> & { children: unknown; onClick?: () => void }) => (
    <button
      type="button"
      data-thread-artifact={props["data-thread-artifact"]}
      onClick={props.onClick}
    >
      {props.children as never}
    </button>
  ),
}));
vi.mock("~/state/entities", () => ({
  useThreadProjection: () => ({
    projection: { messages: state.messages, turnItems: state.turnItems },
  }),
  useThreadShell: () => ({ pullRequests: state.pullRequests }),
}));
vi.mock("../ui/popover", () => ({
  Popover: (props: { children: unknown }) => <div>{props.children as never}</div>,
  PopoverTrigger: (props: { children: unknown }) => (
    <span data-menu-trigger="true">{props.children as never}</span>
  ),
  PopoverPopup: (props: { children: unknown }) => <div>{props.children as never}</div>,
}));
vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));
vi.mock("./useMissingArtifactFiles", () => ({
  useMissingArtifactFiles: () => state.missing,
}));
vi.mock("./ViewerFileActions", () => ({
  ViewerFileActions: (props: { path: string | null }) => (
    <span data-file-actions={props.path ?? ""} />
  ),
}));
vi.mock("./useExistingFileLinks", () => ({ useExistingFileLinks: (metas: unknown) => metas }));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: (
    _environmentId: unknown,
    resource: { path?: string; attachmentId?: string } | null,
  ) => {
    if (resource === null) return { _tag: "Loading" };
    state.minted.push(resource);
    return {
      _tag: "Success",
      url: `https://host.test/api/assets/t/${resource.path ?? resource.attachmentId}`,
    };
  },
}));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));
vi.mock("~/components/ChatMarkdown", () => ({
  default: (props: { text: string }) => <div data-markdown="true">{props.text}</div>,
}));
vi.mock("../files/projectFilesQueryState", () => ({
  useProjectFileQuery: (_environmentId: string, _cwd: string, path: string) => ({
    data: { contents: `contents of ${path}` },
    error: null,
  }),
}));
vi.mock("../files/AttachmentFilePreview", () => ({
  ReadOnlySourcePreview: (props: { name: string }) => <pre data-source={props.name} />,
}));
vi.mock("../files/BrowserDocumentFrame", () => ({
  BrowserDocumentFrame: (props: { src: string; htmlRender?: boolean }) => (
    <iframe title="frame" src={props.src} data-html-render={String(Boolean(props.htmlRender))} />
  ),
}));
vi.mock("../files/AudioPreview", () => ({
  AudioPreview: (props: { src: string }) => <audio src={props.src} />,
}));

import { ArtifactCards, ThreadArtifactsMenu } from "./ThreadArtifacts";

const threadRef = {
  environmentId: EnvironmentId.make("artifact-environment"),
  threadId: ThreadId.make("artifact-thread"),
};
const CWD = "/Users/me/Projects/easychamp";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
  // Pins and hides live in localStorage; a fresh store per test.
  const stored = new Map<string, string>();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    }),
  );
  state.pullRequests = [];
  state.missing = new Set();
  state.minted = [];
  state.openExternal.mockReset();
  state.messages = [
    { id: "u1", role: "user", text: "Ignore `/tmp/user-only.png`." },
    {
      id: "a1",
      role: "assistant",
      createdAt: DateTime.makeUnsafe("2026-10-15T12:00:00.000Z"),
      text: [
        "Cut `/tmp/promo/snap-18s-master.mp4`, cover `/tmp/promo/snap-cover.jpg`,",
        "the email `/tmp/promo/victoria_email.html` and notes `docs/plan.md`.",
        "Bing is verified ([gitops #254](https://github.com/acme/gitops/pull/254)).",
      ].join(" "),
    },
  ];
  state.turnItems = [
    {
      id: "render-1",
      type: "dynamic_tool",
      status: "completed",
      toolName: "mcp__studio-code__html_render",
      output: { htmlRender: { attachmentId: "att-1", title: "Paid Ads Scorecard", height: 400 } },
    },
  ];
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    renderer = create(<ThreadArtifactsMenu threadRef={threadRef} cwd={CWD} />);
  });
}

function item(name: string) {
  const button = renderer!.root
    .findAllByType("button")
    .find((node) => node.findAll((child) => child.children.includes(name)).length > 0);
  expect(button, name).toBeDefined();
  return button!;
}

it("counts and lists what the thread produced, links and published pages included", async () => {
  await render();
  expect(
    renderer!.root.findByProps({ "data-menu-trigger": "true" }).findAllByType("span").at(-1)!
      .children,
  ).toEqual(["6"]);
  expect(
    renderer!.root
      .findAll((node) => node.type === "button" && node.props["data-thread-artifact"])
      .map((node) => node.props["data-thread-artifact"]),
  ).toEqual(["link", "html", "html", "markdown", "image", "video"]);
});

function sections() {
  return renderer!.root
    .findAll((node) => node.type === "section")
    .map((node) => [
      node.props["data-artifact-section"],
      node
        .findAll((child) => child.type === "button" && child.props["data-thread-artifact"])
        .map((child) => child.props["data-thread-artifact"]),
    ]);
}

function action(name: string, kind: "pin" | "hide") {
  const row = renderer!.root.findAll(
    (node) =>
      node.type === "li" && node.findAll((child) => child.children.includes(name)).length > 0,
  )[0]!;
  return row.find((node) => node.type === "button" && node.props["data-artifact-action"] === kind);
}

it("groups by type, folds a merged pull request and a missing file into Older", async () => {
  state.pullRequests = [
    {
      host: "github.com",
      repository: "acme/gitops",
      number: 254,
      url: "https://github.com/acme/gitops/pull/254",
      source: "agent",
      linkedAt: "2026-10-15T12:00:00.000Z",
      snapshot: { state: "merged", title: "Verify Bing" },
      stack: null,
    },
  ];
  state.missing = new Set(["/tmp/promo/snap-cover.jpg"]);
  await render();
  expect(sections()).toEqual([
    ["reports", ["html", "html"]],
    ["files", ["markdown", "video"]],
    ["older", []],
  ]);
  await act(async () =>
    renderer!.root.findByProps({ "data-artifact-section-toggle": "older" }).props.onClick(),
  );
  expect(
    renderer!.root
      .findAll((node) => node.type === "button" && node.props["data-artifact-aged"])
      .map((node) => node.props["data-artifact-aged"]),
  ).toEqual(["merged", "missing"]);
});

it("pins to the top and hides from the list, and remembers both", async () => {
  await render();
  await act(async () => action("plan.md", "pin").props.onClick());
  expect(sections()[0]).toEqual(["pinned", ["markdown"]]);
  await act(async () => action("snap-cover.jpg", "hide").props.onClick());
  expect(
    renderer!.root.findByProps({ "data-menu-trigger": "true" }).findAllByType("span").at(-1)!
      .children,
  ).toEqual(["5"]);
  expect(sections().at(-1)).toEqual(["hidden", []]);
  // The choice survives a remount.
  await act(async () => renderer!.unmount());
  await render();
  expect(sections()[0]).toEqual(["pinned", ["markdown"]]);
});

it("plays a host video through a server URL and steps through the thread's artifacts, oldest first", async () => {
  await render();
  await act(async () => item("snap-18s-master.mp4").props.onClick());
  const video = renderer!.root.findByType("video");
  expect(video.props.src).toBe("https://host.test/api/assets/t//tmp/promo/snap-18s-master.mp4");
  expect(video.props.controls).toBe(true);
  expect(state.minted).toContainEqual({
    _tag: "media-file",
    threadId: threadRef.threadId,
    path: "/tmp/promo/snap-18s-master.mp4",
  });
  expect(
    renderer!.root.findAll((node) => node.type === "span" && node.children.join("") === "1 of 5"),
  ).not.toHaveLength(0);
  expect(overlay.last).toMatchObject({
    title: "snap-18s-master.mp4",
    kind: "Video",
    badge: "MP4",
    detail: "Oct 15",
  });
  expect(
    renderer!.root.findByProps({ "data-file-actions": "/tmp/promo/snap-18s-master.mp4" }),
  ).toBeDefined();
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Next artifact" }).props.onClick(),
  );
  expect(renderer!.root.findByType("img").props.src).toContain("/tmp/promo/snap-cover.jpg");
});

it("opens a published page and an HTML file sandboxed, and markdown as a document", async () => {
  await render();
  await act(async () => item("Paid Ads Scorecard.html").props.onClick());
  expect(renderer!.root.findByType("iframe").props["data-html-render"]).toBe("true");
  await act(async () => item("victoria_email.html").props.onClick());
  const frame = renderer!.root.findByType("iframe");
  expect(frame.props.src).toContain("/tmp/promo/victoria_email.html");
  expect(frame.props["data-html-render"]).toBe("false");
  await act(async () => item("plan.md").props.onClick());
  expect(renderer!.root.findByProps({ "data-markdown": "true" }).children).toEqual([
    `contents of ${CWD}/docs/plan.md`,
  ]);
});

it("opens a link in the browser, not the viewer", async () => {
  await render();
  await act(async () => item("gitops #254").props.onClick());
  expect(state.openExternal).toHaveBeenCalledWith("https://github.com/acme/gitops/pull/254");
  expect(renderer!.root.findAll((node) => node.props["data-artifact-viewer"])).toHaveLength(0);
});

it("shows a report's media and pages as cards that open the viewer", async () => {
  await act(async () => {
    renderer = create(
      <ArtifactCards
        threadRef={threadRef}
        cwd={CWD}
        text={[
          "Screenshots: `/tmp/studio-machine-label/machine-label-1440-light.png`,",
          "`machine-label-1440-dark.png`, the clip `/tmp/promo/snap-18s-master.mp4`",
          "and the fix at `apps/web/src/app.ts:12`.",
        ].join(" ")}
      />,
    );
  });
  const cards = renderer!.root.findAll((node) => node.props["data-artifact-card"] !== undefined);
  expect(cards.map((card) => card.props["data-artifact-card"])).toEqual([
    "image",
    "image",
    "video",
  ]);
  expect(renderer!.root.findAllByType("img")[1]!.props.src).toContain(
    "/tmp/studio-machine-label/machine-label-1440-dark.png",
  );
  await act(async () => cards[2]!.props.onClick());
  expect(
    renderer!.root.findAll(
      (node) => node.type === "div" && node.props["data-artifact-viewer"] === "video",
    ),
  ).toHaveLength(1);
});
