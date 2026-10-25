import { useId, useMemo, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  formatJsonBlocks,
  workerMessagePresentation,
  workerMessageSizeLabel,
} from "../../studio/workerMessagePresentation";
import { findTextOffsets, textMatchesQuery } from "../find/conversationFind.logic";
import { useConversationFindQueryWithin } from "../find/conversationFindStore";
import { Button } from "../ui/button";
import { collapsibleFooterClassName, revealCollapsedTop } from "../chat/CollapsibleReport";

/**
 * A worker's message to its coordinator. A long one shows its opening
 * sentences and the sentence asking for a decision, cut from the text; the
 * whole message is one click away and "Copy original" copies it exactly as the
 * coordinator received it.
 */
export function WorkerMessageBody({
  original,
  text,
  renderMarkdown,
}: {
  /** The message as stored: what the coordinator's model read. */
  original: string;
  /** The same message prepared for display, with thread links. */
  text: string;
  renderMarkdown: (text: string) => ReactNode;
}) {
  const presentation = useMemo(() => workerMessagePresentation(original, text), [original, text]);
  const body = useMemo(() => formatJsonBlocks(text), [text]);
  const bodyId = useId();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  // The find query the reader folded the message under; that query no longer opens it.
  const [foldedForQuery, setFoldedForQuery] = useState<string | null>(null);
  const findQuery = useConversationFindQueryWithin(root);
  // A new search, or the same one run again, may open it again.
  const [lastFindQuery, setLastFindQuery] = useState(findQuery);
  if (findQuery !== lastFindQuery) {
    setLastFindQuery(findQuery);
    setFoldedForQuery(null);
  }
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "message",
    preserveBytes: true,
  });
  const { excerpt } = presentation;
  if (excerpt === null) return renderMarkdown(body);
  // Find in the conversation reaches the folded part by opening it, whenever
  // the hidden text holds a match the excerpt does not show.
  const findOpens =
    findQuery.length > 0 &&
    findQuery !== foldedForQuery &&
    (findTextOffsets(text, findQuery).length > findTextOffsets(excerpt, findQuery).length ||
      (!textMatchesQuery(excerpt, findQuery) && textMatchesQuery(text, findQuery)));
  const open = expanded || findOpens;
  const size = workerMessageSizeLabel(presentation);
  return (
    <div ref={setRoot} className="min-w-0" data-worker-message={open ? "open" : "folded"}>
      <div id={bodyId}>{renderMarkdown(open ? body : excerpt)}</div>
      <div
        className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-foreground/10 pt-1.5 ${collapsibleFooterClassName(open) ?? ""}`}
      >
        <Button
          type="button"
          size="xs"
          variant={open ? "outline" : "ghost-muted"}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={open ? "Show less" : `Show full message, ${size}`}
          data-scroll-anchor-ignore
          onClick={() => {
            setExpanded(!open);
            setFoldedForQuery(open && findOpens ? findQuery : null);
            if (open) revealCollapsedTop(root);
          }}
          className={open ? "bg-background/95 shadow-xs" : "-ml-1"}
        >
          <ChevronDownIcon className={open ? "rotate-180" : undefined} aria-hidden />
          {open ? "Show less" : "Show full message"}
        </Button>
        {open ? null : (
          <span className="text-xs text-muted-foreground" aria-hidden>
            {size}
          </span>
        )}
        <Button
          type="button"
          size="xs"
          variant={open ? "outline" : "ghost-muted"}
          className={`ml-auto ${open ? "bg-background/95 shadow-xs" : ""}`}
          aria-label={isCopied ? "Original message copied" : "Copy original message"}
          onClick={() => copyToClipboard(original, undefined)}
        >
          {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          {isCopied ? "Copied" : "Copy original"}
        </Button>
      </div>
    </div>
  );
}
