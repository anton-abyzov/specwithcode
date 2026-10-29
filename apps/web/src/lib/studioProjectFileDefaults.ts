import {
  STUDIO_PROJECT_FILE_NAME,
  type EnvironmentId,
  type StudioProjectFile,
} from "@specweave-studio/contracts";
import { parseStudioProjectFile } from "@specweave-studio/shared/studioProjectFile";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Read and decode the project's checked-in `specweave-studio.json`.
 *
 * Imperative counterpart to `useStudioProjectFileState` for the new-thread path,
 * which resolves defaults at call time rather than render time. The file
 * query atom caches per (environment, cwd), so repeat calls don't re-fetch.
 * Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files
 * resolve to null.
 */
export async function readStudioProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<StudioProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, STUDIO_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    STUDIO_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseStudioProjectFile(data.contents);
}
