import type { EnvironmentId, ScopedThreadRef } from "@specweave-studio/contracts";
import { reportTitle, reportWordCount } from "@specweave-studio/shared/threadReport";
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { mayBeMissing, MissingFileNotice } from "./MissingFileNotice";
import { MarkdownDocumentView, ReportReader } from "./ReportReader";

/** A markdown file a message links to, opened as a document. */
export interface MarkdownDocumentTarget {
  /** Absolute host path, inside the workspace or not. */
  readonly path: string;
}

export const MARKDOWN_DOCUMENT_PATTERN = /\.(?:md|mdx|markdown)$/i;

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : path;
}

/**
 * Opens a markdown file the way a report opens: docked beside the
 * conversation, with its outline and toolbar. It reads the file by its host
 * path, so a file in a sibling worktree or a temp folder opens like any other.
 * When it cannot be read, it says why and offers the default app instead.
 */
export function MarkdownDocumentReader(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly target: MarkdownDocumentTarget;
  readonly onClose: () => void;
  /** Renders the file; `baseDir` anchors its relative links and images. */
  readonly renderMarkdown: (markdown: string, baseDir: string) => ReactNode;
  readonly onOpenExternally?: (() => void) | undefined;
  /** Opens another file, such as one beside a file that is not there. */
  readonly onOpenFile?: ((path: string) => void) | undefined;
  /** The thread whose message linked the file, shown beside it. */
  readonly threadRef?: ScopedThreadRef | undefined;
}) {
  const { target } = props;
  const name = target.path.split("/").filter(Boolean).at(-1) ?? target.path;
  const file = useProjectFileQuery(props.environmentId, props.cwd, target.path);
  const contents = file.data?.contents ?? null;
  const baseDir = directoryOf(target.path);
  const renderMarkdown = (markdown: string) => props.renderMarkdown(markdown, baseDir);
  const openExternally = props.onOpenExternally ? (
    <Button type="button" size="sm" variant="outline" onClick={props.onOpenExternally}>
      <ExternalLinkIcon aria-hidden />
      Open with the default app
    </Button>
  ) : null;
  return (
    <ReportReader
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      text={contents ?? ""}
      title={contents ? reportTitle(contents, name) : name}
      words={contents ? reportWordCount(contents) : 0}
      save={null}
      layout={null}
      renderMarkdown={renderMarkdown}
      subtitle={target.path}
      threadRef={props.threadRef}
    >
      {contents !== null ? (
        <MarkdownDocumentView text={contents} renderMarkdown={renderMarkdown} />
      ) : file.error !== null && mayBeMissing(file.readError) ? (
        <MissingFileNotice
          environmentId={props.environmentId}
          path={target.path}
          error={file.error}
          onOpen={props.onOpenFile}
          actions={openExternally}
        />
      ) : file.error !== null ? (
        <div className="flex flex-col items-start gap-3 font-sans text-sm" role="alert">
          <p className="text-muted-foreground">
            {name} could not be read here: {file.error}
          </p>
          <p className="break-all font-mono text-muted-foreground text-xs">{target.path}</p>
          {openExternally}
        </div>
      ) : (
        <p className="font-sans text-muted-foreground text-sm">Loading {name}…</p>
      )}
    </ReportReader>
  );
}
