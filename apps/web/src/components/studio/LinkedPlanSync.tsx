import { useEffect, useMemo, useRef, useState } from "react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@specweave-studio/contracts";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { linkedPlanGroups, planLink, syncLinkedPlans } from "../../studio/planLink";

const SYNC_EVERY_MS = 60_000;

/**
 * Replicates the native plan of every shared project between its reachable
 * machines, so a task claimed on one machine is seen, and refused, on the
 * others. An unreachable machine is skipped; its claims stay until the user
 * releases them.
 */
export function LinkedPlanSync() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const operate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const read = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const exportPlan = useAtomCommand(planLink.export, { reportFailure: false });
  const mergePlan = useAtomCommand(planLink.merge, { reportFailure: false });
  const groups = useMemo(() => {
    const byId = new Map(environments.map((item) => [item.environmentId, item]));
    return linkedPlanGroups(projects, (environmentId) => {
      const environment = byId.get(environmentId);
      return environment?.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.linkedPlans === true &&
        operate.has(environmentId) &&
        read.has(environmentId)
        ? { label: environment.label || "Another machine" }
        : null;
    });
  }, [projects, environments, operate, read]);
  const signature = JSON.stringify(
    groups.map((members) => members.map((member) => [member.environmentId, member.projectId])),
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
    void (async () => {
      try {
        for (const members of groups)
          await syncLinkedPlans(members, {
            exportPlan: async (member) => {
              const result = await exportPlan({
                environmentId: member.environmentId,
                input: { projectId: member.projectId },
              });
              return result._tag === "Success" ? result.value : null;
            },
            mergePlan: async (target, peer, exported) => {
              await mergePlan({
                environmentId: target.environmentId,
                input: { projectId: target.projectId, peer, export: exported },
              });
            },
          });
      } finally {
        running.current = false;
      }
    })();
    // `signature` stands for `groups`; `tick` polls for new claims.
  }, [signature, tick]);

  return null;
}
