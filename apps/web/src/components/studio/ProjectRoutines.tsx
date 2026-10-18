import { useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ScheduledTask,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { createScopedProjectSendReceipt } from "../../studio/projectWorkspaceModel";
import { randomUUID } from "../../lib/utils";

export function ProjectRoutines({
  environmentId,
  projectId,
  projectKey,
  canOperate,
  admissionBlocked,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectKey: string;
  canOperate: boolean;
  admissionBlocked: boolean;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled);
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [unknownRun, setUnknownRun] = useState<{ taskId: string; commandId: string } | null>(null);
  const receipts = useMemo(
    () => createScopedProjectSendReceipt(environmentId, projectId, "routine"),
    [environmentId, projectId],
  );
  const tasks = query.data?.tasks.filter((t) => t.projectId === projectId) ?? [];
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
  return (
    <section className="project-settings-section">
      <div className="project-section-title">
        <h2>Project routines</h2>
        <Link
          className="project-text-link"
          to="/settings/scheduled-tasks"
          search={{ project: projectKey, machine: environmentId }}
        >
          Manage routines
        </Link>
      </div>
      <p className="project-muted">
        Schedules belong to this project and run on this host. An enabled schedule is separate from
        a completed task.
      </p>
      {(admissionBlocked || !canOperate) && (
        <p className="project-notice">
          This project cannot admit new routine runs while paused, archived, disconnected or
          read-only.
        </p>
      )}
      {query.error && <p role="alert">{query.error}</p>}
      {error && <p role="alert">{error}</p>}
      {query.isPending && !query.data ? (
        <p role="status">Loading routines…</p>
      ) : tasks.length === 0 ? (
        <p className="project-muted">
          No routines for this project yet. Manage routines to create a schedule with this project
          selected.
        </p>
      ) : (
        tasks.map((task) => (
          <article className="project-routine" key={task.id}>
            <div>
              <h3>{task.title}</h3>
              <p className="project-muted">
                {task.enabled ? "Enabled" : "Paused"} ·{" "}
                {task.threadId ? "Continues its thread" : "Goes to the coordinator"}
              </p>
              <p className="project-muted">
                Next run:{" "}
                {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "No run scheduled"}
              </p>
              {task.lastRunError && <p role="status">{task.lastRunError}</p>}
            </div>
            {unknownRun?.taskId === task.id && (
              <div className="project-notice">
                <p>
                  The previous run may still be working. Check its thread before starting another
                  run.
                </p>
                <button
                  className="project-control"
                  disabled={!canOperate || admissionBlocked || busy !== null}
                  onClick={() => {
                    if (inFlight.current || !canOperate || admissionBlocked) return;
                    receipts.acknowledge(unknownRun.commandId);
                    setUnknownRun(null);
                    void act(task, "run");
                  }}
                >
                  I checked the previous run; start a new run
                </button>
              </div>
            )}
            <div className="project-actions">
              <button
                className="project-control"
                disabled={!canOperate || admissionBlocked || busy !== null}
                onClick={() => void act(task, "run")}
              >
                Run now
              </button>
              <button
                className="project-control"
                disabled={busy !== null || !canOperate || (admissionBlocked && !task.enabled)}
                onClick={() => void act(task, "toggle")}
              >
                {task.enabled ? "Pause" : "Enable"}
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
