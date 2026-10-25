// @vitest-environment jsdom

import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reopenClosedView } from "~/reopenClosedView";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { useViewerOverlayStore, type ViewerFileTarget } from "~/viewerOverlayStore";

import {
  fileReaderLayoutFor,
  fileReaderPlacement,
  type FileReaderLayout,
  hostFocusedFiles,
  moveFocusedFileToPanel,
  openFileInFront,
  reportFileReaderLayout,
  takeFileSurfaceOpener,
  useFocusedFileStore,
} from "./openInFront";

const layout = (rowWidth: number, panelWidth: number, flags = {}): FileReaderLayout => ({
  rowWidth,
  panelWidth,
  sheet: false,
  maximized: false,
  ...flags,
});

describe("where a file link opens (1049 D-05)", () => {
  it("opens beside only when the conversation keeps 560 px and the reader gets 480 px", () => {
    expect(fileReaderPlacement(layout(1280, 540))).toBe("beside");
    expect(fileReaderPlacement(layout(1100, 540))).toBe("beside");
    expect(fileReaderPlacement(layout(1099, 540))).toBe("focused");
    expect(fileReaderPlacement(layout(1280, 480))).toBe("beside");
    expect(fileReaderPlacement(layout(1280, 479))).toBe("focused");
    // A phone, or 1280 px at 200% zoom: 640 CSS px.
    expect(fileReaderPlacement(layout(360, 360))).toBe("focused");
    expect(fileReaderPlacement(layout(640, 360))).toBe("focused");
  });

  it("opens focused over a sheet, a maximized panel or a page not measured yet", () => {
    expect(fileReaderPlacement(layout(1280, 540, { sheet: true }))).toBe("focused");
    expect(fileReaderPlacement(layout(1280, 540, { maximized: true }))).toBe("focused");
    expect(fileReaderPlacement(null)).toBe("focused");
    expect(fileReaderPlacement(undefined)).toBe("focused");
  });

  it("keeps the room the last view of a thread reported until that view leaves", () => {
    const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-room"));
    expect(fileReaderLayoutFor(ref)).toBeNull();
    const first = reportFileReaderLayout(ref, layout(1280, 540));
    expect(fileReaderLayoutFor(ref)).toEqual(layout(1280, 540));
    const second = reportFileReaderLayout(ref, layout(900, 540));
    // The first view leaving does not clear what the second one reported.
    first();
    expect(fileReaderLayoutFor(ref)).toEqual(layout(900, 540));
    second();
    expect(fileReaderLayoutFor(ref)).toBeNull();
  });
});

describe("openFileInFront (1049 AC-06, D-05)", () => {
  const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-front"));
  const fileId = "file:docs/notes.md";
  const target = (overrides: Partial<ViewerFileTarget> = {}): ViewerFileTarget => ({
    threadRef: ref,
    cwd: "/work/repo",
    path: "docs/notes.md",
    line: 12,
    ...overrides,
  });
  const panelState = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  let link: HTMLButtonElement;
  let unhost: () => void;
  let unreport: () => void;

  beforeEach(() => {
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
    // The app shell's focused viewer is mounted, and the page is too narrow for both.
    unhost = hostFocusedFiles();
    unreport = reportFileReaderLayout(ref, layout(900, 540));
  });
  afterEach(() => {
    unreport();
    unhost();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("shows the file in front with all the link knew, and leaves the panel untouched", () => {
    const openInEditor = vi.fn();
    const reveal = vi.fn();
    const file = target({ openInEditor, reveal, revealLabel: "Reveal in Finder", tried: ["a"] });
    link.focus();
    openFileInFront(file);
    expect(useFocusedFileStore.getState()).toEqual({ file, from: link });
    // Nothing in the panel changed, so nothing there counts as the reader's choice.
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(useRightPanelStore.getState().threadPanelVisibilityByThreadKey).toEqual({});
    expect(useRightPanelStore.getState().userActionRevisionByThreadKey).toEqual({});
  });

  it("opens beside once both fit, and the tab remembers the link once", () => {
    unreport();
    unreport = reportFileReaderLayout(ref, layout(1280, 540));
    link.focus();
    openFileInFront(target());
    expect(useFocusedFileStore.getState().file).toBeNull();
    const state = panelState();
    expect(state).toMatchObject({ isOpen: true, activeSurfaceId: fileId });
    const surface = state.surfaces.find((entry) => entry.id === fileId)!;
    expect(takeFileSurfaceOpener(surface)).toBe(link);
    expect(takeFileSurfaceOpener(surface)).toBeUndefined();
  });

  it("credits an open that waited on a lookup to the link clicked just before", async () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    link.addEventListener("click", () => {
      // A bare filename is looked up first; focus has moved on when it resolves.
      void Promise.resolve().then(() => openFileInFront(target()));
    });
    link.click();
    field.focus();
    await Promise.resolve();
    await Promise.resolve();
    expect(useFocusedFileStore.getState().from).toBe(link);
    expect(panelState().surfaces).toEqual([]);
  });

  it("forgets that click after five seconds", () => {
    vi.useFakeTimers();
    link.click();
    vi.advanceTimersByTime(5_001);
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    // Focus is in a field now, which asks for the panel.
    openFileInFront(target());
    expect(useFocusedFileStore.getState().file).toBeNull();
    expect(panelState().activeSurfaceId).toBe(fileId);
  });

  it("R12: on a page not measured yet, opens in front", () => {
    unreport();
    unreport = () => undefined;
    link.focus();
    openFileInFront(target());
    expect(useFocusedFileStore.getState().file?.path).toBe("docs/notes.md");
  });

  it("opens in the panel as before where no focused viewer is mounted", () => {
    unhost();
    link.focus();
    openFileInFront(target());
    expect(useFocusedFileStore.getState().file).toBeNull();
    expect(panelState().activeSurfaceId).toBe(fileId);
  });

  it("R19: keeps the Files explorer in the panel", () => {
    link.focus();
    openFileInFront(target({ path: "." }));
    expect(useFocusedFileStore.getState().file).toBeNull();
    expect(panelState().isOpen).toBe(true);
  });

  it("an opener the caller names wins over what holds focus", () => {
    const menuItem = document.createElement("button");
    const menu = document.createElement("div");
    menu.setAttribute("data-slot", "menu-popup");
    menu.append(menuItem);
    document.body.append(menu);
    link.focus();
    openFileInFront(target(), menuItem);
    expect(useFocusedFileStore.getState().file).toBeNull();
    expect(panelState().activeSurfaceId).toBe(fileId);
  });

  it("R15: leaves a link opened while the overlay is in front to the overlay's own pane", () => {
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
    link.focus();
    openFileInFront(target());
    expect(useFocusedFileStore.getState().file).toBeNull();
    expect(useViewerOverlayStore.getState().linked).toMatchObject({ kind: "file" });
    expect(panelState().surfaces).toEqual([]);
  });

  it("Open beside moves the focused file into the panel, remembering the first link", () => {
    link.focus();
    openFileInFront(target());
    expect(useFocusedFileStore.getState().file).not.toBeNull();
    moveFocusedFileToPanel();
    expect(useFocusedFileStore.getState()).toEqual({ file: null, from: null });
    const state = panelState();
    expect(state).toMatchObject({ isOpen: true, activeSurfaceId: fileId });
    expect(takeFileSurfaceOpener(state.surfaces.find((entry) => entry.id === fileId)!)).toBe(link);
  });

  it("reopening a closed tab with the shortcut puts it back in the panel on a narrow page", async () => {
    link.focus();
    const reopened = await reopenClosedView(
      {
        kind: "panel-tab",
        threadRef: ref,
        surface: {
          id: fileId,
          kind: "file",
          relativePath: "docs/notes.md",
          revealLine: 12,
          revealRequestId: 1,
        },
      },
      { openPreview: vi.fn() as never, workspaceAvailable: true },
    );
    expect(reopened).toBe(true);
    expect(useFocusedFileStore.getState().file).toBeNull();
    expect(panelState()).toMatchObject({ isOpen: true, activeSurfaceId: fileId });
  });
});
