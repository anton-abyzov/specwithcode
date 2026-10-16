import { ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode, type RefObject } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

import { WorkspacePageHeader } from "../../WorkspacePageHeader";
import { Button } from "../../ui/button";
import { RefreshIcon } from "../../ui/refresh-icon";
import { PullRequestGlyph } from "../pullRequestIcons";

/**
 * The left column of Code Review: title and refresh, the search that also opens a pasted link,
 * the scope and filter controls, then the grouped list. Fixed width so the reading pane beside
 * it keeps a stable measure whichever pull request is open.
 */
export function CodeReviewListColumn({
  hidden,
  refreshing,
  onRefresh,
  searchInput,
  controls,
  scrollRef,
  children,
}: {
  /** On a narrow window the list steps aside while a pull request is open. */
  hidden: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  searchInput: ReactNode;
  controls: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label="Pull requests"
      className={cn(
        "@container/pr-list min-h-0 w-full flex-col border-border/60 bg-background md:flex md:w-[clamp(300px,30vw,380px)] md:shrink-0 md:border-r",
        hidden ? "hidden" : "flex",
      )}
    >
      <WorkspacePageHeader electron={isElectron} reserveNativeControls={false} className="gap-2">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">Code Review</h1>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh pull requests"
          onClick={onRefresh}
          disabled={refreshing}
          className="[-webkit-app-region:no-drag]"
        >
          <RefreshIcon size="md" refreshing={refreshing} />
        </Button>
      </WorkspacePageHeader>
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">
        {searchInput}
        <div className="flex min-w-0 items-center gap-1">{controls}</div>
      </div>
      <div
        ref={scrollRef}
        className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-6"
      >
        {children}
      </div>
    </aside>
  );
}

/**
 * One shelf of the list. Collapsible because a reviewer with forty authored pull requests still
 * wants "Needs my review" on screen; capped with "Show more" so no shelf buries the next one.
 */
export function CodeReviewGroupSection<Entry>({
  groupKey,
  label,
  entries,
  initialLimit,
  renderRow,
}: {
  groupKey: string;
  label: string;
  entries: ReadonlyArray<Entry>;
  initialLimit: number;
  renderRow: (entry: Entry) => ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [limit, setLimit] = useState(initialLimit);
  const shown = entries.slice(0, limit);
  const hiddenCount = entries.length - shown.length;
  const headingId = `code-review-group-${groupKey}`;
  return (
    <section aria-labelledby={headingId} className="mb-3" data-code-review-group={groupKey}>
      <h2 id={headingId} className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>{label}</span>
          <span className="tabular-nums opacity-70">{entries.length}</span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </button>
      </h2>
      {open ? (
        <div className="flex flex-col gap-0.5">
          {shown.map(renderRow)}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setLimit((value) => value + initialLimit * 2)}
              className="rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Show {Math.min(hiddenCount, initialLimit * 2)} more
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** The reading pane before anything is chosen: what to do, not how empty it is. */
export function CodeReviewEmptyDetail({ count }: { count: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <PullRequestGlyph.pullRequest aria-hidden className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">Select a pull request</p>
      <p className="max-w-72 text-xs text-muted-foreground">
        {count > 0
          ? "Pick one from the list to read its description, checks and changes. Paste a link in the search to open any other."
          : "Paste a pull request link in the search to open it here."}
      </p>
    </div>
  );
}
