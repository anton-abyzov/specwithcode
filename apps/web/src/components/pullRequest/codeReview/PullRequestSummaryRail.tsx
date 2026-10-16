import type { PullRequestCheck } from "@specweave-studio/contracts";
import {
  CheckIcon,
  CircleDashedIcon,
  FileDiffIcon,
  HammerIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";
import {
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  PullRequestDiffStat,
} from "../pullRequestPresentation";
import type { PullRequestReadiness, ReadinessTone } from "./pullRequestReadiness.logic";

const TONE_TEXT: Record<ReadinessTone, string> = {
  done: "text-emerald-600 dark:text-emerald-300/90",
  pending: "text-amber-600 dark:text-amber-400/90",
  blocked: "text-destructive-foreground",
  neutral: "text-muted-foreground",
};

const TONE_DOT: Record<ReadinessTone, string> = {
  done: "bg-emerald-600/12 text-emerald-600 dark:bg-emerald-300/12 dark:text-emerald-300",
  pending: "bg-amber-500/14 text-amber-600 dark:text-amber-400",
  blocked: "bg-destructive/12 text-destructive-foreground",
  neutral: "bg-muted text-muted-foreground",
};

function ToneGlyph({ tone }: { tone: ReadinessTone }) {
  const Icon =
    tone === "done"
      ? CheckIcon
      : tone === "blocked"
        ? XIcon
        : tone === "pending"
          ? CircleDashedIcon
          : MinusIcon;
  return (
    <span
      className={cn(
        "relative z-1 flex size-4.5 shrink-0 items-center justify-center rounded-full",
        TONE_DOT[tone],
      )}
    >
      <Icon aria-hidden className="size-3 [stroke-width:2.75]" />
    </span>
  );
}

/**
 * The block a reviewer reads first: can this merge, and if not, which of the three things is in
 * the way. The three steps hang off one thread so they read as one question, answered top down.
 */
export function PullRequestReadinessBlock({ readiness }: { readiness: PullRequestReadiness }) {
  return (
    <section
      aria-label="Merge status"
      className="pb-4"
      data-pull-request-readiness={readiness.tone}
    >
      <p className={cn("text-sm font-semibold", TONE_TEXT[readiness.tone])}>{readiness.headline}</p>
      {readiness.items.length > 0 ? (
        <ol className="relative mt-2.5 space-y-2 before:absolute before:top-2 before:bottom-2 before:left-[0.53rem] before:w-px before:bg-border">
          {readiness.items.map((item) => (
            <li
              key={item.key}
              className="flex items-center gap-2.5 text-xs"
              data-readiness-item={item.key}
              data-readiness-tone={item.tone}
            >
              <ToneGlyph tone={item.tone} />
              <span
                className={item.tone === "blocked" ? "text-foreground" : "text-muted-foreground"}
              >
                {item.label}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/** One titled shelf of the rail, ruled off from the one above. */
export function RailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="border-t border-border/60 py-3">
      <div className="mb-1.5 flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function RailChanges({
  files,
  additions,
  deletions,
  onOpen,
}: {
  files: number;
  additions: number;
  deletions: number;
  onOpen?: (() => void) | undefined;
}) {
  const content = (
    <>
      <FileDiffIcon aria-hidden className="size-3.5 text-muted-foreground" />
      <span className="tabular-nums">
        {files.toLocaleString()} {files === 1 ? "file" : "files"}
      </span>
      <PullRequestDiffStat additions={additions} deletions={deletions} className="font-mono" />
    </>
  );
  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {content}
    </button>
  ) : (
    <div className="flex items-center gap-2 text-xs">{content}</div>
  );
}

const CHECKS_SHOWN = 6;
const FAILING = new Set(["failure", "cancelled"]);

/**
 * Failing first, then the rest in the host's order: the reader is here for the red ones. Each
 * failing check carries its own Fix, which starts a worker with that check's log.
 */
export function RailChecks({
  checks,
  stale,
  onRefresh,
  onOpen,
  onFix,
  fixLabel,
  pendingKey,
  keyOf,
}: {
  checks: ReadonlyArray<PullRequestCheck>;
  stale: boolean;
  onRefresh: () => void;
  onOpen: (url: string) => void;
  onFix?: ((check: PullRequestCheck) => void) | undefined;
  fixLabel: string;
  pendingKey: string | null | undefined;
  keyOf: (check: PullRequestCheck) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (stale) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Check details are out of date.</span>
        <Button size="xs" variant="ghost" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    );
  }
  if (checks.length === 0)
    return <p className="text-xs text-muted-foreground">No checks reported.</p>;
  const ordered = checks
    .map((check, index) => ({ check, index }))
    .toSorted(
      (left, right) =>
        Number(FAILING.has(right.check.status)) - Number(FAILING.has(left.check.status)) ||
        left.index - right.index,
    );
  const shown = expanded ? ordered : ordered.slice(0, CHECKS_SHOWN);
  return (
    <div className="-mx-1.5 flex flex-col">
      {shown.map(({ check, index }) => {
        const failing = FAILING.has(check.status);
        return (
          <div
            key={`${index}:${check.name}:${check.url ?? ""}`}
            className="group flex min-w-0 items-center gap-1 rounded-md hover:bg-accent/60"
            data-rail-check={check.status}
          >
            <button
              type="button"
              disabled={!check.url}
              onClick={() => check.url && onOpen(check.url)}
              aria-label={`${check.name}: ${pullRequestCheckStatusLabel(check)}`}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                check.url ? "cursor-pointer" : "cursor-default",
              )}
            >
              <PullRequestCheckStatusIcon status={check.status} />
              <span className="min-w-0 flex-1 truncate">{check.name}</span>
            </button>
            {onFix && failing ? (
              <Button
                size="xs"
                variant="outline"
                className="mr-1 shrink-0"
                disabled={pendingKey !== null && pendingKey !== undefined}
                onClick={() => onFix(check)}
              >
                <HammerIcon aria-hidden className="size-3" />
                {pendingKey === keyOf(check) ? "Starting..." : fixLabel}
              </Button>
            ) : null}
          </div>
        );
      })}
      {ordered.length > CHECKS_SHOWN ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? "Show fewer" : `Show ${ordered.length - CHECKS_SHOWN} more`}
        </button>
      ) : null}
    </div>
  );
}
