/**
 * The preview of one file in the Files layer. Markdown renders with the
 * app's document view, text shows as read-only source, images load from a
 * blob URL through `<img>` (SVG markup is never put in the page), fonts
 * render as a specimen, and anything else says why it is not shown.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { MarkdownDocumentView } from "~/components/chat/ReportReader";
import { ReadOnlySourcePreview } from "~/components/files/AttachmentFilePreview";

import { Button } from "../../../ui/button";
import { fileName, type BrowserFile } from "./filesModel";
import { FontSpecimen } from "./FontSpecimen";
import type { PreviewPlan } from "./previewPlan";
import { readBytes, readText, type SystemFilesApi } from "./systemFilesApi";

export type FileContent =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly bytes: Uint8Array<ArrayBuffer>; readonly text: string };

const TEXT_KINDS = new Set<PreviewPlan["kind"]>(["markdown", "source"]);

/**
 * The file's bytes for a preview that shows them; generated files carry
 * their text, the rest are read once per selection (and on Try again).
 */
export function useFileContent(
  file: BrowserFile | null,
  plan: PreviewPlan | null,
  read: SystemFilesApi["read"],
): { content: FileContent; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState<FileContent>({ status: "idle" });
  const origin = file?.origin ?? null;
  const path = file?.path ?? null;
  const text = file?.text;
  const planKind = plan?.kind ?? null;
  const updatedAt = file?.updatedAt ?? "";
  const bytes = file?.bytes ?? 0;
  // A new read when the file changes on disk, or on Try again.
  const request = useMemo(
    () => (origin === null || path === null ? null : { origin, path, updatedAt, bytes, attempt }),
    [attempt, bytes, origin, path, updatedAt],
  );

  useEffect(() => {
    if (request === null || planKind === null || planKind === "notice") {
      // oxlint-disable-next-line react/set-state-in-effect -- nothing to read for this selection.
      setContent({ status: "idle" });
      return;
    }
    const { origin, path } = request;
    if (origin === "generated") {
      setContent({
        status: "ready",
        bytes: new TextEncoder().encode(text ?? ""),
        text: text ?? "",
      });
      return;
    }
    let live = true;
    setContent({ status: "loading" });
    void read({ origin, path }).then((outcome) => {
      if (!live) return;
      if (!outcome.ok) return setContent({ status: "error", message: outcome.message });
      setContent({
        status: "ready",
        bytes: readBytes(outcome.value),
        text: TEXT_KINDS.has(planKind) ? readText(outcome.value) : "",
      });
    });
    return () => {
      live = false;
    };
  }, [planKind, read, request, text]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { content, retry };
}

function Notice({ children, role = "status" }: { children: string; role?: "status" | "alert" }) {
  return (
    <p className="m-auto max-w-sm p-6 text-center text-sm text-muted-foreground" role={role}>
      {children}
    </p>
  );
}

function ImagePreview({
  bytes,
  mimeType,
  name,
}: {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  name: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    // oxlint-disable-next-line react/set-state-in-effect -- publish the URL once its cleanup is registered.
    setUrl(next);
    setBroken(false);
    return () => URL.revokeObjectURL(next);
  }, [bytes, mimeType]);
  if (broken) return <Notice>{`${name} could not be shown as an image.`}</Notice>;
  if (url === null) return null;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6">
      <img
        src={url}
        alt={name}
        data-testid="file-preview-image"
        className="max-h-full max-w-full rounded-md border border-border/60 bg-muted/40 object-contain"
        onError={() => setBroken(true)}
      />
    </div>
  );
}

export function MarkdownPreview({
  text,
  environmentId,
  className = "report-document mx-auto w-full max-w-[44rem] px-5 py-6 sm:px-8",
}: {
  text: string;
  environmentId: EnvironmentId;
  className?: string;
}) {
  return (
    <article className={className} data-testid="file-preview-markdown">
      <MarkdownDocumentView
        text={text}
        renderMarkdown={(markdown) => (
          <ChatMarkdown text={markdown} cwd={undefined} environmentId={environmentId} />
        )}
      />
    </article>
  );
}

/** The body of the preview pane for one file. */
export function FilePreviewBody({
  file,
  plan,
  content,
  environmentId,
  onRetry,
}: {
  file: BrowserFile;
  plan: PreviewPlan;
  content: FileContent;
  environmentId: EnvironmentId;
  onRetry: () => void;
}) {
  const name = fileName(file.path);
  if (plan.kind === "notice") return <Notice>{plan.message}</Notice>;
  if (content.status === "idle" || content.status === "loading")
    return <Notice>Loading preview…</Notice>;
  if (content.status === "error")
    return (
      <div className="m-auto flex max-w-sm flex-col items-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground" role="alert">
          {content.message}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCwIcon aria-hidden />
          Try again
        </Button>
      </div>
    );
  if (plan.kind === "markdown")
    return <MarkdownPreview text={content.text} environmentId={environmentId} />;
  if (plan.kind === "source")
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="file-preview-source">
        <ReadOnlySourcePreview name={name} text={content.text} />
      </div>
    );
  if (plan.kind === "image")
    return <ImagePreview bytes={content.bytes} mimeType={plan.mimeType} name={name} />;
  return <FontSpecimen bytes={content.bytes} name={name} />;
}
