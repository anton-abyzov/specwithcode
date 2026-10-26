// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@specweave-studio/contracts";

import type { ViewerFileTarget } from "~/viewerOverlayStore";

const state = vi.hoisted(() => ({
  read: vi.fn(),
  openFile: vi.fn(),
  markdown: vi.fn(),
  isNotFile: false,
}));
vi.mock("../files/projectFilesQueryState", () => ({
  useProjectFileQuery: (environmentId: string, cwd: string, path: string | null) => {
    state.read(environmentId, cwd, path);
    return {
      data: { contents: "export const watcher = true;\n", truncated: false },
      error: null,
      readError: null,
      isNotFile: state.isNotFile,
      isPending: false,
      refresh: () => undefined,
    };
  },
}));
vi.mock("../files/AttachmentFilePreview", () => ({
  ReadOnlySourcePreview: (props: { name: string; text: string }) => (
    <pre data-source={props.name}>{props.text}</pre>
  ),
}));
vi.mock("~/components/ChatMarkdown", () => ({
  default: (props: object) => {
    state.markdown(props);
    return null;
  },
}));
vi.mock("../pullRequest/PullRequestDetailPanel", () => ({ PullRequestDetailPanel: () => null }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile: state.openFile }) },
}));

import { ViewerLinkedPane } from "./ViewerLinkedPane";

const environmentId = "library-host" as EnvironmentId;
// A link in a Library document: the Library's server reads it, and no thread owns it.
const libraryFile: ViewerFileTarget = {
  environmentId,
  threadRef: null,
  cwd: "/repo",
  path: "src/permissionWatcher.ts",
  line: undefined,
};

let root: Root;
let content: HTMLDivElement;
let actions: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.read.mockClear();
  state.openFile.mockClear();
  state.markdown.mockClear();
  state.isNotFile = false;
  actions = document.createElement("div");
  document.body.append(actions);
  content = document.createElement("div");
  root = createRoot(content);
});
afterEach(async () => {
  await act(() => root.unmount());
  actions.remove();
  vi.unstubAllGlobals();
});

const render = (file: ViewerFileTarget) =>
  act(() =>
    root.render(<ViewerLinkedPane target={{ kind: "file", file }} actionsSlot={actions} />),
  );
const buttons = () =>
  Array.from(actions.querySelectorAll("button"), (button) => button.textContent);

it("reads a file no thread owns from its own server, with no Open in panel", async () => {
  await render(libraryFile);
  expect(state.read).toHaveBeenCalledWith(environmentId, "/repo", "src/permissionWatcher.ts");
  expect(buttons()).not.toContain("Open in panel");
});

it("keeps Open in panel for a file opened from a thread", async () => {
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
  await render({ ...libraryFile, threadRef });
  expect(buttons()).toContain("Open in panel");
  const open = Array.from(actions.querySelectorAll("button")).find(
    (button) => button.textContent === "Open in panel",
  );
  await act(() => open!.click());
  expect(state.openFile).toHaveBeenCalledWith(threadRef, "src/permissionWatcher.ts", undefined);
});

it("gives a markdown file no thread owns its server, so its own links open in the pane", async () => {
  await render({ ...libraryFile, path: "docs/notes.md" });
  expect(state.markdown).toHaveBeenCalledWith(
    expect.objectContaining({ environmentId, threadRef: undefined, cwd: "/repo" }),
  );
});

it("does not point at a panel it cannot offer for a folder no thread owns", async () => {
  state.isNotFile = true;
  await render(libraryFile);
  expect(content.textContent).toContain("This is a folder, so there is nothing to read here.");
  expect(content.textContent).not.toContain("Open it in the panel");
});
