/**
 * Messages between the coordinators of linked machines in the conversation
 * (1427 AC-18): an incoming message names the machine that sent it, in that
 * machine's color, never "a worker"; an outgoing one is a line under the turn
 * that sent it with where it stands. Pure: the conversation and the headless
 * fixture pass the messages in.
 */
import {
  isWebUrl,
  type CoordinatorMessageRef,
  type CoordinatorMessageView,
  type EnvironmentId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { ArrowUpRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useTx } from "../../i18n";
import {
  COORDINATOR_MESSAGE_KIND_LABELS,
  coordinatorMessageStartsOpen,
  coordinatorMessageStateLabel,
  repliesTo,
} from "../../studio/coordinatorMessages";
import { machineColorProps, useMachineIdentity } from "../../studio/machineIdentity";
import { useMachineNicknames } from "../../studio/machineNickname";

export type CoordinatorMessageCardProps = {
  /** Every kept message of this project, for replies. */
  readonly all: readonly CoordinatorMessageView[];
  /** Opens a thread on its machine; the peer's coordinator when given its id. */
  readonly onOpenThread?: ((threadId: ThreadId, environmentId: EnvironmentId) => void) | undefined;
  /** The peer coordinator's thread on its machine, when the link names one. */
  readonly peerCoordinator?: ((environmentId: string) => ThreadId | null) | undefined;
  /** Renders a message's text; plain paragraphs when not given. */
  readonly renderText?: ((text: string) => ReactNode) | undefined;
  readonly formatTime?: ((epochMs: number) => string) | undefined;
  /** A referenced thread's status now, when this machine sees it; else its status at send. */
  readonly threadStatus?: ((threadId: string, environmentId: string) => string | null) | undefined;
  /**
   * Show replies under the message they answer (the default). Off where every message has its
   * own row in time order, so a reply shows once.
   */
  readonly nestReplies?: boolean | undefined;
};

function MachineName({ environmentId }: { readonly environmentId: string }) {
  const identity = useMachineIdentity(environmentId);
  const nickname = useMachineNicknames();
  return (
    <span className="sws-coordinator-message-machine" {...machineColorProps(identity)}>
      {identity?.name ?? nickname(environmentId)}
    </span>
  );
}

const SLOT = "\u{1}";

/** A translated line with the machine's colored name where the phrase puts it. */
function withMachine(line: string, machine: ReactNode): ReactNode {
  return line
    .split(SLOT)
    .flatMap((part, index) => (index === 0 ? [part] : [machine, part]))
    .map((part, index) => <span key={index}>{part}</span>);
}

function plainText(text: string): ReactNode {
  return text
    .split(/\n{2,}/)
    .filter((part) => part.trim() !== "")
    .map((part, index) => <p key={index}>{part}</p>);
}

function RefChip({
  value,
  onOpenThread,
  threadStatus,
}: {
  readonly value: CoordinatorMessageRef;
} & Pick<CoordinatorMessageCardProps, "onOpenThread" | "threadStatus">) {
  const tx = useTx();
  const nickname = useMachineNicknames();
  if (value.kind === "pull_request") {
    const label = (
      <>
        {tx("Pull request")} · {value.title}
      </>
    );
    // A peer's message is untrusted: only an http(s) link becomes clickable.
    return isWebUrl(value.url) ? (
      <a className="sws-coordinator-message-ref" href={value.url} target="_blank" rel="noreferrer">
        {label}
      </a>
    ) : (
      <span className="sws-coordinator-message-ref">{label}</span>
    );
  }
  const machine = nickname(value.environmentId);
  if (value.kind === "thread") {
    const live = threadStatus?.(value.threadId, value.environmentId) ?? null;
    const status =
      live ??
      (value.statusAtSend ? tx("{status} when sent", { status: value.statusAtSend }) : null);
    const label = (
      <>
        {tx("Thread on {machine}", { machine })} · {value.title}
        {status ? (
          <span data-thread-status={live === null ? "at-send" : "live"}> · {status}</span>
        ) : null}
      </>
    );
    return onOpenThread ? (
      <button
        type="button"
        className="sws-coordinator-message-ref"
        onClick={() => onOpenThread(value.threadId, value.environmentId)}
      >
        {label}
      </button>
    ) : (
      <span className="sws-coordinator-message-ref">{label}</span>
    );
  }
  return (
    <span className="sws-coordinator-message-ref" title={value.path}>
      {tx(value.kind === "report" ? "Report on {machine}" : "File on {machine}", { machine })} ·{" "}
      {value.path.split("/").at(-1)}
    </span>
  );
}

function StateLabel({ message }: { readonly message: CoordinatorMessageView }) {
  const tx = useTx();
  const nickname = useMachineNicknames();
  const label = coordinatorMessageStateLabel(message, nickname(message.peerEnvironmentId));
  if (label === null) return null;
  return (
    <span className="sws-coordinator-message-state" data-tone={label.tone}>
      {tx(label.text, label.values ?? {})}
    </span>
  );
}

function OpenPeer({
  message,
  onOpenThread,
  peerCoordinator,
}: {
  readonly message: CoordinatorMessageView;
} & Pick<CoordinatorMessageCardProps, "onOpenThread" | "peerCoordinator">) {
  const tx = useTx();
  const nickname = useMachineNicknames();
  const threadId = peerCoordinator?.(message.peerEnvironmentId) ?? null;
  if (threadId === null || !onOpenThread) return null;
  return (
    <button
      type="button"
      className="sws-coordinator-message-open"
      onClick={() => onOpenThread(threadId, message.peerEnvironmentId as EnvironmentId)}
    >
      {tx("Open {machine}'s coordinator", { machine: nickname(message.peerEnvironmentId) })}
      <ArrowUpRightIcon aria-hidden className="size-3" />
    </button>
  );
}

/** One incoming message: header, then its subject, text, step, refs and replies. */
function IncomingMessage(
  props: CoordinatorMessageCardProps & { readonly message: CoordinatorMessageView },
) {
  const { message, all, renderText = plainText, formatTime } = props;
  const tx = useTx();
  const nickname = useMachineNicknames();
  const machine = <MachineName environmentId={message.peerEnvironmentId} />;
  const replies = props.nestReplies === false ? [] : repliesTo(message, all);
  return (
    <details
      className="sws-coordinator-message"
      data-coordinator-message={message.kind}
      data-direction="incoming"
      open={coordinatorMessageStartsOpen(message)}
    >
      <summary>
        <span className="sws-coordinator-message-from">
          {withMachine(tx("From {machine}'s coordinator", { machine: SLOT }), machine)}
        </span>
        <span className="sws-coordinator-message-kind">
          {tx(COORDINATOR_MESSAGE_KIND_LABELS[message.kind])}
        </span>
        <strong className="sws-coordinator-message-subject">{message.subject}</strong>
        {formatTime ? (
          <time dateTime={new Date(message.receivedAt).toISOString()}>
            {formatTime(message.receivedAt)}
          </time>
        ) : null}
        <StateLabel message={message} />
      </summary>
      <div className="sws-coordinator-message-body">
        {message.text.trim() !== "" ? renderText(message.text) : null}
        {message.userStep ? (
          <p className="sws-coordinator-message-step" role="note">
            {tx("On {machine}: {step}", {
              machine: nickname(message.userStep.environmentId),
              step: message.userStep.text,
            })}
          </p>
        ) : null}
        {message.refs.length > 0 ? (
          <div className="sws-coordinator-message-refs">
            {message.refs.map((ref, index) => (
              <RefChip
                key={index}
                value={ref}
                onOpenThread={props.onOpenThread}
                threadStatus={props.threadStatus}
              />
            ))}
          </div>
        ) : null}
        <p className="sws-coordinator-message-foot">
          {message.count > 1 ? (
            <span data-coordinator-message-count={message.count}>
              {tx("Sent {count} times", { count: String(message.count) })}
            </span>
          ) : null}
          <OpenPeer {...props} />
        </p>
        {replies.map((reply) => (
          <OutgoingMessage key={reply.id} {...props} message={reply} nested />
        ))}
      </div>
    </details>
  );
}

/** One line: to whom, the kind, the subject and where it stands; replies under it. */
function OutgoingMessage(
  props: CoordinatorMessageCardProps & {
    readonly message: CoordinatorMessageView;
    readonly nested?: boolean;
  },
) {
  const { message, all } = props;
  const tx = useTx();
  const machine = <MachineName environmentId={message.peerEnvironmentId} />;
  const replies = props.nested || props.nestReplies === false ? [] : repliesTo(message, all);
  return (
    <div
      className="sws-coordinator-message-line"
      data-coordinator-message={message.kind}
      data-direction={message.direction}
    >
      <p>
        <span className="sws-coordinator-message-from">
          {withMachine(
            tx(
              message.direction === "outgoing"
                ? "To {machine}'s coordinator"
                : "From {machine}'s coordinator",
              { machine: SLOT },
            ),
            machine,
          )}
        </span>
        <span className="sws-coordinator-message-kind">
          {tx(COORDINATOR_MESSAGE_KIND_LABELS[message.kind])}
        </span>
        <span className="sws-coordinator-message-subject">{message.subject}</span>
        <StateLabel message={message} />
        {props.nested ? null : <OpenPeer {...props} />}
      </p>
      {replies.length > 0 ? (
        <div className="sws-coordinator-message-replies">
          {replies.map((reply) => (
            <IncomingMessage key={reply.id} {...props} message={reply} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The messages one conversation row stands for: one, or a digest's several. */
export function CoordinatorMessageCard(
  props: CoordinatorMessageCardProps & { readonly messages: readonly CoordinatorMessageView[] },
) {
  const tx = useTx();
  const { messages } = props;
  if (messages.length === 0) return null;
  return (
    <div
      className="sws-coordinator-messages"
      data-coordinator-messages=""
      role="group"
      aria-label={tx("Messages between coordinators")}
    >
      {messages.map((message) =>
        message.direction === "incoming" ? (
          <IncomingMessage key={message.id} {...props} message={message} />
        ) : (
          <OutgoingMessage key={message.id} {...props} message={message} />
        ),
      )}
    </div>
  );
}

/** Outgoing messages a turn sent, as lines under its reply. */
export function CoordinatorOutgoingMessages(
  props: CoordinatorMessageCardProps & { readonly messages: readonly CoordinatorMessageView[] },
) {
  if (props.messages.length === 0) return null;
  return (
    <div className="sws-coordinator-messages" data-coordinator-outgoing="">
      {props.messages.map((message) => (
        <OutgoingMessage key={message.id} {...props} message={message} />
      ))}
    </div>
  );
}
