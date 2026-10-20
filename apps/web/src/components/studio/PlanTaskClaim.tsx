import { useMemo } from "react";
import type {
  EnvironmentId,
  ProjectPlanActor,
  ProjectPlanSnapshot,
  ProjectPlanTask,
  ThreadId,
} from "@specweave-studio/contracts";
import { useEnvironments } from "../../state/environments";

export interface PlanClaimMachine {
  readonly label: string;
  readonly connected: boolean;
}
export type PlanClaimMachines = (environmentId: EnvironmentId) => PlanClaimMachine;

/** The machine running a claiming thread, when it is not the machine serving this plan. */
export function claimMachine(
  owner: ProjectPlanActor | null | undefined,
  here: EnvironmentId,
): EnvironmentId | null {
  return owner?.kind === "thread" &&
    owner.environmentId !== undefined &&
    owner.environmentId !== here
    ? owner.environmentId
    : null;
}

/** Names and reachability of the machines holding claims in this plan. */
export function usePlanClaimMachines(
  snapshot: ProjectPlanSnapshot | null | undefined,
): PlanClaimMachines {
  const { environments } = useEnvironments();
  return useMemo(() => {
    const byId = new Map(environments.map((item) => [item.environmentId, item]));
    const saved = new Map(
      (snapshot?.native?.machines ?? []).map((item) => [item.environmentId, item.label]),
    );
    return (environmentId) => {
      const environment = byId.get(environmentId);
      return {
        label: environment?.label || saved.get(environmentId) || "another machine",
        connected: environment?.connection.phase === "connected",
      };
    };
  }, [environments, snapshot]);
}

/** Who holds a plan task, on which machine, and whether that claim is stale or contested. */
export function PlanTaskClaim({
  task,
  here,
  machines,
  onOpenThread,
}: {
  task: ProjectPlanTask;
  here: EnvironmentId;
  machines: PlanClaimMachines;
  onOpenThread: (id: ThreadId) => void;
}) {
  const owner = task.owner;
  const elsewhere = claimMachine(owner, here);
  const holder = elsewhere ? machines(elsewhere) : null;
  const conflict = task.claimConflict;
  const loser = conflict?.owner;
  const loserMachine = claimMachine(loser, here);
  const loserLabel =
    loser?.kind === "thread"
      ? `thread ${loser.threadId} on ${loserMachine ? machines(loserMachine).label : "this machine"}`
      : "you";
  return (
    <>
      {owner?.kind === "thread" && holder ? (
        <>
          Claimed on {holder.label} · thread {owner.threadId}
          {!holder.connected && (
            <strong className="project-plan-claim-stale">
              {" "}
              · Stale · {holder.label} unreachable · only you can release it
            </strong>
          )}
        </>
      ) : owner?.kind === "thread" ? (
        <button className="project-text-link" onClick={() => onOpenThread(owner.threadId)}>
          Assigned thread: {owner.threadId}
        </button>
      ) : owner ? (
        "Assigned to you"
      ) : (
        "Unassigned"
      )}
      {conflict && (
        <strong className="project-plan-claim-conflict">
          {" "}
          · Conflict · {loserLabel} also claimed it while the machines were apart; the earlier claim
          stands
        </strong>
      )}
    </>
  );
}
