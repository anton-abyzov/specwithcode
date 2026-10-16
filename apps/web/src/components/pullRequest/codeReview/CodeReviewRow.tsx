import { memo, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { PullRequestChecksPopover } from "../PullRequestChecksPopover";
import { PullRequestRowGlyph } from "../PullRequestListRow";
import {
  PullRequestSpeedActions,
  type PullRequestSpeedActionResult,
} from "../PullRequestSpeedActions";
import type { PullRequestRowTarget } from "../PullRequestRow";
import type { EnvironmentPullRequestEntry } from "../pullRequestList.logic";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "../pullRequestLinkContextMenu";
import { PullRequestActorAvatar, PullRequestReviewDecisionGlyph } from "../pullRequestPresentation";

/** The repository's own name, without its owner: the owner is the same on nearly every row. */
function repositoryName(repository: string): string {
  return repository.slice(repository.lastIndexOf("/") + 1);
}

/**
 * One pull request in the review list: the title gets two full lines, because the title is how
 * a reader recognises their own work, and everything else folds into one quiet line under it.
 * The lifecycle glyph sits at the left edge so open, draft and merged read down the column.
 */
function CodeReviewRowImpl({
  entry,
  selected,
  statsKey,
  statsRef,
  onSelect,
  speedMode,
  onActed,
  closing = false,
  sweeping = false,
  onCloseSweepStart,
}: {
  entry: EnvironmentPullRequestEntry;
  selected: boolean;
  statsKey?: string;
  statsRef?: RefCallback<HTMLDivElement>;
  onSelect: (entry: PullRequestRowTarget) => void;
  speedMode: boolean;
  onActed: (result: PullRequestSpeedActionResult) => void;
  closing?: boolean;
  sweeping?: boolean;
  onCloseSweepStart?: (entry: EnvironmentPullRequestEntry, event: PointerEvent) => void;
}) {
  const author = entry.author;
  const signalCount =
    Number(entry.reviewDecision !== undefined) + Number(entry.checksState !== undefined);
  return (
    <div
      ref={statsRef}
      data-pull-request-stats-key={statsKey}
      data-pull-request-key={statsKey}
      data-code-review-row
      data-selected={selected ? "true" : undefined}
      className={cn(
        "group/cr-row relative flex items-stretch rounded-lg [content-visibility:auto] [contain-intrinsic-block-size:64px]",
        selected ? "bg-accent ring-1 ring-border" : "hover:bg-accent/55",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(entry)}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PullRequestRowGlyph
          state={entry.state}
          isDraft={entry.isDraft}
          mergeability={entry.mergeability}
          baseBranch={entry.baseBranch}
          className="mt-0.5"
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "line-clamp-2 text-sm leading-5 text-pretty sm:text-xs sm:leading-snug",
              selected ? "text-foreground" : "text-foreground/90",
              signalCount === 1 && "pr-5",
              signalCount === 2 && "pr-10",
            )}
          >
            {entry.title}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
            <PullRequestActorAvatar actor={author} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{author?.name || author?.login || "ghost"}</span>
            <span aria-hidden className="shrink-0 opacity-50">
              /
            </span>
            <span
              className="shrink-0 font-mono tabular-nums"
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void showPullRequestLinkContextMenu({
                  url: entry.url,
                  openLabel: openOnHostLabel(entry.provider),
                  position: { x: event.clientX, y: event.clientY },
                });
              }}
            >
              {repositoryName(entry.repository)}#{entry.number}
            </span>
            <span className="ml-auto shrink-0 tabular-nums">
              {formatRelativeTimeLabel(entry.updatedAt)}
            </span>
          </span>
        </span>
      </button>
      {/* Outside the select button: each opens its own popover and must not select the row. */}
      <span className="absolute top-2 right-2 flex items-center gap-1 text-2xs">
        {entry.reviewDecision === undefined ? null : (
          <PullRequestReviewDecisionGlyph decision={entry.reviewDecision} />
        )}
        {entry.checksState === undefined ? null : (
          <PullRequestChecksPopover
            checksState={entry.checksState}
            environmentId={entry.environmentId}
            reference={{
              projectId: entry.projectId,
              repository: entry.repository,
              number: entry.number,
            }}
          />
        )}
      </span>
      {entry.state !== "merged" && entry.provider === "github" ? (
        <PullRequestSpeedActions
          entry={entry}
          visible={speedMode}
          onActed={onActed}
          closing={closing}
          sweeping={sweeping}
          {...(onCloseSweepStart ? { onCloseSweepStart } : {})}
        />
      ) : null}
    </div>
  );
}

export const CodeReviewRow = memo(CodeReviewRowImpl);
