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

export function useAttentionMembers(projects: readonly AttentionProjectMember[]) {
  const unreachable = useUnreachableHosts();
  const observations = useMemo(
    () =>
      Atom.make((get): AttentionMember[] =>
        expandAttentionProjects(projects).map((project) => {
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
        }),
      ),
    [projects, unreachable],
  );
  return useAtomValue(observations);
}
export function useProjectAttention(
  threads: readonly EnvironmentThreadShell[],
  projects: readonly AttentionProjectMember[],
) {
  const members = useAttentionMembers(projects);
  return useMemo(
    () =>
      aggregateProjectAttention({
        members,
        roots: projectAttentionRoots(threads, members),
        threads,
      }),
    [members, threads],
  );
}
