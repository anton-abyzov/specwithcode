/**
 * A host .xlsx in the Sheet editor. Each save writes the workbook back to the
 * same path through `design.saveWorkbook`, checked against the revision that
 * was read, so a change made in Excel meanwhile shows as a conflict. A file
 * with parts the editor does not keep (charts, pivots, comments...) opens
 * read-only until the person agrees that a save leaves them out; a file cut to
 * the grid limits never saves.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthFilesystemWriteScope,
  type DesignError,
  type DesignPreviewWorkbookResult,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import { useTx } from "../../i18n";
import { Button } from "../ui/button";
import { SheetView } from "./SheetView";

/** What the status line says, and whether saving needs a yes first. */
export function workbookEditState(preview: DesignPreviewWorkbookResult): {
  readonly canSave: boolean;
  readonly lossy: ReadonlyArray<string>;
} {
  return {
    canSave: preview.truncatedSheets === 0 && preview.revision !== undefined,
    lossy: preview.unsupportedFeatures,
  };
}

export function HostWorkbookEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly name: string;
  readonly preview: DesignPreviewWorkbookResult;
  readonly summary: string;
  readonly mode: "light" | "dark";
  readonly onReload: () => void;
}): ReactNode {
  const tx = useTx();
  const capabilities = useServerConfigs().get(props.environmentId)?.environment.capabilities;
  const canWrite = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const saveWorkbook = useAtomCommand(design.saveWorkbook, { reportFailure: false });
  const { canSave, lossy } = workbookEditState(props.preview);
  const [acceptedLoss, setAcceptedLoss] = useState(false);
  // The sheet on screen and the file revision a save is checked against. A
  // re-read of a file this view wrote keeps the text it sent, so the editor
  // does not mistake its own save for a change from elsewhere.
  const [shown, setShown] = useState({ text: props.preview.sheetJson, revision: props.preview.revision });
  const [seenPreview, setSeenPreview] = useState(props.preview.revision);
  const [written, setWritten] = useState<ReadonlyArray<string>>([]);
  if (props.preview.revision !== seenPreview) {
    // A newer read of the file: adopt it unless it is the file this view just wrote.
    setSeenPreview(props.preview.revision);
    if (props.preview.revision === undefined || !written.includes(props.preview.revision)) {
      setShown({ text: props.preview.sheetJson, revision: props.preview.revision });
    }
  }
  // Queued saves read the newest revision, not the one their render saw.
  const revision = useRef(shown.revision);
  useEffect(() => {
    revision.current = shown.revision;
  }, [shown.revision]);

  const editable =
    capabilities?.officeWorkbookEdit === true && canWrite && canSave && (lossy.length === 0 || acceptedLoss);

  const save = async (contents: string): Promise<boolean | "conflict"> => {
    const expectedRevision = revision.current;
    if (expectedRevision === undefined) return false;
    const result = await saveWorkbook({
      environmentId: props.environmentId,
      input: { path: props.path, sheetJson: contents, expectedRevision },
    });
    if (result._tag !== "Success") {
      const error = squashAtomCommandFailure(result) as Partial<DesignError> | null;
      if (error?._tag === "DesignError" && error.code === "conflict") {
        props.onReload();
        return "conflict";
      }
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: tx("Could not save workbook"),
          description:
            error?._tag === "DesignError" && typeof error.detail === "string"
              ? error.detail
              : tx("The workbook could not be written."),
        }),
      );
      return false;
    }
    setWritten((current) => [...current.slice(-19), result.value.revision]);
    revision.current = result.value.revision;
    setShown({ text: contents, revision: result.value.revision });
    return true;
  };

  let status: ReactNode = props.summary;
  if (capabilities?.officeWorkbookEdit === true && canWrite) {
    if (!canSave) {
      status = `${props.summary} ${tx("Too large to edit here; it stays read-only.")}`;
    } else if (lossy.length > 0 && !acceptedLoss) {
      status = (
        <>
          <span>
            {tx("Saving here rewrites the file without: {features}.", { features: lossy.join(", ") })}
          </span>
          <Button
            type="button"
            size="compact"
            variant="outline"
            className="ml-2"
            onClick={() => setAcceptedLoss(true)}
            data-xlsx-accept-loss
          >
            {tx("Edit anyway")}
          </Button>
        </>
      );
    } else {
      status = tx("Edits save to {name}.", { name: props.name });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-xlsx-preview={props.name} data-xlsx-editable={editable || undefined}>
      <div
        className="flex shrink-0 items-center border-b bg-muted/30 px-4 py-1.5 text-muted-foreground text-xs"
        role="status"
      >
        {status}
      </div>
      <div className="min-h-0 flex-1">
        <SheetView
          text={shown.text}
          mode={props.mode}
          onReload={props.onReload}
          onSave={editable ? save : undefined}
        />
      </div>
    </div>
  );
}
