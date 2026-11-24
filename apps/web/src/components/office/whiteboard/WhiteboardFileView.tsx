import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { AuthFilesystemWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import { WHITEBOARD_LIMITS, isWhiteboardPath } from "@specweave-studio/shared/officeWhiteboard";
import { Cause } from "effect";
import { type ReactNode, useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useTheme } from "~/hooks/useTheme";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { useTx } from "../../../i18n";
import { fileSaveErrorMessage } from "../../files/filePreviewMode";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "../../files/projectFilesQueryState";
import { sheetRelativePath } from "../SheetFileView";
import { type WhiteboardSaveOutcome, WhiteboardView } from "./WhiteboardView";

function whiteboardName(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "whiteboard";
  return base.replace(/\.excalidraw$/i, "") || "whiteboard";
}

/** A `.excalidraw` file from a project or thread folder, in the whiteboard editor. */
export function WhiteboardFileView(props: {
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
  const relativePath = sheetRelativePath(props.cwd, props.path);
  const { environmentId, cwd, path } = props;
  const reload = useCallback(async (): Promise<void> => {
    clearProjectFileQueryData(environmentId, cwd, path);
    file.refresh();
  }, [cwd, environmentId, file, path]);
  const save = useCallback(
    async (contents: string, expectedRevision: string): Promise<WhiteboardSaveOutcome> => {
      // Only the whiteboard that is open, and never more than a whiteboard may hold.
      if (relativePath === null || !isWhiteboardPath(relativePath)) return false;
      if (new TextEncoder().encode(contents).byteLength > WHITEBOARD_LIMITS.bytes) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save whiteboard",
            description: `A whiteboard holds at most ${WHITEBOARD_LIMITS.bytes / (1024 * 1024)} MB. Remove an image or two.`,
          }),
        );
        return false;
      }
      const result = await writeFile({
        environmentId,
        input: { cwd, relativePath, contents, expectedRevision },
      });
      if (result._tag !== "Success") {
        const message = fileSaveErrorMessage(squashAtomCommandFailure(result));
        if (message !== null) {
          toastManager.add(
            stackedThreadToast({ type: "error", title: "Could not save file", description: message }),
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
        {tx("This whiteboard is too large to open here.")}
      </p>
    );
  }
  return (
    <WhiteboardView
      // A different file is a different drawing: a fresh editor.
      key={`${environmentId}\0${cwd}\0${path}`}
      text={file.data.contents}
      name={whiteboardName(path)}
      mode={mode}
      onReload={reload}
      onSave={canWrite && relativePath !== null ? save : undefined}
    />
  );
}
