/**
 * "New sheet" and "Import" on the project's Artifacts shelf. A new Sheet, or
 * an uploaded .xlsx or .csv converted to one, is written into SpecWeave's
 * shared output folder (`.specweave/reports/`), where the shelf finds it, and
 * opens in the editor. A .csv converts here; a .xlsx converts on the machine
 * that has the project (`design.importWorkbook`), which stores nothing itself.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { AuthFilesystemWriteScope, DESIGN_WORKBOOK_MAX_BYTES, type DesignError, type EnvironmentId } from "@specweave-studio/contracts";
import {
  SHEET_ARTIFACT_KIND,
  SHEET_ARTIFACT_SUFFIX,
  SHEET_ARTIFACT_VERSION,
  SHEET_LIMITS,
  type SheetDocument,
  csvToSheetDocument,
  parseSheetDocument,
  serializeSheetDocument,
} from "@specweave-studio/shared/officeSheet";
import { FileUpIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import { useTx } from "../../i18n";
import { sheetFileName } from "./sheetFiles";

/** Where new and imported Sheets go: SpecWeave's shared output, which the shelf lists. */
export const SHEET_OUTPUT_FOLDER = ".specweave/reports";

/** A path in the output folder that no listed file has yet. */
export function newSheetPath(title: string, taken: ReadonlySet<string>): string {
  const base = sheetFileName(title, "x").slice(0, -2);
  for (let index = 1; index < 1_000; index += 1) {
    const name = `${SHEET_OUTPUT_FOLDER}/${base}${index === 1 ? "" : `-${index}`}${SHEET_ARTIFACT_SUFFIX}`;
    if (!taken.has(name)) return name;
  }
  return `${SHEET_OUTPUT_FOLDER}/${base}-${Date.now()}${SHEET_ARTIFACT_SUFFIX}`;
}

export function blankSheet(title: string): SheetDocument {
  return { v: SHEET_ARTIFACT_VERSION, kind: SHEET_ARTIFACT_KIND, title, tabs: [{ name: "Sheet1", cells: {} }] };
}

function base64Of(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index += 0x8000) {
    binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function SheetShelfActions(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  /** Paths the shelf already lists, relative to the project. */
  readonly taken: ReadonlySet<string>;
  readonly onOpen: (path: string, title: string) => void;
}): ReactNode {
  const tx = useTx();
  const canWrite = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const capabilities = useServerConfigs().get(props.environmentId)?.environment.capabilities;
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const importWorkbook = useAtomCommand(design.importWorkbook, { reportFailure: false });
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!canWrite) return null;

  const fail = (description: string) =>
    toastManager.add(stackedThreadToast({ type: "error", title: tx("Could not make the sheet"), description }));

  const create = async (document: SheetDocument) => {
    const contents = serializeSheetDocument(document);
    if (new TextEncoder().encode(contents).byteLength > SHEET_LIMITS.bytes) {
      fail(tx("The sheet is larger than a Sheet may hold."));
      return;
    }
    const relativePath = newSheetPath(document.title, props.taken);
    const result = await writeFile({
      environmentId: props.environmentId,
      input: { cwd: props.workspaceRoot, relativePath, contents },
    });
    if (result._tag !== "Success") {
      fail(tx("The file could not be written."));
      return;
    }
    props.onOpen(relativePath, document.title);
  };

  const importFile = async (file: File) => {
    const name = file.name.replace(/\.(xlsx|csv|tsv|txt)$/i, "").trim() || tx("Imported sheet");
    if (/\.xlsx$/i.test(file.name)) {
      if (capabilities?.officeWorkbookEdit !== true) {
        fail(tx("This machine's SpecWithCode is too old to import Excel workbooks. Update it first."));
        return;
      }
      if (file.size > DESIGN_WORKBOOK_MAX_BYTES) {
        fail(tx("The workbook is larger than 25 MB, the import limit."));
        return;
      }
      const result = await importWorkbook({
        environmentId: props.environmentId,
        input: { title: name.slice(0, 200), data: base64Of(await file.arrayBuffer()) },
      });
      if (result._tag !== "Success") {
        const error = squashAtomCommandFailure(result) as Partial<DesignError> | null;
        fail(typeof error?.detail === "string" ? error.detail : tx("The workbook could not be read."));
        return;
      }
      const parsed = parseSheetDocument(result.value.sheetJson);
      if (!parsed.ok) {
        fail(parsed.error);
        return;
      }
      if (result.value.unsupportedFeatures.length > 0 || result.value.truncatedSheets > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: tx("Imported with gaps"),
            description: [
              result.value.truncatedSheets > 0 ? tx("Some sheets were cut to the grid limits.") : "",
              result.value.unsupportedFeatures.length > 0
                ? tx("Left out: {features}.", { features: result.value.unsupportedFeatures.join(", ") })
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          }),
        );
      }
      await create(parsed.document);
      return;
    }
    if (file.size > SHEET_LIMITS.bytes) {
      fail(tx("The file is larger than a Sheet may hold."));
      return;
    }
    const { document, truncated } = csvToSheetDocument(await file.text(), {
      title: name,
      ...(/\.tsv$/i.test(file.name) ? { delimiter: "\t" as const } : {}),
    });
    if (truncated) {
      toastManager.add(
        stackedThreadToast({ type: "info", title: tx("Imported with gaps"), description: tx("Rows or columns past the Sheet's limits were left out.") }),
      );
    }
    await create(document);
  };

  const run = (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void task().finally(() => setBusy(false));
  };

  return (
    <>
      <button
        type="button"
        className="sws-icon-button"
        aria-label={tx("New sheet")}
        title={tx("New sheet")}
        disabled={busy}
        onClick={() => run(() => create(blankSheet(tx("Untitled sheet"))))}
        data-shelf-new-sheet
      >
        <PlusIcon aria-hidden />
      </button>
      <button
        type="button"
        className="sws-icon-button"
        aria-label={tx("Import .xlsx or .csv")}
        title={tx("Import .xlsx or .csv")}
        disabled={busy}
        onClick={() => input.current?.click()}
        data-shelf-import-sheet
      >
        <FileUpIcon aria-hidden />
      </button>
      <input
        ref={input}
        type="file"
        accept=".xlsx,.csv,.tsv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) run(() => importFile(file));
        }}
        data-shelf-import-input
      />
    </>
  );
}
