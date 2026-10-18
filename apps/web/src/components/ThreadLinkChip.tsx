/**
 * A thread named in chat: the same chip on the project page and on a full-page
 * conversation. It shows a thread icon, the thread's status dot and its live
 * title, and opens the thread. A link to a thread that is gone, or that this
 * machine does not have, is a muted chip that says so instead of doing nothing.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { threadCardStatus } from "../studio/projectThreadCards";
import { useHostOffline } from "../studio/unreachableHosts";
import { Tip } from "./studio/shell/Tip";

function ChipFace(props: { title: string; tone?: string }) {
  return (
    <>
      <MessagesSquareIcon className="sws-thread-link-icon" aria-hidden />
      {props.tone === undefined ? null : (
        <span className="sws-dot" data-tone={props.tone} aria-hidden />
      )}
      <span className="sws-thread-link-title">{props.title}</span>
    </>
  );
}

function chipClass(className: string | undefined): string {
  return `sws-thread-link${className ? ` ${className}` : ""}`;
}

/** What the chip says: the thread's current title, else the label the message gave it. */
function liveTitle(thread: EnvironmentThreadShell, label: string): string {
  return thread.title.trim() || label.trim() || "Untitled thread";
}

/** A thread that opens in place, such as the project's right pane. */
export function ThreadLinkChipButton(props: {
  thread: EnvironmentThreadShell;
  label: string;
  onOpen: () => void;
  copyMarkdown?: string | undefined;
  className?: string | undefined;
}) {
  const status = threadCardStatus(props.thread, useHostOffline(props.thread.environmentId));
  const title = liveTitle(props.thread, props.label);
  return (
    <Tip label={`${title} · ${status.label}`} side="top">
      <button
        type="button"
        className={chipClass(props.className)}
        aria-label={`Open thread ${title}, ${status.label}`}
        data-thread-chip={props.thread.id}
        data-markdown-copy={props.copyMarkdown}
        onClick={props.onOpen}
      >
        <ChipFace title={title} tone={status.tone} />
      </button>
    </Tip>
  );
}

/**
 * A thread that opens through a link: inside a project it still opens in the
 * project's pane (`onPlainClick` returns true), anywhere else on its own page.
 * A modified click keeps the link's own behavior.
 */
export function ThreadLinkChipLink(props: {
  thread: EnvironmentThreadShell;
  label: string;
  onPlainClick: () => boolean;
  copyMarkdown?: string | undefined;
  className?: string | undefined;
}) {
  const status = threadCardStatus(props.thread, useHostOffline(props.thread.environmentId));
  const title = liveTitle(props.thread, props.label);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const modified =
      event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (!modified && props.onPlainClick()) event.preventDefault();
  };
  return (
    <Tip label={`${title} · ${status.label}`} side="top">
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId: props.thread.environmentId, threadId: props.thread.id }}
        className={chipClass(props.className)}
        aria-label={`Open thread ${title}, ${status.label}`}
        data-thread-chip={props.thread.id}
        data-markdown-copy={props.copyMarkdown}
        onClick={onClick}
      >
        <ChipFace title={title} tone={status.tone} />
      </Link>
    </Tip>
  );
}

/** A link to a thread that cannot open here, and why. */
export function DeadThreadLinkChip(props: {
  label: string;
  reason: "deleted" | "missing" | "elsewhere";
  copyMarkdown?: string | undefined;
}): ReactNode {
  const why =
    props.reason === "deleted"
      ? "Thread was deleted"
      : props.reason === "elsewhere"
        ? "Thread on another machine; connect it in Settings > Connections to open it"
        : "Thread not found on this machine";
  const title = props.label.trim() || "Thread";
  return (
    <Tip label={why} side="top">
      <span
        role="link"
        aria-disabled="true"
        tabIndex={0}
        className="sws-thread-link"
        aria-label={`${title}, ${why}`}
        data-thread-link-dead={props.reason}
        data-markdown-copy={props.copyMarkdown}
      >
        <ChipFace title={title} />
      </span>
    </Tip>
  );
}
