/* File reads from the fixture's host: a missing file fails as the server reports it. */
import { ProjectReadFileError } from "@specweave-studio/contracts";

import { HOST_FILES } from "../hostFiles";

export function useProjectFileQuery(_environmentId: string, cwd: string, path: string | null) {
  const contents = path === null ? undefined : HOST_FILES.get(path);
  const readError =
    path === null || contents !== undefined
      ? null
      : new ProjectReadFileError({
          cwd,
          relativePath: path,
          failure: "operation_failed",
          operation: "realpath-target",
          cause: Object.assign(new Error("realpath"), { code: "ENOENT" }),
        });
  return {
    data: contents === undefined ? null : { contents, truncated: false },
    error: readError?.message ?? null,
    isPending: false,
    isNotFile: false,
    readError,
    refresh: () => {},
  };
}
