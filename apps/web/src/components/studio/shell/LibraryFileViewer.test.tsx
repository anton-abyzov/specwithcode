import { EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  reads: [] as Array<{ path: string; enabled: boolean }>,
  assets: [] as Array<{ _tag: string; cwd: string; path: string }>,
  readError: null as null | { message: string; reason?: string; failure?: string },
}));

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
    if (enabled && state.readError) {
      return { data: null, error: state.readError.message, readError: state.readError };
    }
    return enabled
      ? { data: { contents: "text", truncated: false }, error: null, readError: null }
      : { data: null, error: null, readError: null };
  },
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: (
    _environmentId: string,
    resource: { _tag: string; cwd: string; path: string },
  ) => {
    state.assets.push(resource);
    return { _tag: "Success", url: `https://asset.test/${resource.path.split("/").at(-1)}` };
  },
}));
vi.mock("../../chat/ViewerImageStage", () => ({
  ViewerImageStage: (props: { src: string }) => <img data-image-stage={props.src} alt="" />,
}));
vi.mock("../../files/BrowserDocumentFrame", () => ({
  BrowserDocumentFrame: (props: { src: string; pdf: boolean; lockedFile?: boolean }) => (
    <iframe
      title="frame"
      data-document-frame={props.src}
      data-pdf={String(props.pdf)}
      data-locked={String(props.lockedFile === true)}
    />
  ),
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
  state.assets = [];
  state.readError = null;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function open(path: string, where?: string) {
  await act(async () => {
    renderer = create(
      <LibraryFileViewer
        environmentId={EnvironmentId.make("library-host")}
        workspaceRoot={ROOT}
        files={[{ path, name: path.split("/").at(-1)! }]}
        path={path}
        onPath={() => {}}
        onClose={() => {}}
        unreadableWhere={where}
      />,
    );
  });
}
const alertText = () =>
  renderer!.root
    .findAll((node) => node.props.role === "alert")
    .map((node) => node.children.join(""));
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

const COPY =
  "/Users/me/.specwithcode/userdata/board-copies/b96/897/.specweave/increments/1342-office/reports";

it("shows an image report as an image from its host path, with no text read", async () => {
  await open(`${COPY}/mockup.png`);
  expect(find("data-image-stage").map((node) => node.props["data-image-stage"])).toEqual([
    "https://asset.test/mockup.png",
  ]);
  expect(state.assets.at(-1)).toEqual({
    _tag: "draft-workspace-file",
    cwd: ROOT,
    path: `${COPY}/mockup.png`,
  });
  expect(state.reads.every((read) => !read.enabled)).toBe(true);
});

it("renders an HTML report in the locked frame, and its source on request", async () => {
  await open(`${COPY}/mockup.html`);
  const frame = find("data-document-frame")[0]!;
  expect(frame.props["data-locked"]).toBe("true");
  expect(frame.props["data-pdf"]).toBe("false");
  const toggle = renderer!.root.find((node) => node.props["data-html-source-switch"] === "");
  await act(async () => toggle.props.onClick());
  expect(find("data-document-frame")).toHaveLength(0);
  expect(find("data-source")).toHaveLength(1);
});

it("shows a PDF report in the PDF frame", async () => {
  await open(`${COPY}/plan.pdf`);
  expect(find("data-document-frame")[0]!.props["data-pdf"]).toBe("true");
});

it("says a missing spec is no longer there and where the Board found it", async () => {
  state.readError = {
    message: `File not found: '${COPY}/../spec.md'.`,
    failure: "operation_failed",
  };
  await open("/gone/worktree/.specweave/increments/1342-office/spec.md", "From worktree gone");
  expect(alertText()).toEqual([
    "This file is no longer at /gone/worktree/.specweave/increments/1342-office/spec.md. From worktree gone. Close and reopen the increment to read its newest copy.",
  ]);
});

it("says an older server refused the Board's copy, and where the spec lives", async () => {
  state.readError = {
    message:
      "Workspace file 'x' is a protected credential or app state file and cannot be read here.",
    failure: "operation_failed",
    reason: "protected",
  };
  await open(
    "/Users/me/.specwithcode/userdata/board-copies/b96/897/.specweave/increments/1342-office/spec.md",
    "From origin/main, fetched 2h ago",
  );
  expect(alertText()).toEqual([
    "This machine's SpecWithCode cannot open the Board's copy of .specweave/increments/1342-office/spec.md. From origin/main, fetched 2h ago. Update SpecWithCode on the machine that serves this project, or open the file in its project folder.",
  ]);
  expect(alertText()[0]).not.toContain("credential");
});
