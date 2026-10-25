import type { DesignComment, DesignDocument, DesignOperation } from "@specweave-studio/contracts";
import { designCommentThreads, designId } from "@specweave-studio/shared/designOps";
import { CheckIcon, ReplyIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { labelFor } from "./PropertiesPanel";

export interface CommentDraft {
  readonly pageId: string;
  readonly nodeId: string | null;
  readonly x: number;
  readonly y: number;
  /** The same spot on the page, used when the anchored layer is gone by the time the comment is posted. */
  readonly canvasX: number;
  readonly canvasY: number;
}

/**
 * Where the comment goes: on its layer while that layer exists, otherwise on
 * the canvas point the layer was at (it was undone, deleted or changed by the
 * agent while the draft was open).
 */
export function commentDraftAnchor(
  draft: CommentDraft,
  hasNode: (id: string) => boolean,
): { nodeId: string | null; x: number; y: number } {
  if (draft.nodeId !== null && !hasNode(draft.nodeId))
    return { nodeId: null, x: draft.canvasX, y: draft.canvasY };
  return { nodeId: draft.nodeId, x: draft.x, y: draft.y };
}

/**
 * Comment threads of the whole design, newest last, with the open draft on top.
 * Replies list under their thread's first comment; Reply shows only where the
 * server threads replies (`canReply`).
 */
export function CommentsPanel({
  document,
  draft,
  activeId,
  canComment,
  canReply,
  onCommit,
  onCancelDraft,
  onOpen,
  onClose,
}: {
  document: DesignDocument;
  draft: CommentDraft | null;
  activeId: string | null;
  canComment: boolean;
  canReply: boolean;
  onCommit: (operations: DesignOperation[]) => void;
  onCancelDraft: () => void;
  onOpen: (comment: DesignComment) => void;
  onClose: () => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const replyField = useRef<HTMLTextAreaElement>(null);
  const nodes = useMemo(
    () =>
      new Map(document.pages.flatMap((page) => page.nodes.map((node) => [node.id, node] as const))),
    [document.pages],
  );
  const pageNames = useMemo(
    () => new Map(document.pages.map((page) => [page.id, page.name])),
    [document.pages],
  );
  const threads = useMemo(() => designCommentThreads(document.comments), [document.comments]);
  const shown = threads.filter((thread) => showResolved || !thread.root.resolved);
  const resolvedCount = threads.filter((thread) => thread.root.resolved).length;
  const replyRoot =
    replyTo === null ? undefined : threads.find((thread) => thread.root.id === replyTo)?.root;
  // The form hides while its thread is deleted or resolved, here or elsewhere.
  const replyOpen = canComment && canReply && replyRoot !== undefined && !replyRoot.resolved;

  useEffect(() => {
    if (draft !== null) field.current?.focus();
  }, [draft]);
  useEffect(() => {
    if (replyTo !== null) replyField.current?.focus();
  }, [replyTo]);

  const cancelReply = () => {
    setReplyTo(null);
    setReplyText("");
  };
  const submitReply = (root: DesignComment) => {
    if (replyText.trim() === "") return;
    onCommit([
      {
        op: "add_comment",
        comment: {
          id: designId("c"),
          parentId: root.id,
          pageId: root.pageId,
          nodeId: root.nodeId,
          x: root.x,
          y: root.y,
          text: replyText.trim(),
          author: { kind: "user" },
          createdAt: new Date().toISOString(),
          resolved: false,
        },
      },
    ]);
    cancelReply();
  };

  const submit = () => {
    if (draft === null || text.trim() === "") return;
    const anchor = commentDraftAnchor(draft, (id) => nodes.has(id));
    onCommit([
      {
        op: "add_comment",
        comment: {
          id: designId("c"),
          pageId: draft.pageId,
          nodeId: anchor.nodeId,
          x: anchor.x,
          y: anchor.y,
          text: text.trim(),
          author: { kind: "user" },
          createdAt: new Date().toISOString(),
          resolved: false,
        },
      },
    ]);
    setText("");
    onCancelDraft();
  };

  return (
    <div data-testid="comments-panel" className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
        <h2 className="text-sm font-medium">Comments</h2>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          Show resolved ({resolvedCount})
          <Switch
            checked={showResolved}
            onCheckedChange={setShowResolved}
            aria-label="Show resolved comments"
          />
        </label>
        <Button variant="ghost" size="icon-xs" aria-label="Close comments" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {draft !== null && (
        <form
          className="flex flex-col gap-2 border-b border-border/70 px-3 py-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <p className="text-xs text-muted-foreground">
            New comment on{" "}
            {(() => {
              const node = draft.nodeId === null ? undefined : nodes.get(draft.nodeId);
              return node === undefined ? "the canvas" : labelFor(node);
            })()}
          </p>
          <Textarea
            ref={field}
            size="sm"
            aria-label="Comment"
            placeholder="What should change?"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
              if (event.key === "Escape") onCancelDraft();
            }}
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="xs" onClick={onCancelDraft}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={text.trim() === ""}>
              Comment
            </Button>
          </div>
        </form>
      )}
      <ol className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && draft === null && (
          <li className="px-3 py-6 text-xs text-muted-foreground">
            {threads.length === 0
              ? "No comments yet. Pick the comment tool (C) and click a layer or the canvas."
              : "Every comment is resolved."}
          </li>
        )}
        {shown.map((thread) => {
          const { root: comment, replies } = thread;
          const number = threads.indexOf(thread) + 1;
          const node = comment.nodeId === null ? undefined : nodes.get(comment.nodeId);
          return (
            <li
              key={comment.id}
              data-comment={comment.id}
              className={cn(
                "group border-b border-border/50 px-3 py-2.5",
                activeId === comment.id && "bg-accent/60",
              )}
            >
              <button
                type="button"
                className="flex w-full items-start gap-2 text-left"
                onClick={() => onOpen(comment)}
              >
                <span
                  className={cn(
                    "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full rounded-bl-none text-3xs font-medium",
                    comment.resolved
                      ? "bg-muted text-muted-foreground"
                      : "bg-primary text-primary-foreground",
                  )}
                >
                  {number}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{authorLabel(comment)}</span>
                    <span>
                      {node === undefined
                        ? (pageNames.get(comment.pageId) ?? "Canvas")
                        : labelFor(node)}
                    </span>
                    <time dateTime={comment.createdAt} className="ml-auto shrink-0">
                      {formatTime(comment.createdAt)}
                    </time>
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 block whitespace-pre-wrap",
                      comment.resolved && "text-muted-foreground",
                    )}
                  >
                    {comment.text}
                  </span>
                </span>
              </button>
              {replies.length > 0 && (
                <ol aria-label="Replies" className="mt-2 ml-7 flex flex-col gap-2">
                  {replies.map((reply) => (
                    <li
                      key={reply.id}
                      data-comment={reply.id}
                      className="group/reply flex items-start gap-1"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{authorLabel(reply)}</span>
                          <time dateTime={reply.createdAt} className="ml-auto shrink-0">
                            {formatTime(reply.createdAt)}
                          </time>
                        </span>
                        <span
                          className={cn(
                            "mt-0.5 block whitespace-pre-wrap",
                            reply.resolved && "text-muted-foreground",
                          )}
                        >
                          {reply.text}
                        </span>
                      </div>
                      {canComment && (
                        <span className="-mt-1 opacity-70 group-hover/reply:opacity-100 focus-within:opacity-100">
                          <Button
                            variant="ghost-destructive"
                            size="icon-xs"
                            aria-label="Delete reply"
                            onClick={() =>
                              onCommit([{ op: "delete_comment", commentId: reply.id }])
                            }
                          >
                            <Trash2Icon />
                          </Button>
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {replyOpen && replyTo === comment.id && (
                <form
                  className="mt-2 ml-7 flex flex-col gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitReply(comment);
                  }}
                >
                  <Textarea
                    ref={replyField}
                    size="sm"
                    aria-label="Reply"
                    placeholder="Reply…"
                    value={replyText}
                    onChange={(event) => setReplyText(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        submitReply(comment);
                      }
                      if (event.key === "Escape") cancelReply();
                    }}
                  />
                  <div className="flex justify-end gap-1.5">
                    <Button type="button" variant="ghost" size="xs" onClick={cancelReply}>
                      Cancel
                    </Button>
                    <Button type="submit" size="xs" disabled={replyText.trim() === ""}>
                      Reply
                    </Button>
                  </div>
                </form>
              )}
              {canComment && (
                <div className="mt-1 flex justify-end gap-0.5 opacity-70 group-hover:opacity-100 focus-within:opacity-100">
                  {canReply && !comment.resolved && !(replyOpen && replyTo === comment.id) && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setReplyText("");
                        setReplyTo(comment.id);
                      }}
                    >
                      <ReplyIcon />
                      Reply
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      if (replyTo === comment.id) cancelReply();
                      onCommit([
                        {
                          op: "resolve_comment",
                          commentId: comment.id,
                          resolved: !comment.resolved,
                        },
                      ]);
                    }}
                  >
                    {comment.resolved ? <RotateCcwIcon /> : <CheckIcon />}
                    {comment.resolved ? "Reopen" : "Resolve"}
                  </Button>
                  <Button
                    variant="ghost-destructive"
                    size="icon-xs"
                    aria-label={replies.length > 0 ? "Delete thread" : "Delete comment"}
                    onClick={() => onCommit([{ op: "delete_comment", commentId: comment.id }])}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function authorLabel(comment: DesignComment) {
  return comment.author.kind === "agent" ? "Agent" : "You";
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : timeFormat.format(date);
}
