import { useEffect, useMemo, useRef, useState } from "react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@specweave-studio/contracts";

import { useProjects } from "../../state/entities";
import { useNamedEnvironments } from "../settings/useNamedEnvironments";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { linkedPlanGroups, planLink, syncLinkedPlans } from "../../studio/planLink";
import { drivenPairs } from "../../studio/serverLinkedSync";
import { useServerSyncCoverage } from "./useServerSyncCoverage";

const SYNC_EVERY_MS = 60_000;

/**
 * Replicates the native plan of every shared project between its reachable
 * machines, so a task claimed on one machine is seen, and refused, on the
 * others, for pairs the machines' servers do not keep in step themselves. An
 * unreachable machine is skipped; its claims stay until the user releases them.
 */
export function LinkedPlanSync() {
  const projects = useProjects();
  const { environments } = useNamedEnvironments();
  const operate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const read = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const exportPlan = useAtomCommand(planLink.export, { reportFailure: false });
  const mergePlan = useAtomCommand(planLink.merge, { reportFailure: false });
  const coverage = useServerSyncCoverage();
  const groups = useMemo(() => {
    const byId = new Map(environments.map((item) => [item.environmentId, item]));
    return linkedPlanGroups(projects, (environmentId) => {
      const environment = byId.get(environmentId);
      return environment?.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.linkedPlans === true &&
        operate.has(environmentId) &&
        read.has(environmentId)
        ? // No placeholder: an empty name keeps the one the plan stores (the server's, from the
          // fleet), where a placeholder merged first would have stayed.
          { label: environment.label }
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
        // Pairs the machines' servers keep in step themselves are left to them.
        const covered = await coverage(drivenPairs(groups, "plan"));
        for (const members of groups)
          await syncLinkedPlans(members, {
            skipPair: (left, right) => covered("plan", left, right),
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
