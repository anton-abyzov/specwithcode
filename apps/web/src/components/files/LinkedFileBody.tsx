import type { EnvironmentId, ScopedThreadRef } from "@specweave-studio/contracts";
import { mediaFileReference } from "@specweave-studio/client-runtime/media-reference";
import { filePreviewDelimiter } from "@specweave-studio/shared/delimitedPreview";
import { filePreviewKind, type FilePreviewKind } from "@specweave-studio/shared/filePreview";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { useTx } from "~/i18n";

import { ReadOnlySourcePreview } from "./AttachmentFilePreview";
import { AudioPreview } from "./AudioPreview";
import { BrowserDocumentFrame } from "./BrowserDocumentFrame";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import { FilePreviewCard, HostDeckPreview } from "./DeckPreview";
import { hostFilePreview, noPreviewReason, type HostFilePreview } from "./hostFilePreview";
import { HostDocumentPreview, HostWorkbookPreview } from "./OfficeDocumentPreview";
import { MarkdownDocumentView } from "../chat/ReportReader";
import { ViewerImageStage } from "../chat/ViewerImageStage";
import { Button } from "../ui/button";

const NATIVE_KINDS = new Set<FilePreviewKind>(["html", "pdf", "image", "video", "audio"]);

/** What the overlay header calls this file. Raw English, same as the artifact labels. */
export function linkedFileKind(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  const kind = filePreviewKind({ name });
  if (kind === "html") return "Page";
  if (kind === "markdown") return "Document";
  if (kind === "pdf") return "PDF";
  if (kind === "image") return "Image";
  if (kind === "video") return "Video";
  if (kind === "audio") return "Audio";
  if (filePreviewDelimiter({ name }) !== null) return "Sheet";
  const host = hostFilePreview(path);
  if (host === "deck") return "Deck";
  if (host === "workbook") return "Sheet";
  if (host === "document") return "Document";
  return "File";
}

interface HtmlSourceMode {
  readonly path: string;
  readonly source: boolean;
  readonly setSource: (source: boolean) => void;
}

const HtmlSourceContext = createContext<HtmlSourceMode | null>(null);

/**
 * Shared by a linked file's body and the header actions, which render through
 * another portal. Source follows the open path: a new file starts rendered,
 * unless the link named a line.
 */
export function HtmlSourceModeProvider(props: {
  readonly path: string;
  readonly initialSource: boolean;
  readonly children: ReactNode;
}) {
  const [state, setState] = useState({ path: props.path, source: props.initialSource });
  if (state.path !== props.path) {
    setState({ path: props.path, source: props.initialSource });
  }
  const source = state.path === props.path ? state.source : props.initialSource;
  const value = useMemo<HtmlSourceMode>(
    () => ({
      path: props.path,
      source,
      setSource: (next) => setState({ path: props.path, source: next }),
    }),
    [props.path, source],
  );
  return <HtmlSourceContext.Provider value={value}>{props.children}</HtmlSourceContext.Provider>;
}

export function useHtmlSourceMode(): HtmlSourceMode | null {
  return useContext(HtmlSourceContext);
}

/** View source while the page is showing, Preview while the source is showing. */
export function HtmlSourceSwitch(props: { readonly path: string; readonly enabled?: boolean }) {
  const tx = useTx();
  const mode = useContext(HtmlSourceContext);
  const name = props.path.split(/[\\/]/).filter(Boolean).at(-1) ?? props.path;
  if (props.enabled === false || mode === null || mode.path !== props.path) return null;
  if (filePreviewKind({ name }) !== "html") return null;
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      data-html-source-switch=""
      onClick={() => mode.setSource(!mode.source)}
    >
      {mode.source ? tx("Preview") : tx("View source")}
    </Button>
  );
}

function previewResource(threadId: ScopedThreadRef["threadId"], absolutePath: string, cwd: string) {
  const inside = mediaFileReference(absolutePath, cwd).relativePath !== undefined;
  return {
    _tag: inside ? ("workspace-file" as const) : ("media-file" as const),
    threadId,
    path: absolutePath,
  };
}

function LinkedAssetPreview(props: {
  readonly kind: FilePreviewKind;
  readonly name: string;
  readonly absolutePath: string;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
}) {
  const tx = useTx();
  const resource = useMemo(
    () => previewResource(props.threadRef.threadId, props.absolutePath, props.cwd),
    [props.absolutePath, props.cwd, props.threadRef.threadId],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  if (asset._tag === "Failure") {
    return (
      <p className="p-4 text-destructive-foreground text-sm" role="alert">
        Unable to load file preview.
      </p>
    );
  }
  if (asset._tag !== "Success") {
    return <p className="p-4 text-muted-foreground text-sm">{tx("Loading…")}</p>;
  }
  switch (props.kind) {
    case "html":
      return <BrowserDocumentFrame src={asset.url} title={props.name} pdf={false} lockedFile />;
    case "pdf":
      return <BrowserDocumentFrame src={asset.url} title={props.name} pdf />;
    case "image":
      return (
        <ViewerImageStage src={asset.url} name={props.name} onError={() => undefined} />
      );
    case "video":
      return (
        <video
          src={asset.url}
          controls
          playsInline
          preload="metadata"
          className="h-full max-h-full w-full"
          data-linked-video={props.name}
        />
      );
    case "audio":
      return <AudioPreview src={asset.url} name={props.name} />;
    default:
      return null;
  }
}

/**
 * One body for a linked file. Media and documents load through a signed URL.
 * Text kinds use the file's text. A file no thread owns keeps the text view;
 * media and HTML say to open them from a thread.
 */
export function LinkedFileBody(props: {
  readonly name: string;
  readonly absolutePath: string;
  readonly pathKey: string;
  readonly text: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string;
  readonly revealLine?: number | undefined;
  readonly renderMarkdown: (markdown: string) => ReactNode;
}) {
  const tx = useTx();
  const sourceMode = useContext(HtmlSourceContext);
  const kind = filePreviewKind({ name: props.name });
  const host: HostFilePreview = hostFilePreview(props.absolutePath);
  const delimiter = filePreviewDelimiter({ name: props.name });
  const showSource =
    kind === "html" && sourceMode?.path === props.pathKey && sourceMode.source === true;
  if (showSource) {
    return props.text === null ? (
      <p className="p-4 text-muted-foreground text-sm">{tx("Loading…")}</p>
    ) : (
      <ReadOnlySourcePreview name={props.name} text={props.text} revealLine={props.revealLine} />
    );
  }
  if (NATIVE_KINDS.has(kind) && props.threadRef === null) {
    return (
      <FilePreviewCard
        environmentId={props.environmentId}
        path={props.absolutePath}
        name={props.name}
        reason={tx("Open this file from a thread to preview it.")}
      />
    );
  }
  if (NATIVE_KINDS.has(kind) && props.threadRef !== null) {
    return (
      <LinkedAssetPreview
        kind={kind}
        name={props.name}
        absolutePath={props.absolutePath}
        environmentId={props.environmentId}
        threadRef={props.threadRef}
        cwd={props.cwd}
      />
    );
  }
  if (kind === "markdown" && props.text !== null) {
    return (
      <article className="report-document report-document-page">
        <MarkdownDocumentView text={props.text} renderMarkdown={props.renderMarkdown} />
      </article>
    );
  }
  if (delimiter !== null && props.text !== null) {
    return <DelimitedTablePreview name={props.name} text={props.text} delimiter={delimiter} />;
  }
  if (host === "deck") {
    return (
      <HostDeckPreview
        environmentId={props.environmentId}
        path={props.absolutePath}
        name={props.name}
      />
    );
  }
  if (host === "workbook") {
    return (
      <HostWorkbookPreview
        environmentId={props.environmentId}
        path={props.absolutePath}
        name={props.name}
      />
    );
  }
  if (host === "document") {
    return (
      <HostDocumentPreview
        environmentId={props.environmentId}
        path={props.absolutePath}
        name={props.name}
      />
    );
  }
  if (host === "card") {
    return (
      <FilePreviewCard
        environmentId={props.environmentId}
        path={props.absolutePath}
        name={props.name}
        reason={noPreviewReason(props.name)}
      />
    );
  }
  if (props.text === null) {
    return <p className="p-4 text-muted-foreground text-sm">{tx("Loading…")}</p>;
  }
  return (
    <ReadOnlySourcePreview name={props.name} text={props.text} revealLine={props.revealLine} />
  );
}
