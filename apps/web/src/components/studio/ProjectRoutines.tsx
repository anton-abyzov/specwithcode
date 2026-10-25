import { useId, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
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
import { RoutineQuickForm } from "./RoutineQuickForm";

export function ProjectRoutines({
  environmentId,
  projectId,
  projectKey,
  canOperate,
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
  onOpenThread?: (threadId: ThreadId) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
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
  const headingId = useId();
  const tasks = query.data?.tasks.filter((t) => t.projectId === projectId) ?? [];
  const settingsSearch = { project: projectKey, machine: environmentId };
  async function act(task: ScheduledTask, kind: "toggle" | "run") {
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
        query.refresh();
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
    machineLabel ? `On ${machineLabel}` : null,
    tasks.length > 0 ? routineCountsLabel(tasks) : null,
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
      {(admissionBlocked || !canOperate) && (
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
        query.error ? null : (
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
        <ul className="sws-routines-list">
          {tasks.map((task) => (
            <RoutineRow
              key={task.id}
              task={task}
              busy={busy !== null}
              canOperate={canOperate}
              admissionBlocked={admissionBlocked}
              unknownRun={unknownRun?.taskId === task.id}
              onAct={(kind) => void act(task, kind)}
              onConfirmRetry={() => {
                if (inFlight.current || !canOperate || admissionBlocked || !unknownRun) return;
                receipts.acknowledge(unknownRun.commandId);
                setUnknownRun(null);
                void act(task, "run");
              }}
              onOpenThread={onOpenThread}
            />
          ))}
        </ul>
      )}
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
