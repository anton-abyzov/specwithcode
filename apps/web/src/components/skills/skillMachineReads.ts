import type { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";

import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { projectWorkspace } from "../../studio/projectWorkspace";

/**
 * One machine's read of its own skills. "Available on" and the "Across
 * machines" table both go through here, so a machine is asked once and the two
 * views share the answer.
 */
export function useSkillMachineRead(input: {
  readonly environmentId: EnvironmentId;
  /** The project on that machine that carries the read; null when it has none. */
  readonly projectId: ProjectId | null;
  /** False for a fleet machine that is listed but cannot be reached. */
  readonly reachable: boolean;
  readonly userLevel: boolean;
  /** Only for the machine the view is open on: the folder or thread it reads. */
  readonly local?:
    | { readonly cwd?: string | undefined; readonly threadId?: ThreadId | undefined }
    | undefined;
}) {
  const environment = useEnvironment(input.environmentId);
  const connected = input.reachable && environment?.connection.phase === "connected";
  const query = useEnvironmentQuery(
    connected && input.projectId
      ? projectWorkspace.skills({
          environmentId: input.environmentId,
          input: {
            projectId: input.projectId,
            refresh: true,
            ...(input.userLevel ? { userLevel: true } : {}),
            ...(input.local && !input.userLevel
              ? {
                  ...(input.local.cwd ? { cwd: input.local.cwd } : {}),
                  ...(input.local.threadId ? { threadId: input.local.threadId } : {}),
                }
              : {}),
          },
        })
      : null,
  );
  return { environment, connected, query };
}
