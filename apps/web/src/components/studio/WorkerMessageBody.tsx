import type { TimelineDetail } from "@specweave-studio/contracts";
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

/** A clipped message fades out at its bottom edge, as a person's long prompt does. */
const CLAMP_FADE_MASK = "linear-gradient(to bottom, black calc(100% - 2rem), transparent)";

/** An open message's controls can stick over its text, so they get the shared toggle's backing. */
const OPEN_CONTROL =
  "bg-background/95 shadow-xs backdrop-blur supports-backdrop-filter:bg-background/80";

/**
 * A message one agent sent another: a worker's to its coordinator, or any
 * agent's on a thread page. A long one shows its opening sentences and the
 * sentence asking for a decision, cut from the text; the whole message is one
 * click away and "Copy original" copies it exactly as it was received. One
 * with no opening to cut (only JSON or a code fence) shows its clipped top.
 * The timeline detail sets how soon it folds; Verbose opens it.
 */
export function WorkerMessageBody({
  original,
  text,
  detail = "normal",
  renderMarkdown,
}: {
  /** The message as stored: what the receiving agent's model read. */
  original: string;
  /** The same message prepared for display, with thread links. */
  text: string;
  detail?: TimelineDetail;
  renderMarkdown: (text: string) => ReactNode;
}) {
  const presentation = useMemo(
    () => workerMessagePresentation(original, text, detail),
    [detail, original, text],
  );
  const body = useMemo(() => formatJsonBlocks(text), [text]);
  const bodyId = useId();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(detail === "verbose");
  // The reader opened it: only then do its controls follow the reader down the message.
  const [openedByReader, setOpenedByReader] = useState(false);
  // A new detail level sets the default again: Verbose opens, the others fold.
  const [lastDetail, setLastDetail] = useState(detail);
  if (detail !== lastDetail) {
    setLastDetail(detail);
    setExpanded(detail === "verbose");
    setOpenedByReader(false);
  }
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
  const { excerpt, clamp } = presentation;
  if (excerpt === null && !clamp) return renderMarkdown(body);
  // Find in the conversation reaches the folded part by opening it, whenever
  // the hidden text holds a match the excerpt does not show. A clipped message
  // opens for any match, since where the clip falls is unknown.
  const findOpens =
    findQuery.length > 0 &&
    findQuery !== foldedForQuery &&
    (excerpt === null
      ? textMatchesQuery(text, findQuery)
      : findTextOffsets(text, findQuery).length > findTextOffsets(excerpt, findQuery).length ||
        (!textMatchesQuery(excerpt, findQuery) && textMatchesQuery(text, findQuery)));
  const open = expanded || findOpens;
  const size = workerMessageSizeLabel(presentation);
  const clipped = !open && excerpt === null;
  return (
    <div
      ref={setRoot}
      className="min-w-0"
      data-worker-message={open ? "open" : "folded"}
      data-worker-message-clamp={clamp ? "true" : undefined}
    >
      <div
        id={bodyId}
        className={
          clipped ? `overflow-hidden ${detail === "concise" ? "max-h-24" : "max-h-44"}` : undefined
        }
        style={
          clipped ? { maskImage: CLAMP_FADE_MASK, WebkitMaskImage: CLAMP_FADE_MASK } : undefined
        }
      >
        {renderMarkdown(open || excerpt === null ? body : excerpt)}
      </div>
      <div
        className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-foreground/10 pt-1.5 ${collapsibleFooterClassName(open && (openedByReader || findOpens)) ?? ""}`}
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
            setOpenedByReader(!open);
            setFoldedForQuery(open && findOpens ? findQuery : null);
            if (open) revealCollapsedTop(root);
          }}
          className={open ? OPEN_CONTROL : "-ml-1"}
        >
          <ChevronDownIcon className={open ? "rotate-180" : undefined} aria-hidden />
          {open ? "Show less" : "Show full message"}
        </Button>
        {open ? null : (
          <span className="text-xs whitespace-nowrap text-muted-foreground" aria-hidden>
            {size}
          </span>
        )}
        <Button
          type="button"
          size="xs"
          variant={open ? "outline" : "ghost-muted"}
          className={`ml-auto shrink-0 ${open ? OPEN_CONTROL : ""}`}
          aria-label={isCopied ? "Original message copied" : "Copy original message"}
          title="Copy original"
          onClick={() => copyToClipboard(original, undefined)}
        >
          {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          {/* A phone keeps the icon, so the footer stays two rows at most. */}
          <span className="max-sm:hidden">{isCopied ? "Copied" : "Copy original"}</span>
        </Button>
      </div>
    </div>
  );
}
