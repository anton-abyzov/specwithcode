import type { AssetResource, EnvironmentId } from "@specweave-studio/contracts";
import { filePreviewKind } from "@specweave-studio/shared/filePreview";
import { SHEET_ARTIFACT_SUFFIX } from "@specweave-studio/shared/officeSheet";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useAssetUrlState } from "~/assets/assetUrls";
import { formatViewerDate } from "~/viewerDate";
import { InViewerOverlay, useViewerOverlay } from "~/viewerOverlayStore";
import ChatMarkdown from "../../ChatMarkdown";
import { MarkdownDocumentView } from "../../chat/ReportReader";
import { ViewerFileActions } from "../../chat/ViewerFileActions";
import { ViewerImageStage } from "../../chat/ViewerImageStage";
import { ReadOnlySourcePreview } from "../../files/AttachmentFilePreview";
import { BrowserDocumentFrame } from "../../files/BrowserDocumentFrame";
import { FilePreviewCard, HostDeckPreview } from "../../files/DeckPreview";
import { hostFilePreview, noPreviewReason } from "../../files/hostFilePreview";
import { HostDocumentPreview, HostWorkbookPreview } from "../../files/OfficeDocumentPreview";
import { useProjectFileQuery } from "../../files/projectFilesQueryState";
import { SheetFileView } from "../../office/SheetFileView";
import { Button } from "../../ui/button";
import { libraryFileType } from "../../../studio/projectPaneModel";
import { incrementCopyRoot, pathInside } from "./boardPaths";

export interface LibraryViewerFile {
  /** Workspace-relative, or an absolute host path. */
  readonly path: string;
  readonly name: string;
  readonly modifiedAt?: string | undefined;
}

function extensionBadge(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
}

/** What the viewer draws from a signed URL rather than from the file's text. */
const ASSET_KINDS = new Set(["image", "html", "pdf", "video"]);

/** The part of a path from `.specweave/` on, which every copy of a project shares. */
function planningPath(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  const at = slashed.lastIndexOf("/.specweave/");
  return at === -1 ? path : slashed.slice(at + 1);
}

/**
 * Why a file cannot be shown, in a sentence, with where it came from when the
 * opener knows (the Board's copy of an increment): never a raw read error.
 */
export function unreadableFileText(input: {
  readonly path: string;
  readonly missing: boolean;
  readonly protected: boolean;
  readonly where?: string | undefined;
  readonly error?: string | null | undefined;
}): string {
  const where = input.where ? ` ${input.where.replace(/\.?$/u, ".")}` : "";
  if (input.missing) {
    return `This file is no longer at ${input.path}.${where}${
      input.where ? " Close and reopen the increment to read its newest copy." : ""
    }`;
  }
  if (input.protected) {
    return input.where
      ? `This machine's SpecWithCode cannot open the Board's copy of ${planningPath(input.path)}.${where} Update SpecWithCode on the machine that serves this project, or open the file in its project folder.`
      : `${input.path} is app state this machine does not open here.`;
  }
  return input.where
    ? `${input.error ?? "This file could not be read."}${where}`
    : (input.error ?? "This file could not be read.");
}

/**
 * The asset an HTML page loads, rooted so its own stylesheets and images
 * resolve: a workspace file from the workspace, a Board copy's file from the
 * copy's root (the folder holding `.specweave/`). Every other kind, and a page
 * outside both, is served as the exact host file.
 */
export function libraryAssetResource(
  workspaceRoot: string,
  path: string,
  kind: string,
): { readonly _tag: "draft-workspace-file"; readonly cwd: string; readonly path: string } {
  const exact = { _tag: "draft-workspace-file" as const, cwd: workspaceRoot, path };
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  if (kind !== "html") return exact;
  if (!absolute) return exact;
  // Compared a whole segment at a time, without case on a Windows path, and
  // cut from the original path (boardPaths).
  const inside = pathInside(workspaceRoot, path);
  if (inside !== null) return { _tag: "draft-workspace-file", cwd: workspaceRoot, path: inside };
  const copy = incrementCopyRoot(path);
  if (copy !== null) return { _tag: "draft-workspace-file", cwd: copy.root, path: copy.relative };
  return exact;
}

function hostPath(workspaceRoot: string, path: string): string {
  // A Windows host answers with a drive path or a network share.
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  return absolute ? path : `${workspaceRoot.replace(/\/+$/, "")}/${path}`;
}

/**
 * A Library file in the app's viewer overlay, with the Library's other files
 * a step away: markdown as a document, text read-only, and the file's
 * actions (editor, file manager, path) in the header.
 */
export function LibraryFileViewer(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly files: ReadonlyArray<LibraryViewerFile>;
  readonly path: string;
  readonly onPath: (path: string) => void;
  readonly onClose: () => void;
  /** Which copy the files come from, said when one cannot be read. */
  readonly unreadableWhere?: string | undefined;
}) {
  const [sourceFor, setSourceFor] = useState<string | null>(null);
  const index = Math.max(
    0,
    props.files.findIndex((file) => file.path === props.path),
  );
  const file = props.files[index] ?? { path: props.path, name: props.path };
  const count = props.files.length;
  const step = (by: 1 | -1) => {
    const next = props.files[(index + by + count) % count];
    if (next) props.onPath(next.path);
  };
  const absolute = hostPath(props.workspaceRoot, file.path);
  const date = formatViewerDate(file.modifiedAt);
  const slots = useViewerOverlay({
    open: true,
    title: file.name,
    kind: "File",
    badge: extensionBadge(file.name),
    detail: date,
    origin: "Library",
    onClose: props.onClose,
  });
  if (slots === null) return null;
  const actions = (
    <>
      {count > 1 ? (
        <>
          <span className="px-1 text-muted-foreground text-xs tabular-nums">
            {index + 1} of {count}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Previous file"
            onClick={() => step(-1)}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Next file"
            onClick={() => step(1)}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
        </>
      ) : null}
      {filePreviewKind({ name: file.path }) === "html" ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-html-source-switch=""
          onClick={() => setSourceFor(sourceFor === file.path ? null : file.path)}
        >
          {sourceFor === file.path ? "Preview" : "View source"}
        </Button>
      ) : null}
      <ViewerFileActions environmentId={props.environmentId} path={absolute} name={file.name} />
    </>
  );
  return createPortal(
    <div
      className="viewer-overlay-frame"
      data-library-viewer="true"
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        if (event.key === "ArrowLeft" && count > 1) step(-1);
        if (event.key === "ArrowRight" && count > 1) step(1);
      }}
    >
      {slots.actions ? createPortal(actions, slots.actions) : null}
      {/* Links in what is open here open in the overlay, never behind it. */}
      <InViewerOverlay value>
        <div className="artifact-viewer-stage">
          <LibraryFileBody
            key={file.path}
            environmentId={props.environmentId}
            workspaceRoot={props.workspaceRoot}
            path={file.path}
            name={file.name}
            source={sourceFor === file.path}
            where={props.unreadableWhere}
          />
        </div>
      </InViewerOverlay>
    </div>,
    slots.content,
  );
}

function LibraryFileBody(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly path: string;
  readonly name: string;
  /** An HTML file shows its text instead of the page. */
  readonly source?: boolean | undefined;
  readonly where?: string | undefined;
}): ReactNode {
  const sheet = props.path.toLowerCase().endsWith(SHEET_ARTIFACT_SUFFIX);
  const host = hostFilePreview(props.path);
  const kind = filePreviewKind({ name: props.path });
  const asset = ASSET_KINDS.has(kind) && !(kind === "html" && props.source === true);
  // HTML is read as text too: its source view, and a missing file said plainly.
  const readable =
    !sheet &&
    host === "text" &&
    libraryFileType(props.path) !== "images" &&
    kind !== "pdf" &&
    kind !== "video";
  const file = useProjectFileQuery(props.environmentId, props.workspaceRoot, props.path, readable);
  const absolute = hostPath(props.workspaceRoot, props.path);
  const notice = (text: string, role?: "alert" | "status") => (
    <p className="m-auto max-w-xl p-6 text-center text-muted-foreground text-sm" role={role}>
      {text}
    </p>
  );
  const unreadable = () =>
    notice(
      unreadableFileText({
        path: absolute,
        missing: /^File not found/u.test(file.readError?.message ?? ""),
        protected: file.readError?.reason === "protected",
        where: props.where,
        error: file.error,
      }),
      "alert",
    );
  if (asset) {
    if (readable && file.error && file.readError?.failure !== "binary_file") return unreadable();
    return (
      <LibraryAssetBody
        environmentId={props.environmentId}
        workspaceRoot={props.workspaceRoot}
        path={absolute}
        name={props.name}
        kind={kind}
        where={props.where}
      />
    );
  }
  if (sheet) {
    return (
      <SheetFileView
        environmentId={props.environmentId}
        cwd={props.workspaceRoot}
        path={props.path}
      />
    );
  }
  if (host === "deck") {
    return (
      <HostDeckPreview environmentId={props.environmentId} path={absolute} name={props.name} />
    );
  }
  if (host === "workbook") {
    return (
      <HostWorkbookPreview environmentId={props.environmentId} path={absolute} name={props.name} />
    );
  }
  if (host === "document") {
    return (
      <HostDocumentPreview environmentId={props.environmentId} path={absolute} name={props.name} />
    );
  }
  const card = (reason: string) => (
    <FilePreviewCard
      environmentId={props.environmentId}
      path={absolute}
      name={props.name}
      reason={reason}
    />
  );
  if (!readable) return card(noPreviewReason(props.name));
  if (file.readError?.failure === "binary_file") {
    return card(`${props.name} is not a text file, and has no preview here.`);
  }
  if (file.error) return unreadable();
  if (!file.data) return notice("Loading…", "status");
  const truncated = file.data.truncated ? (
    <p className="border-b px-4 py-2 text-muted-foreground text-xs" role="status">
      Showing the start of a large file.
    </p>
  ) : null;
  if (/\.(md|mdx|markdown)$/i.test(props.path)) {
    return (
      <>
        {truncated}
        <div className="report-reader-body">
          <article className="report-document report-document-page">
            <MarkdownDocumentView
              text={file.data.contents}
              renderMarkdown={(markdown) => (
                <ChatMarkdown
                  text={markdown}
                  cwd={props.workspaceRoot}
                  environmentId={props.environmentId}
                />
              )}
            />
          </article>
        </div>
      </>
    );
  }
  return (
    <>
      {truncated}
      <ReadOnlySourcePreview name={props.name} text={file.data.contents} />
    </>
  );
}

/** An image, page, PDF or video from a signed URL for its host path; no thread needed. */
function LibraryAssetBody(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  /** Absolute. */
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly where?: string | undefined;
}): ReactNode {
  const resource = useMemo<AssetResource>(
    () => libraryAssetResource(props.workspaceRoot, props.path, props.kind),
    [props.kind, props.path, props.workspaceRoot],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  const [broken, setBroken] = useState(false);
  if (asset._tag === "Failure" || broken) {
    return (
      <p className="m-auto max-w-xl p-6 text-center text-muted-foreground text-sm" role="alert">
        {`${props.name} could not be opened on this machine.${
          props.where ? ` ${props.where.replace(/\.?$/u, ".")}` : ""
        }`}
      </p>
    );
  }
  if (asset._tag !== "Success") {
    return (
      <p className="m-auto p-6 text-center text-muted-foreground text-sm" role="status">
        Loading…
      </p>
    );
  }
  if (props.kind === "image") {
    return <ViewerImageStage src={asset.url} name={props.name} onError={() => setBroken(true)} />;
  }
  if (props.kind === "video") {
    return (
      <video
        src={asset.url}
        controls
        playsInline
        preload="metadata"
        className="h-full max-h-full w-full"
        data-library-video={props.name}
      />
    );
  }
  return (
    <BrowserDocumentFrame
      src={asset.url}
      title={props.name}
      pdf={props.kind === "pdf"}
      lockedFile={props.kind === "html"}
    />
  );
}
