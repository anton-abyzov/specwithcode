// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@specweave-studio/shared/keybindings";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { useViewerOverlayStore, type ViewerFileTarget } from "~/viewerOverlayStore";

import {
  type FileReaderLayout,
  fileReaderLayoutFor,
  openFileInFront,
  reportFileReaderLayout,
  useFileReaderLayoutReport,
  useFocusedFileStore,
} from "~/lib/openInFront";

import { RightPanelTabs } from "./RightPanelTabs";
import { FocusedFileViewer } from "./ViewerOverlayHost";

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/browser/browserDefaults", () => ({ useBrowserDefaults: () => ({ profiles: [] }) }));
// What a read of the focused file returns.
const fileRead = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./files/projectFilesQueryState", () => ({
  useProjectFileQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    readError: null,
    isNotFile: false,
    refresh: () => undefined,
    ...fileRead.current,
  }),
}));

let root: Root;
let container: HTMLDivElement;
const addFiles = vi.fn();
const noop = () => undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  addFiles.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderPanel(
  overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {},
  children: ReactNode = "content",
) {
  await act(() =>
    root.render(
      <RightPanelTabs
        mode="inline"
        open
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        getShortcutContext={() => ({
          terminalFocus: false,
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        })}
        surfaces={[]}
        environmentId={null}
        activeSurfaceId={null}
        pendingSurfaceIds={new Set()}
        previewSessions={{}}
        desktopByTabId={{}}
        terminalLabelsById={new Map()}
        onActivate={noop}
        onCloseSurface={noop}
        onCloseOtherSurfaces={noop}
        onCloseSurfacesToRight={noop}
        onCloseAllSurfaces={noop}
        onCopyFilePath={noop}
        onAddBrowser={noop}
        onAddBrowserInProfile={noop}
        onAddTerminal={noop}
        onAddDiff={noop}
        onAddFiles={addFiles}
        onAddPullRequest={noop}
        onAddPullRequests={noop}
        onAddDevice={noop}
        browserAvailable={false}
        terminalAvailable={false}
        diffAvailable={false}
        filesAvailable
        pullRequestAvailable={false}
        pullRequestsAvailable={false}
        deviceAvailable={false}
        {...overrides}
      >
        {children}
      </RightPanelTabs>,
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
}

async function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  await act(() => (document.activeElement ?? document.body).dispatchEvent(event));
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
  return event;
}

describe("right panel new-tab shortcut", () => {
  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "opens the menu on %s and chooses a tab",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await renderPanel();
      const event = await press(
        "t",
        platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true },
      );
      expect(event.defaultPrevented).toBe(true);
      expect(document.querySelector('[role="menu"]')?.textContent).toContain(
        "Linked pull requests",
      );
      expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
      expect(
        (
          await press("t", {
            metaKey: platform === "MacIntel",
            ctrlKey: platform !== "MacIntel",
            repeat: true,
          })
        ).defaultPrevented,
      ).toBe(true);
      await press("f");
      expect(addFiles).toHaveBeenCalledOnce();
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    },
  );

  it("leaves the shortcut alone while the mounted panel is closed", async () => {
    await renderPanel({ open: false });
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
  });

  it.each(["Win32", "Linux x86_64"])(
    "leaves Ctrl+T for the focused terminal on %s",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await renderPanel({
        getShortcutContext: () => ({
          terminalFocus: true,
          terminalOpen: true,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        }),
      });
      const terminal = document.createElement("textarea");
      const onKeyDown = vi.fn();
      terminal.addEventListener("keydown", onKeyDown);
      container.append(terminal);
      await act(() => terminal.focus());
      const event = await press("t", { ctrlKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(onKeyDown).toHaveBeenCalledWith(event);
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    },
  );

  it("uses a custom binding from a text field and closes on Escape", async () => {
    const input = document.createElement("input");
    await renderPanel({
      keybindings: compileResolvedKeybindingsConfig([{ key: "mod+y", command: "rightPanel.new" }]),
    });
    document.body.append(input);
    input.focus();
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    await press("y", { metaKey: true });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await press("Escape");
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[aria-label="Add panel surface"]'),
    );
    input.remove();
  });

  it("does not open over another popup or during text composition", async () => {
    await renderPanel();
    expect((await press("t", { metaKey: true, isComposing: true })).defaultPrevented).toBe(false);
    const dialog = document.createElement("div");
    dialog.dataset.slot = "dialog-popup";
    container.append(dialog);
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("supports arrow keys with an existing tab in sheet mode and clears the menu on close", async () => {
    const panel = {
      mode: "sheet" as const,
      surfaces: [{ id: "files" as const, kind: "files" as const }],
    };
    await renderPanel(panel);
    await press("t", { metaKey: true });
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Files");
    await press("Enter");
    expect(addFiles).toHaveBeenCalledOnce();
    await press("t", { metaKey: true });
    await renderPanel({ ...panel, open: false });
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
    await renderPanel(panel);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull();
  });
});

/** Room for the conversation (740 px) and the reader (540 px) side by side. */
const WIDE: FileReaderLayout = { rowWidth: 1280, panelWidth: 540, sheet: false, maximized: false };

describe("file reader close, Escape and focus (1049 AC-06)", () => {
  const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-reader"));
  const terminal = {
    id: "terminal:t1" as const,
    kind: "terminal" as const,
    resourceId: "t1",
    terminalIds: ["t1"],
    activeTerminalId: "t1",
  };
  const preview = { id: "browser:tab-1" as const, kind: "preview" as const, resourceId: "tab-1" };
  let link: HTMLButtonElement;
  let unreport: () => void;
  const closeSurface = vi.fn();

  beforeEach(() => {
    useRightPanelStore.setState({
      byThreadKey: {},
      threadPanelVisibilityByThreadKey: {},
      userActionRevisionByThreadKey: {},
      closeRevisionByThreadKey: {},
    });
    useFocusedFileStore.setState({ file: null, from: null });
    closeSurface.mockClear();
    link = document.createElement("button");
    link.textContent = "docs/notes.md";
    document.body.append(link);
    // The conversation and the reader fit side by side, so links open beside (D-05).
    unreport = reportFileReaderLayout(ref, WIDE);
  });
  afterEach(() => {
    unreport();
    link.remove();
  });

  const panelState = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  const content = () => container.querySelector<HTMLElement>("[data-right-panel-surface-content]")!;
  const readerClose = () => container.querySelector<HTMLButtonElement>("[data-file-reader-close]");

  /** A chat link opens the file while it holds focus. */
  async function openFromLink(
    overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {},
    children?: ReactNode,
  ) {
    link.focus();
    openFileInFront({ threadRef: ref, cwd: "", path: "docs/notes.md", line: undefined });
    const state = panelState();
    await renderPanel(
      {
        surfaces: state.surfaces,
        activeSurfaceId: state.activeSurfaceId,
        onCloseSurface: closeSurface,
        ...overrides,
      },
      children,
    );
    return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)!;
  }

  it("C1/C6: shows a labeled Close with no hover, and it closes and returns focus", async () => {
    const file = await openFromLink();
    const close = readerClose();
    expect(close?.textContent).toContain("Close");
    expect(close?.textContent).toContain("Esc");
    expect(close?.getAttribute("aria-label")).toBe("Close notes.md");
    await act(() => close!.click());
    await act(() => vi.advanceTimersToNextFrame());
    expect(closeSurface).toHaveBeenCalledWith(file);
    expect(document.activeElement).toBe(link);
  });

  it("C2: a link hands focus to the reader, and Escape closes it and returns focus to the link", async () => {
    const file = await openFromLink();
    expect(document.activeElement).toBe(content());
    const event = await press("Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(closeSurface).toHaveBeenCalledExactlyOnceWith(file);
    expect(document.activeElement).toBe(link);
  });

  it("returns focus from the tab's own X too", async () => {
    await openFromLink();
    await act(() => container.querySelector<HTMLButtonElement>("[data-panel-tab-close]")!.click());
    await act(() => vi.advanceTimersToNextFrame());
    expect(closeSurface).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(link);
  });

  it("C3: an editor in the reader keeps Escape", async () => {
    await openFromLink({}, <textarea aria-label="Editor" />);
    await act(() => container.querySelector("textarea")!.focus());
    expect((await press("Escape")).defaultPrevented).toBe(false);
    expect(closeSurface).not.toHaveBeenCalled();
  });

  it("C4: an open menu or a combobox showing its list keeps Escape", async () => {
    await openFromLink(
      {},
      <>
        <div role="menu">
          <button type="button">Copy path</button>
        </div>
        <button type="button" aria-expanded="true">
          Pick
        </button>
      </>,
    );
    for (const target of [
      container.querySelector<HTMLElement>('[role="menu"] button')!,
      container.querySelector<HTMLElement>('[aria-expanded="true"]')!,
    ]) {
      await act(() => target.focus());
      expect((await press("Escape")).defaultPrevented).toBe(false);
    }
    expect(closeSurface).not.toHaveBeenCalled();
  });

  it("C5: a write in flight keeps the reader open on Escape, and the labeled Close still closes", async () => {
    const file = await openFromLink({
      pendingSurfaceIds: new Set([`file:docs/notes.md`]),
    });
    expect((await press("Escape")).defaultPrevented).toBe(false);
    expect(closeSurface).not.toHaveBeenCalled();
    await act(() => readerClose()!.click());
    expect(closeSurface).toHaveBeenCalledWith(file);
  });

  it("C7: a link that left the page gets no focus, and closing does not throw", async () => {
    await openFromLink();
    link.remove();
    await press("Escape");
    expect(closeSurface).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(link);
  });

  it("C8: a file opened from inside the panel leaves focus there, and Escape still closes it", async () => {
    const tree = <button type="button">notes.md</button>;
    await renderPanel(
      { surfaces: [{ id: "files", kind: "files" }], activeSurfaceId: "files" },
      tree,
    );
    const item = container.querySelector<HTMLElement>("[data-right-panel-surface-content] button")!;
    await act(() => item.focus());
    useRightPanelStore.getState().openFile(ref, "docs/notes.md");
    const state = panelState();
    await renderPanel(
      {
        surfaces: state.surfaces,
        activeSurfaceId: state.activeSurfaceId,
        onCloseSurface: closeSurface,
      },
      tree,
    );
    expect(document.activeElement).toBe(item);
    await press("Escape");
    expect(closeSurface).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(item);
  });

  it("does not take focus from a field or when a tab is only shown again", async () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    useRightPanelStore.getState().openFile(ref, "docs/notes.md");
    let state = panelState();
    await renderPanel({ surfaces: state.surfaces, activeSurfaceId: state.activeSurfaceId });
    expect(document.activeElement).toBe(field);
    field.remove();

    await openFromLink();
    expect(document.activeElement).toBe(content());
    // The thread is revisited: the same tab mounts again and is no new open.
    await act(() => root.unmount());
    root = createRoot(container);
    link.focus();
    state = panelState();
    await renderPanel({ surfaces: state.surfaces, activeSurfaceId: state.activeSurfaceId });
    expect(document.activeElement).toBe(link);
  });

  it("C9: a terminal or browser keeps Escape and has no labeled Close", async () => {
    for (const surface of [terminal, preview]) {
      await renderPanel(
        { surfaces: [surface], activeSurfaceId: surface.id, onCloseSurface: closeSurface },
        <button type="button">inside</button>,
      );
      expect(readerClose()).toBeNull();
      expect(content().hasAttribute("tabindex")).toBe(false);
      await act(() =>
        container.querySelector<HTMLElement>("[data-right-panel-surface-content] button")!.focus(),
      );
      expect((await press("Escape")).defaultPrevented).toBe(false);
    }
    expect(closeSurface).not.toHaveBeenCalled();
  });

  it("C3: an editor whose field sits in a shadow root keeps Escape", async () => {
    await openFromLink({}, <div data-testid="editor-host" />);
    const host = container.querySelector<HTMLElement>('[data-testid="editor-host"]')!;
    const field = document.createElement("textarea");
    host.attachShadow({ mode: "open" }).append(field);
    await act(() => field.focus());
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    await act(() => field.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(closeSurface).not.toHaveBeenCalled();
  });

  it("closes on an Escape a framed page in the reader left alone, and only then", async () => {
    const file = await openFromLink({}, <iframe title="page" />);
    const frame = container.querySelector("iframe")!;
    const outside = document.createElement("iframe");
    document.body.append(outside);
    const escape = (source: HTMLIFrameElement, method = "ui/notifications/report-escape") =>
      act(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { jsonrpc: "2.0", method },
            source: source.contentWindow,
          }),
        ),
      );
    // Focus is not in the frame yet, then a frame outside the reader, then another message.
    await escape(frame);
    outside.focus();
    await escape(outside);
    frame.focus();
    await escape(frame, "ui/notifications/size-changed");
    expect(closeSurface).not.toHaveBeenCalled();
    await escape(frame);
    expect(closeSurface).toHaveBeenCalledExactlyOnceWith(file);
    outside.remove();
  });

  it("C10: a modified Escape is left alone", async () => {
    await openFromLink();
    for (const modifier of ["shiftKey", "metaKey", "ctrlKey", "altKey"] as const) {
      await act(() => content().focus());
      expect((await press("Escape", { [modifier]: true })).defaultPrevented).toBe(false);
    }
    expect(closeSurface).not.toHaveBeenCalled();
  });

  it("leaves Escape and focus to the sheet, which hands focus back itself", async () => {
    await openFromLink({ mode: "sheet" });
    expect(document.activeElement).toBe(link);
    const close = readerClose();
    expect(close?.textContent).toContain("Close");
    expect(close?.textContent).not.toContain("Esc");
    await act(() => content().setAttribute("tabindex", "-1"));
    await act(() => content().focus());
    expect((await press("Escape")).defaultPrevented).toBe(false);
    expect(closeSurface).not.toHaveBeenCalled();
  });
});

describe("file links open beside or in front by the room there is (1049 AC-06, D-05)", () => {
  const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-placement"));
  const fileId = "file:docs/notes.md";
  let link: HTMLButtonElement;
  let unreport: (() => void) | null = null;
  const report = (layout: Partial<FileReaderLayout>) => {
    unreport?.();
    unreport = reportFileReaderLayout(ref, { ...WIDE, ...layout });
  };
  const panelState = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  const openFromLink = (opener: HTMLElement = link, path = "docs/notes.md", line?: number) => {
    opener.focus();
    openFileInFront({ threadRef: ref, cwd: "", path, line });
  };
  /** A button in a layer with these attributes, as the Files tree, a menu or a dialog has. */
  const inside = (attributes: Record<string, string>) => {
    const layer = document.createElement("div");
    for (const [name, value] of Object.entries(attributes)) layer.setAttribute(name, value);
    const button = document.createElement("button");
    layer.append(button);
    document.body.append(layer);
    return button;
  };

  beforeEach(async () => {
    useRightPanelStore.setState({
      byThreadKey: {},
      threadPanelVisibilityByThreadKey: {},
      userActionRevisionByThreadKey: {},
      closeRevisionByThreadKey: {},
    });
    useFocusedFileStore.setState({ file: null, from: null });
    useViewerOverlayStore.setState({ active: null, linked: null, linkedFrom: null });
    link = document.createElement("button");
    link.textContent = "notes.md";
    document.body.append(link);
    // The app shell's focused viewer, there to show a file in front.
    await act(() => root.render(<FocusedFileViewer />));
  });
  afterEach(() => {
    unreport?.();
    unreport = null;
    document.body.replaceChildren(container);
  });

  it.each([
    ["R1: room for both", { rowWidth: 1280, panelWidth: 540 }, "beside"],
    ["R2: the conversation keeps exactly 560", { rowWidth: 1100, panelWidth: 540 }, "beside"],
    ["R3: the conversation would get 559", { rowWidth: 1099, panelWidth: 540 }, "focused"],
    ["R4: the reader would get 479", { rowWidth: 1280, panelWidth: 479 }, "focused"],
    ["R5: the reader gets exactly 480", { rowWidth: 1280, panelWidth: 480 }, "beside"],
    ["R6: the panel is a sheet over the conversation", { sheet: true }, "focused"],
    ["R11: the panel is maximized", { maximized: true }, "focused"],
  ] as const)("%s opens %s", (_, layout, placement) => {
    report(layout);
    openFromLink(link, "docs/notes.md", 12);
    if (placement === "beside") {
      expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: fileId });
      expect(useFocusedFileStore.getState().file).toBeNull();
      return;
    }
    // The panel stays as it was; the file shows in front with the link to return to.
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(useRightPanelStore.getState().threadPanelVisibilityByThreadKey).toEqual({});
    expect(useRightPanelStore.getState().userActionRevisionByThreadKey).toEqual({});
    expect(useFocusedFileStore.getState()).toEqual({
      file: { threadRef: ref, cwd: "", path: "docs/notes.md", line: 12 },
      from: link,
    });
  });

  it("opens the file in the panel as before where no focused viewer is mounted", async () => {
    await act(() => root.render(null));
    report({ sheet: true });
    openFromLink();
    expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: fileId });
    expect(useFocusedFileStore.getState().file).toBeNull();
  });

  it("takes the room from the conversation view once it has measured its row", async () => {
    function ConversationRoom(props: {
      readonly threadRef: typeof ref | null;
      readonly rowWidth: number | null;
    }) {
      useFileReaderLayoutReport(props.threadRef, props.rowWidth, 540, false, false);
      return null;
    }
    const view = createRoot(document.createElement("div"));
    // The overlay's own copy of the thread reports nothing.
    await act(() => view.render(<ConversationRoom threadRef={null} rowWidth={1280} />));
    expect(fileReaderLayoutFor(ref)).toBeNull();
    await act(() => view.render(<ConversationRoom threadRef={ref} rowWidth={null} />));
    expect(fileReaderLayoutFor(ref)).toBeNull();
    await act(() => view.render(<ConversationRoom threadRef={ref} rowWidth={1280} />));
    expect(fileReaderLayoutFor(ref)).toEqual(WIDE);
    openFromLink();
    expect(panelState().activeSurfaceId).toBe(fileId);
    await act(() => view.unmount());
    expect(fileReaderLayoutFor(ref)).toBeNull();
  });

  it("R12: a page that has not measured itself opens the file in front", () => {
    openFromLink();
    expect(panelState().surfaces).toEqual([]);
    expect(useFocusedFileStore.getState().file?.path).toBe("docs/notes.md");
  });

  it("R13/R14: a panel already open keeps its tabs, adding the file only when it fits", () => {
    useRightPanelStore.getState().openTerminal(ref, "t1");
    const before = panelState();
    report({ rowWidth: 1000 });
    openFromLink();
    expect(panelState()).toBe(before);
    expect(useFocusedFileStore.getState().file?.path).toBe("docs/notes.md");

    useFocusedFileStore.setState({ file: null, from: null });
    report({ rowWidth: 1280 });
    openFromLink();
    expect(panelState().surfaces.map((surface) => surface.id)).toEqual(["terminal:t1", fileId]);
    expect(panelState().activeSurfaceId).toBe(fileId);
    expect(useFocusedFileStore.getState().file).toBeNull();
  });

  it("a link Safari leaves unfocused still opens in front, with focus to return to it", () => {
    report({ rowWidth: 900 });
    const label = document.createElement("span");
    link.append(label);
    link.addEventListener("click", () =>
      openFileInFront({ threadRef: ref, cwd: "", path: "docs/notes.md", line: undefined }),
    );
    (document.activeElement as HTMLElement | null)?.blur();
    label.click();
    expect(document.activeElement).toBe(document.body);
    expect(useFocusedFileStore.getState().from).toBe(link);
    expect(panelState().surfaces).toEqual([]);
  });

  it.each([
    ["R19: the Files explorer", () => openFromLink(link, ".")],
    [
      "a file from the Files tree inside the panel",
      () => openFromLink(inside({ "data-right-panel-surface-content": "" })),
    ],
    [
      "Open in panel from a menu",
      () => openFromLink(inside({ "data-slot": "menu-popup", role: "menu" })),
    ],
    [
      "Open in panel from the viewer overlay",
      () => openFromLink(inside({ "data-slot": "dialog-popup", role: "dialog" })),
    ],
    [
      "a mention typed in the composer",
      () => {
        const composer = document.createElement("textarea");
        document.body.append(composer);
        openFromLink(composer);
      },
    ],
    [
      "an attachment",
      () => {
        link.focus();
        useRightPanelStore.getState().openAttachment(ref, {
          type: "file",
          id: "attachment-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
        });
      },
    ],
  ])("keeps %s in the panel however narrow the page", (_, open) => {
    report({ sheet: true });
    open();
    expect(panelState().isOpen).toBe(true);
    expect(useFocusedFileStore.getState().file).toBeNull();
  });

  it("R15: leaves a link opened while the overlay is in front to the overlay's own pane", () => {
    report({ sheet: true });
    useViewerOverlayStore.getState().open({
      key: "report",
      title: "Report",
      kind: "Report",
      badge: null,
      detail: null,
      threadRef: ref,
      origin: null,
      trail: [],
      onBack: null,
    });
    openFromLink();
    expect(useFocusedFileStore.getState().file).toBeNull();
  });
});

describe("the focused file viewer (1049 AC-06, D-05)", () => {
  const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-focused"));
  let link: HTMLButtonElement;
  let unreport: (() => void) | null = null;
  let viewerRoot: Root;
  let content: HTMLDivElement;
  let actions: HTMLDivElement;
  const closeSurface = vi.fn();
  const report = (layout: Partial<FileReaderLayout>) => {
    unreport?.();
    unreport = reportFileReaderLayout(ref, { ...WIDE, ...layout });
  };
  const moveButton = () => actions.querySelector<HTMLButtonElement>("[data-focused-file-move]");

  /** A link on a narrow page opens the file in front of it. */
  async function openFocused(extra: Partial<ViewerFileTarget> = {}) {
    await act(() => viewerRoot.render(<FocusedFileViewer />));
    report({ rowWidth: 900 });
    link.focus();
    await act(() =>
      openFileInFront({ threadRef: ref, cwd: "", path: "docs/notes.md", line: 12, ...extra }),
    );
  }

  beforeEach(() => {
    useRightPanelStore.setState({
      byThreadKey: {},
      threadPanelVisibilityByThreadKey: {},
      userActionRevisionByThreadKey: {},
      closeRevisionByThreadKey: {},
    });
    useFocusedFileStore.setState({ file: null, from: null });
    content = document.createElement("div");
    content.setAttribute("data-viewer-overlay", "true");
    actions = document.createElement("div");
    link = document.createElement("button");
    link.textContent = "notes.md";
    document.body.append(link, content, actions);
    useViewerOverlayStore.setState({
      active: null,
      linked: null,
      linkedFrom: null,
      slot: content,
      actionsSlot: actions,
    });
    fileRead.current = { data: null, error: null, readError: null };
    closeSurface.mockClear();
    viewerRoot = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(() => viewerRoot.unmount());
    unreport?.();
    unreport = null;
    useViewerOverlayStore.setState({ active: null, slot: null, actionsSlot: null });
    document.body.replaceChildren(container);
  });

  it("shows the file with the thread beside it, and offers Open beside once both fit", async () => {
    await openFocused();
    expect(useViewerOverlayStore.getState().active).toMatchObject({
      kind: "File",
      title: "notes.md",
      badge: "MD",
      detail: "line 12",
      threadRef: ref,
    });
    expect(content.querySelector('[data-viewer-linked="file"]')).not.toBeNull();
    expect(moveButton()?.textContent).toBe("Open in panel");
    // The window widens: the conversation and the reader fit side by side now.
    await act(() => report({ rowWidth: 1280 }));
    expect(moveButton()?.textContent).toBe("Open beside");
  });

  it("keeps the link's Open in editor and Reveal", async () => {
    const openInEditor = vi.fn();
    const reveal = vi.fn();
    await openFocused({ openInEditor, reveal, revealLabel: "Reveal in Finder" });
    const button = (label: string) =>
      Array.from(actions.querySelectorAll("button")).find((item) => item.textContent === label);
    await act(() => button("Open in editor")!.click());
    await act(() => button("Reveal in Finder")!.click());
    expect(openInEditor).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledOnce();
  });

  it("offers nothing to open in the panel, an editor or a folder for a file the host lacks", async () => {
    fileRead.current = {
      data: null,
      error: "No such file",
      readError: { failure: "operation_failed", operation: "open" },
    };
    await openFocused({ openInEditor: vi.fn(), reveal: vi.fn() });
    expect(content.querySelector('[data-viewer-linked="file"]')).not.toBeNull();
    expect(moveButton()).toBeNull();
    expect(actions.querySelectorAll("button")).toHaveLength(0);
  });

  it("C17: Open beside moves the file into the panel, and its tab returns focus to the link", async () => {
    await openFocused();
    await act(() => report({ rowWidth: 1280 }));
    await act(() => moveButton()!.click());
    expect(useViewerOverlayStore.getState().active).toBeNull();
    expect(useFocusedFileStore.getState().file).toBeNull();
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    expect(state).toMatchObject({ isOpen: true, activeSurfaceId: "file:docs/notes.md" });

    await renderPanel({
      surfaces: state.surfaces,
      activeSurfaceId: state.activeSurfaceId,
      onCloseSurface: closeSurface,
    });
    expect(document.activeElement).toBe(
      container.querySelector("[data-right-panel-surface-content]"),
    );
    await press("Escape");
    expect(closeSurface).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(link);
  });

  it("C11/C15: closing it any way (Escape, Close, a route change) returns focus to the link", async () => {
    await openFocused();
    // Focus went into the overlay, which drops it as it closes.
    (document.activeElement as HTMLElement | null)?.blur();
    const { active, close } = useViewerOverlayStore.getState();
    await act(() => close(active!.key));
    expect(useFocusedFileStore.getState().file).toBeNull();
    await act(() => vi.advanceTimersToNextFrame());
    expect(document.activeElement).toBe(link);
  });

  it("C16: another viewer takes its place and keeps focus", async () => {
    await openFocused();
    (document.activeElement as HTMLElement | null)?.blur();
    await act(() =>
      useViewerOverlayStore.getState().open({
        key: "report",
        title: "Report",
        kind: "Report",
        badge: null,
        detail: null,
        threadRef: ref,
        origin: null,
        trail: [],
        onBack: null,
      }),
    );
    expect(useFocusedFileStore.getState().file).toBeNull();
    await act(() => vi.advanceTimersToNextFrame());
    expect(document.activeElement).toBe(document.body);
  });
});
