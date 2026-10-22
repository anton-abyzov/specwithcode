import type { DesignComment, DesignDocument, DesignOperation } from "@specweave-studio/contracts";
import { designId } from "@specweave-studio/shared/designOps";
import { CheckIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react";
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

/** Comments of the whole design, newest last, with the open draft on top. */
export function CommentsPanel({
  document,
  draft,
  activeId,
  canComment,
  onCommit,
  onCancelDraft,
  onOpen,
  onClose,
}: {
  document: DesignDocument;
  draft: CommentDraft | null;
  activeId: string | null;
  canComment: boolean;
  onCommit: (operations: DesignOperation[]) => void;
  onCancelDraft: () => void;
  onOpen: (comment: DesignComment) => void;
  onClose: () => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const nodes = useMemo(
    () =>
      new Map(document.pages.flatMap((page) => page.nodes.map((node) => [node.id, node] as const))),
    [document.pages],
  );
  const pageNames = useMemo(
    () => new Map(document.pages.map((page) => [page.id, page.name])),
    [document.pages],
  );
  const comments = document.comments.filter((comment) => showResolved || !comment.resolved);
  const resolvedCount = document.comments.filter((comment) => comment.resolved).length;

  useEffect(() => {
    if (draft !== null) field.current?.focus();
  }, [draft]);

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
        {comments.length === 0 && draft === null && (
          <li className="px-3 py-6 text-xs text-muted-foreground">
            {document.comments.length === 0
              ? "No comments yet. Pick the comment tool (C) and click a layer or the canvas."
              : "Every comment is resolved."}
          </li>
        )}
        {comments.map((comment) => {
          const number = document.comments.indexOf(comment) + 1;
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
                    <span className="font-medium text-foreground">
                      {comment.author.kind === "agent" ? "Agent" : "You"}
                    </span>
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
              {canComment && (
                <div className="mt-1 flex justify-end gap-0.5 opacity-70 group-hover:opacity-100 focus-within:opacity-100">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      onCommit([
                        {
                          op: "resolve_comment",
                          commentId: comment.id,
                          resolved: !comment.resolved,
                        },
                      ])
                    }
                  >
                    {comment.resolved ? <RotateCcwIcon /> : <CheckIcon />}
                    {comment.resolved ? "Reopen" : "Resolve"}
                  </Button>
                  <Button
                    variant="ghost-destructive"
                    size="icon-xs"
                    aria-label="Delete comment"
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
