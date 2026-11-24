import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { AuthFilesystemWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import {
  WHITEBOARD_DIR,
  WHITEBOARD_SUFFIX,
  emptyWhiteboardText,
} from "@specweave-studio/shared/officeWhiteboard";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { fileSaveErrorMessage } from "../../files/filePreviewMode";

/** A new whiteboard's path: dated to the second, so two never share a file. */
export function newWhiteboardPath(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${WHITEBOARD_DIR}/whiteboard-${stamp}${WHITEBOARD_SUFFIX}`;
}

/**
 * Creates an empty `.excalidraw` file in the project's artifacts folder through
 * the guarded file write, and resolves its path inside the project; null when
 * this machine may not write files here or the write failed.
 */
export function useCreateWhiteboard(environmentId: EnvironmentId, workspaceRoot: string) {
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const create = useCallback(async (): Promise<string | null> => {
    const relativePath = newWhiteboardPath();
    const result = await writeFile({
      environmentId,
      input: { cwd: workspaceRoot, relativePath, contents: emptyWhiteboardText() },
    });
    if (result._tag !== "Success") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create whiteboard",
          description:
            fileSaveErrorMessage(squashAtomCommandFailure(result)) ??
            "The file could not be written. Try again.",
        }),
      );
      return null;
    }
    return relativePath;
  }, [environmentId, workspaceRoot, writeFile]);
  return { canCreate: canWrite, create };
}
