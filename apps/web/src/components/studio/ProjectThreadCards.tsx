/**
 * Threads in the coordinator's conversation: a chip where a message names one,
 * and a card under the message that started one. Both open the thread in the
 * project's right panel; a card also offers the next step its state calls for.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import {
  threadCardActions,
  threadCardPullRequest,
  threadCardStatus,
  type ThreadCardAction,
} from "../../studio/projectThreadCards";
import { useThreadCardGitStatus } from "../../studio/useThreadCardGitStatus";
import {
  useResolveConflictsRequestedFor,
  useResolveThreadConflicts,
} from "../../studio/useResolveThreadConflicts";
import { threadAttentionNote } from "../../studio/projectWorkspaceModel";
import { useHostOffline } from "../../studio/unreachableHosts";
import { PULL_REQUEST_STATE_PRESENTATION, PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Tip } from "./shell/Tip";
import { ThreadLinkChipButton } from "../ThreadLinkChip";
import { formatStudioThreadLink } from "../../studio/studioThreadLinks";
import { compactThreadPlan } from "../../studio/threadPlanProgress";
import { useThreadIncrementProgress } from "../../studio/useThreadIncrementProgress";
import { PlanProgressChip } from "./PlanProgressChip";

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
 * dot, title and state. The whole card opens the thread; beside it, "Resolve
 * conflicts" while its open pull request conflicts with the base branch, "Create
 * PR" while its checkout has work no pull request carries, "View PR" once it has one.
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
  const hostOffline = useHostOffline(thread.environmentId);
  const status = threadCardStatus(thread, hostOffline);
  // An unreachable host's last report is stale; the card says the host is offline instead.
  const blocker = hostOffline ? null : threadAttentionNote(thread);
  const git = useThreadCardGitStatus(thread, projectRoot);
  const pullRequest = threadCardPullRequest(thread, git);
  const resolveRequestedFor = useResolveConflictsRequestedFor({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const actions = threadCardActions({
    thread,
    git,
    pullRequest,
    canChange,
    working: status.tone === "working",
    resolveRequestedFor,
  });
  const title = thread.title.trim() || "Untitled thread";
  const incrementProgress = useThreadIncrementProgress({
    environmentId: thread.environmentId,
    projectId: thread.projectId,
    threadIds: [thread.id],
    activityKey: thread.updatedAt,
  });
  const plan = compactThreadPlan(incrementProgress.get(thread.id) ?? null, thread.planProgress);
  return (
    <div
      className="sws-thread-card"
      role="group"
      aria-label={`Thread ${title}, ${status.label}`}
      data-thread-card={thread.id}
    >
      {/* One button opens the thread; it stretches over the card, so a click anywhere opens it. */}
      <button
        type="button"
        className="sws-thread-card-head"
        aria-label={`Open thread ${title}, ${status.label}`}
        onClick={onOpen}
      >
        <span className="sws-dot" data-tone={status.tone} aria-hidden />
        {/* Cut to one line in a narrow panel; the full title shows on hover. */}
        <Tip label={title} side="top">
          <span className="sws-thread-card-title">{title}</span>
        </Tip>
        {status.tone === "idle" && !hostOffline ? null : (
          <span className="sws-thread-card-status">{status.label}</span>
        )}
        {plan ? <PlanProgressChip plan={plan} /> : null}
        <ChevronRightIcon className="sws-thread-card-open" aria-hidden />
      </button>
      {plan && plan.current ? (
        <span className="sws-thread-card-plan" data-thread-card-plan>
          <span className="sws-thread-card-plan-label">Now</span> {plan.current}
          {plan.next ? (
            <>
              {" "}
              <span className="sws-thread-card-plan-label">· Next</span> {plan.next}
            </>
          ) : null}
        </span>
      ) : null}
      {blocker ? (
        <span className="sws-thread-card-blocker" data-thread-blocker>
          {blocker}
        </span>
      ) : null}
      {actions.length > 0 ? (
        // Secondary actions sit above the card's open button and do their own thing.
        <span className="sws-thread-card-actions" onClick={(event) => event.stopPropagation()}>
          {actions.map((action) => (
            <ThreadCardActionButton
              key={action.kind}
              action={action}
              thread={thread}
              title={title}
              onCreatePullRequest={onCreatePullRequest}
              onOpenPullRequest={onOpenPullRequest}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}

function ThreadCardActionButton({
  action,
  thread,
  title,
  onCreatePullRequest,
  onOpenPullRequest,
}: {
  action: ThreadCardAction;
  thread: EnvironmentThreadShell;
  title: string;
  onCreatePullRequest: () => void;
  onOpenPullRequest: (url: string) => void;
}) {
  if (action.kind === "resolve_conflicts")
    return <ResolveConflictsButton action={action} thread={thread} title={title} />;
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

/** Sends the thread's own agent the request to merge the base in, resolve and push. */
function ResolveConflictsButton({
  action,
  thread,
  title,
}: {
  action: Extract<ThreadCardAction, { kind: "resolve_conflicts" }>;
  thread: EnvironmentThreadShell;
  title: string;
}) {
  const resolve = useResolveThreadConflicts();
  const [sending, setSending] = useState(false);
  const base = action.conflict.baseBranch;
  return (
    <Tip
      label={`#${action.number} conflicts with ${base}. Ask this thread to merge ${base} in, resolve the conflicts, re-run the checks and push.`}
    >
      <button
        type="button"
        className="sws-thread-card-action"
        data-action="resolve-conflicts"
        aria-label={`Resolve the conflicts on pull request #${action.number} in ${title}`}
        disabled={sending}
        onClick={() => {
          setSending(true);
          void resolve(thread, action).finally(() => setSending(false));
        }}
      >
        <PullRequestGlyph.conflicting aria-hidden />
        {sending ? "Sending..." : "Resolve conflicts"}
      </button>
    </Tip>
  );
}
