import { useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { logicalCoordinator } from "../../studio/projectDomain";
import {
  linkMemberOf,
  projectLink,
  replicaMembers,
} from "../../studio/projectLink";
import { membersSyncRequests } from "../../studio/linkedMembersSync";
import { drivenPairs } from "../../studio/serverLinkedSync";
import { useLinkMachines } from "./useLinkMachines";
import { useRetiredMachineRecords } from "../settings/useReplacedMachineRecords";
import { useServerSyncCoverage } from "./useServerSyncCoverage";

/** How often copies are compared while both machines are reachable. */
const SYNC_EVERY_MS = 60_000;

/** Copies of each shared project the app sees on two or more machines. */
export function sharedGroups(projects: ReadonlyArray<EnvironmentProject>): EnvironmentProject[][] {
  const groups = new Map<string, EnvironmentProject[]>();
  for (const project of projects) {
    const id = project.workspaceSettings?.logicalProject?.id;
    if (!id) continue;
    groups.set(id, [...(groups.get(id) ?? []), project]);
  }
  return [...groups.values()].filter(
    (members) => new Set(members.map((member) => member.environmentId)).size > 1,
  );
}

/**
 * Keeps shared projects consistent while their machines are reachable: each
 * member holds a read-only replica of the notes, goal and instructions of the
 * machine project-wide settings are read from. It never makes a coordinator
 * give way and never moves one. Pairs the machines' servers keep in step
 * themselves, with no window open, are left to them. Member copies also take
 * the coordinator's member list, so machines linked later are members there.
 */
export function CoordinatorSync() {
  const projects = useProjects();
  const machines = useLinkMachines();
  // Old records of machines that joined again never name the coordinator that replicates.
  const retiredRecords = useRetiredMachineRecords();
  const retired = useRef(retiredRecords);
  retired.current = retiredRecords;
  const digest = useAtomCommand(projectLink.digest, { reportFailure: false });
  const preview = useAtomCommand(projectLink.preview, { reportFailure: false });
  const replicate = useAtomCommand(projectLink.replicate, { reportFailure: false });
  const syncMembers = useAtomCommand(projectLink.syncMembers, { reportFailure: false });
  const { environments } = useEnvironments();
  const membersCapable = (environmentId: string) =>
    environments.find((item) => item.environmentId === environmentId)?.serverConfig?.environment
      .capabilities.linkedMembersSync === true;
  const coverage = useServerSyncCoverage();
  const groups = useMemo(() => sharedGroups(projects), [projects]);
  // Changes to bindings, settings or reachability start a pass at once; notes are polled.
  const signature = JSON.stringify(
    groups.map((members) =>
      members.map((member) => [
        member.environmentId,
        member.id,
        member.workspaceSettings?.revision ?? 0,
        machines.takeoverReady(member.environmentId),
      ]),
    ),
  );
  const [tick, setTick] = useState(0);
  const running = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), SYNC_EVERY_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (running.current || groups.length === 0) return;
    running.current = true;
    const ready = (project: EnvironmentProject) => machines.takeoverReady(project.environmentId);
    const copy = (project: EnvironmentProject) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    });
    void (async () => {
      try {
        // Pairs the machines' servers keep in step themselves are left to them.
        const covered = await coverage(
          groups.flatMap((members) => {
            const coordinator = logicalCoordinator(members, retired.current)?.member;
            return [
              ...(coordinator
                ? drivenPairs(
                    replicaMembers(coordinator, members).map((member) => [
                      copy(coordinator),
                      copy(member),
                    ]),
                    "replica",
                  )
                : []),
            ];
          }),
        );
        for (const members of groups) {
          const coordinator = logicalCoordinator(members, retired.current)?.member;
          if (!coordinator || !ready(coordinator)) continue;
          // A member refuses a list it cannot trust; the next pass retries.
          for (const request of membersSyncRequests(coordinator, members, membersCapable)) {
            if (!machines.takeoverReady(request.environmentId)) continue;
            await syncMembers(request);
          }
          const targets = replicaMembers(coordinator, members).filter(
            (member) => ready(member) && !covered("replica", copy(coordinator), copy(member)),
          );
          const identity = coordinator.workspaceSettings?.logicalProject;
          if (targets.length === 0 || !identity) continue;
          const own = await digest({
            environmentId: coordinator.environmentId,
            input: { projectId: coordinator.id },
          });
          if (own._tag === "Failure") continue;
          const from = linkMemberOf(coordinator);
          let content: Awaited<ReturnType<typeof preview>> | null = null;
          for (const member of targets) {
            const held = await digest({
              environmentId: member.environmentId,
              input: { projectId: member.id },
            });
            if (held._tag === "Failure") continue;
            const replica = held.value.replica;
            if (
              replica?.digest === own.value.digest &&
              replica.from.environmentId === from.environmentId &&
              replica.from.projectId === from.projectId
            )
              continue;
            content ??= await preview({
              environmentId: coordinator.environmentId,
              input: { projectId: coordinator.id },
            });
            if (content._tag === "Failure") break;
            // A note changed between the two reads: the machine refuses, the next pass retries.
            await replicate({
              environmentId: member.environmentId,
              input: {
                projectId: member.id,
                replica: {
                  from,
                  logicalProjectId: identity.id,
                  digest: own.value.digest,
                  fromEpoch: coordinator.workspaceSettings?.coordinatorBinding?.epoch ?? 0,
                  replicatedAt: new Date().toISOString(),
                  goal: content.value.goal,
                  instructions: content.value.instructions,
                  notes: content.value.notes,
                  notesTruncated: content.value.notesTruncated,
                },
              },
            });
          }
        }
      } finally {
        running.current = false;
      }
    })();
    // `signature` stands for `groups` and readiness; `tick` polls notes.
  }, [signature, tick]);

  return null;
}
