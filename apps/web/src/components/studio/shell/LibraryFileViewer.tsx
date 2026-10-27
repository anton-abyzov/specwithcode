import type { EnvironmentId } from "@specweave-studio/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { formatViewerDate } from "~/viewerDate";
import { InViewerOverlay, useViewerOverlay } from "~/viewerOverlayStore";
import ChatMarkdown from "../../ChatMarkdown";
import { MarkdownDocumentView } from "../../chat/ReportReader";
import { ViewerFileActions } from "../../chat/ViewerFileActions";
import { ReadOnlySourcePreview } from "../../files/AttachmentFilePreview";
import { FilePreviewCard, HostDeckPreview } from "../../files/DeckPreview";
import { hostFilePreview, noPreviewReason } from "../../files/hostFilePreview";
import { useProjectFileQuery } from "../../files/projectFilesQueryState";
import { Button } from "../../ui/button";
import { libraryFileType } from "../../../studio/projectPaneModel";

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

function hostPath(workspaceRoot: string, path: string): string {
  return path.startsWith("/") ? path : `${workspaceRoot.replace(/\/+$/, "")}/${path}`;
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
}) {
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
}): ReactNode {
  const host = hostFilePreview(props.path);
  const readable =
    host === "text" && libraryFileType(props.path) !== "images" && !/\.pdf$/i.test(props.path);
  const file = useProjectFileQuery(props.environmentId, props.workspaceRoot, props.path, readable);
  const absolute = hostPath(props.workspaceRoot, props.path);
  const notice = (text: string, role?: "alert" | "status") => (
    <p className="m-auto p-6 text-center text-muted-foreground text-sm" role={role}>
      {text}
    </p>
  );
  if (host === "deck") {
    return (
      <HostDeckPreview environmentId={props.environmentId} path={absolute} name={props.name} />
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
  if (file.error) return notice(file.error, "alert");
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
