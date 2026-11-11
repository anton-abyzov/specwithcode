import { useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  PowerIcon,
  Settings2Icon,
} from "lucide-react";
import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScheduledTask,
  type ThreadId,
} from "@specweave-studio/contracts";
import { routineCadenceLabel } from "@specweave-studio/shared/routineBrief";
import { ROUTINE_TEMPLATES, type RoutineTemplate } from "@specweave-studio/shared/routineTemplates";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { createScopedProjectSendReceipt } from "../../studio/projectWorkspaceModel";
import {
  routineCountsLabel,
  routineDestinationLabel,
  routineRunTimeLabel,
  routineState,
} from "../../studio/routinePresentation";
import { randomUUID } from "../../lib/utils";
import { routineFollowsCoordinator, routineRunnerOf } from "../../studio/routineRunner";
import { PROJECT_MACHINES_SECTION_ID } from "./projectMachinesSection";
import { RoutineQuickForm } from "./RoutineQuickForm";
import { useLinkMachines } from "./useLinkMachines";

export function ProjectRoutines({
  environmentId: viewedEnvironmentId,
  projectId: viewedProjectId,
  projectKey,
  canOperate: viewedCanOperate,
  admissionBlocked,
  personal = false,
  modelSelection = null,
  machineLabel = null,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectKey: string;
  canOperate: boolean;
  admissionBlocked: boolean;
  /** A personal assistant offers ready-made routines for repeating work. */
  personal?: boolean;
  /** The model a routine started from a template starts its thread on: the coordinator's. */
  modelSelection?: ModelSelection | null;
  /** The machine every routine here runs on, named once in the header. */
  machineLabel?: string | null;
  /** Opens a routine's thread on the machine that holds it: the runner's for its routines. */
  onOpenThread?: (threadId: ThreadId, environmentId: EnvironmentId) => void;
}) {
  // The runner is the copy that coordinates (D-12); side-by-side active copies
  // each run their own, so this page shows the viewed copy's routines. Only a
  // copy that gave its coordinator away has a runner elsewhere: this page then
  // reads and changes the coordinator-owned routines on the runner, so an edit
  // is never overwritten by its next replica, and with the runner offline shows
  // this machine's resting copies, read-only, with Run here. Worker-thread and
  // webhook routines never travel: they stay listed, and operable, for this
  // machine in a group of their own.
  const projects = useProjects();
  const machines = useLinkMachines();
  const navigate = useNavigate();
  const runner = routineRunnerOf(
    projects.find(
      (project) => project.environmentId === viewedEnvironmentId && project.id === viewedProjectId,
    ),
    projects,
    (member) => machines.state(member.environmentId) !== "offline",
  );
  const runnerLabel = runner ? machines.label(runner.member.environmentId) : null;
  const runnerOffline = runner !== null && !runner.online;
  const environmentId = runner?.online ? runner.member.environmentId : viewedEnvironmentId;
  const projectId = runner?.online ? runner.member.id : viewedProjectId;
  const canOperate = viewedCanOperate && !runnerOffline;
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  // With the runner online the main query reads the runner; this one reads the viewed machine.
  const hereQuery = useEnvironmentQuery(
    runner?.online
      ? serverEnvironment.scheduledTasksLive({ environmentId: viewedEnvironmentId, input: {} })
      : null,
  );
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled);
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow);
  const [busy, setBusy] = useState<string | null>(null);
  const [template, setTemplate] = useState<RoutineTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [unknownRun, setUnknownRun] = useState<{ taskId: string; commandId: string } | null>(null);
  const receipts = useMemo(
    () => createScopedProjectSendReceipt(environmentId, projectId, "routine"),
    [environmentId, projectId],
  );
  const hereReceipts = useMemo(
    () => createScopedProjectSendReceipt(viewedEnvironmentId, viewedProjectId, "routine"),
    [viewedEnvironmentId, viewedProjectId],
  );
  const headingId = useId();
  const listed = query.data?.tasks.filter((t) => t.projectId === projectId) ?? [];
  const tasks = runner ? listed.filter(routineFollowsCoordinator) : listed;
  const hereTasks = runner
    ? (runner.online
        ? (hereQuery.data?.tasks.filter((t) => t.projectId === viewedProjectId) ?? [])
        : listed
      ).filter((t) => !routineFollowsCoordinator(t))
    : [];
  const main: RoutineTarget = { environmentId, canOperate, receipts, refresh: query.refresh };
  const here: RoutineTarget = {
    environmentId: viewedEnvironmentId,
    canOperate: viewedCanOperate,
    receipts: hereReceipts,
    refresh: runner?.online ? hereQuery.refresh : query.refresh,
  };
  const settingsSearch = { project: projectKey, machine: environmentId };
  async function act(
    task: ScheduledTask,
    kind: "toggle" | "run",
    { environmentId, canOperate, receipts, refresh }: RoutineTarget,
  ) {
    if (inFlight.current || !canOperate || (admissionBlocked && (kind === "run" || !task.enabled)))
      return;
    inFlight.current = true;
    setBusy(task.id);
    setError(null);
    try {
      const commandId =
        kind === "run"
          ? CommandId.make(receipts.forPrompt(task.id, () => randomUUID()))
          : undefined;
      const result =
        kind === "toggle"
          ? await toggle({ environmentId, input: { id: task.id, enabled: !task.enabled } })
          : await run({ environmentId, input: { id: task.id, commandId } });
      if (result._tag === "Failure") {
        const e = squashAtomCommandFailure(result);
        setError(e instanceof Error ? e.message : "Routine action was rejected.");
        if (
          commandId &&
          e &&
          typeof e === "object" &&
          "reason" in e &&
          e.reason === "run_outcome_unknown"
        ) {
          setUnknownRun({ taskId: task.id, commandId });
        }
      } else {
        if (commandId) {
          receipts.acknowledge(commandId);
          setUnknownRun(null);
        }
        refresh();
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Routine action was not confirmed. Retry uses the same request.",
      );
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  const summary = [
    runner?.online
      ? `Runs on ${runnerLabel}`
      : runner
        ? null
        : machineLabel
          ? `On ${machineLabel}`
          : null,
    tasks.length + hereTasks.length > 0 ? routineCountsLabel([...tasks, ...hereTasks]) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const newRoutine = (
    <Link
      className="sws-routines-button"
      to="/settings/scheduled-tasks"
      search={{ ...settingsSearch, template: "new", projectId }}
    >
      <PlusIcon aria-hidden />
      New routine
    </Link>
  );
  const rows = (list: readonly ScheduledTask[], target: RoutineTarget) => (
    <ul className="sws-routines-list">
      {list.map((task) => (
        <RoutineRow
          key={task.id}
          task={task}
          busy={busy !== null}
          canOperate={target.canOperate}
          admissionBlocked={admissionBlocked}
          unknownRun={unknownRun?.taskId === task.id}
          onAct={(kind) => void act(task, kind, target)}
          onConfirmRetry={() => {
            if (inFlight.current || !target.canOperate || admissionBlocked || !unknownRun) return;
            target.receipts.acknowledge(unknownRun.commandId);
            setUnknownRun(null);
            void act(task, "run", target);
          }}
          onOpenThread={
            onOpenThread ? (threadId) => onOpenThread(threadId, target.environmentId) : undefined
          }
        />
      ))}
    </ul>
  );
  return (
    <section className="project-settings-section sws-routines" aria-labelledby={headingId}>
      <header className="sws-routines-head">
        <div className="sws-routines-heading">
          <h2 id={headingId}>Routines</h2>
          {summary ? <p className="sws-routines-summary">{summary}</p> : null}
        </div>
        <div className="sws-routines-head-actions">
          {canOperate && !personal && tasks.length > 0 ? newRoutine : null}
          <Link
            className="sws-routines-button"
            to="/settings/scheduled-tasks"
            search={settingsSearch}
          >
            <Settings2Icon aria-hidden />
            Manage routines
          </Link>
        </div>
      </header>
      {personal ? (
        <p className="sws-routines-note">
          Reusable work that runs when you ask or on a schedule, each in a thread of its own.
          Routines here prepare and draft; you file, pay and send.
        </p>
      ) : null}
      {runnerOffline ? (
        <div className="project-notice" role="status" data-routine-runner="offline">
          <p>
            Runner offline: {runnerLabel}. These are this machine's copies; they run here only if
            this machine takes over the coordinator.
          </p>
          {viewedCanOperate ? (
            <button
              type="button"
              className="sws-routines-button"
              onClick={() =>
                void navigate({
                  to: "/settings/projects",
                  search: { project: projectKey, machine: undefined, checkout: undefined },
                  hash: PROJECT_MACHINES_SECTION_ID,
                })
              }
            >
              <PlayIcon aria-hidden />
              Run here
            </button>
          ) : null}
        </div>
      ) : null}
      {!runnerOffline && (admissionBlocked || !canOperate) && (
        <p className="project-notice">
          This project cannot start routine runs while it is paused, archived, disconnected or
          read-only.
        </p>
      )}
      {query.error && (
        <p className="sws-routines-alert" role="alert">
          Routines could not load. {query.error}
        </p>
      )}
      {error && (
        <p className="sws-routines-alert" role="alert">
          {error}
        </p>
      )}
      {query.isPending && !query.data ? (
        <p className="sws-routines-empty" role="status">
          Loading routines…
        </p>
      ) : tasks.length === 0 ? (
        query.error || hereTasks.length > 0 ? null : (
          <div className="sws-routines-empty">
            <strong>No routines yet</strong>
            <p>
              {personal
                ? "Start one from a template below."
                : "A routine runs a request in a thread of its own, on a schedule or when you ask."}
            </p>
            {canOperate && !personal ? newRoutine : null}
          </div>
        )
      ) : (
        rows(tasks, main)
      )}
      {hereTasks.length > 0 ? (
        <div className="sws-routines-group" data-routine-group="here">
          <p className="sws-routines-summary">
            Runs on {machineLabel ?? machines.label(viewedEnvironmentId)}: worker thread and webhook
            routines stay with this machine.
          </p>
          {rows(hereTasks, here)}
        </div>
      ) : null}
      {personal && canOperate ? (
        <div className="sws-routine-templates">
          <h3>Start from a template</h3>
          {template ? (
            <RoutineQuickForm
              key={template.id}
              environmentId={environmentId}
              projectId={projectId}
              modelSelection={modelSelection}
              template={template}
              onDone={(saved) => {
                setTemplate(null);
                if (saved) query.refresh();
              }}
            />
          ) : (
            <ul>
              {ROUTINE_TEMPLATES.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="sws-routine-template"
                    disabled={admissionBlocked}
                    onClick={() => setTemplate(entry)}
                  >
                    <strong>{entry.title}</strong>
                    <span>{entry.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** The machine a routine is changed on, and whether this page may change it there. */
interface RoutineTarget {
  readonly environmentId: EnvironmentId;
  readonly canOperate: boolean;
  readonly receipts: ReturnType<typeof createScopedProjectSendReceipt>;
  readonly refresh: () => void;
}

function RoutineRow({
  task,
  busy,
  canOperate,
  admissionBlocked,
  unknownRun,
  onAct,
  onConfirmRetry,
  onOpenThread,
}: {
  task: ScheduledTask;
  busy: boolean;
  canOperate: boolean;
  admissionBlocked: boolean;
  unknownRun: boolean;
  onAct: (kind: "toggle" | "run") => void;
  onConfirmRetry: () => void;
  onOpenThread: ((threadId: ThreadId) => void) | undefined;
}) {
  const titleId = useId();
  const state = routineState(task);
  const showNext = task.nextRunAt && state.tone !== "paused";
  const destination = routineDestinationLabel(task);
  return (
    <li className="sws-routine" data-state={state.tone} aria-labelledby={titleId}>
      <div className="sws-routine-main">
        <div className="sws-routine-title">
          <span className="sws-dot" data-tone={state.dotTone} aria-hidden />
          <h3 id={titleId}>{task.title}</h3>
          <span className="sws-routine-state" data-tone={state.tone}>
            {state.label}
          </span>
        </div>
        <p className="sws-routine-meta">
          <span data-routine-cadence>{routineCadenceLabel(task.schedule)}</span>
          {showNext ? (
            <span>
              Next <time dateTime={task.nextRunAt!}>{routineRunTimeLabel(task.nextRunAt!)}</time>
            </span>
          ) : null}
          {task.lastRunAt && !showNext ? (
            <span>
              Last ran <time dateTime={task.lastRunAt}>{routineRunTimeLabel(task.lastRunAt)}</time>
            </span>
          ) : null}
          {/* A started thread is an action below; until then, say where runs will go. */}
          {task.threadId && onOpenThread ? null : <span>{destination}</span>}
        </p>
        {task.brief && (task.brief.inputs.length > 0 || task.brief.output) ? (
          <ul className="sws-routine-brief">
            {task.brief.inputs.map((entry) => (
              <li key={entry.label}>
                <span>{entry.label}</span> {entry.location}
              </li>
            ))}
            {task.brief.output ? (
              <li>
                <span>Result</span> {task.brief.output}
              </li>
            ) : null}
          </ul>
        ) : null}
        {task.lastRunError ? (
          <p className="sws-routine-error" role="status">
            {task.lastRunError}
          </p>
        ) : null}
      </div>
      <div className="sws-routine-actions">
        <button
          type="button"
          className="sws-routines-button"
          aria-describedby={titleId}
          disabled={!canOperate || admissionBlocked || busy}
          onClick={() => onAct("run")}
        >
          <PlayIcon aria-hidden />
          Run now
        </button>
        {task.schedule.type === "manual" ? null : (
          <button
            type="button"
            className="sws-routines-button"
            aria-describedby={titleId}
            disabled={busy || !canOperate || (admissionBlocked && !task.enabled)}
            onClick={() => onAct("toggle")}
          >
            {task.enabled ? <PauseIcon aria-hidden /> : <PowerIcon aria-hidden />}
            {task.enabled ? "Pause" : "Enable"}
          </button>
        )}
        {task.threadId && onOpenThread ? (
          <button
            type="button"
            className="sws-routines-button"
            aria-describedby={titleId}
            aria-label="Open thread"
            data-routine-thread={task.threadId}
            onClick={() => onOpenThread(task.threadId as ThreadId)}
          >
            <ArrowUpRightIcon aria-hidden />
            Thread
          </button>
        ) : null}
      </div>
      {unknownRun && (
        <div className="project-notice sws-routine-retry">
          <p>
            The previous run may still be working. Check its thread before starting another run.
          </p>
          <button
            type="button"
            className="sws-routines-button"
            disabled={!canOperate || admissionBlocked || busy}
            onClick={onConfirmRetry}
          >
            I checked the previous run; start a new run
          </button>
        </div>
      )}
    </li>
  );
}
