import { useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { logicalCoordinator } from "../../studio/projectDomain";
import {
  linkMemberOf,
  pendingSupersedes,
  projectLink,
  replicaMembers,
} from "../../studio/projectLink";
import { useLinkMachines } from "./useLinkMachines";

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
 * member holds a read-only replica of the coordinator's notes, goal and
 * instructions, so a takeover starts with them, and a coordinator that a
 * member took over from gives way when it is back. It never moves the
 * coordinator on its own.
 */
export function CoordinatorSync() {
  const projects = useProjects();
  const machines = useLinkMachines();
  const digest = useAtomCommand(projectLink.digest, { reportFailure: false });
  const preview = useAtomCommand(projectLink.preview, { reportFailure: false });
  const replicate = useAtomCommand(projectLink.replicate, { reportFailure: false });
  const supersede = useAtomCommand(projectLink.supersede, { reportFailure: false });
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
  const demoted = useRef(new Map<string, number>());

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), SYNC_EVERY_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (running.current || groups.length === 0) return;
    running.current = true;
    const ready = (project: EnvironmentProject) => machines.takeoverReady(project.environmentId);
    void (async () => {
      try {
        for (const members of groups) {
          for (const { successor, previous } of pendingSupersedes(members)) {
            const binding = successor.workspaceSettings?.coordinatorBinding;
            const identity = successor.workspaceSettings?.logicalProject;
            if (!binding || !identity || !ready(successor) || !ready(previous)) continue;
            const key = `${previous.environmentId}:${previous.id}:${binding.operationId}`;
            if (Date.now() - (demoted.current.get(key) ?? 0) < SYNC_EVERY_MS) continue;
            demoted.current.set(key, Date.now());
            await supersede({
              environmentId: previous.environmentId,
              input: {
                projectId: previous.id,
                logicalProjectId: identity.id,
                successor: linkMemberOf(successor),
                coordinatorBinding: binding,
              },
            });
          }
          const coordinator = logicalCoordinator(members)?.member;
          if (!coordinator || !ready(coordinator)) continue;
          const targets = replicaMembers(coordinator, members).filter(ready);
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
