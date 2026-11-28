import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { AuthFilesystemWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import {
  FORM_LIMITS,
  type FormAnswers,
  type FormDocument,
  formResponseCount,
  formatSubmittedAt,
  isFormPath,
  parseForm,
  responsesSheetPath,
} from "@specweave-studio/shared/officeForm";
import {
  SHEET_ARTIFACT_SUFFIX,
  SHEET_LIMITS,
  parseSheetDocument,
} from "@specweave-studio/shared/officeSheet";
import { Cause } from "effect";
import { type ReactNode, useCallback, useMemo } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
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
  useProjectFileReader,
} from "../../files/projectFilesQueryState";
import { SheetFileView, sheetRelativePath } from "../SheetFileView";
import type { FormSubmitOutcome } from "./FormFill";
import { type FormSaveOutcome, FormView } from "./FormView";
import { type SheetWrite, submitFormResponse } from "./submitFormResponse";

/** The responses Sheet's path, in the same form as the form's own path. */
export function responsesPathFor(formPath: string, text: string | undefined): string {
  const parsed = text === undefined ? null : parseForm(text);
  const document: FormDocument =
    parsed?.ok === true ? parsed.document : { v: 1, kind: "form", title: "", items: [] };
  return responsesSheetPath(formPath, document);
}

/** A `.form.json` file from a project or thread folder, in the form view. */
export function FormFileView(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
}): ReactNode {
  const tx = useTx();
  const { environmentId, cwd, path } = props;
  const file = useProjectFileQuery(environmentId, cwd, path);
  const sheetPath = useMemo(
    () => responsesPathFor(path, file.data?.contents),
    [file.data?.contents, path],
  );
  const sheetFile = useProjectFileQuery(environmentId, cwd, sheetPath);
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const readFile = useProjectFileReader();
  const relativePath = sheetRelativePath(cwd, path);
  const sheetRelative = sheetRelativePath(cwd, sheetPath);

  const reload = useCallback(() => {
    clearProjectFileQueryData(environmentId, cwd, path);
    file.refresh();
  }, [cwd, environmentId, file, path]);

  /** A guarded write: true, a conflict, or the reason, shown once as a toast for the form itself. */
  const write = useCallback(
    async (target: string, at: string, contents: string, expectedRevision: string | undefined) => {
      const result = await writeFile({
        environmentId,
        input:
          expectedRevision === undefined
            ? { cwd, relativePath: target, contents }
            : { cwd, relativePath: target, contents, expectedRevision },
      });
      if (result._tag === "Success") {
        setProjectFileQueryData(environmentId, cwd, at, contents);
        confirmProjectFileQueryData(environmentId, cwd, at, contents);
        return true as const;
      }
      const message = fileSaveErrorMessage(squashAtomCommandFailure(result));
      if (message !== null) return { error: message };
      if (Cause.pretty(result.cause).includes("Conflict:")) return "conflict" as const;
      return { error: "The file could not be saved. Try again." };
    },
    [cwd, environmentId, writeFile],
  );

  const save = useCallback(
    async (contents: string, expectedRevision: string): Promise<FormSaveOutcome> => {
      // Only the form that is open, and never more than a form may hold.
      if (relativePath === null || !isFormPath(relativePath)) return false;
      if (new TextEncoder().encode(contents).byteLength > FORM_LIMITS.bytes) return false;
      const written = await write(relativePath, path, contents, expectedRevision);
      if (written === "conflict") {
        clearProjectFileQueryData(environmentId, cwd, path);
        file.refresh();
        return "conflict";
      }
      if (written !== true) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save form",
            description: written.error,
          }),
        );
        return false;
      }
      return true;
    },
    [cwd, environmentId, file, path, relativePath, write],
  );

  const submit = useCallback(
    async (document: FormDocument, answers: FormAnswers): Promise<FormSubmitOutcome> => {
      if (sheetRelative === null || !sheetRelative.toLowerCase().endsWith(SHEET_ARTIFACT_SUFFIX)) {
        return { ok: false, error: "The responses Sheet is outside this project." };
      }
      const outcome = await submitFormResponse({
        document,
        answers,
        // The clock of the machine the answers are typed on, as a person reads it.
        submittedAt: formatSubmittedAt(new Date()),
        read: () => readFile(environmentId, cwd, sheetRelative, SHEET_LIMITS.bytes),
        write: (contents, expectedRevision): Promise<SheetWrite> =>
          write(sheetRelative, sheetPath, contents, expectedRevision),
      });
      sheetFile.refresh();
      return outcome;
    },
    [cwd, environmentId, readFile, sheetFile, sheetPath, sheetRelative, write],
  );

  const responseCount = useMemo(() => {
    if (sheetFile.data === undefined || sheetFile.data === null) return null;
    const parsed = parseSheetDocument(sheetFile.data.contents);
    return parsed.ok ? formResponseCount(parsed.document) : null;
  }, [sheetFile.data]);

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
        {tx("This form is too large to open here.")}
      </p>
    );
  }
  const writable = canWrite && relativePath !== null;
  return (
    <FormView
      key={`${environmentId}\0${cwd}\0${path}`}
      text={file.data.contents}
      onSave={writable ? save : undefined}
      onSubmit={writable ? submit : undefined}
      onReload={reload}
      responseCount={responseCount}
      responses={
        sheetFile.data ? (
          <SheetFileView environmentId={environmentId} cwd={cwd} path={sheetPath} />
        ) : (
          <p className="m-auto p-6 text-center text-muted-foreground text-sm" role="status">
            {sheetFile.error
              ? tx("No responses yet. The responses Sheet is made with the first answer.")
              : tx("Loading…")}
          </p>
        )
      }
    />
  );
}
