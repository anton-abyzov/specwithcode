/**
 * Threads in the coordinator's conversation: a chip where a message names one,
 * and a card under the message that started one. Both open the thread in the
 * project's right panel; a card also offers the next step its state calls for.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { PanelRightOpenIcon } from "lucide-react";

import {
  threadCardActions,
  threadCardPullRequest,
  threadCardStatus,
  type ThreadCardAction,
} from "../../studio/projectThreadCards";
import { useThreadCardGitStatus } from "../../studio/useThreadCardGitStatus";
import { PULL_REQUEST_STATE_PRESENTATION, PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Tip } from "./shell/Tip";
import { ThreadLinkChipButton } from "../ThreadLinkChip";
import { formatStudioThreadLink } from "../../studio/studioThreadLinks";

/** A thread named in a message: its icon, status dot and live title; opens in the right pane. */
export function ProjectThreadChip({
  thread,
  label,
  onOpen,
  className,
  copyMarkdown,
}: {
  thread: EnvironmentThreadShell;
  label: string;
  onOpen: () => void;
  /** Extra classes, such as the mark for a thread a card below announces. */
  className?: string | undefined;
  /** The canonical Markdown link, so copying the message keeps the link. */
  copyMarkdown?: string | undefined;
}) {
  return (
    <ThreadLinkChipButton
      thread={thread}
      label={label}
      onOpen={onOpen}
      className={className}
      copyMarkdown={copyMarkdown ?? formatStudioThreadLink(thread.id, thread.title.trim() || label)}
    />
  );
}

/**
 * A thread the coordinator started, as the project chat shows one: its status
 * dot, title and state, then quick actions. "View thread" is always there;
 * "Create PR" while its checkout has work no pull request carries; "View PR"
 * once it has one.
 */
export function ProjectThreadCard({
  thread,
  projectRoot,
  canChange,
  onOpen,
  onCreatePullRequest,
  onOpenPullRequest,
}: {
  thread: EnvironmentThreadShell;
  /** Where a thread without a worktree of its own works. */
  projectRoot: string | null;
  /** Source control can be changed on the thread's host, and it is connected. */
  canChange: boolean;
  onOpen: () => void;
  onCreatePullRequest: () => void;
  onOpenPullRequest: (url: string) => void;
}) {
  const status = threadCardStatus(thread);
  const git = useThreadCardGitStatus(thread, projectRoot);
  const pullRequest = threadCardPullRequest(thread, git);
  const actions = threadCardActions({ thread, git, pullRequest, canChange });
  const title = thread.title.trim() || "Untitled thread";
  return (
    <div
      className="sws-thread-card"
      role="group"
      aria-label={`Thread ${title}, ${status.label}`}
      data-thread-card={thread.id}
    >
      <span className="sws-thread-card-head">
        <span className="sws-dot" data-tone={status.tone} aria-hidden />
        {/* Cut to one line in a narrow panel; the full title shows on hover. */}
        <Tip label={title} side="top">
          <span className="sws-thread-card-title">{title}</span>
        </Tip>
        {status.tone === "idle" ? null : (
          <span className="sws-thread-card-status">{status.label}</span>
        )}
      </span>
      <span className="sws-thread-card-actions">
        {actions.map((action) => (
          <ThreadCardActionButton
            key={action.kind}
            action={action}
            title={title}
            onOpen={onOpen}
            onCreatePullRequest={onCreatePullRequest}
            onOpenPullRequest={onOpenPullRequest}
          />
        ))}
      </span>
    </div>
  );
}

function ThreadCardActionButton({
  action,
  title,
  onOpen,
  onCreatePullRequest,
  onOpenPullRequest,
}: {
  action: ThreadCardAction;
  title: string;
  onOpen: () => void;
  onCreatePullRequest: () => void;
  onOpenPullRequest: (url: string) => void;
}) {
  if (action.kind === "view_thread")
    return (
      <Tip label="Open this thread in the right panel">
        <button
          type="button"
          className="sws-thread-card-action"
          aria-label={`View thread ${title}`}
          onClick={onOpen}
        >
          <PanelRightOpenIcon aria-hidden />
          View thread
        </button>
      </Tip>
    );
  if (action.kind === "create_pr")
    return (
      <Tip label="Commit, push and open a pull request with this thread's changes">
        <button
          type="button"
          className="sws-thread-card-action"
          data-action="create-pr"
          aria-label={`Create a pull request for ${title}`}
          onClick={onCreatePullRequest}
        >
          <PullRequestGlyph.pullRequest aria-hidden />
          Create PR
        </button>
      </Tip>
    );
  const presentation = PULL_REQUEST_STATE_PRESENTATION[action.state];
  return (
    <Tip label={`Pull request #${action.number} · ${presentation.label}`}>
      <button
        type="button"
        className="sws-thread-card-action"
        data-action="view-pr"
        data-state={action.state}
        aria-label={`View pull request #${action.number}, ${presentation.label}`}
        onClick={() => onOpenPullRequest(action.url)}
      >
        <presentation.Icon aria-hidden className={presentation.toneClassName} />
        View PR
      </button>
    </Tip>
  );
}
