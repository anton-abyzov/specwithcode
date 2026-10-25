import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import {
  deriveThreadQueueWorkflowState,
  type ThreadQueueWaitReason,
} from "@specweave-studio/client-runtime/state/thread-workflows";
import { replaceComposerContextReferences } from "@specweave-studio/shared/composerContextReferences";
import type {
  ChatAttachment as ContractChatAttachment,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import {
  BotIcon,
  CircleAlertIcon,
  CirclePauseIcon,
  Clock3Icon,
  CornerUpRightIcon,
  GripVerticalIcon,
  ListOrderedIcon,
  PencilIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useThreadProjection, useThreadShell } from "../../state/entities";
import { nowMinuteMs, useNowMinute } from "../../hooks/useNowMinute";
import { epochMillis } from "../../studio/projectThreadMentions";
import { queuedAgeLabel, queuedRunOneLine } from "./queuedRunSummary";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
}

interface QueuedRowThumbnail {
  readonly key: string;
  readonly name: string;
  readonly url: string | null;
}

const QUEUED_RUN_DRAG_TYPE = "application/x-studio-queued-run";

/** The thread that sent a queued message, by name; opening threads stays in the timeline. */
function QueuedSenderChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const sender = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const title = sender?.title || "Another thread";
  return (
    <span
      className="inline-flex min-w-0 max-w-24 shrink-0 sm:max-w-36 items-center gap-1 rounded-full border border-border/70 px-1.5 text-2xs text-muted-foreground"
      data-queued-sender={props.threadId}
      title={`From ${title}`}
    >
      <BotIcon aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">From </span>
      <span className="truncate">{title}</span>
    </span>
  );
}

/** A message typed on this thread: queued by the person, not by another thread. */
function QueuedOwnChip() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 px-1.5 text-2xs text-muted-foreground"
      data-queued-sender="you"
      title="Queued by you"
    >
      <UserIcon aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">Queued by </span>
      <span>You</span>
    </span>
  );
}

/**
 * Why the queue is not draining, for the header. Held states keep the words
 * the held banner uses; a running turn keeps "after current turn".
 */
const WAIT_HEADER: Record<ThreadQueueWaitReason, string> = {
  turn: "Queue · after current turn",
  stopped: "Queue · held after Stop",
  failure: "Queue · held after a failure",
  usage_limit: "Queue · held by a usage limit",
  restart: "Queue · waiting for the restart to continue",
  starting: "Queue · starting next",
};

const WAIT_EXPLANATION: Partial<Record<ThreadQueueWaitReason, string>> = {
  stopped: "You stopped the last turn. Nothing here is sent until you resume.",
  failure:
    "The last turn failed. Nothing here is sent until you resume, so the same error is not repeated.",
  usage_limit:
    "The provider's usage limit stopped this thread. The queue waits until you continue the thread.",
  restart: "The server restarted. The queue resumes once the interrupted turn continues.",
};

/** The server's own words for a refused queue command, or null when it succeeded. */
export function queueCommandFailureMessage(
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  const message =
    error !== null && typeof error === "object" && "message" in error
      ? (error as { readonly message: unknown }).message
      : undefined;
  return typeof message === "string" && message.trim().length > 0 ? message : fallback;
}

export interface QueuedRunsControlHandle {
  steerNext: (repeat: boolean) => boolean;
  editLatest: (repeat: boolean) => boolean;
}

export function QueuedRunsControl({
  ref,
  ...props
}: {
  readonly ref?: Ref<QueuedRunsControlHandle>;
  readonly steerShortcutLabel?: string | null;
  readonly editShortcutLabel?: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<
    Pick<ChatMessage, "id" | "inputIntent" | "text" | "attachments">
  >;
  /** The saved queue entry stays visible while its draft is edited in the composer. */
  readonly editingRunId: RunId | null;
  /** Absent where no composer can take the message, so there is no Edit button. */
  readonly onEditQueuedRun?: ((request: EditQueuedRunRequest) => void) | undefined;
  readonly onCancelEdit: () => void;
  /** Resumes a held queue the way the composer's Resume does; absent where it cannot. */
  readonly onResumeHeld?: (() => void) | undefined;
  /** A resume or send is in flight, so Resume would do nothing yet. */
  readonly resumeBusy?: boolean | undefined;
  /**
   * Why this viewer cannot change the queue (no operate permission, or the
   * machine is not connected); null or absent when the row actions work.
   */
  readonly actionsUnavailableReason?: string | null | undefined;
}) {
  const projection = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const [expanded, setExpanded] = useState(true);
  const queueListId = useId();
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  // Live drag-reorder state: the dragged run and the queue index the row
  // would be inserted at (0..queued.length) as of the latest dragover.
  const [dragState, setDragState] = useState<{
    readonly runId: RunId;
    readonly insertIndex: number | null;
  } | null>(null);
  // Drags must start from the grip, not from an accidental text-drag on the
  // row. The grip arms its run id on pointerdown; dragstart verifies it.
  const dragArmedRunIdRef = useRef<RunId | null>(null);
  const workflow = useMemo(
    () => (projection ? deriveThreadQueueWorkflowState(projection) : null),
    [projection],
  );
  const queued = workflow?.queuedRuns ?? [];
  const heldRunIds = queued.flatMap(({ run }) => (run.queueHeld === true ? [run.id] : []));
  const [discardArmed, setDiscardArmed] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const activeRun = workflow?.activeRun ?? null;
  const actionsUnavailable = props.actionsUnavailableReason ?? null;
  const canReorder = workflow?.canReorder === true && actionsUnavailable === null;
  // The server's refusal of the latest queue command, shown until one succeeds.
  const [commandError, setCommandError] = useState<string | null>(null);
  const settle = (result: AtomCommandResult<unknown, unknown>, fallback: string) => {
    const failure = queueCommandFailureMessage(result, fallback);
    if (failure !== null) setCommandError(failure);
    else if (result._tag === "Success") setCommandError(null);
    return failure === null;
  };
  const queuedImageAttachmentIds = useMemo(() => {
    const ids: string[] = [];
    for (const { attachments } of workflow?.queuedRuns ?? []) {
      for (const attachment of attachments) {
        if (attachment.type === "image") ids.push(attachment.id);
      }
    }
    return ids;
  }, [workflow]);
  const queuedImageAttachmentResources = useMemo(
    () =>
      queuedImageAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [queuedImageAttachmentIds],
  );
  const queuedImageAttachmentUrls = useAssetUrls(
    props.environmentId,
    queuedImageAttachmentResources,
  );
  const queuedImageUrlById = useMemo(
    () =>
      new Map(
        queuedImageAttachmentIds.flatMap((attachmentId, index) => {
          const url = queuedImageAttachmentUrls[index];
          return url ? [[attachmentId, url] as const] : [];
        }),
      ),
    [queuedImageAttachmentIds, queuedImageAttachmentUrls],
  );
  // Once the projection holds the message the optimistic copy is stale no
  // matter what happened to its run — keying on still-queued runs alone would
  // resurrect a phantom "pending" row after the run is cancelled or started.
  const acknowledgedMessageIds = useMemo(
    () => new Set((projection?.messages ?? []).map((message) => message.id)),
    [projection],
  );
  const optimisticQueued = props.optimisticMessages.filter(
    (message) => message.inputIntent === "queued_turn" && !acknowledgedMessageIds.has(message.id),
  );
  const nowMs = nowMinuteMs(useNowMinute());
  const items = [
    ...queued.map(
      (
        { run, text, attachments, senderThreadId, summary, createdBy, automatic, steering },
        serverIndex,
      ) => ({
        key: run.id,
        runId: run.id,
        messageId: run.userMessageId,
        serverIndex,
        text,
        attachments,
        senderThreadId: senderThreadId ?? null,
        queuedByYou: senderThreadId === undefined && createdBy === "user",
        automatic: automatic === true,
        steering: steering === true,
        summary: summary ?? null,
        queuedAtMs: epochMillis(run.requestedAt),
        thumbnails: attachments
          .filter((attachment) => attachment.type === "image")
          .map<QueuedRowThumbnail>((attachment) => ({
            key: attachment.id,
            name: attachment.name,
            url: queuedImageUrlById.get(attachment.id) ?? null,
          })),
        pending: false,
      }),
    ),
    ...optimisticQueued.map((message) => ({
      key: message.id,
      runId: null,
      messageId: null,
      serverIndex: null,
      text: message.text,
      attachments: [] as ReadonlyArray<ContractChatAttachment>,
      senderThreadId: null,
      queuedByYou: true,
      automatic: false,
      steering: false,
      summary: null,
      queuedAtMs: null,
      thumbnails: (message.attachments ?? [])
        .filter(isImageAttachment)
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: attachment.previewUrl ?? null,
        })),
      pending: true,
    })),
  ];

  const move = async (runId: RunId, beforeRunId: RunId | null) => {
    if (actionsUnavailable !== null) return;
    setBusyRunId(runId);
    try {
      settle(
        await reorder({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, runId, beforeRunId },
        }),
        "Could not move the queued message.",
      );
    } finally {
      setBusyRunId(null);
    }
  };

  // Automatic deliveries keep their place: a message may not move ahead of one.
  const insertionTarget = (insertIndex: number): number => {
    let index = insertIndex;
    while (queued[index]?.automatic === true) index += 1;
    return index;
  };

  const completeDrag = (runId: RunId, insertIndex: number | null) => {
    setDragState(null);
    dragArmedRunIdRef.current = null;
    if (insertIndex === null || busyRunId !== null) return;
    const draggedIndex = queued.findIndex(({ run }) => run.id === runId);
    if (draggedIndex === -1) return;
    insertIndex = insertionTarget(insertIndex);
    // Inserting immediately before or after itself is a no-op.
    if (insertIndex === draggedIndex || insertIndex === draggedIndex + 1) return;
    void move(runId, queued[insertIndex]?.run.id ?? null);
  };

  const steerInFlightRef = useRef(false);
  const steer = async (queuedRunId: RunId) => {
    if (
      activeRun === null ||
      !workflow?.canPromoteToSteer ||
      actionsUnavailable !== null ||
      steerInFlightRef.current
    )
      return;
    steerInFlightRef.current = true;
    setBusyRunId(queuedRunId);
    try {
      settle(
        await promote({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
        }),
        "Could not steer the queued message into the current turn.",
      );
    } finally {
      steerInFlightRef.current = false;
      setBusyRunId(null);
    }
  };

  useImperativeHandle(ref, () => ({
    steerNext(repeat) {
      const next = queued.find((row) => row.automatic !== true && row.steering !== true);
      if (!next || !workflow?.canPromoteToSteer || actionsUnavailable !== null) return false;
      if (!repeat && busyRunId === null) void steer(next.run.id);
      return true;
    },
    // Declines while a queued message is already being edited so the key keeps
    // moving the caret inside that draft.
    editLatest(repeat) {
      const latest = queued.findLast((row) => row.automatic !== true && row.steering !== true);
      const edit = props.onEditQueuedRun;
      if (
        !latest ||
        !edit ||
        props.editingRunId !== null ||
        busyRunId !== null ||
        actionsUnavailable !== null
      )
        return false;
      if (!repeat) {
        setExpanded(true);
        edit({
          runId: latest.run.id,
          messageId: latest.run.userMessageId,
          text: latest.text,
          attachments: latest.attachments,
        });
      }
      return true;
    },
  }));

  if (items.length === 0) return null;

  const remove = async (runId: RunId) => {
    if (actionsUnavailable !== null) return;
    setBusyRunId(runId);
    try {
      settle(
        await cancel({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, runId },
        }),
        "Could not remove the queued message.",
      );
    } finally {
      setBusyRunId(null);
    }
  };

  // Discarding drops messages other threads may have handed over, so it asks twice.
  const discardHeld = async () => {
    if (!discardArmed) {
      setDiscardArmed(true);
      return;
    }
    setDiscardArmed(false);
    if (actionsUnavailable !== null) return;
    setDiscarding(true);
    let failed = 0;
    let firstFailure: string | null = null;
    try {
      for (const runId of heldRunIds) {
        const failure = queueCommandFailureMessage(
          await cancel({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, runId },
          }),
          "Could not discard a held message.",
        );
        if (failure !== null) {
          failed += 1;
          firstFailure ??= failure;
        }
      }
    } finally {
      setDiscarding(false);
    }
    setCommandError(
      firstFailure === null
        ? null
        : failed === heldRunIds.length
          ? firstFailure
          : `Could not discard ${failed} of ${heldRunIds.length} held messages: ${firstFailure}`,
    );
  };
  const heldCount = heldRunIds.length;
  const heldLabel = `${heldCount} queued message${heldCount === 1 ? "" : "s"} held`;
  const waitReason = workflow?.waitReason;
  const heldDetail =
    waitReason === "usage_limit"
      ? " by the usage limit · continue the thread to send them"
      : waitReason === "failure"
        ? " after a failure · not sent until you resume"
        : waitReason === "stopped"
          ? " after Stop · not sent until you resume"
          : " · not sent until you resume";
  const headerLabel =
    waitReason !== undefined
      ? WAIT_HEADER[waitReason]
      : workflow?.isHeld
        ? "Queue · waiting to resume"
        : "Queue · after current turn";
  const steerUnavailable =
    workflow?.steerUnavailableReason ??
    (activeRun === null
      ? "There is no active run to steer"
      : "Steering is unavailable for this turn");
  const explanation =
    waitReason === undefined
      ? null
      : waitReason === "turn" || waitReason === "starting"
        ? workflow?.canPromoteToSteer
          ? null
          : activeRun === null
            ? null
            : `Steer now is unavailable: ${steerUnavailable}`
        : (WAIT_EXPLANATION[waitReason] ?? null);

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label={`${items.length} queued message${items.length === 1 ? "" : "s"}`}
        aria-live="polite"
        data-chat-composer-collapsed-controls="true"
        className="relative z-0"
        variant={heldCount > 0 ? "warning" : "default"}
      >
        {commandError !== null ? (
          <ComposerBanner.Row data-queue-error role="alert" className="text-destructive-foreground">
            <ComposerBanner.Icon>
              <CircleAlertIcon className="text-destructive-foreground" />
            </ComposerBanner.Icon>
            <ComposerBanner.Content className="min-w-0">
              <span className="min-w-0 break-words whitespace-normal">{commandError}</span>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Dismiss queue error"
                onClick={() => setCommandError(null)}
              >
                <XIcon />
              </Button>
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        ) : null}
        {heldCount > 0 ? (
          // A held queue never starts on its own: say so, and offer both ways out.
          <ComposerBanner.Row data-queue-held={heldCount}>
            <ComposerBanner.Icon>
              <CirclePauseIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content className="text-foreground/80">
              <span className="truncate">
                {heldLabel}
                <span className="text-muted-foreground">{heldDetail}</span>
              </span>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <Button
                size="xs"
                variant="outline"
                disabled={
                  props.onResumeHeld === undefined ||
                  props.resumeBusy === true ||
                  discarding ||
                  busyRunId !== null ||
                  actionsUnavailable !== null
                }
                title={actionsUnavailable ?? undefined}
                onClick={() => {
                  setDiscardArmed(false);
                  props.onResumeHeld?.();
                }}
              >
                Resume
              </Button>
              <Button
                size="xs"
                variant="ghost-muted"
                aria-label={
                  discardArmed
                    ? `Confirm: discard ${heldLabel}`
                    : `Discard ${heldCount === 1 ? "the held message" : `the ${heldCount} held messages`}`
                }
                disabled={discarding || busyRunId !== null || actionsUnavailable !== null}
                title={actionsUnavailable ?? undefined}
                onBlur={() => setDiscardArmed(false)}
                onClick={() => void discardHeld()}
              >
                {discardArmed ? `Discard ${heldCount}?` : "Discard"}
              </Button>
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        ) : null}
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-label={expanded ? "Collapse queued messages" : "Expand queued messages"}
          aria-expanded={expanded}
          aria-controls={queueListId}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setExpanded((value) => !value)}
        >
          <ComposerBanner.Icon>
            <ListOrderedIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground" data-queue-wait={waitReason}>
            {headerLabel}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{items.length}</ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {expanded && (explanation !== null || actionsUnavailable !== null) ? (
          <p
            className="px-2 pb-1 text-2xs leading-snug text-muted-foreground break-words"
            data-queue-reason
          >
            {[actionsUnavailable, explanation].filter((text) => text !== null).join(" ")}
          </p>
        ) : null}
        <ComposerBanner.Scroll className={cn("max-h-32", !expanded && "hidden")}>
          <ComposerBanner.Children render={<ol />} id={queueListId}>
            {items.map((item) => {
              const previewText = replaceComposerContextReferences(item.text, (reference) =>
                reference.kind === "image" && item.thumbnails.length > 0 ? "" : reference.label,
              ).trim();
              const oneLine = queuedRunOneLine(previewText, item.summary);
              const age = queuedAgeLabel(item.queuedAtMs, nowMs);
              const rowRunId = item.runId;
              const rowServerIndex = item.serverIndex;
              const isEditing = rowRunId !== null && rowRunId === props.editingRunId;
              const readOnly = item.automatic || item.steering;
              const rowDraggable =
                rowRunId !== null &&
                rowServerIndex !== null &&
                canReorder &&
                !readOnly &&
                busyRunId === null;
              const rowSteerReason =
                actionsUnavailable ??
                (item.steering
                  ? "Already being steered into the current turn."
                  : workflow?.canPromoteToSteer
                    ? null
                    : steerUnavailable);
              return (
                <ComposerBanner.Row
                  render={<li />}
                  key={item.key}
                  aria-current={isEditing ? "true" : undefined}
                  className={cn(
                    "relative rounded-sm",
                    isEditing && "bg-accent text-accent-foreground",
                    dragState !== null && dragState.runId === item.runId && "opacity-50",
                  )}
                  draggable={rowDraggable}
                  onDragStart={(event) => {
                    if (item.runId === null || dragArmedRunIdRef.current !== item.runId) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.setData(QUEUED_RUN_DRAG_TYPE, item.runId);
                    event.dataTransfer.effectAllowed = "move";
                    setDragState({ runId: item.runId, insertIndex: null });
                  }}
                  onDragEnd={() => {
                    dragArmedRunIdRef.current = null;
                    setDragState(null);
                  }}
                  onDragOver={(event) => {
                    if (dragState === null || item.serverIndex === null) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const rect = event.currentTarget.getBoundingClientRect();
                    const insertIndex =
                      event.clientY < rect.top + rect.height / 2
                        ? item.serverIndex
                        : item.serverIndex + 1;
                    if (dragState.insertIndex !== insertIndex) {
                      setDragState({ runId: dragState.runId, insertIndex });
                    }
                  }}
                  onDrop={(event) => {
                    if (dragState === null) return;
                    event.preventDefault();
                    completeDrag(dragState.runId, dragState.insertIndex);
                  }}
                >
                  {item.serverIndex !== null && dragState?.insertIndex === item.serverIndex ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded bg-primary/70"
                    />
                  ) : null}
                  {item.serverIndex === queued.length - 1 &&
                  dragState?.insertIndex === queued.length ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded bg-primary/70"
                    />
                  ) : null}
                  <ComposerBanner.Icon aria-hidden={false}>
                    {canReorder && !readOnly && rowRunId !== null && rowServerIndex !== null ? (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label="Reorder queued message (drag, or press the arrow keys)"
                        className="cursor-grab active:cursor-grabbing disabled:cursor-default"
                        disabled={busyRunId !== null}
                        onPointerDown={() => {
                          dragArmedRunIdRef.current = rowRunId;
                        }}
                        onKeyDown={(event) => {
                          if (busyRunId !== null) return;
                          if (
                            event.key === "ArrowUp" &&
                            rowServerIndex > 0 &&
                            queued[rowServerIndex - 1]?.automatic !== true
                          ) {
                            event.preventDefault();
                            void move(rowRunId, queued[rowServerIndex - 1]?.run.id ?? null);
                          }
                          if (event.key === "ArrowDown" && rowServerIndex < queued.length - 1) {
                            event.preventDefault();
                            const target = insertionTarget(rowServerIndex + 2);
                            void move(rowRunId, queued[target]?.run.id ?? null);
                          }
                        }}
                      >
                        <GripVerticalIcon />
                      </Button>
                    ) : null}
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content className="overflow-hidden text-foreground/80">
                    {isEditing ? <span className="sr-only">Editing queued message: </span> : null}
                    {item.pending ? (
                      <Clock3Icon
                        aria-label="Saving queued message"
                        className="size-3 shrink-0 text-muted-foreground"
                      />
                    ) : null}
                    {item.thumbnails.length > 0 ? (
                      <span className="flex shrink-0 items-center gap-0.5">
                        {item.thumbnails.map((thumbnail) => (
                          <span
                            key={thumbnail.key}
                            className="size-4 overflow-hidden rounded border border-border/70 bg-background"
                          >
                            {thumbnail.url ? (
                              <img
                                src={thumbnail.url}
                                alt={thumbnail.name}
                                className="size-full object-cover"
                              />
                            ) : (
                              <span
                                aria-label={thumbnail.name}
                                className="block size-full bg-muted/60"
                              />
                            )}
                          </span>
                        ))}
                      </span>
                    ) : null}
                    {item.senderThreadId ? (
                      <QueuedSenderChip
                        environmentId={props.environmentId}
                        threadId={item.senderThreadId}
                      />
                    ) : item.automatic ? (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 px-1.5 text-2xs text-muted-foreground"
                        data-queued-sender="automatic"
                        title="Delivered by the server"
                      >
                        <BotIcon aria-hidden className="size-3 shrink-0" />
                        <span>Automatic</span>
                      </span>
                    ) : item.queuedByYou ? (
                      <QueuedOwnChip />
                    ) : null}
                    <Tooltip>
                      <TooltipTrigger
                        render={<span className="min-w-0 flex-1 truncate" data-queued-summary />}
                      >
                        {oneLine}
                      </TooltipTrigger>
                      <TooltipPopup
                        side="top"
                        className="max-h-64 max-w-96 overflow-y-auto break-words whitespace-pre-line"
                      >
                        {previewText}
                      </TooltipPopup>
                    </Tooltip>
                    {age ? (
                      <span
                        className="shrink-0 text-2xs text-muted-foreground tabular-nums max-sm:hidden"
                        data-queued-age
                      >
                        {age}
                      </span>
                    ) : null}
                  </ComposerBanner.Content>
                  <ComposerBanner.Actions>
                    {item.automatic ? (
                      <span
                        className="shrink-0 text-2xs text-muted-foreground"
                        data-queued-automatic
                        title="An automatic delivery cannot be edited, steered, removed or moved."
                      >
                        Delivers after this turn
                      </span>
                    ) : item.steering ? (
                      <>
                        <span
                          className="shrink-0 text-2xs text-muted-foreground"
                          data-queued-steering
                        >
                          Steering…
                        </span>
                        <Tooltip>
                          <TooltipTrigger render={<span className="flex shrink-0" />}>
                            <ComposerBanner.Dismiss
                              aria-label="Remove queued message"
                              disabled={
                                item.runId === null ||
                                busyRunId !== null ||
                                actionsUnavailable !== null
                              }
                              onClick={() => {
                                if (item.runId !== null) void remove(item.runId);
                              }}
                            />
                          </TooltipTrigger>
                          <TooltipPopup>{actionsUnavailable ?? "Remove from queue"}</TooltipPopup>
                        </Tooltip>
                      </>
                    ) : isEditing ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label="Cancel editing queued message"
                        onClick={props.onCancelEdit}
                      >
                        Cancel
                      </Button>
                    ) : (
                      <>
                        {props.onEditQueuedRun ? (
                          <Tooltip>
                            <TooltipTrigger render={<span className="flex shrink-0" />}>
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                aria-label="Edit queued message"
                                disabled={
                                  item.runId === null ||
                                  busyRunId !== null ||
                                  actionsUnavailable !== null
                                }
                                onClick={() => {
                                  if (item.runId !== null && item.messageId !== null) {
                                    props.onEditQueuedRun?.({
                                      runId: item.runId,
                                      messageId: item.messageId,
                                      text: item.text,
                                      attachments: item.attachments,
                                    });
                                  }
                                }}
                              >
                                <PencilIcon />
                              </Button>
                            </TooltipTrigger>
                            <TooltipPopup>
                              {actionsUnavailable ??
                                `Edit in the composer${item.serverIndex === queued.length - 1 && props.editShortcutLabel ? ` (${props.editShortcutLabel})` : ""}`}
                            </TooltipPopup>
                          </Tooltip>
                        ) : null}
                        <Tooltip>
                          <TooltipTrigger render={<span className="flex shrink-0" />}>
                            <Button
                              size="xs"
                              variant="ghost-muted"
                              disabled={
                                item.runId === null || busyRunId !== null || rowSteerReason !== null
                              }
                              data-disabled-reason={rowSteerReason ?? undefined}
                              onClick={() => {
                                if (item.runId !== null) {
                                  void steer(item.runId);
                                }
                              }}
                            >
                              <CornerUpRightIcon />
                              Steer now
                            </Button>
                          </TooltipTrigger>
                          <TooltipPopup>
                            {rowSteerReason ??
                              `Send into the current turn now${item.serverIndex === 0 && props.steerShortcutLabel ? ` (${props.steerShortcutLabel})` : ""}`}
                          </TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger render={<span className="flex shrink-0" />}>
                            <ComposerBanner.Dismiss
                              aria-label="Remove queued message"
                              disabled={
                                item.runId === null ||
                                busyRunId !== null ||
                                actionsUnavailable !== null
                              }
                              onClick={() => {
                                if (item.runId !== null) void remove(item.runId);
                              }}
                            />
                          </TooltipTrigger>
                          <TooltipPopup>{actionsUnavailable ?? "Remove from queue"}</TooltipPopup>
                        </Tooltip>
                      </>
                    )}
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
              );
            })}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
