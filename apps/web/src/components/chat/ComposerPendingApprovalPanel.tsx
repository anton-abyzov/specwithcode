import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";

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
  const scrollableDetail =
    "block max-h-40 w-full min-w-0 overflow-auto whitespace-pre font-mono text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", className)}
      role="group"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-medium text-warning">{fallbackLabel}</span>
        {approval.appName ? <span className="min-w-0 truncate">{approval.appName}</span> : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>
        ) : null}
      </span>
      <Detail
        aria-label={detailAriaLabel}
        className={cn(
          "block max-h-20 w-full min-w-0 overflow-auto text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5",
          approval.requestKind === "mcp-elicitation"
            ? "whitespace-pre-wrap font-sans wrap-break-word"
            : "whitespace-pre font-mono",
        )}
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.responseCapability === "not_resumable"
          ? "Provider process is gone — interrupt or restart the run to respond."
          : approval.detail || fallbackLabel}
      </Detail>
      {fileChange ? (
        <code
          aria-label="File path"
          className={cn(scrollableDetail, "whitespace-pre-wrap break-all")}
          tabIndex={0}
        >
          {fileChange.fileName}
        </code>
      ) : null}
      {fileChange?.diffStr ? (
        <code aria-label="Supplied patch" className={scrollableDetail} tabIndex={0}>
          {fileChange.diffStr}
        </code>
      ) : null}
      {fileChange?.changes?.map((change, index) => (
        <span className="flex w-full min-w-0 flex-col gap-1" key={index}>
          {change.oldPath ? (
            <code
              aria-label="Previous file path"
              className={cn(scrollableDetail, "whitespace-pre-wrap break-all")}
              tabIndex={0}
            >
              {change.oldPath}
            </code>
          ) : null}
          <code
            aria-label="File path"
            className={cn(scrollableDetail, "whitespace-pre-wrap break-all")}
            tabIndex={0}
          >
            {change.path}
          </code>
          {change.diffStr ? (
            <code aria-label="Supplied patch" className={scrollableDetail} tabIndex={0}>
              {change.diffStr}
            </code>
          ) : (
            <span className="text-xs text-muted-foreground">Preview unavailable</span>
          )}
        </span>
      ))}
      {approval.requestKind === "file-change" &&
      !fileChange?.diffStr &&
      !fileChange?.changes?.length ? (
        <span className="text-xs text-muted-foreground">Preview unavailable</span>
      ) : null}
    </span>
  );
});
