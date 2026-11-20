/**
 * The newer version each tracked skill's source holds, read from the same
 * status query the updates panel shows, so the page asks the machine once.
 */
import { useMemo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { skillFolderInput, skillLatestVersions, type SkillFolderScope } from "./SkillUpdate.logic";

const NONE: ReadonlyMap<string, string> = new Map();

export function useSkillLatestVersions(scope: SkillFolderScope): ReadonlyMap<string, string> {
  const query = useEnvironmentQuery(
    projectWorkspace.skillSources({
      environmentId: scope.environmentId,
      input: { ...skillFolderInput(scope), operation: "status" },
    }),
  );
  const statuses = query.data?.statuses;
  return useMemo(() => (statuses ? skillLatestVersions(statuses) : NONE), [statuses]);
}
