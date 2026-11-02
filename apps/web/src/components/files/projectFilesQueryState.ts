import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProjectListEntriesResult,
  ProjectReadFileError,
  type ProjectReadFileResult,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import {
  executeAtomQuery,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

const EMPTY_PROJECT_FILE_PATH = "";
const EMPTY_PROJECT_ENTRIES_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectListEntriesResult, never>(false),
);
const EMPTY_PROJECT_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("project-file-query:empty"));
/** A pending in-app write to the file, overlaying the query until confirmed. */
export function optimisticFileAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
) {
  return projectEnvironment.optimisticFile({ environmentId, cwd, relativePath });
}

// Dirty contents must survive a closed preview, including failed or unauthorized saves.
const unsavedFileMounts = new Map<ReturnType<typeof optimisticFileAtom>, () => void>();

function releaseUnsavedFile(atom: ReturnType<typeof optimisticFileAtom>): void {
  const unmount = unsavedFileMounts.get(atom);
  unsavedFileMounts.delete(atom);
  unmount?.();
}

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

interface ProjectFileQueryState extends ProjectQueryState<ProjectReadFileResult> {
  readonly readError: ProjectReadFileError | null;
  /** The path exists but is not a regular file, typically a directory. */
  readonly isNotFile: boolean;
}

function getProjectEntriesQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
) {
  return projectEnvironment.listEntries({
    environmentId,
    input: { cwd, ...(directoryPath !== undefined ? { directoryPath } : {}) },
  });
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: { cwd, relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH },
  });
}

export function setProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  if (!unsavedFileMounts.has(atom)) {
    unsavedFileMounts.set(atom, appAtomRegistry.mount(atom));
  }
  appAtomRegistry.set(atom, {
    confirmedAgainst: undefined,
    data: {
      relativePath,
      contents,
      byteLength: new TextEncoder().encode(contents).byteLength,
      truncated: false,
    },
  });
}

export function getOptimisticProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? null;
}

/** The contents the Files panel shows, read outside React so it is current within a frame. */
export function getProjectFileContents(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): string | undefined {
  const optimistic = getOptimisticProjectFileQueryData(environmentId, cwd, relativePath);
  if (optimistic) return optimistic.contents;
  const result = appAtomRegistry.get(getProjectFileQueryAtom(environmentId, cwd, relativePath));
  return Option.getOrUndefined(AsyncResult.value(result))?.contents;
}

export function getUnsavedProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  const optimistic = appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath));
  return optimistic?.confirmedAgainst === undefined ? (optimistic?.data ?? null) : null;
}

export function confirmProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): boolean {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimisticFile = appAtomRegistry.get(atom);
  if (optimisticFile?.data.contents !== contents) return false;

  const queryAtom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  const confirmed = {
    ...optimisticFile,
    confirmedAgainst: appAtomRegistry.get(queryAtom),
  };
  appAtomRegistry.set(atom, confirmed);
  releaseUnsavedFile(atom);
  appAtomRegistry.refresh(queryAtom);
  void executeAtomQuery(appAtomRegistry, queryAtom, {
    reportDefect: false,
    reportFailure: false,
  }).then((result) => {
    if (result._tag === "Success" && appAtomRegistry.get(atom) === confirmed) {
      appAtomRegistry.set(atom, null);
    }
  });
  return true;
}

export function resolveProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  data: ProjectReadFileResult | null,
): ProjectReadFileResult | null {
  if (relativePath === null) return data;
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? data;
}

export function clearProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  appAtomRegistry.set(atom, null);
  releaseUnsavedFile(atom);
}

function failureCause<A>(result: AsyncResult.AsyncResult<A, unknown>): unknown {
  return result._tag === "Failure" ? Cause.squash(result.cause) : null;
}

function errorMessage(cause: unknown): string | null {
  if (cause === null) return null;
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

const isProjectReadFileError = Schema.is(ProjectReadFileError);

/**
 * `gone`: this file can never be read as it is. `unavailable`: try again; no
 * answer, a dropped connection, or a filesystem error that may pass.
 */
export type ProjectFileRead =
  | { readonly _tag: "contents"; readonly contents: string }
  | { readonly _tag: "gone" }
  | { readonly _tag: "unavailable" };

export function isLastingReadFailure(cause: unknown): boolean {
  if (!isProjectReadFileError(cause) || cause.failure === undefined) return false;
  // A file or worktree that no longer resolves, or a file the server never reads, will not come
  // back on a retry.
  return (
    cause.failure !== "operation_failed" ||
    cause.operation === "realpath-target" ||
    cause.operation === "realpath-workspace-root" ||
    cause.reason === "protected"
  );
}

/** Reads a file fresh, for a caller that keeps only what it derives from it. */
export function useProjectFileReader(): (
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  maxBytes?: number,
) => Promise<ProjectFileRead> {
  const read = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
    reportDefect: false,
    refresh: true,
  });
  return useCallback(
    async (environmentId, cwd, relativePath, maxBytes) => {
      const result = await read({
        environmentId,
        input: { cwd, relativePath, ...(maxBytes === undefined ? {} : { maxBytes }) },
      });
      if (result._tag === "Success") return { _tag: "contents", contents: result.value.contents };
      return {
        _tag: isLastingReadFailure(squashAtomCommandFailure(result)) ? "gone" : "unavailable",
      };
    },
    [read],
  );
}

export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
): ProjectQueryState<ProjectListEntriesResult> {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const atom = canReadFiles
    ? getProjectEntriesQueryAtom(environmentId, cwd, directoryPath)
    : EMPTY_PROJECT_ENTRIES_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: fileAccess.isPending
      ? null
      : canReadFiles
        ? errorMessage(failureCause(result))
        : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: fileAccess.isPending || result.waiting,
    refresh,
  };
}

/**
 * Backing query for the project file picker: a debounced, bounded, file-only
 * server search. An empty query is a valid request — the index answers it
 * with frecency-ordered files, so the picker's initial view is recent files
 * without transferring the full workspace listing. `matchedQuery` is the
 * query the returned entries were computed for, so the caller can highlight
 * against results instead of half-typed input.
 */
export function useProjectFilePickerQuery(
  environmentId: EnvironmentId,
  cwd: string,
  query: string,
  limit: number,
  options?: { readonly imageOnly?: boolean },
) {
  const search = useProjectPathSearch(
    {
      environmentId,
      cwd,
      query,
      kind: "file",
      ...(options?.imageOnly ? { imageOnly: true } : {}),
    },
    limit,
    { allowEmptyQuery: true },
  );

  return {
    entries: search.isPending ? [] : search.entries,
    error: search.error,
    isPending: search.isPending,
    matchedQuery: search.searchedQuery,
  };
}

export function useProjectFileQuery(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  enabled = true,
): ProjectFileQueryState {
  // The caller decides what to read. A media path is not skipped here: a folder
  // named `assets.png` is only knowable as a folder from the read failure.
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const isQueryEnabled = enabled;
  const atom =
    enabled && canReadFiles
      ? getProjectFileQueryAtom(environmentId, cwd, relativePath)
      : EMPTY_PROJECT_FILE_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  const data = Option.getOrNull(AsyncResult.value(result));
  const optimisticResult = useAtomValue(
    optimisticFileAtom(environmentId, cwd, relativePath ?? EMPTY_PROJECT_FILE_PATH),
  );
  const optimisticFile = relativePath === null ? null : optimisticResult;
  const cause = failureCause(result);
  const readError = isProjectReadFileError(cause) ? cause : null;

  return {
    data: canReadFiles ? (optimisticFile?.data ?? data) : null,
    error:
      !isQueryEnabled || fileAccess.isPending
        ? null
        : canReadFiles
          ? errorMessage(cause)
          : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: isQueryEnabled && (fileAccess.isPending || result.waiting),
    readError,
    isNotFile: readError?.failure === "path_not_file",
    refresh,
  };
}
