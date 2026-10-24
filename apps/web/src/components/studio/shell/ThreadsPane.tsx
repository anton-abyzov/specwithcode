/**
 * The project's Threads pane: what is waiting on the person first, then what
 * is idle or done. Each row names who runs the thread and on which model. In
 * a SpecWeave project, threads that changed code without an increment carry
 * an "Unplanned" chip, and the header can narrow the list to them.
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
  ListChecksIcon,
  RotateCcwIcon,
  SearchIcon,
  SlidersVerticalIcon,
  WifiOffIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { PULL_REQUEST_STATE_PRESENTATION } from "../../pullRequest/pullRequestIcons";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { sessionStateSince } from "../../../studio/overviewModel";
import {
  threadAttentionNote,
  type ProjectThreadGroup,
} from "../../../studio/projectWorkspaceModel";
import { threadLocation } from "../../../studio/threadLocation";
import { useMachineNicknames } from "../../../studio/machineNickname";
import { withRunningSubagents } from "../../../studio/threadSubagents";
import { useEnvironments } from "../../../state/environments";
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
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { ThreadModelBadge, useProviderEntriesByEnvironment } from "./ModelBadge";
import { PlanProgressChip } from "../PlanProgressChip";
import { compactThreadPlan } from "../../../studio/threadPlanProgress";
import { useProjectThreadIncrementProgress } from "../../../studio/useThreadIncrementProgress";
import { ProjectPaneBar, type ProjectPaneBarProps } from "./ProjectPaneBar";
import { Tip } from "./Tip";
import { UnplannedThreadChip, UnplannedThreadsFilter } from "./UnplannedThreads";
import { useUnplannedNoticeShown } from "../../../studio/unplannedNotice";
import { HandoffRowAction, HandoffRowBadge } from "../../handoff/HandoffBadge";
import { useUnreachableHosts } from "../../../studio/unreachableHosts";

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
  /** Working subagents per `environmentId:threadId`; they roll up into their thread's row. */
  runningSubagents?: ReadonlyMap<string, number>;
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
  /** Stop or continue every thread at once; absent where the person cannot change threads. */
  bulk?:
    | {
        readonly running: number;
        readonly interrupted: number;
        readonly busy: boolean;
        readonly onStopAll: () => void;
        readonly onContinueAll: () => void;
      }
    | undefined;
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
  // With the project on one machine the composer already names it, so rows stay quiet.
  // Once it lives on several, every row names its own, so rows compare at a glance.
  const multiMachine =
    (props.machineLabels?.size ?? 0) > 1 ||
    Boolean(props.remoteWorkerCount) ||
    allThreads.some((thread) => thread.environmentId !== props.environmentId);
  const unreachable = useUnreachableHosts();
  const { environments } = useEnvironments();
  const nickname = useMachineNicknames();
  // A row names where a thread lives and runs ("M4", "M4 → Minis") by nickname; the
  // tooltip keeps the host label. Machines this device reaches name themselves, and
  // project members fill in the ones it does not.
  const machineNames = useMemo(() => {
    const labels = new Map<string, string>();
    for (const environment of environments)
      labels.set(environment.environmentId, environment.label);
    for (const [environmentId, label] of props.machineLabels ?? [])
      if (label !== environmentId && !labels.has(environmentId)) labels.set(environmentId, label);
    const name = (environmentId: string, fallbackLabel?: string | null) => {
      const label = labels.get(environmentId) ?? fallbackLabel;
      const resolved = nickname(environmentId, label);
      return label || resolved !== environmentId ? resolved : "another machine";
    };
    return {
      name,
      fullName: (environmentId: string, fallbackLabel?: string | null) =>
        labels.get(environmentId) ?? fallbackLabel ?? name(environmentId),
    };
  }, [environments, props.machineLabels, nickname]);
  const { progress: incrementProgress, unplanned } = useProjectThreadIncrementProgress(
    props.environmentId,
    allThreads,
  );
  const isUnplanned = (thread: EnvironmentThreadShell) =>
    thread.environmentId === props.environmentId && unplanned.has(thread.id);
  // Increments are recommended, not required: the notice, its filter and the
  // row chips go away for good once the person hides them for this project.
  const [unplannedNoticeShown, setUnplannedNoticeShown] = useUnplannedNoticeShown(
    props.environmentId,
    allThreads.find((thread) => thread.environmentId === props.environmentId)?.projectId,
  );
  const unplannedCount = unplannedNoticeShown ? allThreads.filter(isUnplanned).length : 0;
  const [unplannedOnly, setUnplannedOnly] = useState(false);
  // The filter lets go by itself once every unplanned thread is linked or cleared.
  const showUnplannedOnly = unplannedOnly && unplannedCount > 0;
  const groups = useMemo(() => {
    const built = buildThreadPaneGroups(
      allThreads,
      sortBy,
      query,
      props.runningSubagents,
      unreachable,
    );
    return showUnplannedOnly
      ? built.map((entry) => ({
          ...entry,
          threads: entry.threads.filter(
            (thread) => thread.environmentId === props.environmentId && unplanned.has(thread.id),
          ),
        }))
      : built;
  }, [
    allThreads,
    query,
    sortBy,
    props.runningSubagents,
    props.environmentId,
    unreachable,
    showUnplannedOnly,
    unplanned,
  ]);
  const matches = groups.reduce((sum, group) => sum + group.threads.length, 0);
  const searching = query.trim() !== "";
  // Searching or filtering shows every match: empty groups go, folded ones open.
  const narrowed = searching || showUnplannedOnly;
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
            {props.bulk ? (
              <Menu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <MenuTrigger
                        render={
                          <button
                            type="button"
                            className="sws-icon-button"
                            aria-label="Thread actions"
                            data-bulk-thread-actions
                          />
                        }
                      />
                    }
                  >
                    <ListChecksIcon aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">Stop or continue all threads</TooltipPopup>
                </Tooltip>
                <MenuPopup align="end" side="bottom" className="min-w-56">
                  <MenuItem
                    disabled={props.bulk.busy || props.bulk.running === 0}
                    onClick={props.bulk.onStopAll}
                  >
                    Stop all running ({props.bulk.running})
                  </MenuItem>
                  <MenuItem
                    disabled={props.bulk.busy || props.bulk.interrupted === 0}
                    onClick={props.bulk.onContinueAll}
                  >
                    Continue all interrupted ({props.bulk.interrupted})
                  </MenuItem>
                </MenuPopup>
              </Menu>
            ) : null}
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
                <MenuSeparator />
                <MenuGroup>
                  <MenuCheckboxItem
                    variant="switch"
                    checked={unplannedNoticeShown}
                    onCheckedChange={(checked) => setUnplannedNoticeShown(checked)}
                    data-unplanned-notice-toggle
                  >
                    Note threads without an increment
                  </MenuCheckboxItem>
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
              : threadsSummary(allThreads, props.remoteWorkerCount, unreachable)}
          </p>
          {unplannedCount > 0 && !offerStarters ? (
            <UnplannedThreadsFilter
              count={unplannedCount}
              pressed={showUnplannedOnly}
              onToggle={() => setUnplannedOnly((on) => !on)}
              onHide={() => {
                setUnplannedOnly(false);
                setUnplannedNoticeShown(false);
              }}
            />
          ) : null}
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
          if (narrowed && threads.length === 0) return null;
          const limit = narrowed ? threads.length : (limits[group] ?? THREAD_GROUP_PAGE);
          const rows = threads.slice(0, limit);
          const hidden = threads.length - rows.length;
          const slug = group.replace(/\s+/g, "-").toLowerCase();
          const headingId = `sws-threads-${slug}`;
          const listId = `sws-threads-${slug}-list`;
          // A search looks inside folded groups too; hiding a match would read as "not found".
          const isFolded = !narrowed && folded.includes(group);
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
                  aria-disabled={narrowed || undefined}
                  onClick={narrowed ? undefined : () => setGroupFolded(group, !isFolded)}
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
                    const subagentsWorking =
                      props.runningSubagents?.get(`${thread.environmentId}:${thread.id}`) ?? 0;
                    const hostOffline = unreachable.has(thread.environmentId);
                    const ownTone = threadTone(thread, hostOffline);
                    const tone = subagentsWorking > 0 && ownTone === "idle" ? "working" : ownTone;
                    const entry =
                      entriesByEnvironment
                        .get(thread.environmentId)
                        ?.get(
                          (thread.modelIdentity?.current ?? thread.modelSelection).instanceId,
                        ) ?? null;
                    const currentModel = thread.modelIdentity?.current ?? thread.modelSelection;
                    const label = modelLabel(entry, currentModel.instanceId, currentModel.model);
                    const settled = thread.settledOverride === "settled";
                    const archived = thread.archivedAt !== null;
                    const action = archived || settled ? "Reopen" : "Resolve";
                    // The group heading already says "Working" or "Waiting on you"; a row
                    // names only a more specific state, such as "Answer needed".
                    const statusWord = withRunningSubagents(
                      threadStatusWord(thread, hostOffline),
                      subagentsWorking,
                    );
                    const rowStatus = statusWord === group ? null : statusWord;
                    const location = threadLocation({
                      summary: thread.source,
                      servingEnvironmentId: thread.environmentId,
                      name: machineNames.name,
                      fullName: machineNames.fullName,
                      unreachable,
                    });
                    // A thread that runs away from home says so even in a one-machine project.
                    const machine = multiMachine || location.moved ? location : null;
                    const showDot = tone === "waiting" || tone === "working" || tone === "failed";
                    const pullRequest = threadPullRequest(thread);
                    const plan = compactThreadPlan(
                      thread.environmentId === props.environmentId
                        ? (incrementProgress.get(thread.id) ?? null)
                        : null,
                      thread.planProgress,
                    );
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
                                    const blocker = threadAttentionNote(thread);
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
                              <ThreadModelBadge
                                thread={thread}
                                entries={
                                  entriesByEnvironment.get(thread.environmentId) ?? new Map()
                                }
                              />
                              {plan ? <PlanProgressChip plan={plan} /> : null}
                              {unplannedNoticeShown && isUnplanned(thread) ? (
                                <UnplannedThreadChip />
                              ) : null}
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
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <span
                                        className="sws-thread-machine"
                                        data-execution={machine.state}
                                        data-moved={machine.moved || undefined}
                                      />
                                    }
                                  >
                                    {machine.state === "unknown" ? (
                                      <WifiOffIcon aria-hidden />
                                    ) : (
                                      <LaptopIcon aria-hidden />
                                    )}
                                    <span className="sr-only">{machine.description}</span>
                                    <span aria-hidden>{machine.label}</span>
                                  </TooltipTrigger>
                                  <TooltipPopup side="bottom">{machine.description}</TooltipPopup>
                                </Tooltip>
                              ) : null}
                              <HandoffRowBadge
                                environmentId={thread.environmentId}
                                threadId={thread.id}
                                localEnvironmentId={props.environmentId}
                                hostOffline={hostOffline}
                              />
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
                        <HandoffRowAction
                          environmentId={thread.environmentId}
                          threadId={thread.id}
                          localEnvironmentId={props.environmentId}
                          hostOffline={hostOffline}
                          canOperate={
                            props.canChangeThread ? props.canChangeThread(thread) : props.canChange
                          }
                          onOpenThread={(threadId, environmentId) =>
                            props.onOpen(threadId, environmentId)
                          }
                        />
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
              ) : !narrowed && threads.length > THREAD_GROUP_PAGE ? (
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
