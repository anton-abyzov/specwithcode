import { useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentId, OrchestrationV2TurnItem, ThreadId } from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputText,
} from "@specweave-studio/client-runtime/work-log/item-detail";
import ChatView from "../ChatView";
import { useThreadProjection, useThreadStatus } from "../../state/entities";
import { Button } from "../ui/button";
import { useTurnItemDetail } from "../../state/queries";
import { ToolCodePanel } from "../chat/toolOutputPresentation";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  ProjectMessageRoutingContext,
  type ProjectMessageRouting,
} from "../../studio/projectMessageRouting";
import { firstRequestAction } from "./CoordinatorNativeControls";

/** Requests and tool output are overlays on the existing conversation, never another chat. */
export function ProjectCoordinatorDetails({
  environmentId,
  threadId,
  routing,
  error,
  view = "requests",
  runId = null,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  routing: ProjectMessageRouting;
  error?: string | null;
  view?: "requests" | "activity";
  runId?: string | null;
  onClose: () => void;
}) {
  const previous = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const close = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(
    () => () => {
      if (previous.current instanceof HTMLElement && previous.current.isConnected)
        previous.current.focus({ preventScroll: true });
    },
    [],
  );
  const ref = useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]);
  const projection = useThreadProjection(ref);
  const status = useThreadStatus(ref);
  const items = (projection?.projection.turnItems ?? []).filter(
    (item) =>
      (runId === null || item.runId === runId) &&
      !["user_message", "assistant_message", "reasoning", "plan", "proposed_plan"].includes(
        item.type,
      ),
  );
  const title = view === "activity" ? "Coordinator activity" : "Coordinator requests";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        className="max-w-2xl"
        showCloseButton={false}
        // The request's own action first; Close only when there is nothing to act on.
        initialFocus={() =>
          (view === "requests" ? firstRequestAction(panel.current) : null) ?? close.current
        }
        finalFocus={previous}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {view === "activity"
              ? runId
                ? "Inspect tool output from this turn."
                : "Inspect tool output from this conversation."
              : "Respond to an approval, question, or proposed plan."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel ref={panel}>
          {error ? (
            <p className="text-sm text-destructive-foreground" role="alert">
              {error}
            </p>
          ) : null}
          {view === "requests" ? (
            <ProjectMessageRoutingContext
              value={{
                ...routing,
                // Settled everywhere means settled here: a page error stays beside the composer.
                onCoordinatorRequestsResolved: onClose,
                closeCoordinatorRequests: (focus) => {
                  if (focus) previous.current = focus;
                  onClose();
                },
              }}
            >
              <ChatView
                key={`${environmentId}:${threadId}`}
                environmentId={environmentId}
                threadId={threadId}
                routeKind="server"
                layoutMode="embedded"
                reserveTitleBarControlInset={false}
                reviewOnly
              />
            </ProjectMessageRoutingContext>
          ) : (
            <div className="space-y-3" aria-busy={status === "empty" || status === "synchronizing"}>
              {items.length ? (
                items.map((item) => (
                  <CoordinatorActivityItem
                    key={item.id}
                    item={item}
                    environmentId={environmentId}
                    threadId={threadId}
                  />
                ))
              ) : (
                <p className="text-sm text-muted-foreground" role="status">
                  {status === "empty" || status === "synchronizing"
                    ? "Loading activity…"
                    : "No tool output has been recorded."}
                </p>
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button ref={close} variant="outline" size="sm" />}>
            Close {view === "activity" ? "activity" : "review"}
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CoordinatorActivityItem({
  item: wireItem,
  environmentId,
  threadId,
}: {
  item: OrchestrationV2TurnItem;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  const detail = useTurnItemDetail(
    open && turnItemNeedsDetailFetch(wireItem)
      ? {
          environmentId,
          threadId: wireItem.threadId ?? threadId,
          itemId: wireItem.id,
          revision: turnItemDetailRevision(wireItem),
        }
      : null,
  );
  const item = detail.data?.item?.type === wireItem.type ? detail.data.item : wireItem;
  const input =
    "input" in item
      ? typeof item.input === "string"
        ? item.input
        : JSON.stringify(item.input, null, 2)
      : null;
  const output = turnItemOutputText(item);
  return (
    <details
      className="rounded-lg border p-3 text-sm"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
        {item.title || ("toolName" in item ? item.toolName : item.type.replaceAll("_", " "))}{" "}
        <span className="text-muted-foreground">({item.status})</span>
      </summary>
      {open ? (
        <div className="mt-3 space-y-3">
          {detail.isPending ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading full output…
            </p>
          ) : null}
          {detail.error ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {detail.error}
            </p>
          ) : null}
          {input ? <ToolCodePanel label="Input" text={input} /> : null}
          {output ? <ToolCodePanel label="Output" text={output} /> : null}
          {!input && !output ? (
            <ToolCodePanel label="Details" text={JSON.stringify(item, null, 2)} />
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
