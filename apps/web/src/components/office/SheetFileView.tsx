import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { AuthFilesystemWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import {
  type OfficeThemeSource,
  SHEET_ARTIFACT_SUFFIX,
  SHEET_LIMITS,
} from "@specweave-studio/shared/officeSheet";
import { Cause } from "effect";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useTheme } from "~/hooks/useTheme";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import { useTx } from "../../i18n";
import { DocumentHeader } from "../documents/DocumentHeader";
import { useLiveSheet } from "../documents/useLiveSheet";
import { Button } from "../ui/button";
import { fileSaveErrorMessage } from "../files/filePreviewMode";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "../files/projectFilesQueryState";
import { SheetView } from "./SheetView";

/** The path inside the folder, or null when the file is outside it. */
export function sheetRelativePath(cwd: string, path: string): string | null {
  // A drive letter or a UNC share (\\host\share) marks a Windows folder.
  const windowsRoot = (value: string) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  const isWindows = windowsRoot(cwd) || (cwd.length === 0 && windowsRoot(path));
  if (isWindows) {
    const slashed = (value: string) => value.replace(/\\/g, "/");
    const root = slashed(cwd).replace(/\/+$/, "");
    const target = slashed(path);
    const drive = /^[A-Za-z]:\//.test(target);
    if (!target.startsWith("/") && !drive) return target;
    if (root.length === 0) return null;
    // Windows paths compare without case; the rest of the path is returned as written.
    return target.toLowerCase().startsWith(`${root.toLowerCase()}/`)
      ? target.slice(root.length + 1)
      : null;
  }
  // POSIX paths preserve literal backslashes in filenames.
  const root = cwd.replace(/\/+$/, "");
  if (!path.startsWith("/")) return path;
  if (root.length === 0) return null;
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/** The design system a sheet names, as the roles the Office theme reads. */
function useOfficeThemeSource(
  environmentId: EnvironmentId,
  systemId: string | null,
  mode: "light" | "dark",
): OfficeThemeSource | null {
  const systems = useEnvironmentQuery(
    systemId === null
      ? null
      : design.systemList({ environmentId, input: { filter: { kind: "all" } } }),
  );
  const summary = systems.data?.systems.find((entry) => entry.ref.systemId === systemId) ?? null;
  const owner = summary?.ref.owner ?? null;
  const system = useEnvironmentQuery(
    summary === null || owner === null
      ? null
      : design.systemGet({
          environmentId,
          input: {
            owner:
              owner.kind === "playground"
                ? { kind: "playground" }
                : { kind: "project", projectId: owner.projectId },
            systemId: summary.ref.systemId,
          },
        }),
  );
  const found = system.data?.system ?? null;
  return useMemo(() => {
    if (found === null) return null;
    const named = found.modes.find(
      (entry) => entry.id.toLowerCase() === mode || entry.name.toLowerCase().includes(mode),
    );
    return { modes: [(named ?? found.modes[0])?.id ?? mode], tokens: found.tokens };
  }, [found, mode]);
}

/** A `.sheet.json` file from a project or thread folder, in the sheet viewer. */
export function SheetFileView(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
}): ReactNode {
  const tx = useTx();
  const { resolvedTheme } = useTheme();
  const mode = resolvedTheme === "dark" ? "dark" : "light";
  const file = useProjectFileQuery(props.environmentId, props.cwd, props.path);
  const canWrite = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const [systemId, setSystemId] = useState<string | null>(null);
  const themeSource = useOfficeThemeSource(props.environmentId, systemId, mode);
  const relativePath = sheetRelativePath(props.cwd, props.path);
  const { environmentId, cwd, path } = props;
  // Live when the machine can hold a session on the file; otherwise saved by revision.
  const live = useLiveSheet({ environmentId, cwd, relativePath });
  /** How many times the sheet was opened again after its live session ended. */
  const [opened, setOpened] = useState(0);
  const reload = useCallback(async (): Promise<void> => {
    clearProjectFileQueryData(environmentId, cwd, path);
    file.refresh();
  }, [cwd, environmentId, file, path]);
  const save = useCallback(
    async (contents: string, expectedRevision?: string): Promise<boolean | "conflict"> => {
      // Only the sheet that is open, and never more than a sheet may hold.
      if (relativePath === null || !relativePath.toLowerCase().endsWith(SHEET_ARTIFACT_SUFFIX)) {
        return false;
      }
      if (new TextEncoder().encode(contents).byteLength > SHEET_LIMITS.bytes) return false;
      const result = await writeFile({
        environmentId,
        input:
          expectedRevision !== undefined
            ? { cwd, relativePath, contents, expectedRevision }
            : { cwd, relativePath, contents },
      });
      if (result._tag !== "Success") {
        // A file the server refuses every time (protected, not UTF-8 text) says why.
        // Checked first: its message may name a path that reads like a conflict.
        const message = fileSaveErrorMessage(squashAtomCommandFailure(result));
        if (message !== null) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not save file",
              description: message,
            }),
          );
          return false;
        }
        if (Cause.pretty(result.cause).includes("Conflict:")) {
          clearProjectFileQueryData(environmentId, cwd, path);
          file.refresh();
          return "conflict";
        }
        return false;
      }
      setProjectFileQueryData(environmentId, cwd, path, contents);
      confirmProjectFileQueryData(environmentId, cwd, path, contents);
      return true;
    },
    [cwd, environmentId, file, path, relativePath, writeFile],
  );
  if (!file.data) {
    return (
      <p
        className="m-auto p-6 text-center text-muted-foreground text-sm"
        role={file.error ? "alert" : "status"}
      >
        {file.error ?? tx("Loading…")}
      </p>
    );
  }
  if (file.data.truncated) {
    return (
      <p className="m-auto p-6 text-center text-muted-foreground text-sm" role="alert">
        {tx("This sheet is too large to open here.")}
      </p>
    );
  }
  const binding = live?.binding ?? null;
  // A sheet whose session has ended goes back to revision saves; one still joining is read-only.
  const joining = live !== null && live.state.status === "connecting";
  // Ended for a reason (the file left, or another took its name): the sheet stays read-only
  // until it is opened again, so an edit begun in the old session is not saved by revision
  // into whatever is under the name now.
  const ended = live !== null && live.state.status === "closed" && live.state.problem !== null;
  const title =
    binding?.document.title ??
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.sheet\.json$/i, "") ??
    path;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-sheet-live={binding !== null}>
      <DocumentHeader
        kind="sheet"
        title={title}
        presence={binding === null ? [] : (live?.presence ?? [])}
        activity={binding === null ? [] : (live?.state.activity ?? [])}
        access={(binding === null ? canWrite : binding.editable) ? "edit" : "view"}
      />
      {ended ? (
        // Why live editing ended, which may say where unsaved changes were kept.
        <p className="office-sheet-note" role="alert" data-testid="sheet-live-ended">
          {live.state.problem}{" "}
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="sheet-live-reopen"
            onClick={() => {
              void reload();
              setOpened((count) => count + 1);
              live.reopen();
            }}
          >
            {tx("Open it again")}
          </Button>
        </p>
      ) : null}
      <SheetView
        // A new view when the session ends and when the sheet is opened again: text still in a
        // cell editor belongs to the sheet that was open, and is not carried into another.
        key={`${ended ? "ended" : "open"}-${opened}`}
        text={file.data.contents}
        mode={mode}
        themeSource={themeSource}
        onDesignSystem={setSystemId}
        onReload={reload}
        onSave={
          binding === null && !joining && !ended && canWrite && relativePath !== null
            ? save
            : undefined
        }
        live={binding ?? undefined}
      />
    </div>
  );
}
