import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { AuthFilesystemWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import { createRef, useEffect, useMemo, useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { fileSaveErrorMessage, protectedFileSaveToastId } from "./filePreviewMode";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getUnsavedProjectFileQueryData,
} from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

interface FileSaveOptions {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change"> & {
  /** The server refused this file as protected: the editor stops offering edits until reopened. */
  readonly readOnly: boolean;
} {
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const fileKey = protectedFileSaveToastId(environmentId, cwd, relativePath);
  // The file the server refused as protected; another file starts writable.
  const [refusedFile, setRefusedFile] = useState<string | null>(null);
  const session = useMemo(() => {
    const coordinatorRef = createRef<FileSaveCoordinator>();
    // Shared by the StrictMode setup replays of this file; reopening starts afresh.
    const state = { refused: false };
    return {
      change: (contents: string) => {
        if (!state.refused) coordinatorRef.current?.change(contents);
      },
      setup: () => {
        const coordinator = new FileSaveCoordinator({
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          canPersist: () =>
            !state.refused && readEnvironmentScope(environmentId, AuthFilesystemWriteScope),
          onPendingChange: (pending) => onPendingChange(relativePath, pending),
          persist: async (nextContents) => {
            const result = await writeFile({
              environmentId,
              input: { cwd, relativePath, contents: nextContents },
            });
            // A protected file is refused every time: say why once, stop saving it and
            // stop offering edits, instead of retrying on every keystroke.
            const message =
              result._tag === "Success"
                ? null
                : fileSaveErrorMessage(squashAtomCommandFailure(result));
            if (message !== null && !state.refused) {
              state.refused = true;
              setRefusedFile(fileKey);
              toastManager.add({
                ...stackedThreadToast({
                  type: "error",
                  title: "Could not save file",
                  description: message,
                }),
                id: fileKey,
              });
            }
            return result;
          },
          onConfirmed: (confirmedContents) =>
            confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents),
        });
        coordinatorRef.current = coordinator;
        return () => {
          coordinatorRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [cwd, environmentId, fileKey, onPendingChange, relativePath, writeFile]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  useEffect(() => {
    if (!canWriteFiles) return;
    let cancelled = false;
    // Replay must retire the first session before recovery queues a draft to flush.
    queueMicrotask(() => {
      if (cancelled) return;
      const unsaved = getUnsavedProjectFileQueryData(environmentId, cwd, relativePath);
      if (unsaved) session.change(unsaved.contents);
    });
    return () => {
      cancelled = true;
    };
  }, [canWriteFiles, cwd, environmentId, relativePath, session]);
  const readOnly = refusedFile === fileKey;
  const { change } = session;
  return useMemo(() => ({ change, readOnly }), [change, readOnly]);
}
