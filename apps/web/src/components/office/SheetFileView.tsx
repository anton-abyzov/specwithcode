import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { AuthFilesystemWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import {
  type OfficeThemeSource,
  SHEET_ARTIFACT_SUFFIX,
  SHEET_LIMITS,
} from "@specweave-studio/shared/officeSheet";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useTheme } from "~/hooks/useTheme";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import { useTx } from "../../i18n";
import { fileSaveErrorMessage } from "../files/filePreviewMode";
import { setProjectFileQueryData, useProjectFileQuery } from "../files/projectFilesQueryState";
import { SheetView } from "./SheetView";

/** The path inside the folder, or null when the file is outside it. */
export function sheetRelativePath(cwd: string, path: string): string | null {
  const slashed = (value: string) => value.replace(/\\/g, "/");
  const root = slashed(cwd).replace(/\/+$/, "");
  const target = slashed(path);
  const drive = /^[A-Za-z]:\//.test(target);
  if (!target.startsWith("/") && !drive) return target;
  if (root.length === 0) return null;
  // Windows paths compare without case; the rest of the path is returned as written.
  const same = drive
    ? target.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : target.startsWith(`${root}/`);
  return same ? target.slice(root.length + 1) : null;
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
  const save = useCallback(
    async (contents: string): Promise<boolean> => {
      // Only the sheet that is open, and never more than a sheet may hold.
      if (relativePath === null || !relativePath.endsWith(SHEET_ARTIFACT_SUFFIX)) return false;
      if (new TextEncoder().encode(contents).byteLength > SHEET_LIMITS.bytes) return false;
      const result = await writeFile({ environmentId, input: { cwd, relativePath, contents } });
      if (result._tag !== "Success") {
        // A file the server refuses every time (protected, not UTF-8 text) says why.
        const message = fileSaveErrorMessage(squashAtomCommandFailure(result));
        if (message !== null) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not save file",
              description: message,
            }),
          );
        }
        return false;
      }
      setProjectFileQueryData(environmentId, cwd, path, contents);
      return true;
    },
    [cwd, environmentId, path, relativePath, writeFile],
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
  return (
    <SheetView
      text={file.data.contents}
      mode={mode}
      themeSource={themeSource}
      onDesignSystem={setSystemId}
      onSave={canWrite && relativePath !== null ? save : undefined}
    />
  );
}
