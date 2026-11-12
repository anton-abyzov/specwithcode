import { useMemo } from "react";
import { remoteWorkerLaunchers } from "@specweave-studio/client-runtime/state/projectAttention";
import { useAideEnabled } from "../hooks/useSettings";
import { useProjects } from "../state/entities";
import { visibleWithAide } from "./personalAssistant";
import { useAttentionMembers } from "./useProjectAttention";

/**
 * The coordinator machine of each remote worker thread, keyed as
 * attentionOwnerMachine reads it. Built from the same projects and remote
 * worker readings as the Overview, so alerts pick the same owner machine as
 * the sidebar and Overview counts. Empty until those readings arrive.
 */
export function useRemoteWorkerLaunchers(): ReadonlyMap<string, string> {
  const aideEnabled = useAideEnabled();
  const catalogProjects = useProjects();
  const projects = useMemo(
    () => visibleWithAide(catalogProjects, aideEnabled),
    [catalogProjects, aideEnabled],
  );
  const members = useAttentionMembers(projects);
  return useMemo(() => remoteWorkerLaunchers(members), [members]);
}
