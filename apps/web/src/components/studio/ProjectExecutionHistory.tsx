import { useMemo, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { useThreadHistory, useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { useMachineNickname, useMachineNicknames } from "../../studio/machineNickname";
import { requestExecutionLabel, type ProjectExecutionScope } from "../../studio/projectDomain";
import { ProjectMessageBody } from "./ProjectMessageBody";
import { useProviderEntries } from "./shell/ModelBadge";

/**
 * The checkouts that ran this project's coordinator before this one, newest first. A handoff or
 * takeover names its predecessor on the incoming binding and the relinquished binding keeps its
 * own, so the chain is followed through the members this machine can read. A link or "Copy files
 * only" adds members without moving the coordinator, so they never appear here.
 */
export function coordinatorPredecessorKeys(
  project: EnvironmentProject,
  members: readonly EnvironmentProject[],
): string[] {
  const byKey = new Map(members.map((member) => [`${member.environmentId}:${member.id}`, member]));
  const keys: string[] = [];
  let predecessor = project.workspaceSettings?.coordinatorBinding?.predecessor;
  while (predecessor) {
    const key = `${predecessor.environmentId}:${predecessor.projectId}`;
    if (keys.includes(key) || key === `${project.environmentId}:${project.id}`) break;
    keys.push(key);
    predecessor = byKey.get(key)?.workspaceSettings?.coordinatorBinding?.predecessor;
  }
  return keys;
}

export function ProjectExecutionHistory({
  project,
  members,
  scopes,
}: {
  project: EnvironmentProject;
  members: readonly EnvironmentProject[];
  scopes: readonly ProjectExecutionScope[];
}) {
  if (!project.workspaceSettings?.logicalProject) return null;
  const chain = coordinatorPredecessorKeys(project, members);
  // A predecessor that never ran a coordinator has no history to hand over.
  const predecessors = scopes.filter(
    (scope) =>
      scope.coordinatorThreadId && chain.includes(`${scope.environmentId}:${scope.projectId}`),
  );
  if (predecessors.length === 0) return null;
  return (
    <section
      className="project-notice"
      data-slot="handoff-history"
      aria-label="Coordinator handoff history"
    >
      <p>
        Continued from another machine. This session started fresh with the retained messages,
        project context and a committed Git checkpoint.
      </p>
      {predecessors.map((scope) => (
        <HistorySegment key={`${scope.environmentId}:${scope.projectId}`} scope={scope} />
      ))}
      <details>
        <summary>What a handoff does not move</summary>
        <p>
          Native provider sessions, live processes, credentials and uncommitted files stay behind.
          An offline machine may have newer history that is unavailable here. Workers remain on
          their own machines.
        </p>
      </details>
    </section>
  );
}
function HistorySegment({ scope }: { scope: ProjectExecutionScope }) {
  const [open, setOpen] = useState(false);
  const environment = useEnvironment(scope.environmentId);
  const label = environment?.label ?? scope.environmentId;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        Previous coordinator on {label} · Read only
        {environment?.connection.phase !== "connected" ? " · Offline" : ""}
      </summary>
      {open && scope.coordinatorThreadId ? <RetainedMessages scope={scope} label={label} /> : null}
    </details>
  );
}
function RetainedMessages({ scope, label }: { scope: ProjectExecutionScope; label: string }) {
  const machine = useMachineNickname(scope.environmentId, label);
  const ref = useMemo(
    () => scopeThreadRef(scope.environmentId, scope.coordinatorThreadId!),
    [scope.environmentId, scope.coordinatorThreadId],
  );
  const thread = useThreadProjection(ref);
  const history = useThreadHistory(ref);
  const load = useAtomCommand(threadEnvironment.loadEarlierHistory);
  const providers = useProviderEntries(scope.environmentId);
  if (!thread) return <p>History is unavailable. Connect {label} to load its retained messages.</p>;
  return (
    <div aria-label={`Retained coordinator messages on ${label}`}>
      {history.hasMoreHistory && (
        <button
          disabled={history.loading}
          onClick={() =>
            void load({
              environmentId: scope.environmentId,
              input: { threadId: scope.coordinatorThreadId! },
            })
          }
        >
          Load earlier messages
        </button>
      )}
      {history.error && <p role="alert">{history.error}</p>}
      {thread.projection.messages.map((message) => (
        <article key={message.id} className="project-message">
          <h3>{message.role === "user" ? "You" : "Coordinator"}</h3>
          <p className="project-muted">
            {requestExecutionLabel(message, thread.projection.runs, machine, providers)}
          </p>
          <ProjectMessageBody text={message.text} collapsible>
            <p className="whitespace-pre-wrap break-words">{message.text}</p>
          </ProjectMessageBody>
        </article>
      ))}
    </div>
  );
}

const RAW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** Also names declared hosts absent from the local catalog, so missing rows are never silently complete. */
export function ProjectThreadAvailability({
  scopes,
}: {
  scopes: readonly ProjectExecutionScope[];
}) {
  const { environments } = useEnvironments();
  const nickname = useMachineNicknames();
  return (
    <>
      {[...new Set(scopes.map((scope) => scope.environmentId))].map((environmentId) => {
        const environment = environments.find((entry) => entry.environmentId === environmentId);
        // A machine never saved here has no label: its nickname names it, never its raw id.
        const known = nickname(environmentId);
        const name =
          environment?.label ??
          (known === environmentId && RAW_ID.test(known) ? "another machine" : known);
        return environment?.connection.phase === "connected" ? null : (
          <p
            key={environmentId}
            className="project-notice"
            role="status"
            data-unavailable-thread-host={environmentId}
          >
            {environment ? `${name} is offline` : `This app is not connected to ${name}`} — the
            thread list may be incomplete. Cached threads may be out of date.
          </p>
        );
      })}
    </>
  );
}
