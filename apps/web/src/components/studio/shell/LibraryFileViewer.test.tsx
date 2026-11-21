import { EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ reads: [] as Array<{ path: string; enabled: boolean }> }));

vi.mock("~/viewerOverlayStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/viewerOverlayStore")>()),
  useViewerOverlay: () => ({ content: {} as HTMLElement, actions: {} as HTMLElement }),
}));
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (node: unknown) => node,
}));
vi.mock("../../chat/ViewerFileActions", () => ({
  ViewerFileActions: (props: { path: string }) => <span data-file-actions={props.path} />,
}));
vi.mock("../../ChatMarkdown", () => ({ default: () => null }));
vi.mock("../../files/AttachmentFilePreview", () => ({
  ReadOnlySourcePreview: (props: { name: string }) => <pre data-source={props.name} />,
}));
vi.mock("../../files/projectFilesQueryState", () => ({
  useProjectFileQuery: (_environmentId: string, _root: string, path: string, enabled: boolean) => {
    state.reads.push({ path, enabled });
    return enabled
      ? { data: { contents: "text", truncated: false }, error: null, readError: null }
      : { data: null, error: null, readError: null };
  },
}));
vi.mock("../../files/DeckPreview", () => ({
  HostDeckPreview: (props: { path: string }) => <div data-host-deck={props.path} />,
  FilePreviewCard: (props: { path: string; reason: string }) => (
    <div data-file-card={props.path}>{props.reason}</div>
  ),
}));
vi.mock("../../files/OfficeDocumentPreview", () => ({
  HostWorkbookPreview: (props: { path: string }) => <div data-host-workbook={props.path} />,
  HostDocumentPreview: (props: { path: string }) => <div data-host-document={props.path} />,
}));
vi.mock("../../office/SheetFileView", () => ({
  SheetFileView: (props: { path: string }) => <div data-sheet-file={props.path} />,
}));

import { LibraryFileViewer } from "./LibraryFileViewer";

const ROOT = "/Users/me/Projects/launch";
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.reads = [];
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function open(path: string) {
  await act(async () => {
    renderer = create(
      <LibraryFileViewer
        environmentId={EnvironmentId.make("library-host")}
        workspaceRoot={ROOT}
        files={[{ path, name: path.split("/").at(-1)! }]}
        path={path}
        onPath={() => {}}
        onClose={() => {}}
      />,
    );
  });
}
const find = (prop: string) =>
  renderer!.root.findAll((node) => typeof node.props[prop] === "string");

it("shows a Library deck as its slides from its host path, without a text read", async () => {
  await open("decks/launch.pptx");
  expect(find("data-host-deck").map((node) => node.props["data-host-deck"])).toEqual([
    `${ROOT}/decks/launch.pptx`,
  ]);
  expect(state.reads.every((read) => !read.enabled)).toBe(true);
});

it("shows Office files in native previews, legacy Office files as cards, and text as text", async () => {
  await open("/tmp/brief.docx");
  expect(find("data-host-document").map((node) => node.props["data-host-document"])).toEqual([
    "/tmp/brief.docx",
  ]);
  await act(async () => renderer!.unmount());
  await open("/tmp/model.xlsx");
  expect(find("data-host-workbook").map((node) => node.props["data-host-workbook"])).toEqual([
    "/tmp/model.xlsx",
  ]);
  await act(async () => renderer!.unmount());
  await open("/tmp/legacy.doc");
  expect(find("data-file-card").map((node) => node.children.join(""))).toEqual([
    "Only Word documents saved as .docx have a preview here.",
  ]);
  await act(async () => renderer!.unmount());
  await open("notes/plan.txt");
  expect(find("data-source")).toHaveLength(1);
  expect(state.reads).toContainEqual({ path: "notes/plan.txt", enabled: true });
});

it("opens sheets with uppercase suffixes in SheetFileView instead of raw JSON", async () => {
  await open(".specweave/artifacts/budget.SHEET.JSON");
  expect(find("data-sheet-file").map((node) => node.props["data-sheet-file"])).toEqual([
    ".specweave/artifacts/budget.SHEET.JSON",
  ]);
  expect(find("data-source")).toHaveLength(0);
  expect(state.reads.every((read) => !read.enabled)).toBe(true);
});
