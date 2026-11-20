import { useEffect, useMemo, useState } from "react";
import { requestConnectionRetry } from "../../connection/retryRequests";
import { paneWords } from "../../studio/assistantTerms";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { useEnvironment } from "../../state/environments";
import { useNamedEnvironments } from "../settings/useNamedEnvironments";
import { useThreadHistory, useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { useMachineStillChecking } from "../../studio/machineChecking";
import {
  hostReachOr,
  useHostReachStates,
  useHostDownNotes,
  useIdentityMismatchedHosts,
} from "../../studio/unreachableHosts";
import { useClockWhile } from "../../hooks/useClockWhile";
import { useTx } from "../../i18n";
import { machineLastSeenAt, useMachineLastSeenVersion } from "../../lib/machineLastSeen";
import {
  identityMismatchShown,
  machineReachDetail,
  machineReachWords,
} from "../../lib/machineStatus";
import { isMachineReachDown } from "@specweave-studio/client-runtime/connection";
import { useMachineNickname, useMachineNicknames } from "../../studio/machineNickname";
import { routedThreadReplyDisplayText } from "@specweave-studio/shared/routedMessage";
import { requestExecutionLabel, type ProjectExecutionScope } from "../../studio/projectDomain";
import { Button } from "../ui/button";
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
  const machineNames = useMachineNicknames();
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
        <div className="my-2 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={history.loading}
            onClick={() =>
              void load({
                environmentId: scope.environmentId,
                input: { threadId: scope.coordinatorThreadId! },
              })
            }
          >
            {history.loading ? "Loading…" : "Load earlier messages"}
          </Button>
        </div>
      )}
      {history.error && <p role="alert">{history.error}</p>}
      {thread.projection.messages.map((message) => {
        const text =
          message.role === "user" && message.createdBy === "user"
            ? routedThreadReplyDisplayText(message.text, machineNames)
            : message.text;
        return (
          <article key={message.id} className="project-message">
            <h3>{message.role === "user" ? "You" : "Coordinator"}</h3>
            <p className="project-muted">
              {requestExecutionLabel(message, thread.projection.runs, machine, providers)}
            </p>
            <ProjectMessageBody text={text} collapsible>
              <p className="whitespace-pre-wrap break-words">{text}</p>
            </ProjectMessageBody>
          </article>
        );
      })}
    </div>
  );
}

const RAW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** How often a shown offline notice asks its machine's connection to try again. */
export const OFFLINE_RETRY_MS = 30_000;

/**
 * Tries the machine again now, and every 30 s while the notice shows. The
 * connection itself retries at most 60 s apart for 30 minutes after it last
 * answered; after that its own wait grows to as much as 10 minutes.
 */
function OfflineRetry() {
  useEffect(() => {
    requestConnectionRetry();
    const timer = window.setInterval(requestConnectionRetry, OFFLINE_RETRY_MS);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      {" "}
      <button
        type="button"
        className="underline underline-offset-2"
        data-slot="offline-retry"
        onClick={requestConnectionRetry}
      >
        Try again
      </button>
    </>
  );
}

/** Also names declared hosts absent from the local catalog, so missing rows are never silently complete. */
export function ProjectThreadAvailability({
  scopes,
  personal,
}: {
  scopes: readonly ProjectExecutionScope[];
  /** The personal assistant says topics where a project says threads. */
  personal?: boolean;
}) {
  const say = paneWords(personal);
  const { environments } = useNamedEnvironments();
  const nickname = useMachineNicknames();
  const stillChecking = useMachineStillChecking();
  const reach = useHostReachStates();
  const identityMismatched = useIdentityMismatchedHosts();
  const notes = useHostDownNotes();
  const tx = useTx();
  useMachineLastSeenVersion();
  const down = [...new Set(scopes.map((scope) => scope.environmentId))].some((environmentId) => {
    const state = reach.get(environmentId);
    return state !== undefined && isMachineReachDown(state);
  });
  // "Last answered 5m ago" ages while the notice shows.
  const now = useClockWhile(down);
  return (
    <>
      {[...new Set(scopes.map((scope) => scope.environmentId))].map((environmentId) => {
        const environment = environments.find((entry) => entry.environmentId === environmentId);
        // A machine never saved here has no label: its nickname names it, never its raw id.
        const known = nickname(environmentId);
        const name =
          environment?.label ??
          (known === environmentId && RAW_ID.test(known) ? "another machine" : known);
        const state = environment
          ? hostReachOr(reach.get(environmentId), environment.connection)
          : undefined;
        if (state === "connected") return null;
        // While the page is still finding out, it says so instead of "not connected".
        if (stillChecking(environmentId))
          return (
            <p
              key={environmentId}
              className="project-notice"
              role="status"
              data-checking-thread-host={environmentId}
            >
              Checking {name}…
            </p>
          );
        const mismatched = identityMismatchShown(state, identityMismatched.has(environmentId));
        const words =
          environment && state
            ? machineReachWords(
                state,
                environment.connection.phase,
                mismatched,
                notes.get(environmentId) ?? null,
              )
            : null;
        // Reconnecting, connecting and catching up are calm: the threads below
        // keep their groups, and nothing is wrong yet.
        if (words !== null && state !== undefined && !isMachineReachDown(state))
          return (
            <p
              key={environmentId}
              className="project-notice"
              role="status"
              data-reach-state={state}
              data-settling-thread-host={environmentId}
            >
              {tx(words.headline, { machine: name })}
            </p>
          );
        const detail =
          words === null
            ? null
            : machineReachDetail(
                words,
                environment?.connection.lastConnectedAt ?? machineLastSeenAt(environmentId),
                now,
                tx,
              );
        return (
          <p
            key={environmentId}
            className="project-notice"
            role="status"
            data-reach-state={state}
            data-unavailable-thread-host={environmentId}
          >
            {words ? tx(words.headline, { machine: name }) : `This app is not connected to ${name}`}{" "}
            — {say("the thread list may be incomplete. Cached threads may be out of date.")}
            {detail ? ` ${detail}.` : null}
            {words?.hint ? ` ${tx(words.hint)}` : null}
            {/* Retrying never reaches a machine whose address answers as another one. */}
            {environment && !mismatched ? <OfflineRetry /> : null}
          </p>
        );
      })}
    </>
  );
}
