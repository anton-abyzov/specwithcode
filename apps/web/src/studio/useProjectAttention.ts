import { projectRemoteAttentionAtom } from "./fleet";
import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { EnvironmentId } from "@specweave-studio/contracts";
import type {
  EnvironmentShellState,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import {
  aggregateProjectAttention,
  type AttentionMember,
} from "@specweave-studio/client-runtime/state/projectAttention";
import { environmentShell } from "../state/shell";
import {
  expandAttentionProjects,
  projectAttentionRoots,
  type AttentionProjectMember,
} from "./projectAttentionScope";
import { useUnreachableHosts } from "./unreachableHosts";
import { useAttentionRaise } from "./attentionRaise";

export { expandAttentionProjects, projectAttentionRoots, type AttentionProjectMember };

/**
 * How current a machine's view of one project is. A machine whose project list
 * is live has reported every project it has, so a project missing from that list
 * (deleted there, or a linked member that was never added) has nothing left to
 * wait for. Reading it as "empty" kept the machine "catching up" forever.
 */
export function memberFreshness(
  shell: Pick<EnvironmentShellState, "snapshot" | "status">,
  projectId: string,
  unreachable: boolean,
): AttentionMember["freshness"] {
  if (unreachable) return "offline";
  if (Option.isNone(shell.snapshot)) return "empty";
  if (shell.snapshot.value.projects.some((p) => p.id === projectId)) return shell.status;
  return shell.status === "live" ? "live" : "empty";
}

type RemoteWorkers = NonNullable<AttentionMember["remoteWorkers"]>;
const sameRemoteWorkers = (left: RemoteWorkers | undefined, right: RemoteWorkers | undefined) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((worker, index) => {
      const other = right[index]!;
      return (
        worker.environmentId === other.environmentId &&
        worker.remoteThreadId === other.remoteThreadId &&
        worker.state === other.state
      );
    }));

/** Whether two readings say the same about every member, so the earlier one can stand. */
export function sameAttentionMembers(
  left: readonly AttentionMember[],
  right: readonly AttentionMember[],
): boolean {
  return (
    left.length === right.length &&
    left.every((member, index) => {
      const other = right[index]!;
      return (
        member.environmentId === other.environmentId &&
        member.projectId === other.projectId &&
        member.coordinatorThreadId === other.coordinatorThreadId &&
        member.freshness === other.freshness &&
        member.includeUserRoots === other.includeUserRoots &&
        member.remoteWorkersComplete === other.remoteWorkersComplete &&
        sameRemoteWorkers(member.remoteWorkers, other.remoteWorkers)
      );
    })
  );
}

export function useAttentionMembers(projects: readonly AttentionProjectMember[]) {
  const unreachable = useUnreachableHosts();
  const observations = useMemo(
    () =>
      Atom.make((get): AttentionMember[] => {
        const next = expandAttentionProjects(projects).map((project): AttentionMember => {
          const shell = get(
            environmentShell.stateValueAtom(EnvironmentId.make(project.environmentId)),
          );
          const remote = get(
            projectRemoteAttentionAtom(
              JSON.stringify({ environmentId: project.environmentId, projectId: project.id }),
            ),
          );
          return {
            includeUserRoots: Boolean(project.workspaceSettings?.logicalProject),
            remoteWorkers: remote.workers,
            remoteWorkersComplete: remote.complete,
            environmentId: project.environmentId,
            projectId: project.id,
            coordinatorThreadId:
              project.workspaceSettings?.coordinatorThreadId ?? `project-coordinator:${project.id}`,
            freshness: memberFreshness(shell, project.id, unreachable.has(project.environmentId)),
          };
        });
        // Each shell update and each remote worker poll reads the members again. Most
        // say what the last one said; the same array then stands, so the project
        // counts built from it are not built again.
        const previous = Option.getOrNull(get.self<AttentionMember[]>());
        return previous !== null && sameAttentionMembers(previous, next) ? previous : next;
      }),
    [projects, unreachable],
  );
  return useAtomValue(observations);
}
export function useProjectAttention(
  threads: readonly EnvironmentThreadShell[],
  projects: readonly AttentionProjectMember[],
) {
  const members = useAttentionMembers(projects);
  const raises = useAttentionRaise();
  return useMemo(
    () =>
      aggregateProjectAttention({
        members,
        roots: projectAttentionRoots(threads, members),
        threads,
        raises,
      }),
    [members, threads, raises],
  );
}
