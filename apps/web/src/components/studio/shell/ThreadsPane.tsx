/**
 * The project's Threads pane: what is waiting on the person first, then what
 * is idle or done. Each row names who runs the thread and on which model.
 */
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { resolveThreadCurrentPullRequestLink } from "@specweave-studio/shared/threadPullRequests";
import * as Schema from "effect/Schema";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  LaptopIcon,
  RotateCcwIcon,
  SearchIcon,
  SlidersVerticalIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { PULL_REQUEST_STATE_PRESENTATION } from "../../pullRequest/pullRequestIcons";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { sessionStateSince } from "../../../studio/overviewModel";
import { threadBlocker, type ProjectThreadGroup } from "../../../studio/projectWorkspaceModel";
import {
  buildThreadPaneGroups,
  compactAge,
  modelLabel,
  nowFromMinute,
  THREAD_GROUP_PAGE,
  THREAD_GROUP_PAGE_STEP,
  THREAD_GROUPS_FOLDED_BY_DEFAULT,
  THREAD_SORT_LABELS,
  THREAD_SORTS,
  THREAD_TONE_LABELS,
  threadsSummary,
  threadStatusWord,
  threadTone,
  type ThreadSort,
} from "../../../studio/shellModel";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { ModelBadge, useProviderEntriesByEnvironment } from "./ModelBadge";
import { ProjectPaneBar, type ProjectPaneBarProps } from "./ProjectPaneBar";
import { Tip } from "./Tip";

const SORT_STORAGE_KEY = "studio:project-threads-sort:v1";
const SortSchema = Schema.Literals(THREAD_SORTS);
const FOLDED_STORAGE_KEY = "studio:project-threads-folded:v1";
const FoldedSchema = Schema.Array(Schema.String);
const EMPTY_GROUP_COPY: Partial<Record<ProjectThreadGroup, string>> = {
  "Waiting on you": "No decisions or replies requested.",
};

/** The one pull request a row has room for: the open one, else the latest. */
function threadPullRequest(thread: EnvironmentThreadShell) {
  const link = resolveThreadCurrentPullRequestLink(thread.pullRequests);
  if (!link) return null;
  const state =
    link.snapshot?.state === "open" && link.snapshot.isDraft
      ? "draft"
      : (link.snapshot?.state ?? "open");
  return { number: link.number, state, ...PULL_REQUEST_STATE_PRESENTATION[state] };
}

export function ThreadsPane({
  findRef,
  threads: allThreads,
  query,
  onQueryChange: setQuery,
  findOpen,
  onFindOpenChange,
  bar,
  ...props
}: {
  environmentId: EnvironmentId;
  threads: readonly EnvironmentThreadShell[];
  canChange: boolean;
  findRef: RefObject<HTMLInputElement | null>;
  onOpen: (id: ThreadId, environmentId?: EnvironmentId) => void;
  canChangeThread?: (thread: EnvironmentThreadShell) => boolean;
  machineLabels?: ReadonlyMap<string, string>;
  onToggleResolved: (thread: EnvironmentThreadShell) => void;
  /** Anything the project has to say above the list, such as a failed archive load. */
  notice?: ReactNode;
  /** Workers this project runs on other machines; they are not threads here. */
  remoteWorkerCount?: number;
  bar: ProjectPaneBarProps;
  /** First tasks to offer in place of the groups while the project has no threads. */
  starters?: ReactNode;
  /** The find field stays out of the way until asked for, as the sort menu does. */
  findOpen: boolean;
  onFindOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const entriesByEnvironment = useProviderEntriesByEnvironment();
  const now = nowFromMinute(useNowMinute());
  const [sortBy, setSortBy] = useLocalStorage<ThreadSort, ThreadSort>(
    SORT_STORAGE_KEY,
    "activity",
    SortSchema,
  );
  const [folded, setFolded] = useLocalStorage<readonly string[], readonly string[]>(
    FOLDED_STORAGE_KEY,
    THREAD_GROUPS_FOLDED_BY_DEFAULT,
    FoldedSchema,
  );
  const setGroupFolded = (group: ProjectThreadGroup, fold: boolean) =>
    setFolded((current) =>
      fold
        ? [...current.filter((name) => name !== group), group]
        : current.filter((name) => name !== group),
    );
  const findShown = findOpen || query !== "";
  const findButtonRef = useRef<HTMLButtonElement>(null);
  const [limits, setLimits] = useState<Partial<Record<ProjectThreadGroup, number>>>({});
  const groups = useMemo(
    () => buildThreadPaneGroups(allThreads, sortBy, query),
    [allThreads, query, sortBy],
  );
  const matches = groups.reduce((sum, group) => sum + group.threads.length, 0);
  const searching = query.trim() !== "";
  const offerStarters =
    allThreads.length === 0 && props.starters != null && !props.remoteWorkerCount;

  return (
    <>
      <ProjectPaneBar
        {...bar}
        tools={
          <>
            <Tip label="Find a thread (/)">
              <button
                ref={findButtonRef}
                type="button"
                className="sws-icon-button"
                aria-label="Find a thread"
                aria-keyshortcuts="/"
                aria-expanded={findShown}
                aria-controls={findShown ? "sws-threads-find" : undefined}
                onClick={() => {
                  if (findShown) {
                    setQuery("");
                    onFindOpenChange(false);
                  } else {
                    onFindOpenChange(true);
                    // The click has rendered by the next frame, so the field is there to take focus.
                    requestAnimationFrame(() => findRef.current?.focus());
                  }
                }}
              >
                <SearchIcon aria-hidden />
              </button>
            </Tip>
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      render={
                        <button
                          type="button"
                          className="sws-icon-button"
                          aria-label={`Sort threads, by ${THREAD_SORT_LABELS[sortBy].toLowerCase()}`}
                        />
                      }
                    />
                  }
                >
                  <SlidersVerticalIcon aria-hidden />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Sort threads</TooltipPopup>
              </Tooltip>
              <MenuPopup align="end" side="bottom" className="min-w-52">
                <MenuGroup>
                  <MenuGroupLabel>Sort by</MenuGroupLabel>
                  <MenuRadioGroup
                    value={sortBy}
                    onValueChange={(value) => setSortBy(value as ThreadSort)}
                  >
                    {THREAD_SORTS.map((value) => (
                      <MenuRadioItem key={value} value={value}>
                        <span className="flex items-center justify-between gap-6">
                          {THREAD_SORT_LABELS[value]}
                          <MenuRadioItemIndicator />
                        </span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
              </MenuPopup>
            </Menu>
          </>
        }
      />
      <div
        className="sws-threads-body"
        id="sws-pane-threads"
        role="tabpanel"
        aria-labelledby="sws-pane-tab-threads"
      >
        <header className="sws-threads-head">
          <h2>{offerStarters ? "Welcome." : "Welcome back."}</h2>
          <p role="status">
            {offerStarters
              ? "No threads yet. Pick a first task, or ask the coordinator for one."
              : threadsSummary(allThreads, props.remoteWorkerCount)}
          </p>
        </header>
        {props.notice}
        <div id="sws-threads-find">
          {findShown ? (
            <label className="sws-find">
              <SearchIcon aria-hidden />
              <span className="sr-only">Find a project thread</span>
              <input
                ref={findRef}
                type="search"
                aria-label="Find a project thread"
                placeholder="Find a thread"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.stopPropagation();
                  if (query !== "") setQuery("");
                  else {
                    // The field goes away; its button is where the keyboard belongs next.
                    findButtonRef.current?.focus();
                    onFindOpenChange(false);
                  }
                }}
              />
            </label>
          ) : null}
        </div>
        {searching && matches === 0 ? (
          <p className="sws-empty" role="status">
            No thread matches “{query.trim()}”.
          </p>
        ) : null}
        {offerStarters ? props.starters : null}
        {(offerStarters ? [] : groups).map(({ group, threads }) => {
          if (searching && threads.length === 0) return null;
          const limit = searching ? threads.length : (limits[group] ?? THREAD_GROUP_PAGE);
          const rows = threads.slice(0, limit);
          const hidden = threads.length - rows.length;
          const slug = group.replace(/\s+/g, "-").toLowerCase();
          const headingId = `sws-threads-${slug}`;
          const listId = `sws-threads-${slug}-list`;
          // A search looks inside folded groups too; hiding a match would read as "not found".
          const isFolded = !searching && folded.includes(group);
          return (
            <section
              className="sws-thread-group"
              key={group}
              aria-labelledby={headingId}
              data-group={group}
            >
              <h3 id={headingId}>
                <button
                  type="button"
                  className="sws-group-bar"
                  aria-expanded={!isFolded}
                  aria-controls={isFolded ? undefined : listId}
                  // A search opens every group on purpose; folding one then would change
                  // nothing on screen and still be remembered.
                  aria-disabled={searching || undefined}
                  onClick={searching ? undefined : () => setGroupFolded(group, !isFolded)}
                >
                  {isFolded ? <ChevronRightIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
                  {group}
                  <span className="sws-group-count">
                    {threads.length}
                    <span className="sr-only"> threads</span>
                  </span>
                </button>
              </h3>
              {isFolded ? null : rows.length === 0 ? (
                <p className="sws-empty" id={listId}>
                  {EMPTY_GROUP_COPY[group] ?? "Nothing here."}
                </p>
              ) : (
                <div className="sws-thread-list" id={listId}>
                  {rows.map((thread) => {
                    const tone = threadTone(thread);
                    const entry =
                      entriesByEnvironment
                        .get(thread.environmentId)
                        ?.get(thread.modelSelection.instanceId) ?? null;
                    const label = modelLabel(
                      entry,
                      thread.modelSelection.instanceId,
                      thread.modelSelection.model,
                    );
                    const settled = thread.settledOverride === "settled";
                    const archived = thread.archivedAt !== null;
                    const action = archived || settled ? "Reopen" : "Resolve";
                    // The group heading already says "Working" or "Waiting on you"; a row
                    // names only a more specific state, such as "Answer needed".
                    const statusWord = threadStatusWord(thread);
                    const rowStatus = statusWord === group ? null : statusWord;
                    // This project's own machine goes without saying; name only another one.
                    const machine =
                      thread.environmentId === props.environmentId
                        ? null
                        : (props.machineLabels?.get(thread.environmentId) ?? null);
                    const showDot = tone === "waiting" || tone === "working" || tone === "failed";
                    const pullRequest = threadPullRequest(thread);
                    return (
                      <article
                        className="sws-thread-row project-thread-card"
                        key={`${thread.environmentId}:${thread.id}`}
                        data-tone={tone}
                        data-thread-id={thread.id}
                        data-thread-environment={thread.environmentId}
                      >
                        <button
                          type="button"
                          className="sws-thread-open"
                          onClick={() => props.onOpen(thread.id, thread.environmentId)}
                        >
                          <span
                            className="sws-dot"
                            data-tone={showDot ? tone : "none"}
                            aria-hidden
                          />
                          <span className="sws-thread-text">
                            <strong>{thread.title || "Untitled thread"}</strong>
                            <span className="sws-thread-meta">
                              {rowStatus
                                ? (() => {
                                    const blocker = threadBlocker(thread);
                                    const word = (
                                      <span className="sws-thread-status" data-tone={tone}>
                                        {rowStatus}
                                      </span>
                                    );
                                    // Blocked says on hover what the report asks of the reader.
                                    return blocker ? (
                                      <Tip label={blocker} side="top">
                                        {word}
                                      </Tip>
                                    ) : (
                                      word
                                    );
                                  })()
                                : null}
                              <ModelBadge
                                entry={entry}
                                instanceId={thread.modelSelection.instanceId}
                                model={thread.modelSelection.model}
                              />
                              {pullRequest ? (
                                <span className="sws-thread-pr" data-state={pullRequest.state}>
                                  <pullRequest.Icon
                                    aria-hidden
                                    className={pullRequest.toneClassName}
                                  />
                                  <span className="sr-only">Pull request </span>#
                                  {pullRequest.number}
                                  <span className="sr-only">, {pullRequest.label}</span>
                                </span>
                              ) : null}
                              {machine ? (
                                <span className="sws-thread-machine">
                                  <LaptopIcon aria-hidden />
                                  {machine}
                                </span>
                              ) : null}
                              {thread.runtime?.lastError ? (
                                <span className="sws-thread-error">{thread.runtime.lastError}</span>
                              ) : null}
                            </span>
                          </span>
                          <span className="sr-only">
                            , {THREAD_TONE_LABELS[tone]}, {label.full}, updated
                          </span>
                          <time className="sws-thread-age" dateTime={sessionStateSince(thread)}>
                            {compactAge(sessionStateSince(thread), now)}
                          </time>
                        </button>
                        <Tip label={`${action} ${thread.title}`}>
                          <button
                            type="button"
                            className="sws-thread-action"
                            disabled={
                              props.canChangeThread
                                ? !props.canChangeThread(thread)
                                : !props.canChange
                            }
                            aria-label={action}
                            onClick={() => {
                              // Show where it went, so the same row can undo it.
                              if (action === "Resolve") setGroupFolded("Resolved", false);
                              props.onToggleResolved(thread);
                            }}
                          >
                            {settled || archived ? (
                              <RotateCcwIcon aria-hidden />
                            ) : (
                              <CheckIcon aria-hidden />
                            )}
                            <span>{action}</span>
                          </button>
                        </Tip>
                      </article>
                    );
                  })}
                </div>
              )}
              {isFolded ? null : hidden > 0 ? (
                <button
                  type="button"
                  className="sws-show-more"
                  onClick={() =>
                    setLimits((previous) => ({
                      ...previous,
                      [group]: limit + THREAD_GROUP_PAGE_STEP,
                    }))
                  }
                >
                  Show more
                  <span className="sr-only">
                    , {Math.min(hidden, THREAD_GROUP_PAGE_STEP)} of {hidden} hidden {group} threads
                  </span>
                </button>
              ) : !searching && threads.length > THREAD_GROUP_PAGE ? (
                <button
                  type="button"
                  className="sws-show-more"
                  onClick={() =>
                    setLimits((previous) => ({ ...previous, [group]: THREAD_GROUP_PAGE }))
                  }
                >
                  Show fewer
                </button>
              ) : null}
            </section>
          );
        })}
      </div>
    </>
  );
}
