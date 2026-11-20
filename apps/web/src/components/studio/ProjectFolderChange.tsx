import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CircleCheckIcon,
  CircleXIcon,
  FolderGit2Icon,
  FolderInputIcon,
  FolderOpenIcon,
  InfoIcon,
  LoaderCircleIcon,
  ScanSearchIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { CommandId, type ProjectFolderCheck } from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { displayFolder } from "../../lib/displayFolder";
import { randomUUID } from "../../lib/utils";
import {
  worktreesSettingRecommendation,
  worktreesSwitchDiffers,
} from "../../lib/folderLayoutGuidance";
import { readLocalApi } from "../../localApi";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMachineNickname } from "../../studio/machineNickname";
import { ProjectFolderCopies } from "./ProjectFolderCopies";

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "1 thread keeps", "2 threads keep". */
function pluralVerb(count: number, noun: string, verb: string) {
  return `${plural(count, noun)} ${count === 1 ? `${verb}s` : verb}`;
}

type Tone = "ok" | "warn" | "error" | "info";
const TONE_ICON = {
  ok: CircleCheckIcon,
  warn: TriangleAlertIcon,
  error: CircleXIcon,
  info: InfoIcon,
} as const;

function CheckLine({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <p
      className="project-check-line"
      data-tone={tone}
      role={tone === "error" ? "alert" : undefined}
    >
      <Icon size={15} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** A folder path compared without case, trailing separators or Windows backslashes. */
function comparablePath(folder: string) {
  return folder.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

/**
 * How the new folder's repository compares with the current one, as one sentence.
 * Two folders without a Git remote cannot be told apart, so that case says so instead
 * of calling them different. Exported for tests.
 */
export function repositorySummary(
  check: Pick<
    ProjectFolderCheck,
    "sameRepository" | "currentRepository" | "targetRepository" | "currentRoot" | "targetRoot"
  >,
): string {
  const current = check.currentRepository;
  const target = check.targetRepository;
  if (check.sameRepository) return `Same repository: ${target ?? current ?? "no Git remote"}.`;
  const inside = comparablePath(check.currentRoot).startsWith(
    `${comparablePath(check.targetRoot)}/`,
  )
    ? " The current folder is inside the new one."
    : "";
  if (current === null && target === null)
    return `Neither folder has a Git remote, so the app cannot tell whether they hold the same code.${inside}`;
  if (target === null)
    return `The new folder has no Git remote; the current one is ${current}.${inside}`;
  if (current === null)
    return `The current folder has no Git remote; the new one is ${target}.${inside}`;
  return `Different repository: the new folder is ${target}, the current one ${current}.${inside}`;
}

const LAYOUT_LABEL = {
  single: "One Git repository",
  umbrella: "Umbrella workspace (repositories/<owner>/<repo>)",
  nested: "Folder with nested repositories",
  plain: "Plain folder, no Git repository found",
} as const;

/** One line on what the folder holds, for the check. Exported for tests. */
export function layoutSummary(layout: NonNullable<ProjectFolderCheck["layout"]>): string {
  const base = LAYOUT_LABEL[layout.kind];
  if (layout.repositoryCount === 0) return `${base}.`;
  const shown = layout.repositories.slice(0, 3).join(", ");
  const more = layout.repositoryCount > 3 ? ` and ${layout.repositoryCount - 3} more` : "";
  const partial = layout.truncated ? " The search stopped early; there may be more." : "";
  return `${base}${layout.rootIsRepository ? ", itself a checkout," : ""} with ${layout.repositoryCount} ${layout.repositoryCount === 1 ? "repository" : "repositories"}: ${shown}${more}.${partial}`;
}

/** The planning change the user must confirm, or null when plan cards read the same increments. */
export function planningSummary(check: Pick<ProjectFolderCheck, "planning" | "currentRoot">) {
  const planning = check.planning;
  if (planning === undefined || !planning.changes) return null;
  const before =
    planning.currentRoot === null
      ? "no SpecWeave increments"
      : `${plural(planning.currentIncrements, "increment")} in ${displayFolder(planning.currentRoot)}`;
  const after =
    planning.targetRoot === null
      ? "none"
      : `${plural(planning.targetIncrements, "increment")} in ${displayFolder(planning.targetRoot)}`;
  return {
    change: `Plan cards read ${before} now and would read ${after}.`,
    broken:
      planning.brokenLinks.length === 0
        ? null
        : `${plural(planning.brokenLinks.length, "linked increment")} would show "not found": ${planning.brokenLinks.slice(0, 5).join(", ")}${planning.brokenLinks.length > 5 ? ", …" : ""}.`,
    undo: `Nothing is deleted or rewritten. To go back, change the folder to ${displayFolder(check.currentRoot)} again.`,
  };
}

const REFUSAL_TEXT = {
  folder_not_directory: "This path is a file, not a folder.",
  folder_protected: "This folder is protected and cannot be a project folder.",
  repository_unreadable: "The folder's Git repository could not be read.",
  environment_invalid: "The project's approved folders do not fit this folder.",
} as const;

/** Why the folder cannot be used at all, or null. Exported for tests. */
export function refusalSummary(check: Pick<ProjectFolderCheck, "refusal">): string | null {
  const refusal = check.refusal;
  if (refusal === undefined) return null;
  return refusal.detail.trim() || REFUSAL_TEXT[refusal.reason];
}

const NESTED_SHOWN = 5;

const RELATION_LABEL = {
  inside: "inside the new folder",
  contains: "contains it",
  same: "used this folder",
} as const;

/** Other projects inside the new folder or around it, or null. Exported for tests. */
export function nestedProjectsSummary(
  check: Pick<ProjectFolderCheck, "nestedProjects">,
): string | null {
  const nested = check.nestedProjects ?? [];
  if (nested.length === 0) return null;
  const shown = nested
    .slice(0, NESTED_SHOWN)
    .map(
      (other) =>
        `"${other.title}" (${RELATION_LABEL[other.relation]}${other.deleted ? ", deleted" : other.archived ? ", archived" : ""})`,
    )
    .join(", ");
  const more = nested.length > NESTED_SHOWN ? ` and ${nested.length - NESTED_SHOWN} more` : "";
  const deleted = nested.some((other) => other.deleted)
    ? " A deleted project's threads, memory and routines do not come back with this change."
    : "";
  return `Other projects overlap this folder: ${shown}${more}. They keep their own folders and threads.${deleted}`;
}

/**
 * Changing the folder never moves files. Said plainly when the new folder is
 * empty, since the project's code then stays behind. Exported for tests.
 */
export function emptyTargetSummary(
  check: Pick<ProjectFolderCheck, "targetEmpty" | "currentRoot" | "unchanged">,
): string | null {
  if (check.unchanged || check.targetEmpty !== true) return null;
  return `The new folder is empty. Changing the folder moves no files: everything in ${check.currentRoot}, including uncommitted work, stays there. To bring the code along, move it into the new folder first, then change the folder.`;
}

/**
 * What threads can use in the new folder, as Environment > Repositories lists
 * it after the change. Exported for tests.
 */
export function repositoriesFoundLine(
  layout: NonNullable<ProjectFolderCheck["layout"]>,
): string | null {
  const count = layout.repositoryCount;
  if (count === 0) return null;
  return `${count}${layout.truncated ? " or more" : ""} ${count === 1 ? "repository" : "repositories"} found. Threads can use any of them.`;
}

/**
 * Which workspace suits the new folder, as Project settings > Use worktrees
 * recommends it. Advice only: the check never changes the setting. Exported for tests.
 */
export function workspaceRecommendationLine(
  layout: NonNullable<ProjectFolderCheck["layout"]>,
): { readonly recommended: "local" | "worktree"; readonly text: string } | null {
  const recommendation = worktreesSettingRecommendation(layout);
  if (recommendation === null) return null;
  return { recommended: recommendation.on ? "worktree" : "local", text: recommendation.text };
}

/**
 * How long Stop may take before the flow says the work is still running. The server bounds
 * each step of a Stop, and a provider slow on several in a row can take well over a minute.
 */
export const STOP_WAIT_MS = 120_000;
const STOP_WAIT_TEXT = `${STOP_WAIT_MS / 60_000} minutes`;
/** Pause between checks while Stop takes effect. */
export const STOP_POLL_MS = 2_000;
const TIMED_OUT = Symbol("timed out");

type Timers = Set<ReturnType<typeof setTimeout>>;

/** Resolves after `ms`; `timers` holds it until then, so an unmount can clear it. */
function later(ms: number, stopTimers: Timers): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stopTimers.delete(timer);
      resolve();
    }, ms);
    stopTimers.add(timer);
  });
}

/** Whether two checks compare the same two repositories, so a tick still applies. */
function sameRepositoryDetails(a: ProjectFolderCheck, b: ProjectFolderCheck) {
  return (
    a.currentRoot === b.currentRoot &&
    a.targetRoot === b.targetRoot &&
    a.currentRepository === b.currentRepository &&
    a.targetRepository === b.targetRepository &&
    a.sameRepository === b.sameRepository
  );
}

/** The promise's value, or TIMED_OUT once `ms` have passed; the promise itself runs on. */
function within<T>(
  promise: Promise<T>,
  ms: number,
  stopTimers: Timers,
): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stopTimers.delete(timer);
      resolve(TIMED_OUT);
    }, ms);
    stopTimers.add(timer);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        stopTimers.delete(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        stopTimers.delete(timer);
        resolve(TIMED_OUT);
      },
    );
  });
}

function quotedTitles(threads: ReadonlyArray<{ readonly title: string }>) {
  return threads.map((thread) => `"${thread.title}"`).join(", ");
}

/**
 * Held messages do not block the change; said so the person knows where they will run.
 * Exported for tests.
 */
export function heldThreadsSummary(check: Pick<ProjectFolderCheck, "heldThreads">): string | null {
  const held = check.heldThreads ?? [];
  if (held.length === 0) return null;
  const count = held.reduce((sum, thread) => sum + thread.messageCount, 0);
  return `${quotedTitles(held)} ${held.length === 1 ? "has" : "have"} ${plural(count, "held message")}. ${count === 1 ? "It runs" : "They run"} in the new folder when you resume ${held.length === 1 ? "the thread" : "those threads"}.`;
}

/** The line shown once the folder changed, built from the check the change was applied with. */
export function changedSummary(
  check: Pick<
    ProjectFolderCheck,
    "currentRoot" | "targetRoot" | "threadCount" | "keptInPlaceCount" | "reboundWorktreeCount"
  >,
): string {
  const parts = [`The project now uses ${check.targetRoot}.`];
  if (check.keptInPlaceCount > 0) {
    parts.push(
      `${pluralVerb(check.keptInPlaceCount, "thread", "keep")} running in ${check.currentRoot}; the coordinator and new threads use ${check.targetRoot}.`,
    );
  } else {
    parts.push(
      check.threadCount > 0
        ? "Its threads run there from their next turn."
        : "New threads run there.",
    );
  }
  if (check.reboundWorktreeCount > 0) {
    parts.push(
      `${plural(check.reboundWorktreeCount, "thread checkout")} inside the old folder now ${check.reboundWorktreeCount === 1 ? "points" : "point"} at the same place in the new one.`,
    );
  }
  parts.push(`To undo, change the folder back to ${check.currentRoot}.`);
  if (check.keptInPlaceCount > 0) parts.push("Changing it back does not move the kept threads.");
  return parts.join(" ");
}

/**
 * Moves a project to another folder. The server checks the folder first: it must
 * exist, be usable as a project folder, belong to no other project, and nothing
 * may be running; a folder from a different repository needs an explicit
 * confirmation, and so does a folder whose SpecWeave planning root differs
 * (plan cards would read other increments). The check also shows what the
 * folder holds and which other projects overlap it. Memory and history stay
 * with the project, the coordinator and new threads use the new folder, and
 * thread checkouts inside the old folder are rebound to the same place in the
 * new one. When the old folder stays a checkout of another repository (a
 * repository project moving up to its umbrella), the threads that ran in it
 * are kept there instead of moving.
 */
export function ProjectFolderChange({
  project,
  disabled,
  blockedReason = null,
  onChanged,
  useWorktrees = null,
  onUseWorktreesChange,
  embedded = false,
  members,
}: {
  project: EnvironmentProject;
  /** Every copy the sidebar groups as this project, so unlinked copies list their folders too. */
  members?: readonly EnvironmentProject[] | undefined;
  disabled: boolean;
  /** Shown under the controls, which stay disabled, while set (unsaved edits elsewhere). */
  blockedReason?: string | null;
  onChanged: () => void;
  /** The project's Use worktrees switch, when the host knows it. */
  useWorktrees?: boolean | null;
  /** Flips the switch; called only when the person ticked the box and the folder changed. */
  onUseWorktreesChange?: ((on: boolean) => void) | undefined;
  /** Another machine's copy, changed from the list under this project's own folder. */
  embedded?: boolean;
}) {
  const machine = useMachineNickname(project.environmentId);
  const [alsoSwitch, setAlsoSwitch] = useState(false);
  const [folder, setFolder] = useState("");
  const [check, setCheck] = useState<ProjectFolderCheck | null>(null);
  const [confirmRepository, setConfirmRepository] = useState(false);
  const [confirmPlanning, setConfirmPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "stopping" | "changing">("idle");
  const [stopped, setStopped] = useState<string | null>(null);
  // Bumped whenever the folder or the check changes, so a Stop still waiting on its runs
  // stops polling once the person moved on, and after unmount.
  const generation = useRef(0);
  // Timers of a Stop still waiting, cleared on unmount.
  const timers = useRef<Timers>(new Set());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      generation.current += 1;
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  const runCheck = useAtomCommand(projectEnvironment.folderCheck);
  const changeFolder = useAtomCommand(projectEnvironment.changeFolder);
  const folderStop = useAtomCommand(projectEnvironment.folderStop);
  // Only the desktop app can open a native folder picker.
  const pickFolder =
    typeof window !== "undefined" && window.desktopBridge !== undefined
      ? readLocalApi()?.dialogs.pickFolder
      : undefined;
  const locked = disabled || blockedReason !== null || busy;

  function failed(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
    const cause = squashAtomCommandFailure(result);
    setError(cause instanceof Error ? cause.message : fallback);
  }

  async function inspect(path = folder) {
    const workspaceRoot = path.trim();
    if (locked || workspaceRoot.length === 0) return;
    const run = ++generation.current;
    setBusy(true);
    setPhase("checking");
    setError(null);
    setDone(null);
    setStopped(null);
    const result = await runCheck({
      environmentId: project.environmentId,
      input: { projectId: project.id, workspaceRoot },
    });
    if (run !== generation.current) return;
    setBusy(false);
    setPhase("idle");
    if (result._tag === "Failure") {
      setCheck(null);
      failed(result, "The folder could not be checked. Try again.");
      return;
    }
    setCheck(result.value);
    setConfirmRepository(false);
    setConfirmPlanning(false);
    // The switch never changes unless the box is ticked for this check.
    setAlsoSwitch(false);
  }

  async function choose() {
    if (locked || !pickFolder) return;
    const picked = await pickFolder({ initialPath: project.workspaceRoot });
    if (!picked) return;
    setFolder(picked);
    await inspect(picked);
  }

  /**
   * Stop ends a run asynchronously: the provider winds the turn down and the server
   * settles it, which can take a minute or more. So the flow asks the server to stop what
   * blocks the change (it stops only threads that still block, so nothing newer is
   * reached), and checks the folder again until the stopped threads are idle, keeping
   * what the person ticked while the details it confirms stay the same. It says plainly
   * when they are idle, which still run once the wait runs out, or that it could not tell.
   */
  async function stopRuns() {
    if (locked || !check) return;
    const run = ++generation.current;
    const pressed = check;
    const targetRoot = pressed.targetRoot;
    const stopping = pressed.activeThreads;
    const stoppingIds = new Set(stopping.map((thread) => thread.id));
    setBusy(true);
    setPhase("stopping");
    setError(null);
    setDone(null);
    setStopped(null);
    // The wait is bounded from the press, every call included, so a slow machine cannot
    // keep the flow locked past it.
    const deadline = Date.now() + STOP_WAIT_MS;
    const remaining = () => Math.max(0, deadline - Date.now());
    const reasons: string[] = [];
    // The threads the server says it stopped. One that only left the list of blockers (kept
    // in its folder since, say) may still run, so it is never called stopped.
    let serverStopped: ReadonlySet<string> | null = null;
    // Polling starts without waiting on this answer, so a slow one cannot use up the wait.
    // Each thread goes with the run the check saw, so the server never stops newer work.
    const answered = folderStop({
      environmentId: project.environmentId,
      input: {
        commandId: CommandId.make(`folder-stop:${randomUUID()}`),
        projectId: project.id,
        workspaceRoot: targetRoot,
        threads: stopping.map((thread) => ({
          id: thread.id,
          runId: thread.runId ?? null,
          // Absent from an older server's check: the server then binds to its own reading.
          ...(thread.latestExecutedRunId === undefined
            ? {}
            : { latestExecutedRunId: thread.latestExecutedRunId }),
          ...(thread.teardownsThrough === undefined
            ? {}
            : { teardownsThrough: thread.teardownsThrough }),
        })),
      },
    }).then((result) => {
      if (run !== generation.current) return;
      if (result._tag === "Success") {
        serverStopped = new Set(result.value.stopped);
        for (const failure of result.value.failed) reasons.push(failure.message);
        return;
      }
      const cause = squashAtomCommandFailure(result);
      reasons.push(
        cause instanceof Error && cause.message.length > 0
          ? `Stop failed: ${cause.message.replace(/\.?$/u, ".")}`
          : "Stop failed. If this machine runs an older SpecWithCode, update it or stop the thread there.",
      );
    });
    let latest: ProjectFolderCheck | null = null;
    let unknown = false;
    let checkFailure: Parameters<typeof squashAtomCommandFailure>[0] | null = null;
    while (remaining() > 0) {
      await later(Math.min(STOP_POLL_MS, remaining()), timers.current);
      if (run !== generation.current) return;
      const result = await within(
        runCheck({
          environmentId: project.environmentId,
          input: { projectId: project.id, workspaceRoot: targetRoot },
        }),
        remaining(),
        timers.current,
      );
      if (run !== generation.current) return;
      if (result === TIMED_OUT) {
        unknown = true;
        break;
      }
      if (result._tag === "Failure") {
        checkFailure = result;
        break;
      }
      latest = result.value;
      unknown = false;
      // A tick confirms the details shown when it was given, not ones that changed since.
      if (!sameRepositoryDetails(pressed, latest)) setConfirmRepository(false);
      if (JSON.stringify(pressed.planning ?? null) !== JSON.stringify(latest.planning ?? null)) {
        setConfirmPlanning(false);
      }
      setCheck(latest);
      const still = latest.activeThreads.filter((thread) => stoppingIds.has(thread.id));
      if (still.length === 0) break;
    }
    if (run !== generation.current) return;
    setBusy(false);
    setPhase("idle");
    if (checkFailure !== null) {
      setCheck(null);
      failed(checkFailure, "The folder could not be checked after Stop. Check it again.");
      return;
    }
    const still =
      latest === null
        ? stopping
        : latest.activeThreads.filter((thread) => stoppingIds.has(thread.id));
    if (!unknown && latest !== null && still.length === 0) {
      // Nothing blocks any more; which of them the server stopped is in its answer.
      if (serverStopped === null) await within(answered, remaining(), timers.current);
      if (run !== generation.current) return;
      const confirmed: ReadonlySet<string> = serverStopped ?? new Set<string>();
      const ended = stopping.filter((thread) => confirmed.has(thread.id));
      const cleared = stopping.filter((thread) => !confirmed.has(thread.id));
      setStopped(
        [
          ended.length > 0 ? `Stopped ${quotedTitles(ended)}.` : "",
          cleared.length > 0
            ? `${quotedTitles(cleared)} no longer ${cleared.length === 1 ? "blocks" : "block"} this change.`
            : "",
        ]
          .filter((part) => part.length > 0)
          .join(" "),
      );
      return;
    }
    const reason = reasons.length > 0 ? ` ${[...new Set(reasons)].join(" ")}` : "";
    setError(
      unknown || latest === null
        ? `The app could not confirm within ${STOP_WAIT_TEXT} that ${quotedTitles(still)} stopped.${reason} Check the folder again, or open the thread.`
        : `${quotedTitles(still)} ${still.length === 1 ? "is" : "are"} still running ${STOP_WAIT_TEXT} after Stop.${reason} Open ${still.length === 1 ? "the thread" : "each thread"} to see what it is doing, or press Stop again.`,
    );
  }

  async function apply() {
    if (locked || !check) return;
    const applied = check;
    ++generation.current;
    setBusy(true);
    setPhase("changing");
    setError(null);
    setStopped(null);
    const result = await changeFolder({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        workspaceRoot: check.targetRoot,
        ...(check.sameRepository ? {} : { confirmDifferentRepository: confirmRepository }),
        ...(planning === null ? {} : { confirmPlanningImpact: confirmPlanning }),
      },
    });
    setBusy(false);
    setPhase("idle");
    if (result._tag === "Failure") {
      failed(result, "The folder did not change. Check it again and retry.");
      return;
    }
    if (alsoSwitch && switchDiffers !== null) onUseWorktreesChange?.(switchDiffers.recommendedOn);
    setDone(
      changedSummary(applied) +
        (alsoSwitch && switchDiffers !== null
          ? ` Use worktrees is now ${switchDiffers.recommendedOn ? "on" : "off"}.`
          : ""),
    );
    setCheck(null);
    setFolder("");
    onChanged();
  }

  const planning = check === null ? null : planningSummary(check);
  const refusal = check === null ? null : refusalSummary(check);
  const nested = check === null ? null : nestedProjectsSummary(check);
  const emptyTarget = check === null ? null : emptyTargetSummary(check);
  const held = check === null ? null : heldThreadsSummary(check);
  const repositoriesFound = check?.layout ? repositoriesFoundLine(check.layout) : null;
  const workspaceAdvice = check?.layout ? workspaceRecommendationLine(check.layout) : null;
  const switchDiffers =
    check?.layout && useWorktrees !== null && onUseWorktreesChange !== undefined
      ? worktreesSwitchDiffers(check.layout, useWorktrees)
      : null;
  const blocked =
    check === null ||
    refusal !== null ||
    (planning !== null && !confirmPlanning) ||
    check.unchanged ||
    !check.targetExists ||
    check.conflictingProject !== null ||
    check.activeThreads.length > 0 ||
    (!check.sameRepository && !confirmRepository);

  // What is left once Stop worked: the change itself, or the confirmation it still needs.
  const stoppedNext =
    check === null || check.activeThreads.length > 0
      ? null
      : !blocked
        ? "Nothing blocks the change now."
        : (!check.sameRepository && !confirmRepository) || (planning !== null && !confirmPlanning)
          ? "Confirm the folder above, then press Change folder."
          : null;

  const Wrapper = embedded ? "div" : "section";
  return (
    <Wrapper
      className={embedded ? "project-folder-copy-change" : "project-setting-row"}
      {...(embedded ? {} : { "aria-labelledby": "project-folder-title" })}
    >
      <div>
        {embedded ? null : (
          <>
            <h3 id="project-folder-title">
              {machine ? `Project folder on ${machine}` : "Project folder"}
            </h3>
            <p className="project-muted">
              Point this project at another folder, such as the repository root after it moved. Its
              threads, memory and history stay with the project.
            </p>
            <div className="project-folder-current" title={project.workspaceRoot}>
              <FolderGit2Icon size={15} aria-hidden="true" />
              <span>
                <bdi>{displayFolder(project.workspaceRoot)}</bdi>
              </span>
              <small>Current</small>
            </div>
            <ProjectFolderCopies
              project={project}
              members={members}
              disabled={locked}
              renderChange={(copy, done) => (
                <ProjectFolderChange project={copy} disabled={disabled} embedded onChanged={done} />
              )}
            />
          </>
        )}
        <div className="project-input-row">
          <input
            aria-label={embedded ? `New project folder on ${machine}` : "New project folder"}
            placeholder="New folder path, for example ~/Projects/my-repo"
            value={folder}
            disabled={locked}
            onChange={(e) => {
              generation.current += 1;
              setFolder(e.target.value);
              setCheck(null);
              setDone(null);
              setStopped(null);
              setBusy(false);
              setPhase("idle");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void inspect();
            }}
          />
          {pickFolder && !embedded ? (
            <button
              type="button"
              className="project-control"
              disabled={locked}
              onClick={() => void choose()}
            >
              <FolderOpenIcon aria-hidden="true" />
              Choose…
            </button>
          ) : null}
          <button
            type="button"
            className="project-control"
            disabled={locked || folder.trim().length === 0}
            onClick={() => void inspect()}
          >
            {phase === "checking" ? (
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            ) : (
              <ScanSearchIcon aria-hidden="true" />
            )}
            Check
          </button>
        </div>
        {blockedReason ? (
          <p className="project-muted" data-folder-blocked>
            {blockedReason}
          </p>
        ) : null}
        {error ? <CheckLine tone="error">{error}</CheckLine> : null}
        {done ? <CheckLine tone="ok">{done}</CheckLine> : null}
        {stopped ? (
          <CheckLine tone="ok">
            <span data-folder-stopped>
              {stopped}
              {stoppedNext ? ` ${stoppedNext}` : ""}
            </span>
          </CheckLine>
        ) : null}
        {check ? (
          <div aria-label="Folder check">
            {check.unchanged ? (
              <CheckLine tone="info">The project already uses this folder.</CheckLine>
            ) : refusal ? (
              <CheckLine tone="error">
                <span data-folder-refusal={check.refusal?.reason}>{refusal}</span>
              </CheckLine>
            ) : !check.targetExists ? (
              <CheckLine tone="error">
                {check.targetRoot} does not exist. Create or clone it first.
              </CheckLine>
            ) : check.conflictingProject ? (
              <CheckLine tone="error">
                {check.targetRoot} belongs to the project "{check.conflictingProject.title}" (
                {plural(check.conflictingProject.threadCount, "thread")}
                {check.conflictingProject.archived ? ", archived" : ""}). Point that project at
                another folder or delete it first.
              </CheckLine>
            ) : (
              <>
                <CheckLine tone={check.sameRepository ? "ok" : "warn"}>
                  {repositorySummary(check)}{" "}
                  {check.keptInPlaceCount > 0
                    ? `${plural(check.threadCount, "thread")} stay in the project. ${pluralVerb(check.keptInPlaceCount, "thread", "keep")} running in ${check.currentRoot}, so their files and sessions do not change; new threads and the coordinator use the new folder`
                    : `${plural(check.threadCount, "thread")} move with the project`}
                  {check.reboundWorktreeCount > 0
                    ? `; ${plural(check.reboundWorktreeCount, "thread checkout")} inside the old folder will point at the same place in the new one`
                    : ""}
                  .
                </CheckLine>
                {!check.sameRepository ? (
                  <label className="project-checkbox">
                    <input
                      type="checkbox"
                      checked={confirmRepository}
                      disabled={locked}
                      onChange={(e) => setConfirmRepository(e.target.checked)}
                    />
                    This is the right folder for this project
                  </label>
                ) : null}
                {emptyTarget ? (
                  <CheckLine tone="warn">
                    <span data-folder-empty-target>{emptyTarget}</span>
                  </CheckLine>
                ) : null}
                {check.layout ? (
                  <CheckLine tone="info">
                    <span data-folder-layout={check.layout.kind}>
                      {layoutSummary(check.layout)}
                    </span>
                  </CheckLine>
                ) : null}
                {repositoriesFound ? (
                  <CheckLine tone="info">
                    <span data-folder-repositories-found>{repositoriesFound}</span>
                  </CheckLine>
                ) : null}
                {switchDiffers ? (
                  <>
                    <CheckLine tone="info">
                      <span data-folder-switch-differs>
                        {switchDiffers.text}
                        {workspaceAdvice && switchDiffers.recommendedOn
                          ? ` ${workspaceAdvice.text.replace(/^Recommended for this folder: on\.\s*/u, "")}`
                          : ""}
                      </span>
                    </CheckLine>
                    <label className="project-checkbox">
                      <input
                        type="checkbox"
                        checked={alsoSwitch}
                        disabled={locked}
                        onChange={(e) => setAlsoSwitch(e.target.checked)}
                      />
                      {switchDiffers.offer}
                    </label>
                  </>
                ) : workspaceAdvice ? (
                  <CheckLine tone="info">
                    <span data-folder-workspace-recommendation={workspaceAdvice.recommended}>
                      {workspaceAdvice.text}
                    </span>
                  </CheckLine>
                ) : null}
                {nested ? (
                  <CheckLine tone="warn">
                    <span data-folder-nested-projects>{nested}</span>
                  </CheckLine>
                ) : null}
                {planning ? (
                  <>
                    <CheckLine tone="warn">
                      <span data-folder-planning="changes">
                        {planning.change} {planning.broken ?? ""} {planning.undo}
                      </span>
                    </CheckLine>
                    <label className="project-checkbox">
                      <input
                        type="checkbox"
                        checked={confirmPlanning}
                        disabled={locked}
                        onChange={(e) => setConfirmPlanning(e.target.checked)}
                      />
                      Plan cards should read the new folder's increments
                    </label>
                  </>
                ) : null}
                {held ? (
                  <CheckLine tone="info">
                    <span data-folder-held>{held}</span>
                  </CheckLine>
                ) : null}
                {check.activeThreads.length > 0 ? (
                  <div className="project-notice" data-folder-active-work>
                    <p>
                      {phase === "stopping"
                        ? `Stopping ${quotedTitles(check.activeThreads)}. This can take a minute or two; the folder can change once ${check.activeThreads.length === 1 ? "it has" : "they have"} stopped.`
                        : `Stop the running work first: ${quotedTitles(check.activeThreads)}.`}
                    </p>
                    <button
                      type="button"
                      className="project-control"
                      disabled={locked}
                      aria-busy={phase === "stopping"}
                      onClick={() => void stopRuns()}
                    >
                      {phase === "stopping" ? (
                        <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                      ) : (
                        <SquareIcon aria-hidden="true" />
                      )}
                      {phase === "stopping"
                        ? "Stopping…"
                        : `Stop ${plural(check.activeThreads.length, "run")}`}
                    </button>
                  </div>
                ) : null}
              </>
            )}
            {!check.unchanged ? (
              <div className="project-actions">
                <button
                  type="button"
                  className="project-control project-control-strong"
                  disabled={locked || blocked}
                  aria-busy={phase === "changing"}
                  onClick={() => void apply()}
                >
                  {phase === "changing" ? (
                    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                  ) : (
                    <FolderInputIcon aria-hidden="true" />
                  )}
                  {phase === "changing" ? "Changing folder…" : "Change folder"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Wrapper>
  );
}
