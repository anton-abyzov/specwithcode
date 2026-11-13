import type {
  EnvironmentId,
  EnvironmentMachineKind,
  VcsRef,
  ProjectId,
  ProjectFoundRepository,
  ThreadRepositories,
  WorktreeSubmodules,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { sanitizeNewRefName } from "@specweave-studio/shared/git";
import {
  repositoriesNamedInTask,
  TASK_REPOSITORIES_MAX,
  taskRepositoryNames,
  type TaskRepositoryPick,
} from "@specweave-studio/shared/taskRepositories";
import { toSortableTimestamp } from "../lib/threadSort";
export {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  sanitizeNewRefName,
} from "@specweave-studio/shared/git";

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  /** Null when the machine's "No project" folder is not created yet. */
  projectId: ProjectId | null;
  label: string;
  isPrimary: boolean;
  machine: EnvironmentMachineKind;
  /** More than one machine is saved, so every thread names the machine it runs on. */
  fleet?: boolean;
}

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

const GENERIC_LOCAL_ENVIRONMENT_LABELS = new Set(["local", "local environment"]);

function normalizeDisplayLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveEnvironmentOptionLabel(input: {
  isPrimary: boolean;
  environmentId: EnvironmentId;
  runtimeLabel?: string | null;
  savedLabel?: string | null;
}): string {
  const runtimeLabel = normalizeDisplayLabel(input.runtimeLabel);
  const savedLabel = normalizeDisplayLabel(input.savedLabel);

  if (input.isPrimary) {
    const preferredLocalLabel = [runtimeLabel, savedLabel].find((label) => {
      if (!label) return false;
      return !GENERIC_LOCAL_ENVIRONMENT_LABELS.has(label.toLowerCase());
    });
    return preferredLocalLabel ?? "This device";
  }

  return runtimeLabel ?? savedLabel ?? input.environmentId;
}

// A remote (non-primary) environment is always surfaced, even when it is the
// only environment available: with a single connected machine there is nothing
// to pick, but the user still needs to see where the project runs. With more
// than one saved machine every thread names its machine, this one included.
export function shouldShowEnvironmentIndicator(input: {
  activeEnvironment: Pick<EnvironmentOption, "isPrimary" | "fleet"> | null;
  canPickEnvironment: boolean;
}): boolean {
  if (input.canPickEnvironment) return true;
  if (input.activeEnvironment === null) return false;
  return !input.activeEnvironment.isPrimary || input.activeEnvironment.fleet === true;
}

export function shouldShowComposerContextStrip(input: {
  isDraftHeroState: boolean;
  persistInActiveThreads: boolean;
  hasActiveProject: boolean;
  isGitRepo: boolean;
  showEnvironmentIndicator: boolean;
  /** A collapsed composer's controls currently fit in their measured strip host. */
  hostsRestingComposerControls: boolean;
}): boolean {
  return (
    input.hasActiveProject &&
    (input.isDraftHeroState || input.persistInActiveThreads) &&
    (input.isGitRepo || input.showEnvironmentIndicator || input.hostsRestingComposerControls)
  );
}

// Labels collapse to icons when the strip's content no longer fits. A small
// hysteresis on the way back out keeps the boundary from flapping.
const CONTEXT_STRIP_COMPACT_EXPAND_HYSTERESIS_PX = 16;

export function resolveContextStripLabelsCompact(input: {
  compact: boolean;
  neededWidth: number;
  availableWidth: number;
}): boolean {
  return input.compact
    ? input.neededWidth > input.availableWidth - CONTEXT_STRIP_COMPACT_EXPAND_HYSTERESIS_PX
    : input.neededWidth > input.availableWidth;
}

export function resolveEnvModeLabel(mode: EnvMode): string {
  return mode === "worktree" ? "New worktree" : "Current checkout";
}

export const WORKTREE_SUBMODULES_LABELS: Record<WorktreeSubmodules, string> = {
  recursive: "Recursive",
  "top-level": "Top level only",
  none: "Skip",
};

export function resolveCurrentWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Current worktree" : resolveEnvModeLabel("local");
}

// A locked thread in worktree mode with no path is still creating its
// worktree, so it reads as a new worktree rather than the project checkout.
export function resolveLockedWorkspaceLabel(
  activeWorktreePath: string | null,
  effectiveEnvMode: EnvMode,
): string {
  if (activeWorktreePath) return "Worktree";
  return effectiveEnvMode === "worktree" ? resolveEnvModeLabel("worktree") : "Local checkout";
}

export function resolveWorkspaceDisplayName(path: string | null): string | null {
  if (!path) return null;
  const normalizedPath = path.replace(/[\\/]+$/, "");
  if (normalizedPath.length === 0) return path;
  return normalizedPath.split(/[\\/]/).at(-1) ?? normalizedPath;
}

export interface PreviousWorktreeSeed {
  branch: string | null;
  worktreePath: string;
}

// The most recently touched worktree in the project that the composer isn't
// already pointing at. Backs the "Previous worktree" entry in the workspace
// selector so a follow-up thread can hop back into the worktree you just
// worked in without hunting for its branch. Archived threads don't compete —
// the rest of the UI hides them, so their worktrees shouldn't resurface here.
export function resolvePreviousWorktreeSeed(input: {
  threads: ReadonlyArray<{
    branch: string | null;
    worktreePath: string | null;
    updatedAt: string;
    archivedAt?: string | null;
  }>;
  currentWorktreePath: string | null;
}): PreviousWorktreeSeed | null {
  let latest: { branch: string | null; worktreePath: string; updatedAt: number } | null = null;
  for (const thread of input.threads) {
    if (
      !thread.worktreePath ||
      thread.worktreePath === input.currentWorktreePath ||
      (thread.archivedAt ?? null) !== null
    ) {
      continue;
    }
    const updatedAt = toSortableTimestamp(thread.updatedAt);
    if (updatedAt === null) {
      continue;
    }
    if (latest === null || updatedAt > latest.updatedAt) {
      latest = {
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        updatedAt,
      };
    }
  }
  return latest === null ? null : { branch: latest.branch, worktreePath: latest.worktreePath };
}

export function resolvePreviousWorktreeLabel(seed: PreviousWorktreeSeed): string {
  return seed.branch ? `Previous worktree (${seed.branch})` : "Previous worktree";
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
  /**
   * The server is still creating this thread's worktree. The thread exists
   * from the start of that setup but gets its worktree path only at the end.
   */
  preparingWorktree?: boolean;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode, preparingWorktree } = input;
  if (!hasServerThread) {
    if (activeWorktreePath) {
      return "local";
    }
    return draftThreadEnvMode === "worktree" ? "worktree" : "local";
  }
  return activeWorktreePath || preparingWorktree ? "worktree" : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export function resolveBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
  resolvedActiveBranchIsRemote: boolean | null;
  startFromOrigin: boolean;
}): string {
  const {
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    resolvedActiveBranchIsRemote,
    startFromOrigin,
  } = input;
  if (!resolvedActiveBranch) {
    return "Select ref";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    const baseRef =
      startFromOrigin && resolvedActiveBranchIsRemote === false
        ? `origin/${resolvedActiveBranch}`
        : resolvedActiveBranch;
    return `From ${baseRef}`;
  }
  return resolvedActiveBranch;
}

export function resolveBranchToolbarPrBranch(input: {
  activeThreadBranch: string | null;
  resolvedActiveBranch: string | null;
}): string | null {
  return input.activeThreadBranch === input.resolvedActiveBranch ? input.activeThreadBranch : null;
}

export function resolveLocalCheckoutBranchMismatch(input: {
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): { threadBranch: string; currentBranch: string } | null {
  const { effectiveEnvMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (effectiveEnvMode !== "local" || activeWorktreePath !== null) {
    return null;
  }
  if (!activeThreadBranch || !currentGitBranch || activeThreadBranch === currentGitBranch) {
    return null;
  }
  return { threadBranch: activeThreadBranch, currentBranch: currentGitBranch };
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  refName: Pick<VcsRef, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, refName } = input;

  if (refName.worktreePath) {
    return {
      checkoutCwd: refName.worktreePath,
      nextWorktreePath: refName.worktreePath === activeProjectCwd ? null : refName.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && refName.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}

export function shouldIncludeBranchPickerItem(input: {
  itemValue: string;
  normalizedQuery: string;
  createBranchItemValue: string | null;
  checkoutPullRequestItemValue: string | null;
}): boolean {
  const { itemValue, normalizedQuery, createBranchItemValue, checkoutPullRequestItemValue } = input;

  if (normalizedQuery.length === 0) {
    return true;
  }

  if (createBranchItemValue && itemValue === createBranchItemValue) {
    return true;
  }

  if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
    return true;
  }

  const lowerItemValue = itemValue.toLowerCase();
  if (lowerItemValue.includes(normalizedQuery)) {
    return true;
  }

  // A query containing whitespace can only ever match a ref under its sanitized
  // name, because that is the name such a ref would have been created with.
  // Without this, typing "new branch" hides an existing "new-branch".
  const sanitizedQuery = sanitizeNewRefName(normalizedQuery);
  return (
    sanitizedQuery.length > 0 &&
    sanitizedQuery !== normalizedQuery &&
    lowerItemValue.includes(sanitizedQuery)
  );
}

/** One repository a thread holds, as the server's environment read reports it. */
type HeldRepository = ThreadRepositories["repositories"][number];

/** The chip on the thread: how many repositories it holds, or that it has none yet. */
export function threadRepositoriesCountLabel(count: number): string {
  return count === 0 ? "No repository yet" : count === 1 ? "1 repository" : `${count} repositories`;
}

/** The thread's header line: `fix/environment-list · 2 repositories`. */
export function threadRepositoriesLabel(branch: string | null, count: number): string {
  const label = threadRepositoriesCountLabel(count);
  return branch === null || count === 0 ? label : `${branch} · ${label}`;
}

/** `worktree from origin/main · dependencies installed`. */
export function threadRepositoryLine(repository: HeldRepository): string {
  const from = repository.baseRef === null ? "worktree" : `worktree from ${repository.baseRef}`;
  return `${from} · dependencies ${repository.dependencies === "installed" ? "installed" : "not installed"}`;
}

/** The repositories the thread does not hold yet, for "Add repository". */
export function addableThreadRepositories(
  found: ReadonlyArray<ProjectFoundRepository> | undefined,
  thread: ThreadRepositories,
): ReadonlyArray<ProjectFoundRepository> {
  if (found === undefined || thread.repositories.length >= thread.limit) return [];
  const held = new Set(thread.repositories.map((repository) => repository.repository));
  return found.filter((row) => row.state === "available" && !held.has(row.path));
}

/** The pull request of a held repository: the thread's link whose repository is its origin. */
export function threadRepositoryPullRequest<Link extends { readonly repository: string }>(
  repository: HeldRepository,
  found: ReadonlyArray<ProjectFoundRepository> | undefined,
  pullRequests: ReadonlyArray<Link> | undefined,
): Link | null {
  const origin = found?.find((row) => row.path === repository.repository)?.origin?.toLowerCase();
  if (origin === undefined || origin === null) return null;
  return pullRequests?.find((link) => link.repository.toLowerCase() === origin) ?? null;
}

export type ThreadRepositoryEvent =
  | { readonly kind: "started-empty"; readonly id: string; readonly at: null }
  | {
      readonly kind: "added";
      readonly id: string;
      readonly at: string | null;
      readonly by: "agent" | "user";
      readonly name: string;
      readonly branch: string | null;
      readonly baseRef: string | null;
      readonly dependencies: HeldRepository["dependencies"];
    };

/**
 * What the timeline says about the thread's repositories: that it started with
 * none (every repository it holds was added later), and each one added since,
 * oldest first. A thread whose repositories came with its launch says nothing.
 */
export function threadRepositoryEvents(
  thread: ThreadRepositories | undefined,
): ReadonlyArray<ThreadRepositoryEvent> {
  if (thread === undefined) return [];
  const added = thread.repositories.filter((repository) => repository.addedBy !== null);
  if (added.length !== thread.repositories.length) return [];
  return [
    { kind: "started-empty", id: "thread-repositories:started", at: null },
    ...added
      .toSorted((left, right) => (left.addedAt ?? "").localeCompare(right.addedAt ?? ""))
      .map((repository) => ({
        kind: "added" as const,
        id: `thread-repositories:${repository.relativePath}`,
        at: repository.addedAt,
        by: repository.addedBy!,
        name: repository.name,
        branch: thread.branch,
        baseRef: repository.baseRef,
        dependencies: repository.dependencies,
      })),
  ];
}

/** The two lines of a repository row in the timeline. */
export function threadRepositoryEventText(event: ThreadRepositoryEvent): {
  readonly title: string;
  readonly name: string | null;
  readonly detail: string;
} {
  if (event.kind === "started-empty")
    return {
      title: "Started in its own folder with no repository.",
      name: null,
      detail: "The agent reads the project folder and adds a repository before changing it.",
    };
  const on = event.branch === null ? "Worktree" : `Worktree on ${event.branch}`;
  return {
    title: event.by === "agent" ? "Agent added" : "You added",
    name: event.name,
    detail: `${on}${event.baseRef === null ? "" : ` from ${event.baseRef}`}. Dependencies ${event.dependencies === "installed" ? "installed" : "not installed"}.`,
  };
}

/** The composer's repository pick for one draft: none picked means the agent decides. */
export interface ComposerRepositoryPick {
  /** Paths relative to the project folder. */
  readonly repositories: ReadonlyArray<string>;
  /** With exactly one repository: the branch of it to start from. */
  readonly baseBranch: string | null;
}

export const AGENT_DECIDES: ComposerRepositoryPick = { repositories: [], baseBranch: null };

/** Check or uncheck one repository. The base branch resets to the single pick's current branch. */
export function toggleComposerRepository(
  pick: ComposerRepositoryPick,
  relativePath: string,
  found: ReadonlyArray<ProjectFoundRepository>,
): ComposerRepositoryPick {
  const order = found.map((row) => row.relativePath);
  const repositories = (
    pick.repositories.includes(relativePath)
      ? pick.repositories.filter((path) => path !== relativePath)
      : [...pick.repositories, relativePath]
  ).toSorted((left, right) => order.indexOf(left) - order.indexOf(right));
  const only =
    repositories.length === 1 ? found.find((row) => row.relativePath === repositories[0]) : null;
  return { repositories, baseBranch: only?.branch ?? only?.defaultBranch ?? null };
}

/**
 * What "Agent decides" starts the thread with for this draft: the same pick
 * the server makes from the message at launch.
 */
export function composerTaskPick(
  prompt: string,
  found: ReadonlyArray<ProjectFoundRepository>,
): TaskRepositoryPick {
  // Only a clone that is here can be checked out; the launch skips the rest too.
  return repositoriesNamedInTask(
    prompt,
    found.filter((row) => row.state !== "absent" && row.state !== "missing"),
  );
}

/** The line under "Agent decides": what the thread will start with, and why. */
export function composerAgentDecidesHint(taskPick: TaskRepositoryPick | undefined): string {
  const picked = taskPick?.picked ?? [];
  const named = taskPick?.named ?? [];
  if (picked.length > 0)
    return `Starts with ${taskRepositoryNames(picked)}, named in your message. The agent adds others the task changes.`;
  if (named.length > TASK_REPOSITORIES_MAX)
    return `Your message names ${named.length} repositories, so it starts with none. The agent adds the ones the task changes.`;
  return "It adds the repositories the task changes.";
}

/**
 * `Repositories: Agent decides`, `Repositories: Agent decides · api` (named in
 * the draft), `Repositories: api`, `Repositories: 3 picked`.
 */
export function composerRepositoriesLabel(
  pick: ComposerRepositoryPick,
  found: ReadonlyArray<ProjectFoundRepository>,
  taskPick?: TaskRepositoryPick,
): string {
  if (pick.repositories.length === 0) {
    const named = taskPick?.picked ?? [];
    if (named.length === 1) return `Repositories: Agent decides · ${named[0]!.name}`;
    if (named.length > 1) return `Repositories: Agent decides · ${named.length} named`;
    return "Repositories: Agent decides";
  }
  if (pick.repositories.length === 1)
    return `Repositories: ${found.find((row) => row.relativePath === pick.repositories[0])?.name ?? pick.repositories[0]}`;
  return `Repositories: ${pick.repositories.length} picked`;
}

/** What the launch sends for a pick: nothing when the agent decides. */
export function composerRepositoryLaunch(pick: ComposerRepositoryPick | null): {
  readonly repositories?: ReadonlyArray<string>;
  readonly repositoryBaseBranch?: string;
} {
  if (pick === null || pick.repositories.length === 0) return {};
  return {
    repositories: pick.repositories,
    ...(pick.repositories.length === 1 && pick.baseBranch !== null
      ? { repositoryBaseBranch: pick.baseBranch }
      : {}),
  };
}

// Picks live for the page's lifetime, keyed by the draft's thread: never saved, never remembered.
const composerPicks = new Map<string, ComposerRepositoryPick>();
const composerPickListeners = new Set<() => void>();
export const composerRepositoryPicks = {
  get: (threadId: string): ComposerRepositoryPick => composerPicks.get(threadId) ?? AGENT_DECIDES,
  set(threadId: string, pick: ComposerRepositoryPick) {
    if (pick.repositories.length === 0) composerPicks.delete(threadId);
    else composerPicks.set(threadId, pick);
    for (const listener of composerPickListeners) listener();
  },
  subscribe(listener: () => void) {
    composerPickListeners.add(listener);
    return () => void composerPickListeners.delete(listener);
  },
};
