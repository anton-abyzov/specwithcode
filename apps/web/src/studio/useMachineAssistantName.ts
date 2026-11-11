import { DEFAULT_PERSONAL_ASSISTANT_NAME } from "@specweave-studio/contracts";
import { useMemo } from "react";

import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { findMachineAssistant } from "./personalAssistant";

/**
 * What a machine's personal assistant is called: its title, or the default
 * name while it has none. Without `environmentId` it is this device's machine.
 */
export function useMachineAssistantName(environmentId?: string | null): string {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machine = environmentId ?? primaryEnvironmentId;
  return useMemo(() => {
    if (machine == null) return DEFAULT_PERSONAL_ASSISTANT_NAME;
    const title = findMachineAssistant(projects, machine)?.title.trim();
    return title ? title : DEFAULT_PERSONAL_ASSISTANT_NAME;
  }, [projects, machine]);
}
