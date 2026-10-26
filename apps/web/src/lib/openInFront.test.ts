import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const panel = vi.hoisted(() => ({ openFile: vi.fn(), openPullRequest: vi.fn() }));
vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => panel },
}));

import type { EnvironmentId, ScopedThreadRef } from "@specweave-studio/contracts";
import { useViewerOverlayStore } from "../viewerOverlayStore";
import {
  hostFocusedFiles,
  openFileInFront,
  openPullRequestInFront,
  openPullRequestInPanel,
  stepOutOfViewerOverlay,
  useFocusedFileStore,
} from "./openInFront";

const threadRef = { environmentId: "host-1", threadId: "thread-1" } as unknown as ScopedThreadRef;
const environmentId = "host-1" as EnvironmentId;
const file = { environmentId, threadRef, cwd: "/repo", path: "/repo/notes.md", line: 4 };
// A link in a Library document, which no thread owns.
const libraryFile = { ...file, threadRef: null };
const pullRequest = {
  environmentId: "host-1" as never,
  threadRef,
  reference: { projectId: "project-1" as never, repository: "acme/app", number: 442 },
  url: "https://github.com/acme/app/pull/442",
  panel: {
    ref: threadRef,
    target: { projectId: "project-1", repository: "acme/app", number: 442 },
  },
};

function openOverlay() {
  useViewerOverlayStore.getState().open({
    key: "report",
    title: "Findings",
    kind: "Report",
    badge: "MD",
    detail: null,
    threadRef,
    origin: null,
    trail: [],
    onBack: null,
  });
}

beforeEach(() => {
  panel.openFile.mockClear();
  panel.openPullRequest.mockClear();
  const { active, close } = useViewerOverlayStore.getState();
  if (active) close(active.key);
});

describe("openFileInFront", () => {
  it("opens in the side panel when no overlay is in front", () => {
    openFileInFront(file);
    expect(panel.openFile).toHaveBeenCalledWith(threadRef, "/repo/notes.md", 4);
    expect(useViewerOverlayStore.getState().linked).toBeNull();
  });

  it("opens in the overlay, never in the panel behind it", () => {
    openOverlay();
    openFileInFront(file);
    expect(panel.openFile).not.toHaveBeenCalled();
    expect(useViewerOverlayStore.getState().linked).toEqual({ kind: "file", file });
    // The viewer is still the overlay's: Back returns to it.
    expect(useViewerOverlayStore.getState().active?.key).toBe("report");
  });

  it("opens a file no thread owns in the overlay", () => {
    openOverlay();
    openFileInFront(libraryFile);
    expect(useViewerOverlayStore.getState().linked).toEqual({ kind: "file", file: libraryFile });
    expect(panel.openFile).not.toHaveBeenCalled();
  });

  it("opens a file no thread owns nowhere when the overlay is closed", () => {
    // The focused viewer is there to take a file, but it shows one beside a thread.
    const release = hostFocusedFiles();
    try {
      expect(() => openFileInFront(libraryFile)).not.toThrow();
      expect(panel.openFile).not.toHaveBeenCalled();
      expect(useViewerOverlayStore.getState().linked).toBeNull();
      expect(useFocusedFileStore.getState().file).toBeNull();
    } finally {
      release();
    }
  });
});

describe("openPullRequestInFront", () => {
  it("leaves the pull request to its usual place when no overlay is in front", () => {
    expect(openPullRequestInFront(pullRequest)).toBe(false);
    expect(useViewerOverlayStore.getState().linked).toBeNull();
  });

  it("shows the pull request in the overlay while it is open", () => {
    openOverlay();
    expect(openPullRequestInFront(pullRequest)).toBe(true);
    expect(useViewerOverlayStore.getState().linked).toEqual({
      kind: "pull-request",
      pullRequest,
    });
    expect(panel.openPullRequest).not.toHaveBeenCalled();
  });

  it("moves it to the panel by closing the overlay first, so the panel is in front", () => {
    openOverlay();
    openPullRequestInFront(pullRequest);
    openPullRequestInPanel(pullRequest.panel);
    expect(useViewerOverlayStore.getState().active).toBeNull();
    expect(useViewerOverlayStore.getState().linked).toBeNull();
    expect(panel.openPullRequest).toHaveBeenCalledWith(threadRef, pullRequest.panel.target);
  });
});

describe("the overlay's link target", () => {
  it("goes when the overlay closes or another viewer takes it", () => {
    openOverlay();
    openFileInFront(file);
    stepOutOfViewerOverlay();
    expect(useViewerOverlayStore.getState().linked).toBeNull();
    openOverlay();
    openFileInFront(file);
    openOverlay();
    expect(useViewerOverlayStore.getState().linked).toBeNull();
  });

  it("returns focus to the link it came from on Back", () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    const link = { isConnected: true, focus: vi.fn() };
    vi.stubGlobal("HTMLElement", class {});
    Object.setPrototypeOf(link, HTMLElement.prototype);
    vi.stubGlobal("document", { activeElement: link });
    openOverlay();
    openFileInFront(file);
    // A second link from the pane keeps the original one to return to.
    vi.stubGlobal("document", { activeElement: null });
    openPullRequestInFront(pullRequest);
    useViewerOverlayStore.getState().closeLinked();
    frames.forEach((frame) => frame());
    expect(link.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(useViewerOverlayStore.getState().linked).toBeNull();
    vi.unstubAllGlobals();
  });
});
