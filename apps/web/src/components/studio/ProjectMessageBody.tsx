import { useId, useRef, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { collapsibleFooterClassName, revealCollapsedTop } from "../chat/CollapsibleReport";

/** Presentation only: retain the full original message for inspection and copying. */
export function ProjectMessageBody({
  text,
  collapsible,
  children,
}: {
  text: string;
  collapsible: boolean;
  children: ReactNode;
}) {
  const bodyId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "message" });
  const canCollapse = collapsible && (text.length > 600 || text.split("\n").length > 8);

  if (!canCollapse) return children;
  const preview = text.trim().split("\n").slice(0, 4).join("\n").slice(0, 320).trimEnd();

  return (
    <div ref={root} className="min-w-0" data-project-message-disclosure>
      <div id={bodyId}>
        {expanded ? (
          children
        ) : (
          <p className="m-0 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
            {preview}…
          </p>
        )}
      </div>
      <div
        className={`mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-foreground/10 pt-1.5 ${collapsibleFooterClassName(expanded) ?? ""}`}
      >
        <Button
          type="button"
          size="xs"
          variant={expanded ? "outline" : "ghost-muted"}
          aria-expanded={expanded}
          aria-controls={bodyId}
          data-scroll-anchor-ignore
          onClick={() => {
            setExpanded(!expanded);
            if (expanded) revealCollapsedTop(root.current);
          }}
          className={expanded ? "bg-background/95 shadow-xs" : "-ml-1"}
        >
          <ChevronDownIcon className={expanded ? "rotate-180" : undefined} aria-hidden />
          {expanded ? "Show less" : "Show full message"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant={expanded ? "outline" : "ghost-muted"}
          className={expanded ? "bg-background/95 shadow-xs" : undefined}
          aria-label={isCopied ? "Message copied" : "Copy full message"}
          onClick={() => copyToClipboard(text, undefined)}
        >
          {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          {isCopied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
