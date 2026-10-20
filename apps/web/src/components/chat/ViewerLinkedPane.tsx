import { ExternalLinkIcon, FolderOpenIcon, PanelRightOpenIcon, SquarePenIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import ChatMarkdown from "~/components/ChatMarkdown";
import { isElectron } from "~/env";
import { openLinkOutsideApp } from "~/browser/externalBrowsers";
import type { ShortcutMatchContext } from "~/keybindings";
import { openPullRequestInPanel, stepOutOfViewerOverlay } from "~/lib/openInFront";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  InViewerOverlay,
  type ViewerFileTarget,
  type ViewerLinkTarget,
  type ViewerPullRequestTarget,
  viewerExtensionBadge,
} from "~/viewerOverlayStore";
import { ReadOnlySourcePreview } from "../files/AttachmentFilePreview";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { PullRequestDetailPanel } from "../pullRequest/PullRequestDetailPanel";
import { Button } from "../ui/button";
import { MarkdownDocumentView } from "./ReportReader";

const MARKDOWN_FILE = /\.(?:md|mdx|markdown)$/i;

function fileName(target: ViewerFileTarget): string {
  return target.path.split(/[\\/]/).filter(Boolean).at(-1) ?? target.path;
}

/** What the overlay header says about a link target: where you are now. */
export function viewerLinkHeader(target: ViewerLinkTarget): {
  readonly title: string;
  readonly kind: string;
  readonly badge: string;
  readonly detail: string | null;
} {
  if (target.kind === "file") {
    const name = fileName(target.file);
    return {
      title: name,
      kind: "File",
      badge: viewerExtensionBadge(name),
      detail: target.file.line ? `line ${target.file.line}` : null,
    };
  }
  const { reference } = target.pullRequest;
  return {
    title: `#${reference.number}`,
    kind: "Pull request",
    badge: "PR",
    detail: reference.repository,
  };
}

/**
 * A file or pull request a link inside the overlay opened, in the viewer's
 * place. The viewer stays mounted behind it, so the header's Back returns to
 * where it was left. Focus moves here when it opens, so the keyboard reads
 * and scrolls what is now in front.
 */
export function ViewerLinkedPane(props: {
  readonly target: ViewerLinkTarget;
  readonly actionsSlot: HTMLElement | null;
}) {
  const ref = useRef<HTMLElement>(null);
  const { target } = props;
  const key =
    target.kind === "file"
      ? `file:${target.file.path}:${target.file.line ?? ""}`
      : `pr:${target.pullRequest.environmentId}:${target.pullRequest.url}`;
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [key]);
  const header = viewerLinkHeader(target);
  return (
    <section
      ref={ref}
      key={key}
      tabIndex={-1}
      className="viewer-overlay-linked"
      aria-label={`${header.kind} ${header.title}`}
      data-viewer-linked={target.kind}
    >
      <InViewerOverlay value>
        {target.kind === "file" ? (
          <LinkedFile target={target.file} actionsSlot={props.actionsSlot} />
        ) : (
          <LinkedPullRequest target={target.pullRequest} actionsSlot={props.actionsSlot} />
        )}
      </InViewerOverlay>
    </section>
  );
}

function LinkedFile(props: {
  readonly target: ViewerFileTarget;
  readonly actionsSlot: HTMLElement | null;
}) {
  const { target } = props;
  const unresolved = target.tried !== undefined && target.tried.length > 0;
  const file = useProjectFileQuery(
    target.threadRef.environmentId,
    target.cwd,
    unresolved ? null : target.path,
  );
  const name = fileName(target);
  const contents = file.data?.contents ?? null;
  const baseDir = target.path.startsWith("/")
    ? target.path.slice(0, target.path.lastIndexOf("/"))
    : undefined;
  const renderMarkdown = useCallback(
    (markdown: string): ReactNode => (
      <ChatMarkdown
        text={markdown}
        cwd={target.cwd || undefined}
        imageBaseDir={baseDir}
        threadRef={target.threadRef}
      />
    ),
    [baseDir, target.cwd, target.threadRef],
  );
  const actions = (
    <>
      {target.openInEditor ? (
        <Button type="button" size="xs" variant="ghost" onClick={target.openInEditor}>
          <SquarePenIcon aria-hidden />
          Open in editor
        </Button>
      ) : null}
      {target.reveal ? (
        <Button type="button" size="xs" variant="ghost" onClick={target.reveal}>
          <FolderOpenIcon aria-hidden />
          {target.revealLabel ?? "Reveal"}
        </Button>
      ) : null}
    </>
  );
  const headerActions = unresolved ? null : (
    <>
      {actions}
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => {
          stepOutOfViewerOverlay();
          useRightPanelStore.getState().openFile(target.threadRef, target.path, target.line);
        }}
      >
        <PanelRightOpenIcon aria-hidden />
        Open in panel
      </Button>
    </>
  );
  return (
    <>
      {props.actionsSlot && headerActions ? createPortal(headerActions, props.actionsSlot) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-report-file-pane="true">
        {unresolved ? (
          <div
            className="flex flex-col gap-2 p-4 text-sm"
            role="status"
            data-report-file-unresolved="true"
          >
            <p>
              {name} was not found. The link names it without saying where it lives, and it is in
              none of these places:
            </p>
            <ul className="flex flex-col gap-1 font-mono text-muted-foreground text-xs">
              {target.tried!.map((path) => (
                <li key={path} className="break-all">
                  {path}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Ask the worker for its full path, or look in its worktree.
            </p>
            {target.openInEditor || target.reveal ? (
              <div className="flex gap-1">{actions}</div>
            ) : null}
          </div>
        ) : file.isNotFile ? (
          <p className="p-4 text-muted-foreground text-sm">
            This is a folder. Open it in the panel to browse it.
          </p>
        ) : file.error !== null && contents === null ? (
          <div className="flex flex-col items-start gap-2 p-4 text-sm" role="alert">
            <p className="text-destructive-foreground">{file.error}</p>
            <div className="flex gap-1">{actions}</div>
          </div>
        ) : contents === null ? (
          <p className="p-4 text-muted-foreground text-sm">Loading…</p>
        ) : MARKDOWN_FILE.test(name) ? (
          <article className="report-document report-document-page">
            <MarkdownDocumentView text={contents} renderMarkdown={renderMarkdown} />
          </article>
        ) : (
          <ReadOnlySourcePreview name={name} text={contents} revealLine={target.line} />
        )}
      </div>
    </>
  );
}

const shortcutContext = (): ShortcutMatchContext => ({
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: !isElectron,
  isDesktop: isElectron,
});

function LinkedPullRequest(props: {
  readonly target: ViewerPullRequestTarget;
  readonly actionsSlot: HTMLElement | null;
}) {
  const { target } = props;
  const { panel } = target;
  const headerActions = (
    <>
      {panel ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => openPullRequestInPanel(panel)}
        >
          <PanelRightOpenIcon aria-hidden />
          Open in panel
        </Button>
      ) : null}
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => void openLinkOutsideApp(target.url)}
      >
        <ExternalLinkIcon aria-hidden />
        Open in browser
      </Button>
    </>
  );
  return (
    <>
      {props.actionsSlot ? createPortal(headerActions, props.actionsSlot) : null}
      <div className="flex min-h-0 flex-1 flex-col" data-viewer-pull-request={target.url}>
        <PullRequestDetailPanel
          environmentId={target.environmentId}
          shortcutsEnabled
          getShortcutContext={shortcutContext}
          threadRef={target.threadRef}
          reference={target.reference}
          context="page"
        />
      </div>
    </>
  );
}
