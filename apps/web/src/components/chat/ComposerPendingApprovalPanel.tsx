import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "command"
        ? "Command approval"
        : approval.requestKind === "file-read"
          ? "File read approval"
          : approval.requestKind === "permission"
            ? "App permission approval"
            : "File change approval";
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : approval.requestKind === "permission"
            ? "Permission request"
            : "File change";

  const fileChange = approval.requestKind === "file-change" ? approval.fileChange : undefined;
  const notResumable = approval.responseCapability === "not_resumable";
  // A code well: long commands and paths wrap instead of scrolling sideways.
  const codeWell =
    "block w-full min-w-0 rounded-md bg-foreground/[0.04] px-2.5 py-1.5 font-mono text-xs/4 text-foreground whitespace-pre-wrap wrap-anywhere dark:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";
  const hasFileDetails = Boolean(
    fileChange?.fileName || fileChange?.diffStr || fileChange?.changes?.length,
  );
  const previewUnavailable = (
    <span className="text-xs text-muted-foreground">Preview unavailable</span>
  );

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col items-stretch gap-1.5", className)}
      role="group"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-medium text-warning-foreground">{fallbackLabel}</span>
        {approval.appName ? <span className="min-w-0 truncate">{approval.appName}</span> : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1 of {pendingCount}</span>
        ) : null}
      </span>
      {notResumable ? (
        <span className="text-xs text-muted-foreground" role="status">
          Provider process is gone — interrupt or restart the run to respond.
        </span>
      ) : (
        <Detail
          aria-label={detailAriaLabel}
          className={cn(
            codeWell,
            // About seven lines, then a thin vertical scrollbar.
            "max-h-31 overflow-y-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5",
            approval.requestKind === "mcp-elicitation" && "font-sans wrap-break-word break-normal",
          )}
          data-approval-detail="complete"
          tabIndex={0}
        >
          {approval.detail || fallbackLabel}
        </Detail>
      )}
      {fileChange && hasFileDetails ? (
        // One bounded list for every file, so a many-file change never pushes the composer away.
        <ComposerBanner.Scroll className="max-h-[min(20rem,36dvh)]">
          <span className="flex w-full min-w-0 flex-col gap-1.5">
            <code aria-label="File path" className={codeWell} tabIndex={0}>
              {fileChange.fileName}
            </code>
            {fileChange.diffStr ? (
              <code aria-label="Supplied patch" className={codeWell} tabIndex={0}>
                {fileChange.diffStr}
              </code>
            ) : null}
            {fileChange.changes?.map((change, index) => (
              <span className="flex w-full min-w-0 flex-col gap-1" key={index}>
                {change.oldPath ? (
                  <code aria-label="Previous file path" className={codeWell} tabIndex={0}>
                    {change.oldPath}
                  </code>
                ) : null}
                <code aria-label="File path" className={codeWell} tabIndex={0}>
                  {change.path}
                </code>
                {change.diffStr ? (
                  <code aria-label="Supplied patch" className={codeWell} tabIndex={0}>
                    {change.diffStr}
                  </code>
                ) : (
                  previewUnavailable
                )}
              </span>
            ))}
            {!fileChange.diffStr && !fileChange.changes?.length ? previewUnavailable : null}
          </span>
        </ComposerBanner.Scroll>
      ) : null}
      {approval.requestKind === "file-change" && !hasFileDetails ? previewUnavailable : null}
    </span>
  );
});
