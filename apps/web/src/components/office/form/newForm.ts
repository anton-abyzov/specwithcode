import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { AuthFilesystemWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import {
  FORM_DIR,
  FORM_RESPONSES_SUFFIX,
  FORM_SUFFIX,
  emptyResponsesSheet,
  newFormDocument,
  serializeForm,
} from "@specweave-studio/shared/officeForm";
import { serializeSheetDocument } from "@specweave-studio/shared/officeSheet";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { fileSaveErrorMessage } from "../../files/filePreviewMode";

/**
 * A new form's file stem: dated to the second, with a random tail so two made
 * in the same second (two clicks, two windows) never share a file.
 */
export function newFormStem(
  now: Date = new Date(),
  tail: string = Math.random().toString(36).slice(2, 8).padEnd(6, "0"),
): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `form-${stamp}-${tail}`;
}

/** The two files a new form is: the form, and its header-only responses Sheet beside it. */
export function newFormFiles(stem: string): {
  readonly form: { readonly relativePath: string; readonly contents: string };
  readonly sheet: { readonly relativePath: string; readonly contents: string };
} {
  const sheetName = `${stem}${FORM_RESPONSES_SUFFIX}`;
  const document = newFormDocument("Untitled form", sheetName);
  return {
    form: { relativePath: `${FORM_DIR}/${stem}${FORM_SUFFIX}`, contents: serializeForm(document) },
    sheet: {
      relativePath: `${FORM_DIR}/${sheetName}`,
      contents: serializeSheetDocument(emptyResponsesSheet(document)),
    },
  };
}

/**
 * Creates a new form and its responses Sheet in the project's artifacts folder
 * through the guarded file write, and resolves the form's path inside the
 * project; null when this machine may not write files here or a write failed.
 */
export function useCreateForm(environmentId: EnvironmentId, workspaceRoot: string) {
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const create = useCallback(async (): Promise<string | null> => {
    const files = newFormFiles(newFormStem());
    // The Sheet first: a form never exists without the place its answers go.
    for (const file of [files.sheet, files.form]) {
      const result = await writeFile({
        environmentId,
        input: { cwd: workspaceRoot, relativePath: file.relativePath, contents: file.contents },
      });
      if (result._tag !== "Success") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not create form",
            description:
              fileSaveErrorMessage(squashAtomCommandFailure(result)) ??
              "The file could not be written. Try again.",
          }),
        );
        return null;
      }
    }
    return files.form.relativePath;
  }, [environmentId, workspaceRoot, writeFile]);
  return { canCreate: canWrite, create };
}
