import {
  STUDIO_PROJECT_FILE_NAME,
  type EnvironmentId,
  type StudioProjectFile,
  type StudioProjectFileScript,
} from "@specweave-studio/contracts";
import { parseStudioProjectFile } from "@specweave-studio/shared/studioProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<StudioProjectFileScript> = [];

export interface StudioProjectFileState {
  /**
   * - `valid`: specweave-studio.json exists and decoded.
   * - `invalid`: specweave-studio.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable specweave-studio.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: StudioProjectFile | null;
  scripts: ReadonlyArray<StudioProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `specweave-studio.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useStudioProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): StudioProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", STUDIO_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseStudioProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `specweave-studio.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useStudioProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<StudioProjectFileScript> {
  return useStudioProjectFileState(environmentId, cwd).scripts;
}
