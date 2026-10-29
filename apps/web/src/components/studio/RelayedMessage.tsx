import type { TimelineDetail } from "@specweave-studio/contracts";
import { useId, useMemo, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import type { TimestampFormat } from "@specweave-studio/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import {
  formatJsonBlocks,
  workerMessagePresentation,
  workerMessageSizeLabel,
  relayAttentionText,
} from "../../studio/workerMessagePresentation";
import { textMatchesQuery } from "../find/conversationFind.logic";
import { useConversationFindQueryWithin } from "../find/conversationFindStore";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { collapsibleFooterClassName, revealCollapsedTop } from "../chat/CollapsibleReport";

/** A footer riding over the text gets a backing, as the shared fold toggle does. */
const STICKY_BACKING =
  "bg-background/95 shadow-xs backdrop-blur supports-backdrop-filter:bg-background/80";

/** Who relayed the message: the coordinator, another thread, or an agent with no thread. */
export type RelayedMessageSource = "coordinator" | "thread" | "agent";

/**
 * A message one agent sent another: the coordinator's to a thread, a worker's
 * to its coordinator, or one thread's to another. It reads as a quiet note,
 * not a bubble, so the person's own messages stay the loudest thing on the
 * page: a muted "Message from …" disclosure, the text in muted prose, then a
 * link to where it came from and when.
 *
 * Non-verbose detail folds internal receipts without routine previews. Candidate
 * questions, decisions and failure prose stay visible; this is presentation,
 * not the attention/blocker classifier. Find and disclosure reveal the original.
 * Verbose opens the body. Copy preserves the exact original bytes.
 */
export function RelayedMessage({
  label,
  source,
  view,
  createdAt,
  timestampFormat,
  original,
  text,
  detail = "normal",
  renderMarkdown,
  attachments,
  actions,
}: {
  /** "Message from coordinator", "Message from Fix Safari export", … */
  label: string;
  source: RelayedMessageSource;
  /** Opens where the message came from; null when that is not reachable. */
  view: { readonly label: string; readonly onOpen: () => void } | null;
  createdAt: string | undefined;
  timestampFormat: TimestampFormat;
  /** The message as stored: what the receiving agent's model read. */
  original: string;
  /** The same message prepared for display, with thread links. */
  text: string;
  detail?: TimelineDetail;
  renderMarkdown: (text: string) => ReactNode;
  /** Files and images sent with it, shown while it is open. */
  attachments?: ReactNode;
  /** More footer actions, such as reverting to before it. */
  actions?: ReactNode;
}) {
  const presentation = useMemo(
    () => workerMessagePresentation(original, text, detail),
    [detail, original, text],
  );
  const body = useMemo(() => formatJsonBlocks(text), [text]);
  const bodyId = useId();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const { excerpt, clamp } = presentation;
  const long = excerpt !== null || clamp;
  const openByDefault = detail === "verbose";
  const attention = useMemo(() => relayAttentionText(text), [text]);
  const [expanded, setExpanded] = useState(openByDefault);
  // The reader opened it: only then does "Show less" follow the reader down the message.
  const [openedByReader, setOpenedByReader] = useState(false);
  // A new detail level sets the default again: Verbose opens, the others fold.
  const [lastDetail, setLastDetail] = useState(detail);
  if (detail !== lastDetail) {
    setLastDetail(detail);
    setExpanded(openByDefault);
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
  // Find reaches the folded part by opening it, whenever the hidden text holds
  // a match the folded view does not show. A clipped message opens for any
  // match, since where the clip falls is unknown.
  const findOpens =
    !expanded &&
    findQuery.length > 0 &&
    findQuery !== foldedForQuery &&
    textMatchesQuery(text, findQuery);
  const open = expanded || findOpens;
  const hasText = text.trim().length > 0;
  const toggle = () => {
    setExpanded(!open);
    setOpenedByReader(!open);
    setFoldedForQuery(open && findOpens ? findQuery : null);
    if (open) revealCollapsedTop(root);
  };
  const toggleLabel = open
    ? `${label}. Show less`
    : long
      ? `${label}. Show full message, ${workerMessageSizeLabel({ ...presentation, hidden: presentation.characters })}`
      : `${label}. Show message`;
  const time =
    createdAt === undefined ? "" : formatDayAwareTimestamp(createdAt, timestampFormat) || "";
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  // Opened by the reader, the footer follows them down a long message so Show less stays near.
  const sticky = open && long && openedByReader;

  return (
    <section
      ref={setRoot}
      className="group/relay min-w-0 text-sm leading-relaxed"
      data-relayed-message={source}
      data-worker-message={!long ? undefined : open ? "open" : "folded"}
      data-worker-message-clamp={clamp ? "true" : undefined}
      data-relayed-message-state={open ? "open" : "folded"}
    >
      <h3 className="m-0 text-sm font-normal">
        <button
          type="button"
          className="-ms-1 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-sm px-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={toggleLabel}
          data-scroll-anchor-ignore
          onClick={toggle}
        >
          <span className="min-w-0 truncate">{label}</span>
          <Chevron aria-hidden className="size-3.5 shrink-0" />
        </button>
      </h3>
      {!open && attention ? (
        <div data-relayed-attention={true} className="mt-0.5 text-muted-foreground">
          {renderMarkdown(attention)}
        </div>
      ) : null}
      <div id={bodyId} hidden={!open}>
        {open && hasText ? (
          <div className="mt-0.5 text-muted-foreground" data-relayed-message-body>
            {renderMarkdown(body)}
          </div>
        ) : null}
        {open && attachments ? <div className="mt-2">{attachments}</div> : null}
      </div>
      <div
        className={`mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums ${sticky ? `-mx-1.5 w-fit rounded-md px-1.5 py-0.5 ${STICKY_BACKING} ${collapsibleFooterClassName(true)}` : ""}`}
        hidden={!open}
        style={!open ? { display: "none" } : undefined}
        data-relayed-message-footer
      >
        {view ? (
          <InlineButton tone="link" onClick={view.onOpen}>
            {view.label}
          </InlineButton>
        ) : null}
        {time ? (
          <Tooltip>
            <TooltipTrigger
              render={<time dateTime={createdAt} tabIndex={0} />}
              className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
            >
              {time}
            </TooltipTrigger>
            <TooltipPopup>{formatChatTimestampTooltip(createdAt!, timestampFormat)}</TooltipPopup>
          </Tooltip>
        ) : null}
        {sticky ? (
          <InlineButton tone="muted" onClick={toggle}>
            Show less
          </InlineButton>
        ) : null}
        <span className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/relay:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
          {hasText ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              aria-label={isCopied ? "Original message copied" : "Copy original message"}
              title="Copy original"
              onClick={() => copyToClipboard(original, undefined)}
            >
              {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            </Button>
          ) : null}
          {actions}
        </span>
      </div>
    </section>
  );
}
