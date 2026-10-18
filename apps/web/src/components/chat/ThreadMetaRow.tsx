/**
 * One compact line above the plan card: where the thread came from when that
 * is not the default, the worktree it works in, how long its current turn has
 * run and the pull requests it opened or linked, as small chips.
 *
 * In a project only the coordinator starts threads, so a worker needs no
 * origin chip; only a thread another thread started reads "Subagent of". The
 * folder shows only for a worktree: the project's own folder says nothing new.
 * Every tooltip opens below its chip, so none covers its neighbours; three
 * pull requests show, the rest wait behind "+N", newest first.
 */
import type { ThreadPullRequestLink } from "@specweave-studio/contracts";
import type { RunAwaitingPerson } from "@specweave-studio/shared/orchestrationV2PendingBackgroundWork";
import { BotIcon, FolderOpenIcon, TimerIcon } from "lucide-react";
import { memo, useState, type ComponentType, type ReactNode } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { nowMinuteMs, useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const VISIBLE_PULL_REQUESTS = 3;

export function pullRequestPillState(link: ThreadPullRequestLink) {
  const snapshot = link.snapshot;
  if (snapshot === null) return PULL_REQUEST_STATE_PRESENTATION.open;
  return snapshot.state === "open" && snapshot.isDraft
    ? PULL_REQUEST_STATE_PRESENTATION.draft
    : PULL_REQUEST_STATE_PRESENTATION[snapshot.state];
}

/** Newest link first; a link without a timestamp keeps its place. */
export function orderPullRequestPills(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ThreadPullRequestLink[] {
  return [...links].toSorted((left, right) => right.linkedAt.localeCompare(left.linkedAt));
}

/** The folder's own name; the chip's tooltip keeps the whole path. */
export function folderBasename(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || path
  );
}

/** "45s" under a minute, then "31m", "3h 55m", "2d 4h". */
export function formatRunDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** Provenance worth a chip: a subagent's parent. A coordinator's worker has none. */
export type ThreadOrigin = {
  readonly kind: "subagent";
  readonly parentTitle: string;
  readonly onOpen: () => void;
};

export interface ThreadMetaRun {
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

const CHIP =
  "inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/60 lane-surface px-2 text-xs text-muted-foreground shadow-xs";
// lane-surface paints its fill as layers, so hover tints the layer rather than bg-*.
const CHIP_ACTION = "cursor-pointer hover:text-foreground hover:[--lane-tint:var(--accent)]";

function MetaChip(props: {
  readonly tip: string;
  readonly icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  readonly iconClassName?: string;
  readonly children: ReactNode;
  readonly onClick?: (() => void) | undefined;
  readonly href?: string;
  readonly meta: string;
}) {
  const Icon = props.icon;
  const content = (
    <>
      <Icon aria-hidden className={cn("size-3.5 shrink-0", props.iconClassName)} />
      {props.children}
    </>
  );
  const trigger = props.href ? (
    <a
      href={props.href}
      role="listitem"
      data-thread-meta={props.meta}
      className={cn(CHIP, CHIP_ACTION)}
      onClick={(event) => {
        event.preventDefault();
        props.onClick?.();
      }}
    >
      {content}
    </a>
  ) : props.onClick ? (
    <button
      type="button"
      role="listitem"
      data-thread-meta={props.meta}
      className={cn(CHIP, CHIP_ACTION)}
      onClick={props.onClick}
    >
      {content}
    </button>
  ) : (
    <span role="listitem" data-thread-meta={props.meta} className={CHIP}>
      {content}
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipPopup side="bottom" className="max-w-96 break-words">
        {props.tip}
      </TooltipPopup>
    </Tooltip>
  );
}

const AWAITING_PERSON_TIPS: Record<RunAwaitingPerson, string> = {
  approval: "your approval",
  answer: "your answer",
  "sign-in": "your sign-in",
};

/**
 * How long the latest turn ran, live while it runs. A turn blocked on the
 * person reads "Waiting on you", in the waiting tone, not "Running".
 */
function RunDurationChip({
  run,
  awaitingPerson,
}: {
  run: ThreadMetaRun & { readonly startedAt: string };
  awaitingPerson: RunAwaitingPerson | null;
}) {
  const nowMinute = useNowMinute();
  const running = run.completedAt === null;
  const end = running ? nowMinuteMs(nowMinute) : Date.parse(run.completedAt!);
  const duration = formatRunDuration(end - Date.parse(run.startedAt));
  const waiting = running && awaitingPerson !== null;
  return (
    <MetaChip
      meta="duration"
      icon={TimerIcon}
      {...(waiting ? { iconClassName: "text-warning-foreground" } : {})}
      tip={
        waiting
          ? `The current turn has run for ${duration} and waits on ${AWAITING_PERSON_TIPS[awaitingPerson]}.`
          : running
            ? `The current turn has run for ${duration}.`
            : `The last turn ran ${duration}.`
      }
    >
      <span
        className={cn("shrink-0 tabular-nums", waiting && "font-medium text-warning-foreground")}
        data-run-state={waiting ? "waiting" : running ? "running" : "done"}
      >
        {waiting ? `Waiting on you ${duration}` : running ? `Running ${duration}` : `Ran ${duration}`}
      </span>
    </MetaChip>
  );
}

export const ThreadMetaRow = memo(function ThreadMetaRow({
  origin,
  folder,
  run,
  awaitingPerson = null,
  pullRequests,
  onOpenPullRequest,
}: {
  origin: ThreadOrigin | null;
  folder: {
    readonly label: string;
    readonly path: string;
    readonly onOpen?: (() => void) | undefined;
  } | null;
  run: ThreadMetaRun | null;
  /** What the running turn waits on from the person, if anything. */
  awaitingPerson?: RunAwaitingPerson | null;
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  onOpenPullRequest: (url: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const { copyToClipboard } = useCopyToClipboard<{ path: string }>({
    target: "path",
    onCopy: ({ path }) =>
      toastManager.add({ type: "success", title: "Path copied", description: path }),
  });
  const startedRun =
    run !== null && run.startedAt !== null ? { ...run, startedAt: run.startedAt } : null;
  if (origin === null && folder === null && startedRun === null && pullRequests.length === 0) {
    return null;
  }
  const ordered = orderPullRequestPills(pullRequests);
  const shown = showAll ? ordered : ordered.slice(0, VISIBLE_PULL_REQUESTS);
  const hidden = ordered.length - shown.length;
  return (
    <div
      role="list"
      aria-label="Thread details"
      className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-1.5"
      data-thread-meta-row
    >
      {origin ? (
        <MetaChip
          meta="subagent"
          icon={BotIcon}
          tip={`Subagent of ${origin.parentTitle}. Open the parent thread.`}
          onClick={origin.onOpen}
        >
          <span className="shrink-0">Subagent of</span>
          <span className="min-w-0 max-w-48 truncate text-foreground/80">{origin.parentTitle}</span>
        </MetaChip>
      ) : null}
      {folder ? (
        <MetaChip
          meta="folder"
          icon={FolderOpenIcon}
          tip={
            folder.onOpen
              ? `${folder.path}. Click to open the folder.`
              : `${folder.path}. Click to copy the path.`
          }
          onClick={folder.onOpen ?? (() => copyToClipboard(folder.path, { path: folder.path }))}
        >
          <span className="min-w-0 max-w-28 truncate font-mono sm:max-w-48">
            {folderBasename(folder.path)}
          </span>
        </MetaChip>
      ) : null}
      {startedRun ? <RunDurationChip run={startedRun} awaitingPerson={awaitingPerson} /> : null}
      {shown.map((link) => {
        const state = pullRequestPillState(link);
        const branch = link.snapshot?.headBranch ?? link.repository;
        const title = link.snapshot?.title;
        return (
          <MetaChip
            key={`${link.host}/${link.repository}#${link.number}`}
            meta="pull-request"
            href={link.url}
            icon={state.Icon}
            iconClassName={state.toneClassName}
            tip={`${title ? `${title}. ` : ""}#${link.number} ${branch}, ${state.label.toLowerCase()}.`}
            onClick={() => onOpenPullRequest(link.url)}
          >
            <span className="shrink-0 font-mono text-foreground/80">#{link.number}</span>
            <span className={cn("shrink-0 font-medium", state.toneClassName)}>{state.label}</span>
          </MetaChip>
        );
      })}
      {hidden > 0 || showAll ? (
        <button
          type="button"
          className="h-6 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={showAll ? "Show fewer pull requests" : `Show ${hidden} more pull requests`}
          onClick={() => setShowAll((all) => !all)}
        >
          {showAll ? "Fewer" : `+${hidden}`}
        </button>
      ) : null}
    </div>
  );
});
