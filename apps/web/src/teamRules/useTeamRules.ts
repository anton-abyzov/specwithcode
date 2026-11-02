import type { EnvironmentId } from "@specweave-studio/contracts";
import { useMemo } from "react";

import { useEnvironment } from "../state/environments";
import { teamRulesFromSummary } from "./teamRulesView";

/** The rules a machine reported. A build or server without them reads as no rules. */
export function useTeamRules(environmentId: EnvironmentId | null | undefined) {
  const summary = useEnvironment(environmentId ?? null)?.serverConfig?.teamRules;
  return useMemo(() => teamRulesFromSummary(summary), [summary]);
}
