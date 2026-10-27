import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  messages: [] as Array<{ id: string; role: string; text: string; createdAt?: unknown }>,
  turnItems: [] as unknown[],
  /** The app's own thread record: where it was continued from. */
  thread: undefined as unknown,
  /** Other threads' projections by id, such as the one a migrated thread continued. */
  others: new Map<string, { messages: unknown[]; turnItems: unknown[] }>(),
  minted: [] as unknown[],
  openExternal: vi.fn(),
  pullRequests: [] as unknown[],
  missing: new Set<string>(),
  checked: [] as Array<{ environmentId: unknown; paths: ReadonlyArray<string> }>,
  unreachable: new Set<string>(),
  /** Full tool calls the host returns on a detail read, by item id. */
  details: new Map<string, unknown>(),
  detailReads: [] as string[],
  unreadable: new Set<string>(),
  /** Files read as text, and the ones the host refuses as binary. */
  reads: [] as string[],
  binary: new Set<string>(),
}));

const overlay = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock("~/viewerOverlayStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/viewerOverlayStore")>()),
  // The overlay's header is the host's; the viewer's actions portal into it.
  useViewerOverlay: (options: Record<string, unknown> & { open: boolean }) => {
    overlay.last = options;
    return options.open ? { content: {} as HTMLElement, actions: {} as HTMLElement } : null;
  },
  useViewerContentKeys: () => {},
  useKeepViewerFocus: () => () => {},
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
  useThreadProjection: (ref: { threadId: string } | null) => {
    if (ref === null) return null;
    const other = state.others.get(ref.threadId);
    if (other) return { projection: other };
    return {
      projection: { messages: state.messages, turnItems: state.turnItems, thread: state.thread },
    };
  },
  useThreadShell: () => ({ pullRequests: state.pullRequests }),
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: (environmentId: string | null) =>
    environmentId === null
      ? null
      : { label: environmentId === "origin-environment" ? "Example Mini" : "Example Mac" },
  useUnreachableEnvironmentIds: () => state.unreachable,
}));
vi.mock("~/state/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/orchestration")>();
  return {
    ...actual,
    orchestrationEnvironment: {
      ...actual.orchestrationEnvironment,
      turnItem: (target: unknown) => ({ detailRead: target }),
    },
  };
});
vi.mock("@specweave-studio/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@specweave-studio/client-runtime/state/runtime")>()),
  // The host's answer to a turn item detail read.
  executeAtomQuery: async (
    _registry: unknown,
    atom: { detailRead?: { input: { itemId: string } } },
  ) => {
    const id = atom.detailRead?.input.itemId ?? "";
    state.detailReads.push(id);
    const item = state.details.get(id);
    return item ? { _tag: "Success", value: { item } } : { _tag: "Failure" };
  },
}));
vi.mock("../ui/popover", () => ({
  Popover: (props: { children: unknown; onOpenChange?: (open: boolean) => void }) => (
    <div>
      <button type="button" data-open-list="true" onClick={() => props.onOpenChange?.(true)} />
      {props.children as never}
    </div>
  ),
  PopoverTrigger: (props: { children: unknown }) => (
    <span data-menu-trigger="true">{props.children as never}</span>
  ),
  PopoverPopup: (props: { children: unknown }) => <div>{props.children as never}</div>,
}));
vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));
vi.mock("./useMissingArtifactFiles", () => ({
  useArtifactFileChecks: (input: {
    environmentId: unknown;
    paths: ReadonlyArray<string>;
    offline: string | null;
  }) => {
    state.checked.push({ environmentId: input.environmentId, paths: input.paths });
    return new Map(
      input.paths.map((path) => [
        path,
        input.offline !== null
          ? { state: "unreachable", reason: input.offline }
          : { state: state.missing.has(path) ? "missing" : "present" },
      ]),
    );
  },
}));
vi.mock("./ViewerFileActions", () => ({
  ViewerFileActions: (props: { path: string | null; menuItems?: unknown }) => (
    <span data-file-actions={props.path ?? ""}>{props.menuItems as never}</span>
  ),
}));
vi.mock("./useExistingFileLinks", () => ({
  useExistingFileLinks: (metas: unknown) => metas,
  // The missing-file notice lists the folder; here it is empty.
  folderEntriesOnHost: async () => [],
}));
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
  useProjectFileQuery: (_environmentId: string, _cwd: string, path: string) =>
    (state.reads.push(path), state.binary.has(path))
      ? {
          data: null,
          error: `'${path}' is not a text file, so it has no text preview.`,
          readError: { failure: "binary_file" },
        }
      : state.unreadable.has(path)
        ? {
            data: null,
            error: "No such file.",
            readError: { failure: "operation_failed", operation: "open" },
          }
        : { data: { contents: `contents of ${path}` }, error: null, readError: null },
}));
vi.mock("../files/DeckPreview", () => ({
  HostDeckPreview: (props: { path: string }) => <div data-host-deck={props.path} />,
  FilePreviewCard: (props: { path: string | null; reason: string }) => (
    <div data-file-card={props.path ?? ""}>{props.reason}</div>
  ),
}));
vi.mock("../files/AttachmentFilePreview", () => ({
  ReadOnlySourcePreview: (props: { name: string }) => <pre data-source={props.name} />,
}));
vi.mock("../files/BrowserDocumentFrame", () => ({
  BrowserDocumentFrame: (props: { src: string; htmlRender?: boolean }) => (
    <iframe title="frame" src={props.src} data-html-render={String(Boolean(props.htmlRender))} />
  ),
}));
vi.mock("./ViewerImageStage", () => ({
  ViewerImageStage: (props: { src: string; name: string }) => (
    <img src={props.src} alt={props.name} data-viewer-image-stage="true" />
  ),
}));
vi.mock("../files/AudioPreview", () => ({
  AudioPreview: (props: { src: string }) => <audio src={props.src} />,
}));

import { useViewerOverlayStore } from "~/viewerOverlayStore";
import { ArtifactCards, MessageFileViewer, ThreadArtifactsMenu } from "./ThreadArtifacts";

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
  state.thread = undefined;
  state.others = new Map();
  state.checked = [];
  state.unreachable = new Set();
  state.details = new Map();
  state.detailReads = [];
  state.unreadable = new Set();
  state.reads = [];
  state.binary = new Set();
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

it("hands a file to the side panel only after the overlay is out of the way", async () => {
  // A file opened while the overlay is up opens in the overlay, so the panel
  // must be asked once the overlay has gone, or it opens nowhere visible.
  useViewerOverlayStore.getState().open({
    key: "message-file",
    title: "notes.ts",
    kind: "File",
    badge: "TS",
    detail: null,
    threadRef,
    origin: null,
    trail: [],
    onBack: null,
  });
  const overlayWhenOpened: Array<unknown> = [];
  const target = {
    filePath: "/tmp/promo/notes.ts",
    targetPath: "/tmp/promo/notes.ts",
    displayPath: "notes.ts",
    workspaceRelativePath: null,
    basename: "notes.ts",
  };
  const onClose = vi.fn();
  await act(async () => {
    renderer = create(
      <MessageFileViewer
        threadRef={threadRef}
        cwd={CWD}
        target={target}
        links={[target]}
        onClose={onClose}
        onOpenInPanel={() => overlayWhenOpened.push(useViewerOverlayStore.getState().active)}
      />,
    );
  });
  await act(async () => item("Open in panel").props.onClick());
  expect(overlayWhenOpened).toEqual([null]);
  expect(onClose).toHaveBeenCalledOnce();
});

// Synthetic only: no real page, account or machine.
const PAGE_URL = "https://claude.ai/artifact/ExampleArtifact0001";

function artifactCall(id: string, output: unknown, extra: Record<string, unknown> = {}) {
  return {
    id,
    threadId: threadRef.threadId,
    type: "dynamic_tool",
    status: "completed",
    toolName: "Artifact",
    input: { file_path: "/tmp/promo/probe.html", title: "Probe page" },
    output,
    nativeItemRef: { driver: "claudeAgent", nativeId: id, strength: "exact" },
    completedAt: DateTime.makeUnsafe("2026-10-16T09:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-16T09:00:00.000Z"),
    ...extra,
  };
}

function published(seq: number) {
  return {
    url: PAGE_URL,
    path: "/tmp/promo/probe.html",
    artifact_id: "00000000-0000-4000-8000-000000000001",
    title: "Probe page",
    seq,
    version: `1700000000-000${seq}`,
    audience: "owner",
  };
}

function rows() {
  return renderer!.root
    .findAll((node) => node.type === "button" && node.props["data-thread-artifact"])
    .map((node) => node.props["data-thread-artifact"]);
}

it("lists a Claude Code publish once at its newest version, in Reports, and opens it in the browser", async () => {
  // The first call kept its result as JSON text, as a replayed history does;
  // the timeline withholds the newer one's, which a detail read returns.
  state.turnItems = [
    artifactCall("publish-1", JSON.stringify(published(1))),
    artifactCall("publish-2", undefined, { outputOmitted: true }),
    artifactCall(
      "read-1",
      { read: { url: PAGE_URL } },
      { input: { action: "read", url: PAGE_URL } },
    ),
    artifactCall("failed-1", "Artifacts need a claude.ai login.", { status: "failed" }),
  ];
  state.details.set("publish-2", artifactCall("publish-2", published(2)));
  state.messages.push({ id: "a2", role: "assistant", text: `Published: ${PAGE_URL}` });
  await render();
  await act(async () => {});
  expect(sections()).toContainEqual(["reports", ["native", "html"]]);
  expect(rows().filter((kind) => kind === "native")).toHaveLength(1);
  // One read: the newest call answered for the page.
  expect(state.detailReads).toEqual(["publish-2"]);
  const page = renderer!.root.find(
    (node) => node.type === "li" && node.props["data-thread-artifact-row"] === "native",
  );
  expect(page.findByProps({ "data-artifact-version": "true" }).children).toEqual(["Version 2"]);
  expect(page.findByProps({ "data-artifact-note": "true" }).children).toEqual([
    "Private claude.ai link. Opens only for the account that published it.",
  ]);
  await act(async () =>
    page
      .find((node) => node.type === "button" && node.props["data-thread-artifact"] === "native")
      .props.onClick(),
  );
  expect(state.openExternal).toHaveBeenCalledWith(PAGE_URL);
  expect(renderer!.root.findAll((node) => node.props["data-artifact-viewer"])).toHaveLength(0);
});

function nativeRows() {
  return rows().filter((kind) => kind === "native");
}

it("asks again for a page the host did not answer for, later and at once when it is back", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  state.turnItems = [artifactCall("publish-retry", undefined, { outputOmitted: true })];
  await render();
  await act(async () => {});
  expect(state.detailReads).toEqual(["publish-retry"]);
  expect(nativeRows()).toHaveLength(0);
  // The host answers now; the next attempt lists the page.
  state.details.set("publish-retry", artifactCall("publish-retry", published(1)));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(state.detailReads).toEqual(["publish-retry", "publish-retry"]);
  expect(nativeRows()).toHaveLength(1);
});

it("asks nothing while the machine is offline and reads the page when it returns", async () => {
  state.unreachable = new Set([threadRef.environmentId]);
  state.turnItems = [artifactCall("publish-offline", undefined, { outputOmitted: true })];
  state.details.set("publish-offline", artifactCall("publish-offline", published(1)));
  await render();
  await act(async () => {});
  expect(state.detailReads).toEqual([]);
  state.unreachable = new Set();
  await act(async () => renderer!.update(<ThreadArtifactsMenu threadRef={threadRef} cwd={CWD} />));
  await act(async () => {});
  expect(state.detailReads).toEqual(["publish-offline"]);
  expect(nativeRows()).toHaveLength(1);
});

it("keeps entries and pins as the thread moves from Claude to Codex and back", async () => {
  const change = (id: string, driver: string, path: string) => ({
    id,
    type: "file_change",
    status: "completed",
    fileName: path,
    changes: [{ path, operation: "add" }],
    nativeItemRef: { driver, nativeId: id, strength: "exact" },
    completedAt: DateTime.makeUnsafe("2026-10-16T10:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-16T10:00:00.000Z"),
  });
  // Claude publishes a page and writes a file.
  state.turnItems = [
    artifactCall("publish-switch", published(1)),
    change("claude-write", "claudeAgent", "/tmp/promo/claude-notes.md"),
  ];
  await render();
  await act(async () => {});
  await act(async () => action("claude-notes.md", "pin").props.onClick());
  const reads = state.detailReads.length;
  // Codex takes a turn, then Claude again; the timeline only grows.
  state.turnItems = [
    ...state.turnItems,
    change("codex-write", "codex", "/tmp/promo/codex-plan.md"),
    change("claude-again", "claudeAgent", "/tmp/promo/claude-final.md"),
  ];
  await act(async () => renderer!.update(<ThreadArtifactsMenu threadRef={threadRef} cwd={CWD} />));
  await act(async () => {});
  expect(sections()[0]).toEqual(["pinned", ["markdown"]]);
  expect(rows().filter((kind) => kind === "native")).toHaveLength(1);
  for (const name of ["claude-notes.md", "codex-plan.md", "claude-final.md"]) item(name);
  // The page is not read again for another provider's turns.
  expect(state.detailReads).toHaveLength(reads);
});

it("reads remote-only once the page's source left the disk, and still opens the link", async () => {
  state.turnItems = [artifactCall("publish-3", published(3))];
  state.missing = new Set(["/tmp/promo/probe.html"]);
  await render();
  await act(async () => {});
  const page = renderer!.root.find(
    (node) => node.type === "li" && node.props["data-thread-artifact-row"] === "native",
  );
  expect(page.props["data-artifact-state"]).toBe("remote-only");
  expect(sections()).toContainEqual(["reports", ["native", "html"]]);
  await act(async () =>
    page
      .find((node) => node.type === "button" && node.props["data-thread-artifact"] === "native")
      .props.onClick(),
  );
  expect(state.openExternal).toHaveBeenCalledWith(PAGE_URL);
});

it("opens a missing file as an explained notice with its last known path, asking for nothing", async () => {
  state.missing = new Set(["/tmp/promo/snap-cover.jpg"]);
  await render();
  await act(async () =>
    renderer!.root.findByProps({ "data-artifact-section-toggle": "older" }).props.onClick(),
  );
  await act(async () => item("snap-cover.jpg").props.onClick());
  await act(async () => {});
  expect(
    renderer!.root.findAll(
      (node) => node.props["data-missing-file"] === "/tmp/promo/snap-cover.jpg",
    ),
  ).not.toHaveLength(0);
  expect(
    renderer!.root.findByProps({ "data-copy-path": "/tmp/promo/snap-cover.jpg" }),
  ).toBeDefined();
  expect(state.minted).not.toContainEqual(
    expect.objectContaining({ path: "/tmp/promo/snap-cover.jpg" }),
  );
});

it("explains a document that is gone when it is opened, not with the raw error", async () => {
  state.unreadable = new Set([`${CWD}/docs/plan.md`]);
  await render();
  await act(async () => item("plan.md").props.onClick());
  await act(async () => {});
  expect(
    renderer!.root.findAll((node) => node.props["data-missing-file"] === `${CWD}/docs/plan.md`),
  ).not.toHaveLength(0);
});

it("reads every file unreachable while the machine is offline, and opens one without asking for it", async () => {
  state.unreachable = new Set([threadRef.environmentId]);
  await render();
  expect(renderer!.root.findByProps({ "data-artifact-shelf-notice": "true" }).children).toEqual([
    "Example Mac is offline. Its files can't be checked until it is back.",
  ]);
  expect(
    renderer!.root
      .findAll((node) => node.type === "li" && node.props["data-artifact-state"] === "unreachable")
      .map((node) => node.props["data-thread-artifact-row"]),
  ).toEqual(["html", "markdown", "image", "video"]);
  // Unreachable is not gone: nothing folds into Older.
  expect(sections().map(([id]) => id)).not.toContain("older");
  await act(async () => item("snap-18s-master.mp4").props.onClick());
  expect(
    renderer!.root.findAll(
      (node) => node.props["data-unreachable-file"] === "/tmp/promo/snap-18s-master.mp4",
    ),
  ).not.toHaveLength(0);
  expect(state.minted).not.toContainEqual(
    expect.objectContaining({ path: "/tmp/promo/snap-18s-master.mp4" }),
  );
});

it("lists what a migrated thread's origin listed, with its pins, moved into this checkout", async () => {
  const ORIGIN_ROOT = "/Users/example/origin/easychamp";
  const origin = {
    environmentId: EnvironmentId.make("origin-environment"),
    threadId: ThreadId.make("origin-thread"),
  };
  state.thread = {
    id: threadRef.threadId,
    execution: { sourceRoot: { ...origin, workspaceRoot: ORIGIN_ROOT } },
  };
  // The continuation's own thread holds only its seed message.
  state.messages = [{ id: "seed", role: "user", text: "Continue here." }];
  state.turnItems = [];
  state.others.set(origin.threadId, {
    messages: [
      {
        id: "o1",
        role: "assistant",
        createdAt: DateTime.makeUnsafe("2026-10-15T12:00:00.000Z"),
        text: `Wrote \`${ORIGIN_ROOT}/docs/handoff.md\`.`,
      },
    ],
    turnItems: [],
  });
  window.localStorage.setItem(
    `studio:artifact-shelf:v2:${origin.environmentId}:${origin.threadId}`,
    JSON.stringify({ version: 2, pinned: [`file:${ORIGIN_ROOT}/docs/handoff.md`], hidden: [] }),
  );
  await render();
  await act(async () => renderer!.root.findByProps({ "data-open-list": "true" }).props.onClick());
  expect(sections()).toEqual([["pinned", ["markdown"]]]);
  const moved = renderer!.root.find(
    (node) => node.type === "li" && node.props["data-thread-artifact-row"] === "markdown",
  );
  expect(moved.findByProps({ "data-artifact-source": "true" }).children).toEqual([
    "From Example Mini",
  ]);
  // Checked on this machine, at this checkout's path.
  expect(state.checked.at(-1)).toEqual({
    environmentId: threadRef.environmentId,
    paths: [`${CWD}/docs/handoff.md`],
  });
});

it("lists a migrated thread's origin from the snapshot it left when its thread cannot be read", async () => {
  const ORIGIN_ROOT = "/Users/example/origin/easychamp";
  const origin = {
    environmentId: EnvironmentId.make("origin-environment"),
    threadId: ThreadId.make("origin-thread"),
  };
  state.thread = {
    id: threadRef.threadId,
    execution: { sourceRoot: { ...origin, workspaceRoot: ORIGIN_ROOT } },
  };
  state.messages = [{ id: "seed", role: "user", text: "Continue here." }];
  state.turnItems = [];
  // Its machine is out of reach: its thread reads as empty here.
  state.others.set(origin.threadId, { messages: [], turnItems: [] });
  window.localStorage.setItem(
    `studio:artifact-shelf:v2:${origin.environmentId}:${origin.threadId}`,
    JSON.stringify({
      version: 2,
      pinned: [],
      hidden: [],
      snapshot: [
        {
          id: `file:${ORIGIN_ROOT}/docs/handoff.md`,
          kind: "markdown",
          name: "handoff.md",
          path: `${ORIGIN_ROOT}/docs/handoff.md`,
          at: Date.parse("2026-10-15T12:00:00.000Z"),
        },
        {
          id: "link:example.com/spec",
          kind: "link",
          name: "Spec",
          url: "https://example.com/spec",
        },
      ],
    }),
  );
  await render();
  // Counted before the list opens, without reading the origin's thread.
  expect(
    renderer!.root.findByProps({ "data-menu-trigger": "true" }).findAllByType("span").at(-1)!
      .children,
  ).toEqual(["2"]);
  expect(sections()).toEqual([
    ["files", ["markdown"]],
    ["links", ["link"]],
  ]);
  expect(state.checked.at(-1)?.paths).toEqual([`${CWD}/docs/handoff.md`]);
});

it("opens a deck as its slides and other binary files as cards, never as a failed text read", async () => {
  const deck = "/Users/me/.specwithcode/m4/evidence/exports/installed-1.0.92-deck.pptx";
  state.messages = [
    {
      id: "a2",
      role: "assistant",
      createdAt: DateTime.makeUnsafe("2026-10-15T12:00:00.000Z"),
      text: `Deck \`${deck}\`, talk \`/tmp/out/talk.key\`, brief \`/tmp/out/brief.docx\` and blob \`/tmp/out/blob.dat\`.`,
    },
  ];
  state.turnItems = [];
  state.binary = new Set(["/tmp/out/blob.dat"]);
  await render();
  const cards = () =>
    renderer!.root
      .findAll((node) => typeof node.props["data-file-card"] === "string")
      .map((node) => [node.props["data-file-card"], node.children.join("")]);

  await act(async () => item("installed-1.0.92-deck.pptx").props.onClick());
  expect(renderer!.root.findAll((node) => node.props["data-host-deck"] === deck)).toHaveLength(1);
  expect(state.reads).not.toContain(deck);
  expect(state.minted).not.toContainEqual(expect.objectContaining({ path: deck }));

  for (const [name, path, reason] of [
    ["talk.key", "/tmp/out/talk.key", "Keynote presentations have no preview here."],
    ["brief.docx", "/tmp/out/brief.docx", "Word documents have no preview here."],
  ] as const) {
    await act(async () => renderer!.unmount());
    await render();
    await act(async () => item(name).props.onClick());
    expect(cards()).toEqual([[path, reason]]);
    expect(state.reads).not.toContain(path);
  }

  await act(async () => renderer!.unmount());
  await render();
  await act(async () => item("blob.dat").props.onClick());
  expect(cards()).toEqual([
    ["/tmp/out/blob.dat", "blob.dat is not a text file, and has no preview here."],
  ]);
});
