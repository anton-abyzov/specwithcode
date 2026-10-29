import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
} from "@specweave-studio/contracts";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { linkedMemory, linkedMemoryGroups, syncLinkedMemory } from "../../studio/linkedMemory";

/** How often linked copies exchange memory while their machines are reachable. */
const SYNC_EVERY_MS = 60_000;

/**
 * Keeps project memory the same on every reachable copy of a linked project,
 * in both directions: the last writer wins per file and the other version is
 * kept beside it. Memory larger than one message goes over in pages, and each
 * pass ends by checking both copies agree. Machines too old for two-way memory
 * are left out.
 */
export function LinkedMemorySync() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const settings = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const operate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const read = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const exportMemory = useAtomCommand(linkedMemory.export, { reportFailure: false });
  const mergeMemory = useAtomCommand(linkedMemory.merge, { reportFailure: false });
  const groups = useMemo(() => {
    const byId = new Map(environments.map((item) => [item.environmentId, item]));
    const ready = (environmentId: EnvironmentId) => {
      const environment = byId.get(environmentId);
      return (
        environment?.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.linkedMemorySync === true &&
        settings.has(environmentId) &&
        operate.has(environmentId) &&
        read.has(environmentId)
      );
    };
    return linkedMemoryGroups(
      projects,
      ready,
      (environmentId) => byId.get(environmentId)?.label ?? "Machine",
    );
  }, [projects, environments, settings, operate, read]);
  const signature = JSON.stringify(groups);
  const running = useRef(false);

  const sync = useEffectEvent(() => {
    if (running.current || groups.length === 0) return;
    running.current = true;
    void syncLinkedMemory(groups, {
      exportMemory: async (member, options) => {
        const result = await exportMemory({
          environmentId: member.environmentId,
          input: { projectId: member.projectId, ...options },
        });
        return result._tag === "Success" ? result.value : null;
      },
      mergeMemory: async (member, peer, memory) => {
        const result = await mergeMemory({
          environmentId: member.environmentId,
          input: { projectId: member.projectId, peer, export: memory },
        });
        return result._tag === "Success";
      },
    }).finally(() => {
      running.current = false;
    });
  });

  useEffect(() => {
    const timer = setInterval(sync, SYNC_EVERY_MS);
    return () => clearInterval(timer);
  }, []);

  // A copy that just came online or was just linked syncs without waiting a full minute.
  useEffect(() => {
    if (signature !== "[]") sync();
  }, [signature]);

  return null;
}
