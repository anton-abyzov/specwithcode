import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectId,
  TeamRulesSummary,
  ThreadId,
} from "@specweave-studio/contracts";

import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

/**
 * The rules for one project or thread: the machine's plus its zones and
 * repository. An older server has no such call, so it reads as the machine's.
 */
export function useFolderTeamRulesSummary(
  environmentId: EnvironmentId | null | undefined,
  projectId: ProjectId | null | undefined,
  threadId?: ThreadId | null,
): TeamRulesSummary | undefined {
  const machine = useAtomValue(serverEnvironment.configValueAtom(environmentId ?? null))?.teamRules;
  const folder = useEnvironmentQuery(
    environmentId === null ||
      environmentId === undefined ||
      projectId === null ||
      projectId === undefined
      ? null
      : serverEnvironment.teamRulesForFolder({
          environmentId,
          input: {
            projectId,
            ...(threadId === null || threadId === undefined ? {} : { threadId }),
          },
        }),
  );
  return folder.data?.teamRules ?? machine;
}
