import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const overlay = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
const media = vi.hoisted(() => ({ save: vi.fn(async () => {}), copyImage: vi.fn(async () => {}) }));
vi.mock("~/viewerOverlayStore", () => ({
  // The overlay's header and thread pane are the host's; the viewer portals into them.
  useViewerOverlay: (options: Record<string, unknown> & { open: boolean }) => {
    overlay.last = options;
    return options.open ? { content: {} as HTMLElement, actions: {} as HTMLElement } : null;
  },
  useViewerContentKeys: () => {},
  useKeepViewerFocus: () => () => {},
  viewerExtensionBadge: (name: string) => name.slice(name.lastIndexOf(".") + 1).toUpperCase(),
}));
const calls = vi.hoisted(() => [] as string[]);
vi.mock("~/lib/openInFront", () => ({
  stepOutOfViewerOverlay: () => calls.push("step out"),
}));
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (node: unknown) => node,
}));
vi.mock("../ui/dialog", () => ({
  Dialog: (props: { open: boolean; children: unknown }) =>
    props.open ? <div data-dialog="open">{props.children as never}</div> : null,
  DialogPopup: (props: { children: unknown }) => (
    <div data-dialog-popup="true">{props.children as never}</div>
  ),
  DialogTitle: (props: { children: unknown }) => <h2>{props.children as never}</h2>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: { children: unknown }) => <>{props.children as never}</>,
  TooltipTrigger: (props: { render?: unknown; children: unknown }) => (
    <>{(props.render ?? props.children) as never}</>
  ),
  TooltipPopup: () => null,
}));
vi.mock("../ui/menu", () => ({
  MenuItem: (props: { children: unknown; onClick?: () => void }) => (
    <button type="button" data-menu-item="true" onClick={props.onClick}>
      {props.children as never}
    </button>
  ),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn(() => "toast"), update: vi.fn() },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("./ViewerFileActions", () => ({
  ViewerFileActions: (props: { path: string | null; menuItems?: unknown }) => (
    <span data-file-actions={props.path ?? ""}>{props.menuItems as never}</span>
  ),
}));
vi.mock("./ViewerImageStage", () => ({
  ViewerImageStage: (props: { src: string; name: string }) => (
    <img src={props.src} alt={props.name} data-viewer-image-stage="true" />
  ),
}));
vi.mock("./ZoomableImage", () => ({
  ZoomableImage: (props: { src: string; name: string }) => (
    <img src={props.src} alt={props.name} data-lightbox-image="true" />
  ),
}));
vi.mock("../media/MediaActions", () => ({
  MediaActions: (props: { children: unknown }) => <>{props.children as never}</>,
  useMediaActions: () => ({
    save: media.save,
    copyImage: media.copyImage,
    canReadMedia: true,
    assertCanReadMedia: () => {},
  }),
}));
vi.mock("../media/MediaVideoPlayer", () => ({
  MediaVideoPlayer: (props: { src: string | null }) => <video src={props.src ?? undefined} />,
}));
vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Loading" }),
  useAssetUrlRefresh: () => () => {},
}));

import { ExpandedImageDialog } from "./ExpandedImageDialog";

const threadRef = {
  environmentId: EnvironmentId.make("media-environment"),
  threadId: ThreadId.make("media-thread"),
};
const preview = {
  index: 0,
  images: [
    {
      src: "https://host.test/a.png",
      name: "chart-light.png",
      actionsSource: {
        kind: "image" as const,
        name: "chart-light.png",
        src: "https://host.test/a.png",
        reference: {
          kind: "file" as const,
          path: "/tmp/shots/chart-light.png",
          relativePath: "shots/chart-light.png",
        },
      },
    },
    { src: "https://host.test/b.png", name: "chart-dark.png" },
  ],
};

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", Object.assign(new EventTarget(), {}));
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("HTMLElement", class {});
  overlay.last = null;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const byLabel = (label: string) => renderer!.root.findByProps({ "aria-label": label });

it("opens a thread's image in the viewer overlay beside that thread, not a lightbox", async () => {
  const onClose = vi.fn();
  await act(async () => {
    renderer = create(
      <ExpandedImageDialog preview={preview} onClose={onClose} threadRef={threadRef} />,
    );
  });
  expect(renderer!.root.findAll((node) => node.props["data-dialog"] === "open")).toHaveLength(0);
  expect(overlay.last).toMatchObject({
    open: true,
    title: "chart-light.png",
    kind: "Image",
    badge: "PNG",
    threadRef,
  });
  expect(overlay.last!.onClose).toBe(onClose);
  expect(renderer!.root.findByProps({ "data-viewer-image-stage": "true" }).props.src).toBe(
    "https://host.test/a.png",
  );
  expect(
    renderer!.root.findByProps({ "data-file-actions": "/tmp/shots/chart-light.png" }),
  ).toBeDefined();

  // Download goes through the media actions, which mint a fresh URL for host files.
  await act(async () => byLabel("Download chart-light.png").props.onClick());
  expect(media.save).toHaveBeenCalledTimes(1);

  // The header steps through the message's media, and the header follows.
  expect(
    renderer!.root.findAll((node) => node.type === "span" && node.children.join("") === "1 of 2"),
  ).toHaveLength(1);
  await act(async () => byLabel("Next media").props.onClick());
  expect(overlay.last).toMatchObject({ title: "chart-dark.png", kind: "Image" });
  expect(renderer!.root.findByProps({ "data-viewer-image-stage": "true" }).props.src).toBe(
    "https://host.test/b.png",
  );
});

it("keeps media no thread owns in the lightbox", async () => {
  await act(async () => {
    renderer = create(<ExpandedImageDialog preview={preview} onClose={() => {}} />);
  });
  expect(overlay.last).toBeNull();
  expect(renderer!.root.findAll((node) => node.props["data-dialog"] === "open")).toHaveLength(1);
  expect(renderer!.root.findByProps({ "data-lightbox-image": "true" }).props.src).toBe(
    "https://host.test/a.png",
  );
});

it("opens the file in the panel only after the overlay is out of the way", async () => {
  calls.length = 0;
  const onClose = vi.fn(() => calls.push("close"));
  const withFile = {
    ...preview,
    images: [
      {
        ...preview.images[0]!,
        actionsSource: {
          kind: "image" as const,
          name: "chart-light.png",
          src: "https://host.test/a.png",
          onOpenFile: () => calls.push("open file"),
        },
      },
    ],
  };
  await act(async () => {
    renderer = create(
      <ExpandedImageDialog preview={withFile} onClose={onClose} threadRef={threadRef} />,
    );
  });
  const item = renderer!.root
    .findAllByProps({ "data-menu-item": "true" })
    .find(
      (node) => node.findAll((child) => child.children.includes("Open in file viewer")).length > 0,
    );
  await act(async () => item!.props.onClick());
  expect(calls).toEqual(["step out", "open file", "close"]);
});
