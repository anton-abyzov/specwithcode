import type { ProjectAttention } from "@specweave-studio/client-runtime/state/projectAttention";
/**
 * The project's Threads pane: what is waiting on the person first, then what
 * is idle or done. Each row names who runs the thread and on which model. In
 * a SpecWeave project, threads that changed code without an increment carry
 * a muted No increment glyph, and the header can narrow the list to them.
 */
import type { DesignSummary, EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { scopeThreadRef, scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import type { AttentionReason } from "@specweave-studio/shared/projectAttention";
import { resolveThreadCurrentPullRequestLink } from "@specweave-studio/shared/threadPullRequests";
import { useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  LaptopIcon,
  ListChecksIcon,
  ListFilterIcon,
  PaletteIcon,
  RotateCcwIcon,
  SearchIcon,
  SlidersVerticalIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { PULL_REQUEST_STATE_PRESENTATION } from "../../pullRequest/pullRequestIcons";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { sessionStateSince } from "../../../studio/overviewModel";
import {
  threadAttentionNote,
  type ProjectThreadGroup,
} from "../../../studio/projectWorkspaceModel";
import { paneWords, withPinnedTopics } from "../../../studio/assistantTerms";
import { threadLocation } from "../../../studio/threadLocation";
import {
  machineColumnCh,
  machineColumnLabel,
  machineFilterOptions,
} from "../../../studio/threadMachineFilter";
import {
  agentChoices,
  machineChoices,
  threadMatchesPaneFilters,
  type ThreadPaneFacts,
} from "../../../studio/threadPaneFilters";
import { useMachineNicknames } from "../../../studio/machineNickname";
import { useMachineIdentities } from "../../../studio/machineIdentity";
import { withRunningSubagents } from "../../../studio/threadSubagents";
import { useEnvironments, usePrimaryEnvironmentId } from "../../../state/environments";
import {
  buildThreadPaneGroups,
  threadToneShowsDot,
  compactAge,
  modelLabel,
  nowFromMinute,
  THREAD_GROUP_PAGE,
  THREAD_GROUP_PAGE_STEP,
  type ThreadPaneGroup,
  THREAD_GROUPS_FOLDED_BY_DEFAULT,
  THREAD_SORT_LABELS,
  THREAD_SORTS,
  THREAD_TONE_LABELS,
  attentionActionWord,
  threadAttentionWord,
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
import { useSidebarThreadPlans } from "../../sidebar/SidebarPlanProgress";
import { ProjectPaneBar, type ProjectPaneBarProps } from "./ProjectPaneBar";
import { Tip } from "./Tip";
import { UnplannedThreadChip, UnplannedThreadsFilter } from "./UnplannedThreads";
import { useUnplannedNotice } from "../../../studio/unplannedNotice";
import { HandoffRowAction, HandoffRowBadge } from "../../handoff/HandoffBadge";
import { designRoute } from "../../design/gallery/designLinks";
import { useUnreachableHosts } from "../../../studio/unreachableHosts";

const SORT_STORAGE_KEY = "studio:project-threads-sort:v1";
const SortSchema = Schema.Literals(THREAD_SORTS);
const FOLDED_STORAGE_KEY = "studio:project-threads-folded:v1";
const FoldedSchema = Schema.Array(Schema.String);
// The machine each project's list is narrowed to, by `environmentId:projectId`.
const MACHINE_FILTER_STORAGE_KEY = "studio:project-threads-machine:v1";
const MachineFilterSchema = Schema.Record(Schema.String, Schema.String);
// The agent and open pull request filters, by the same key.
const PANE_FILTERS_STORAGE_KEY = "studio:project-threads-filters:v1";
const PaneFiltersSchema = Schema.Record(
  Schema.String,
  Schema.Struct({ agent: Schema.NullOr(Schema.String), openPullRequest: Schema.Boolean }),
);
type StoredPaneFilters = typeof PaneFiltersSchema.Type;
const NO_PANE_FILTERS = { agent: null, openPullRequest: false } as const;

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
  /** The project whose list this is; its machine filter is remembered under it. */
  projectId: string;
  /** Every host has answered, so a machine missing from the list is really gone. */
  threadsLoaded?: boolean;
  threads: readonly EnvironmentThreadShell[];
  /** Working subagents per `environmentId:threadId`; they roll up into their thread's row. */
  runningSubagents?: ReadonlyMap<string, number>;
  attention?: ProjectAttention;
  /** A check's project: its summary counts nothing as waiting on the person. */
  unattended?: boolean | undefined;
  /** Opens where an attention action is answered, such as the coordinator's own page. */
  onOpenAction?: (id: ThreadId, environmentId: EnvironmentId, reason: AttentionReason) => void;
  canChange: boolean;
  findRef: RefObject<HTMLInputElement | null>;
  onOpen: (id: ThreadId, environmentId?: EnvironmentId) => void;
  canChangeThread?: (thread: EnvironmentThreadShell) => boolean;
  machineLabels?: ReadonlyMap<string, string>;
  onToggleResolved: (thread: EnvironmentThreadShell) => void;
  /**
   * Anything the project has to say above the list, such as a failed archive load. It
   * receives the machine filter, so per-machine notices such as remote workers follow it.
   */
  renderNotice?: (scope: { readonly machineFilter: string | null }) => ReactNode;
  /** The project's artifacts shelf, above the threads. */
  shelf?: ReactNode;
  /** Workers this project runs on other machines; they are not threads here. */
  remoteWorkerCount?: number;
  /** The project's design each agent thread is bound to, by thread id. */
  designsByThread?: ReadonlyMap<string, DesignSummary>;
  bar: ProjectPaneBarProps;
  /** The personal assistant says topics, and leads with its pinned ones. */
  personal?: boolean;
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
  const router = useRouter();
  const say = paneWords(props.personal);
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
  const setGroupFolded = (group: ThreadPaneGroup["group"], fold: boolean) =>
    setFolded((current) =>
      fold
        ? [...current.filter((name) => name !== group), group]
        : current.filter((name) => name !== group),
    );
  const findShown = findOpen || query !== "";
  const findButtonRef = useRef<HTMLButtonElement>(null);
  const [limits, setLimits] = useState<Partial<Record<ThreadPaneGroup["group"], number>>>({});
  // With the project on one machine the composer already names it, so rows stay quiet.
  // Once it lives on several, every row names its own, so rows compare at a glance.
  const multiMachine =
    (props.machineLabels?.size ?? 0) > 1 ||
    Boolean(props.remoteWorkerCount) ||
    allThreads.some((thread) => thread.environmentId !== props.environmentId);
  const unreachable = useUnreachableHosts();
  const { environments } = useEnvironments();
  const nickname = useMachineNicknames();
  const machineIdentity = useMachineIdentities();
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
  const locate = (thread: EnvironmentThreadShell) =>
    threadLocation({
      summary: thread.source,
      servingEnvironmentId: thread.environmentId,
      name: machineNames.name,
      fullName: machineNames.fullName,
      unreachable,
    });
  // Once threads run on several machines, the list can be narrowed to one of them.
  const machineOptions = useMemo(
    () =>
      machineFilterOptions(allThreads, (thread) => {
        const location = threadLocation({
          summary: thread.source,
          servingEnvironmentId: thread.environmentId,
          name: machineNames.name,
          fullName: machineNames.fullName,
          unreachable,
        });
        return {
          machineId: location.executionMachineId,
          label: location.label.split(" → ").at(-1)!,
        };
      }),
    [allThreads, machineNames, unreachable],
  );
  const filterKey = `${props.environmentId}:${props.projectId}`;
  const [machineFilters, setMachineFilters] = useLocalStorage<
    Readonly<Record<string, string>>,
    Readonly<Record<string, string>>
  >(MACHINE_FILTER_STORAGE_KEY, {}, MachineFilterSchema);
  const storedFilter = machineFilters[filterKey] ?? null;
  // With one machine left there is no row to undo it from, and nothing to narrow.
  const machineFilter =
    machineOptions.length > 1 && machineOptions.some((option) => option.machineId === storedFilter)
      ? storedFilter
      : null;
  const setMachineFilter = (machineId: string | null) =>
    setMachineFilters((current) => {
      const { [filterKey]: _dropped, ...rest } = current;
      return machineId === null ? rest : { ...rest, [filterKey]: machineId };
    });
  // Once every host has answered, a machine with no thread left lets the filter go for
  // good, so a thread that comes back there later is not hidden unasked.
  const staleFilter = storedFilter !== null && machineFilter === null && props.threadsLoaded;
  useEffect(() => {
    if (!staleFilter) return;
    setMachineFilters((current) => {
      const { [filterKey]: _dropped, ...rest } = current;
      return rest;
    });
  }, [staleFilter, filterKey]);
  const [paneFilters, setPaneFilters] = useLocalStorage<StoredPaneFilters, StoredPaneFilters>(
    PANE_FILTERS_STORAGE_KEY,
    {},
    PaneFiltersSchema,
  );
  const storedPaneFilters = paneFilters[filterKey] ?? NO_PANE_FILTERS;
  const updatePaneFilters = (change: Partial<(typeof paneFilters)[string]>) =>
    setPaneFilters((current) => {
      const { [filterKey]: previous = NO_PANE_FILTERS, ...rest } = current;
      const next = { ...previous, ...change };
      return next.agent === null && !next.openPullRequest ? rest : { ...rest, [filterKey]: next };
    });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // What the filters read about a thread, by the key its row uses.
  const threadFacts = useMemo(() => {
    const facts = new Map<string, ThreadPaneFacts>();
    for (const thread of allThreads) {
      const current = thread.modelIdentity?.current ?? thread.modelSelection;
      const pullRequest = threadPullRequest(thread);
      facts.set(`${thread.environmentId}:${thread.id}`, {
        machine: threadLocation({
          summary: thread.source,
          servingEnvironmentId: thread.environmentId,
          name: machineNames.name,
          unreachable,
        }).executionMachineId,
        agent: modelLabel(
          entriesByEnvironment.get(thread.environmentId)?.get(current.instanceId) ?? null,
          current.instanceId,
          current.model,
        ).provider,
        openPullRequest: pullRequest?.state === "open" || pullRequest?.state === "draft",
        open: thread.archivedAt === null && thread.settledOverride !== "settled",
      });
    }
    return facts;
  }, [allThreads, machineNames, unreachable, entriesByEnvironment]);
  const allFacts = useMemo(() => [...threadFacts.values()], [threadFacts]);
  const anyOpenPullRequest = allFacts.some((facts) => facts.openPullRequest);
  // An agent no thread uses any more lets go, as a machine does, so nothing stays hidden by it.
  const agentKnown = allFacts.some((facts) => facts.agent === storedPaneFilters.agent);
  const agentFilter = agentKnown ? storedPaneFilters.agent : null;
  // Names need each host's provider list too; before it arrives a thread can read differently.
  const agentNamesLoaded = allThreads.every((thread) =>
    entriesByEnvironment.has(thread.environmentId),
  );
  const staleAgent =
    storedPaneFilters.agent !== null &&
    agentFilter === null &&
    props.threadsLoaded &&
    agentNamesLoaded;
  useEffect(() => {
    if (!staleAgent) return;
    updatePaneFilters({ agent: null });
  }, [staleAgent, filterKey]);
  const openPullRequestOnly = storedPaneFilters.openPullRequest;
  const filters = {
    machine: machineFilter,
    agent: agentFilter,
    openPullRequest: openPullRequestOnly,
  };
  const machineRow = machineChoices(machineOptions, allFacts, filters, primaryEnvironmentId);
  const agentRow = agentChoices(allFacts, filters);
  const offerAgents = agentRow.length > 1 || agentFilter !== null;
  const offerPullRequests = anyOpenPullRequest || openPullRequestOnly;
  const activeMenuFilters = (agentFilter === null ? 0 : 1) + (openPullRequestOnly ? 1 : 0);
  const anyFilter = machineFilter !== null || activeMenuFilters > 0;
  const clearFilters = () => {
    setMachineFilter(null);
    updatePaneFilters(NO_PANE_FILTERS);
  };
  // Sized by what the rows show, so "→ Minis" fits as well as "M4".
  const machineCh = machineColumnCh(
    allThreads.flatMap((thread) => {
      const location = locate(thread);
      return multiMachine || location.moved ? [machineColumnLabel(location)] : [];
    }),
  );
  const {
    progress: incrementProgress,
    unplanned,
    answered: unplannedAnswered,
  } = useProjectThreadIncrementProgress(props.environmentId, allThreads);
  const isUnplanned = (thread: EnvironmentThreadShell) =>
    thread.environmentId === props.environmentId && unplanned.has(thread.id);
  // A thread on another machine works on an increment there: its progress is
  // read from that machine with one query per machine and project, the way
  // the sidebar reads its own rows.
  const threadsElsewhere = useMemo(
    () => allThreads.filter((thread) => thread.environmentId !== props.environmentId),
    [allThreads, props.environmentId],
  );
  const { plans: plansElsewhere, loaders: planLoadersElsewhere } =
    useSidebarThreadPlans(threadsElsewhere);
  // Increments are recommended, not required. Dismissing the notice acknowledges
  // the threads it counts, and it comes back only for a thread it has not
  // counted; the sort menu switch turns the notice and the row chips off for good.
  const {
    shown: unplannedNoticeShown,
    setShown: setUnplannedNoticeShown,
    fresh: freshUnplanned,
    dismiss: dismissUnplanned,
  } = useUnplannedNotice(
    props.environmentId,
    allThreads.find((thread) => thread.environmentId === props.environmentId)?.projectId,
    unplanned,
  );
  const unplannedCount = allThreads.filter(
    (thread) => isUnplanned(thread) && freshUnplanned.has(thread.id),
  ).length;
  const [unplannedOnly, setUnplannedOnly] = useState(false);
  // The filter lets go by itself once nothing is left to count (linked, cleared,
  // dismissed in another window or switched off), so a later unplanned thread
  // never narrows the list unasked. A read still in flight for a changed thread
  // list, one that failed before any answer, or a session that is refreshing
  // counts nothing yet, so only an answered read lets it go.
  if (unplannedOnly && unplannedAnswered && unplannedCount === 0) setUnplannedOnly(false);
  const showUnplannedOnly = unplannedOnly && unplannedCount > 0;
  const groups = useMemo(() => {
    const built = buildThreadPaneGroups(
      allThreads,
      sortBy,
      query,
      props.runningSubagents,
      unreachable,
      props.attention,
    );
    const unplannedShown = showUnplannedOnly
      ? built.map((entry) => ({
          ...entry,
          threads: entry.threads.filter(
            (thread) =>
              thread.environmentId === props.environmentId && freshUnplanned.has(thread.id),
          ),
        }))
      : built;
    return props.personal ? withPinnedTopics(unplannedShown) : unplannedShown;
  }, [
    props.personal,
    allThreads,
    query,
    sortBy,
    props.runningSubagents,
    props.attention,
    props.environmentId,
    unreachable,
    showUnplannedOnly,
    freshUnplanned,
  ]);
  // A thread waiting on the person marks its machine while the filters keep it off the
  // list. Searching does not count: the find field is in view and says what it hides.
  const machinesWaiting = useMemo(() => {
    const waiting = new Map<string, number>();
    if (props.unattended) return waiting;
    const unsearched = buildThreadPaneGroups(
      allThreads,
      sortBy,
      "",
      props.runningSubagents,
      unreachable,
      props.attention,
    );
    for (const thread of unsearched.find((entry) => entry.group === "Needs you")?.threads ?? []) {
      const facts = threadFacts.get(`${thread.environmentId}:${thread.id}`);
      if (!facts || threadMatchesPaneFilters(facts, filters)) continue;
      waiting.set(facts.machine, (waiting.get(facts.machine) ?? 0) + 1);
    }
    return waiting;
  }, [
    allThreads,
    sortBy,
    props.runningSubagents,
    props.attention,
    props.unattended,
    unreachable,
    threadFacts,
    machineFilter,
    agentFilter,
    openPullRequestOnly,
  ]);
  const shownGroups = anyFilter
    ? groups.map((entry) => ({
        ...entry,
        threads: entry.threads.filter((thread) => {
          const facts = threadFacts.get(`${thread.environmentId}:${thread.id}`);
          return facts !== undefined && threadMatchesPaneFilters(facts, filters);
        }),
      }))
    : groups;
  const matches = shownGroups.reduce((sum, group) => sum + group.threads.length, 0);
  const searching = query.trim() !== "";
  // A filter is a lasting focus, so Resolved stays folded and paging stays on. A search or
  // the unplanned list looks inside everything, because a hidden match would read as none.
  const openEverything = searching || showUnplannedOnly;
  const offerStarters =
    allThreads.length === 0 && props.starters != null && !props.remoteWorkerCount;
  // The coordinator is not a row here, so a question it asks is offered in the header,
  // one per asking coordinator. A coordinator on another machine is named, because
  // answering it opens that machine's coordinator.
  const coordinatorAsks = (props.attention?.roots ?? []).flatMap((root) => {
    const action = root.coordinator ? root.actions[0] : undefined;
    if (!action) return [];
    const location = locate(root.thread);
    return [
      {
        action,
        machineId: location.executionMachineId,
        machine:
          root.thread.environmentId === props.environmentId && !location.moved
            ? null
            : location.label.split(" → ").at(-1)!,
      },
    ];
  });
  // Under a machine filter the summary keeps the project's count, as the badge does,
  // and says how many of them the narrowed list and header still show.
  const filteredMachine =
    machineFilter === null
      ? null
      : (machineRow.find((choice) => choice.machineId === machineFilter)?.label ?? null);
  const shownWaiting =
    filteredMachine === null
      ? undefined
      : {
          label: filteredMachine,
          count:
            (shownGroups.find((entry) => entry.group === "Needs you")?.threads.length ?? 0) +
            coordinatorAsks.filter((ask) => ask.machineId === machineFilter).length,
        };

  return (
    <>
      {planLoadersElsewhere}
      <ProjectPaneBar
        {...bar}
        tools={
          <>
            <Tip label={say("Find a thread (/)")}>
              <button
                ref={findButtonRef}
                type="button"
                className="sws-icon-button"
                aria-label={say("Find a thread")}
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
                            aria-label={say("Thread actions")}
                            data-bulk-thread-actions
                          />
                        }
                      />
                    }
                  >
                    <ListChecksIcon aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">{say("Stop or continue all threads")}</TooltipPopup>
                </Tooltip>
                <MenuPopup align="end" side="bottom" className="min-w-56">
                  {anyFilter ? (
                    <MenuGroup>
                      <MenuGroupLabel data-bulk-ignores-filters>
                        Every machine, ignoring filters
                      </MenuGroupLabel>
                    </MenuGroup>
                  ) : null}
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
                          aria-label={say(
                            `Sort threads, by ${THREAD_SORT_LABELS[sortBy].toLowerCase()}`,
                          )}
                        />
                      }
                    />
                  }
                >
                  <SlidersVerticalIcon aria-hidden />
                </TooltipTrigger>
                <TooltipPopup side="bottom">{say("Sort threads")}</TooltipPopup>
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
                    {say("Note threads without an increment")}
                  </MenuCheckboxItem>
                </MenuGroup>
              </MenuPopup>
            </Menu>
          </>
        }
      />
      <div
        className="sws-threads-body"
        style={{ "--sws-machine-col": `${machineCh}ch` } as React.CSSProperties}
        id="sws-pane-threads"
        role="tabpanel"
        aria-labelledby="sws-pane-tab-threads"
      >
        <header className="sws-threads-head">
          {/* A first visit gets a greeting; after that the summary leads on its own. */}
          {offerStarters ? <h2>Welcome.</h2> : null}
          <p role="status">
            {offerStarters && !props.attention
              ? props.personal
                ? "No topics yet. Ask Percy for a new topic, or pick one below."
                : "No threads yet. Pick a first task, or ask the coordinator for one."
              : say(
                  threadsSummary(
                    allThreads,
                    props.remoteWorkerCount,
                    unreachable,
                    props.runningSubagents,
                    props.attention,
                    props.unattended,
                    shownWaiting,
                  ),
                )}
          </p>
          {coordinatorAsks.map(({ action, machine }) => (
            <button
              key={`${action.environmentId}:${action.threadId}`}
              type="button"
              className="sws-threads-ask"
              data-coordinator-ask
              data-coordinator-machine={machine ?? undefined}
              onClick={() =>
                (props.onOpenAction ?? props.onOpen)(
                  action.threadId as ThreadId,
                  action.environmentId as EnvironmentId,
                  action.reason,
                )
              }
            >
              <span className="sws-dot" data-tone="waiting" aria-hidden />
              {props.personal ? "Percy" : machine ? `${machine} coordinator` : "Coordinator"} ·{" "}
              {attentionActionWord(action.reason)}
            </button>
          ))}
          {unplannedCount > 0 && !offerStarters ? (
            <UnplannedThreadsFilter
              count={unplannedCount}
              pressed={showUnplannedOnly}
              onToggle={() => setUnplannedOnly((on) => !on)}
              onHide={() => {
                setUnplannedOnly(false);
                dismissUnplanned();
              }}
            />
          ) : null}
          {!offerStarters && (machineRow.length > 1 || offerAgents || offerPullRequests) ? (
            <div className="sws-threads-filters" data-thread-filters>
              {machineRow.length > 1 ? (
                <div
                  className="sws-filter-machines"
                  role="group"
                  aria-label={say("Show threads on")}
                >
                  <button
                    type="button"
                    className="sws-filter-choice"
                    aria-pressed={machineFilter === null}
                    data-machine-choice="all"
                    onClick={() => setMachineFilter(null)}
                  >
                    All
                  </button>
                  {machineRow.map((choice) => {
                    const waiting = machinesWaiting.get(choice.machineId) ?? 0;
                    return (
                      <Tip
                        key={choice.machineId}
                        label={choice.current ? `${choice.label} · this machine` : choice.label}
                      >
                        <button
                          type="button"
                          className="sws-filter-choice"
                          aria-pressed={machineFilter === choice.machineId}
                          aria-label={`${choice.label}${choice.current ? ", this machine" : ""}, ${choice.count} open ${say(choice.count === 1 ? "thread" : "threads")}${waiting > 0 ? `, ${waiting} ${waiting === 1 ? "needs" : "need"} you` : ""}`}
                          data-machine-choice={choice.machineId}
                          data-current={choice.current || undefined}
                          onClick={() =>
                            setMachineFilter(
                              machineFilter === choice.machineId ? null : choice.machineId,
                            )
                          }
                        >
                          {waiting > 0 ? (
                            <span className="sws-dot" data-tone="waiting" aria-hidden />
                          ) : null}
                          <span className="sws-filter-choice-name">{choice.label}</span>
                          <span className="sws-filter-count">{choice.count}</span>
                        </button>
                      </Tip>
                    );
                  })}
                </div>
              ) : null}
              {agentFilter !== null ? (
                <button
                  type="button"
                  className="sws-filter-chip"
                  data-filter-chip="agent"
                  aria-label={say(`Showing ${agentFilter} threads. Remove this filter`)}
                  onClick={() => updatePaneFilters({ agent: null })}
                >
                  {agentFilter}
                  <XIcon aria-hidden />
                </button>
              ) : null}
              {openPullRequestOnly ? (
                <button
                  type="button"
                  className="sws-filter-chip"
                  data-filter-chip="pull-request"
                  aria-label={say("Showing threads with an open pull request. Remove this filter")}
                  onClick={() => updatePaneFilters({ openPullRequest: false })}
                >
                  Open pull request
                  <XIcon aria-hidden />
                </button>
              ) : null}
              {offerAgents || offerPullRequests ? (
                <Menu>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <MenuTrigger
                          render={
                            <button
                              type="button"
                              className="sws-filter-more"
                              aria-label={say(
                                activeMenuFilters > 0
                                  ? `Filter threads, ${activeMenuFilters} on`
                                  : "Filter threads",
                              )}
                              data-thread-filter-menu
                            />
                          }
                        />
                      }
                    >
                      <ListFilterIcon aria-hidden />
                    </TooltipTrigger>
                    <TooltipPopup side="bottom">{say("Filter threads")}</TooltipPopup>
                  </Tooltip>
                  <MenuPopup align="end" side="bottom" className="min-w-52">
                    {offerAgents ? (
                      <MenuGroup>
                        <MenuGroupLabel>Agent</MenuGroupLabel>
                        <MenuRadioGroup
                          value={agentFilter ?? ""}
                          onValueChange={(value) =>
                            updatePaneFilters({ agent: value === "" ? null : (value as string) })
                          }
                        >
                          {[{ agent: "", count: null as number | null }, ...agentRow].map(
                            (option) => (
                              <MenuRadioItem
                                key={option.agent}
                                value={option.agent}
                                closeOnClick
                                data-agent-filter={option.agent || "all"}
                              >
                                <span className="flex items-center justify-between gap-6">
                                  <span>
                                    {option.agent || "All agents"}
                                    {option.count === null ? null : (
                                      <span className="text-muted-foreground"> {option.count}</span>
                                    )}
                                  </span>
                                  <MenuRadioItemIndicator />
                                </span>
                              </MenuRadioItem>
                            ),
                          )}
                        </MenuRadioGroup>
                      </MenuGroup>
                    ) : null}
                    {offerAgents && offerPullRequests ? <MenuSeparator /> : null}
                    {offerPullRequests ? (
                      <MenuGroup>
                        <MenuCheckboxItem
                          variant="switch"
                          checked={openPullRequestOnly}
                          onCheckedChange={(checked) =>
                            updatePaneFilters({ openPullRequest: checked })
                          }
                          data-pull-request-filter
                        >
                          Open pull request
                        </MenuCheckboxItem>
                      </MenuGroup>
                    ) : null}
                  </MenuPopup>
                </Menu>
              ) : null}
            </div>
          ) : null}
        </header>
        {props.shelf}
        {props.renderNotice?.({ machineFilter })}
        <div id="sws-threads-find">
          {findShown ? (
            <label className="sws-find">
              <SearchIcon aria-hidden />
              <span className="sr-only">{say("Find a project thread")}</span>
              <input
                ref={findRef}
                type="search"
                aria-label={say("Find a project thread")}
                placeholder={say("Find a thread")}
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
        {matches === 0 && (searching || anyFilter) && !offerStarters ? (
          <p className="sws-empty" role="status" data-thread-filter-empty>
            {searching ? (
              <>
                {say("No thread matches")} “{query.trim()}”.
              </>
            ) : (
              say("No thread matches these filters.")
            )}
            {anyFilter ? (
              <>
                {" "}
                <button type="button" className="sws-filter-clear" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            ) : null}
          </p>
        ) : null}
        {offerStarters ? props.starters : null}
        {(offerStarters ? [] : shownGroups).map(({ group, threads }) => {
          // A group with nothing in it takes no room; the summary line says what is quiet.
          if (threads.length === 0) return null;
          const limit = openEverything ? threads.length : (limits[group] ?? THREAD_GROUP_PAGE);
          const rows = threads.slice(0, limit);
          const hidden = threads.length - rows.length;
          const slug = group.replace(/\s+/g, "-").toLowerCase();
          const headingId = `sws-threads-${slug}`;
          const listId = `sws-threads-${slug}-list`;
          // A search looks inside folded groups too; hiding a match would read as "not found".
          const isFolded = !openEverything && folded.includes(group);
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
                  aria-disabled={openEverything || undefined}
                  onClick={openEverything ? undefined : () => setGroupFolded(group, !isFolded)}
                >
                  {isFolded ? <ChevronRightIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
                  {group}
                  <span className="sws-group-count">
                    {threads.length}
                    {openEverything ? " shown" : ""}
                    <span className="sr-only">{say(" threads")}</span>
                  </span>
                </button>
              </h3>
              {isFolded ? null : (
                <div className="sws-thread-list" id={listId}>
                  {rows.map((thread) => {
                    const subagentsWorking =
                      props.runningSubagents?.get(`${thread.environmentId}:${thread.id}`) ?? 0;
                    const hostOffline = unreachable.has(thread.environmentId);
                    const ownTone = threadTone(thread, hostOffline);
                    // A subagent's question puts its parent here; the row says which one.
                    const attentionWord = threadAttentionWord(thread, props.attention);
                    const tone = attentionWord
                      ? group === "Working"
                        ? "background"
                        : "waiting"
                      : subagentsWorking > 0 && ownTone === "idle"
                        ? "working"
                        : ownTone;
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
                    // The group heading already says "Working" or "Needs you"; a row
                    // names only a more specific state, such as "Answer needed".
                    const statusWord =
                      attentionWord ??
                      (settled && subagentsWorking > 0
                        ? `${subagentsWorking} ${subagentsWorking === 1 ? "subagent" : "subagents"} working`
                        : withRunningSubagents(
                            threadStatusWord(thread, hostOffline),
                            subagentsWorking,
                          ));
                    const rowStatus = statusWord === group ? null : statusWord;
                    const location = locate(thread);
                    // A thread that runs away from home says so even in a one-machine project.
                    const machine = multiMachine || location.moved ? location : null;
                    const showDot = threadToneShowsDot(tone);
                    const pullRequest = threadPullRequest(thread);
                    const plan =
                      thread.environmentId === props.environmentId
                        ? compactThreadPlan(
                            incrementProgress.get(thread.id) ?? null,
                            thread.planProgress,
                          )
                        : (plansElsewhere.get(
                            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                          ) ?? null);
                    return (
                      <div key={`${thread.environmentId}:${thread.id}`}>
                        <article
                          className="sws-thread-row project-thread-card"
                          data-tone={tone}
                          data-attention={group === "Needs you" ? "" : undefined}
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
                              <strong>{thread.title || say("Untitled thread")}</strong>
                              <span className="sws-thread-meta">
                                <span className="sws-thread-meta-lead">
                                  {rowStatus
                                    ? (() => {
                                        const blocker = threadAttentionNote(thread);
                                        const word = (
                                          <span
                                            className="sws-thread-status"
                                            data-tone={tone}
                                            style={
                                              tone === "background"
                                                ? { color: "var(--muted-foreground)" }
                                                : undefined
                                            }
                                          >
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
                                </span>
                                <span className="sws-thread-meta-rest">
                                  {plan ? <PlanProgressChip plan={plan} /> : null}
                                  {unplannedNoticeShown && isUnplanned(thread) ? (
                                    <UnplannedThreadChip
                                      canAct={
                                        props.canChangeThread
                                          ? props.canChangeThread(thread)
                                          : props.canChange
                                      }
                                    />
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
                                  <HandoffRowBadge
                                    environmentId={thread.environmentId}
                                    threadId={thread.id}
                                    localEnvironmentId={props.environmentId}
                                    hostOffline={hostOffline}
                                  />
                                  {thread.runtime?.lastError ? (
                                    <span className="sws-thread-error">
                                      {thread.runtime.lastError}
                                    </span>
                                  ) : null}
                                </span>
                              </span>
                            </span>
                            {machine ? (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <span
                                      className="sws-thread-machine machine-mark"
                                      data-machine-id={machine.executionMachineId}
                                      data-machine-color={
                                        machineIdentity(machine.executionMachineId).color
                                      }
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
                                  <span className="sws-thread-machine-name" aria-hidden>
                                    {machine.moved ? (
                                      <span className="sws-thread-machine-arrow">→ </span>
                                    ) : null}
                                    {machine.label.split(" → ").at(-1)}
                                  </span>
                                </TooltipTrigger>
                                <TooltipPopup side="bottom">{machine.description}</TooltipPopup>
                              </Tooltip>
                            ) : null}
                            <span className="sr-only">
                              , {THREAD_TONE_LABELS[tone]}, {label.full}, updated
                            </span>
                            <time className="sws-thread-age" dateTime={sessionStateSince(thread)}>
                              {compactAge(sessionStateSince(thread), now)}
                            </time>
                          </button>
                          {(() => {
                            const bound = props.designsByThread?.get(thread.id);
                            if (!bound || bound.ref.owner.kind !== "project") return null;
                            const owner = {
                              kind: "project",
                              projectId: bound.ref.owner.projectId,
                            } as const;
                            return (
                              <Tip label={`Open the design ${bound.title || "Untitled"}`}>
                                <button
                                  type="button"
                                  className="sws-thread-design-action"
                                  data-testid="thread-design-pill"
                                  onClick={() =>
                                    void router.navigate(designRoute(owner, bound.ref.designId))
                                  }
                                >
                                  <PaletteIcon aria-hidden />
                                  Design
                                </button>
                              </Tip>
                            );
                          })()}
                          <HandoffRowAction
                            environmentId={thread.environmentId}
                            threadId={thread.id}
                            localEnvironmentId={props.environmentId}
                            hostOffline={hostOffline}
                            canOperate={
                              props.canChangeThread
                                ? props.canChangeThread(thread)
                                : props.canChange
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
                        {(() => {
                          const root = props.attention?.roots.find(
                            (root) =>
                              root.thread.id === thread.id &&
                              root.thread.environmentId === thread.environmentId,
                          );
                          const children =
                            root?.actions.filter((action) => action.threadId !== thread.id) ?? [];
                          if (!children.length) return null;
                          return (
                            <details className="w-full px-4 pb-2 text-xs" data-attention-requests>
                              <summary className="cursor-pointer">
                                {children.length} {children.length === 1 ? "request" : "requests"}{" "}
                                from subagents
                              </summary>
                              <ul>
                                {children.map((request) => (
                                  <li key={request.key}>
                                    <button
                                      type="button"
                                      className="py-1 text-left underline"
                                      data-request-id={request.requestId}
                                      onClick={() =>
                                        (props.onOpenAction ?? props.onOpen)(
                                          request.threadId as ThreadId,
                                          request.environmentId as EnvironmentId,
                                          request.reason,
                                        )
                                      }
                                    >
                                      {attentionActionWord(request.reason)} ·{" "}
                                      {request.title || "Subagent"}. Open{" "}
                                      {request.reason === "message" ? "message" : "request"}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          );
                        })()}
                      </div>
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
              ) : !openEverything && threads.length > THREAD_GROUP_PAGE ? (
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
