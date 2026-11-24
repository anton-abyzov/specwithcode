/**
 * The Word document entry in the Artifacts shelf's New menu (ArtifactNewMenu):
 * a blank document in the project's `.specweave/artifacts/` folder, which the
 * shelf opens in the editor straight away.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { AuthFilesystemWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import { FileTextIcon } from "lucide-react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import type { ArtifactNewEntry, CreatedArtifact } from "./ArtifactNewMenu";

const ARTIFACTS_FOLDER = ".specweave/artifacts";
const BLANK_DOCUMENT = { blocks: [{ type: "paragraph" as const, runs: [] }] };

/** The name of the n-th new document: untitled-document.docx, then -2, -3. */
export function newDocumentName(attempt: number): string {
  return attempt <= 1 ? "untitled-document.docx" : `untitled-document-${attempt}.docx`;
}

/** Whether this person may make documents on the machine. */
export function useCanCreateDocument(environmentId: EnvironmentId): boolean {
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  return capabilities?.officeDocumentEditing === true && canWrite;
}

/** The "Document" entry, or null where this person cannot make one. */
export function useNewDocumentEntry(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}): ArtifactNewEntry | null {
  const canCreate = useCanCreateDocument(props.environmentId);
  const save = useAtomCommand(design.documentSave, { reportFailure: false });
  if (!canCreate) return null;

  const create = async (): Promise<CreatedArtifact | null> => {
    const root = props.workspaceRoot.replace(/[\\/]+$/, "");
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const name = newDocumentName(attempt);
      const relative = `${ARTIFACTS_FOLDER}/${name}`;
      // "create" never replaces a file: a taken name comes back as a conflict.
      const result = await save({
        environmentId: props.environmentId,
        input: { path: `${root}/${relative}`, document: BLANK_DOCUMENT, mode: "create" },
      });
      if (result._tag === "Success") return { path: relative, title: name };
      const error = squashAtomCommandFailure(result) as { code?: unknown; message?: unknown };
      if (error?.code === "conflict") continue;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not make the document",
          description: typeof error?.message === "string" ? error.message : "Something went wrong.",
        }),
      );
      return null;
    }
    return null;
  };

  return { id: "document", label: "Document", icon: <FileTextIcon aria-hidden />, create };
}
