/**
 * The Artifacts shelf's New menu: a blank Word document in the project's
 * `.specweave/artifacts/` folder, opened in the editor straight away.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { AuthFilesystemWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import { LibraryFileViewer } from "./LibraryFileViewer";

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

export function NewArtifactMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  const canCreate = useCanCreateDocument(props.environmentId);
  const save = useAtomCommand(design.documentSave, { reportFailure: false });
  const [opened, setOpened] = useState<{ path: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!canCreate) return null;

  const create = async () => {
    setBusy(true);
    const root = props.workspaceRoot.replace(/[\\/]+$/, "");
    try {
      for (let attempt = 1; attempt <= 50; attempt += 1) {
        const name = newDocumentName(attempt);
        const relative = `${ARTIFACTS_FOLDER}/${name}`;
        const result = await save({
          environmentId: props.environmentId,
          input: { path: `${root}/${relative}`, document: BLANK_DOCUMENT, mode: "create" },
        });
        if (result._tag === "Success") {
          setOpened({ path: relative, name });
          return;
        }
        const error = squashAtomCommandFailure(result) as { code?: unknown; message?: unknown };
        if (error?.code === "conflict") continue;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not make the document",
            description: typeof error?.message === "string" ? error.message : "Something went wrong.",
          }),
        );
        return;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Menu>
        <MenuTrigger
          render={<button type="button" className="sws-icon-button" disabled={busy} />}
          aria-label="New artifact"
        >
          <PlusIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" className="min-w-44">
          <MenuItem onClick={() => void create()}>New document</MenuItem>
        </MenuPopup>
      </Menu>
      {opened ? (
        <LibraryFileViewer
          environmentId={props.environmentId}
          workspaceRoot={props.workspaceRoot}
          files={[opened]}
          path={opened.path}
          onPath={() => undefined}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </>
  );
}
