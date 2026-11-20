/**
 * Coordinator messages inside a project's conversation (1427 AC-18): the kept
 * messages with what their cards need, and the "Messages between coordinators"
 * filter that lists only them.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/models";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { CoordinatorMessageView, EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import type { TimestampFormat } from "@specweave-studio/contracts/settings";
import { useCallback, useMemo } from "react";

import { useTx } from "../../i18n";
import {
  coordinatorMessageRoots,
  coordinatorMessageRow,
  placeOutgoingMessages,
  rowMessages,
} from "../../studio/coordinatorMessages";
import { useCoordinatorMessages } from "../../studio/useCoordinatorMessages";
import { formatShortTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { threadRelationshipStatusLabel } from "../chat/ThreadRelationshipIcon";
import { Button } from "../ui/button";
import {
  CoordinatorMessageCard,
  type CoordinatorMessageCardProps,
  CoordinatorOutgoingMessages,
} from "./CoordinatorMessageCard";

export function useConversationCoordinatorMessages(
  project: EnvironmentProject,
  onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void,
  timestampFormat: TimestampFormat,
  threads: readonly EnvironmentThreadShell[] = [],
): {
  readonly linked: boolean;
  readonly byId: ReadonlyMap<string, CoordinatorMessageView>;
  readonly card: CoordinatorMessageCardProps;
} {
  const members = project.workspaceSettings?.logicalProject?.members;
  const { list, byId } = useCoordinatorMessages({
    environmentId: project.environmentId,
    projectId: project.id,
    enabled: members !== undefined,
  });
  const peerCoordinator = useCallback(
    (environmentId: string) =>
      members?.find((member) => member.environmentId === environmentId)?.coordinatorThreadId ??
      null,
    [members],
  );
  const renderText = useCallback(
    (text: string) => (
      <ChatMarkdown
        text={text}
        cwd={project.workspaceRoot}
        environmentId={project.environmentId}
        isStreaming={false}
      />
    ),
    [project.workspaceRoot, project.environmentId],
  );
  const formatTime = useCallback(
    (epochMs: number) => formatShortTimestamp(new Date(epochMs).toISOString(), timestampFormat),
    [timestampFormat],
  );
  // Keyed by text so the cards rebuild only when a status they could show changes.
  const statusKey = threads
    .map((thread) => `${thread.environmentId}:${thread.id}=${thread.runtime?.status ?? ""}`)
    .join("\n");
  const threadStatus = useMemo(() => {
    const statuses = new Map(
      statusKey
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const at = line.lastIndexOf("=");
          return [line.slice(0, at), line.slice(at + 1)] as const;
        }),
    );
    return (threadId: string, environmentId: string) => {
      const status = statuses.get(`${environmentId}:${threadId}`);
      return status ? threadRelationshipStatusLabel(status) : null;
    };
  }, [statusKey]);
  const card = useMemo<CoordinatorMessageCardProps>(
    // Every message has its own row in the conversation, so replies are not nested there.
    () => ({
      all: list,
      onOpenThread,
      peerCoordinator,
      renderText,
      formatTime,
      threadStatus,
      nestReplies: false,
    }),
    [list, onOpenThread, peerCoordinator, renderText, formatTime, threadStatus],
  );
  return { linked: members !== undefined, byId, card };
}

/**
 * Where the shown rows put messages: a posted message's card replaces its row
 * (one whose record is gone keeps its plain row), and each message this machine
 * sent sits under the reply of the turn that sent it.
 */
export function usePeerMessagePlacement(
  peer: {
    readonly byId: ReadonlyMap<string, CoordinatorMessageView>;
    readonly card: CoordinatorMessageCardProps;
  },
  rows: readonly {
    readonly message: { readonly id: string; readonly runId?: string | null | undefined };
  }[],
  firstShown: number,
) {
  const { byId } = peer;
  const { all } = peer.card;
  return useMemo(() => {
    const shown = rows.slice(firstShown).map(({ message }) => message);
    const cards = new Map<string, CoordinatorMessageView[]>();
    for (const message of shown) {
      const at = coordinatorMessageRow(message.id);
      const found = at === null ? [] : rowMessages(at, byId, all);
      if (found.length > 0) cards.set(message.id, found);
    }
    const outgoing = placeOutgoingMessages(
      all,
      shown.map((message) => ({ id: message.id, runId: message.runId ?? null })),
    );
    // Incoming messages no row stands for, shown or above the window (quiet, held or not
    // yet posted), so none is lost from the conversation.
    const carded = new Set(
      rows.flatMap(({ message }) => {
        const at = coordinatorMessageRow(message.id);
        return at === null ? [] : rowMessages(at, byId, all).map((each) => each.id);
      }),
    );
    const incomingRest = all
      .filter((message) => message.direction === "incoming" && !carded.has(message.id))
      .toSorted((a, b) => a.receivedAt - b.receivedAt);
    return { cards, outgoing, incomingRest };
  }, [rows, firstShown, byId, all]);
}

/** The filter's switch, shown once a message was sent or received here. */
export function CoordinatorMessagesFilterSwitch(props: {
  readonly card: CoordinatorMessageCardProps;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  const tx = useTx();
  if (props.card.all.length === 0 && !props.on) return null;
  return (
    <div className="sws-coordinator-messages-filter">
      <Button
        variant={props.on ? "secondary" : "outline"}
        size="sm"
        aria-pressed={props.on}
        onClick={() => props.onChange(!props.on)}
      >
        {props.on ? tx("Show the whole conversation") : tx("Messages between coordinators")}
      </Button>
    </div>
  );
}

/** Every message between coordinators, oldest first, each reply under its message. */
export function CoordinatorMessagesOnly(props: { readonly card: CoordinatorMessageCardProps }) {
  const tx = useTx();
  const roots = useMemo(() => coordinatorMessageRoots(props.card.all), [props.card.all]);
  const card = { ...props.card, nestReplies: true };
  if (roots.length === 0)
    return (
      <p className="project-muted" role="status">
        {tx("No messages between coordinators yet.")}
      </p>
    );
  return (
    <>
      {roots.map((message) =>
        message.direction === "incoming" ? (
          <CoordinatorMessageCard key={message.id} {...card} messages={[message]} />
        ) : (
          <CoordinatorOutgoingMessages key={message.id} {...card} messages={[message]} />
        ),
      )}
    </>
  );
}
