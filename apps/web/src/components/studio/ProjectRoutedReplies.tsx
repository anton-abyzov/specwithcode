import { useMemo } from "react";
import * as DateTime from "effect/DateTime";
import { MessageId, ThreadId } from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { useStructuralValue } from "../../hooks/useStructuralValue";
import { useThreadProjection, useThreadShell } from "../../state/entities";
import {
  routedRepliesForThread,
  routedReplyNotes,
} from "../../studio/projectCoordinatorMessageDisplay";
import type { ChatMessage, RoutedMessageNote } from "../../types";

const EMPTY: readonly ChatMessage[] = [];

/** Same notes in the same order: what the worker's timeline shows for them. */
export function sameRoutedMessages(
  kept: readonly ChatMessage[],
  next: readonly ChatMessage[],
): boolean {
  return (
    kept.length === next.length &&
    kept.every((message, index) => {
      const other = next[index]!;
      return (
        message.id === other.id &&
        message.text === other.text &&
        message.createdAt === other.createdAt &&
        message.routedNote?.kind === other.routedNote?.kind &&
        message.routedNote?.targetThreadId === other.routedNote?.targetThreadId
      );
    })
  );
}

/**
 * Messages the person typed in this worker that did not come back to it. Each
 * one goes to the coordinator first; one delivered back here is already in the
 * timeline as the person's own, so only the rest are returned, to sit in the
 * timeline where they were typed with a note on where they went.
 *
 * The coordinator's messages change on every streamed token. The list keeps its
 * identity until a note changes, so the worker's timeline is not rebuilt for them.
 */
export function useRoutedThreadMessages(
  project: { readonly id: string; readonly environmentId: EnvironmentThreadShell["environmentId"] },
  coordinatorId: ThreadId | null,
  thread: EnvironmentThreadShell,
): readonly ChatMessage[] {
  const coordinatorRef = useMemo(
    () => (coordinatorId ? scopeThreadRef(project.environmentId, coordinatorId) : null),
    [project.environmentId, coordinatorId],
  );
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const coordinatorMessages = useThreadProjection(coordinatorRef)?.projection.messages;
  const threadMessages = useThreadProjection(threadRef)?.projection.messages;
  const routed = useMemo(() => {
    if (!coordinatorId || !coordinatorMessages) return EMPTY;
    const replies = routedRepliesForThread(coordinatorMessages, project, thread);
    const notes = routedReplyNotes(replies, threadMessages ?? [], thread.id, coordinatorId);
    return notes.flatMap((note): ChatMessage[] => {
      const reply = replies.find((candidate) => candidate.id === note.id);
      if (!reply?.createdAt) return [];
      const at = DateTime.formatIso(reply.createdAt);
      return [
        {
          id: MessageId.make(note.id),
          role: "user",
          text: note.text,
          runId: null,
          streaming: false,
          createdBy: "user",
          createdAt: at,
          updatedAt: at,
          routedNote: {
            kind: note.kind,
            targetThreadId:
              note.targetThreadId === null ? null : ThreadId.make(note.targetThreadId),
          },
        },
      ];
    });
  }, [coordinatorId, coordinatorMessages, threadMessages, project, thread]);
  return useStructuralValue(routed, sameRoutedMessages);
}

/** One muted line under the person's message: where the coordinator sent it. */
export function RoutedMessageNoteLine({
  note,
  environmentId,
  onOpenThread,
  onOpenCoordinator,
}: {
  note: RoutedMessageNote;
  environmentId: EnvironmentThreadShell["environmentId"];
  onOpenThread: (threadId: ThreadId) => void;
  onOpenCoordinator: (() => void) | undefined;
}) {
  const target = useThreadShell(
    useMemo(
      () =>
        note.targetThreadId === null ? null : scopeThreadRef(environmentId, note.targetThreadId),
      [environmentId, note.targetThreadId],
    ),
  );
  const link = "rounded-sm underline-offset-2 hover:text-foreground hover:underline";
  return (
    <p className="me-1 text-2xs text-muted-foreground" data-routed-note={note.kind}>
      {note.kind === "sent" && note.targetThreadId !== null ? (
        <button type="button" className={link} onClick={() => onOpenThread(note.targetThreadId!)}>
          → Sent to {target?.title ?? "another thread"}
        </button>
      ) : note.kind === "pending" ? (
        "Sending via coordinator…"
      ) : (
        <button type="button" className={link} onClick={onOpenCoordinator}>
          → Answered in the coordinator
        </button>
      )}
    </p>
  );
}
