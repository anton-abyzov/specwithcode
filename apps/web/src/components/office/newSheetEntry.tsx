/**
 * The Sheet entry in the Artifacts shelf's New menu. A new Sheet, or
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
import { TableIcon } from "lucide-react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import { useTx } from "../../i18n";
import { useProjectFileReader } from "../files/projectFilesQueryState";
import type { ArtifactNewEntry, CreatedArtifact } from "../studio/shell/ArtifactNewMenu";
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

/** The Sheet entry, or null without file write on the machine that has the project. */
export function useNewSheetEntry(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  /** Paths the shelf already lists, relative to the project. */
  readonly taken: ReadonlySet<string>;
}): ArtifactNewEntry | null {
  const tx = useTx();
  const canWrite = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const capabilities = useServerConfigs().get(props.environmentId)?.environment.capabilities;
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const importWorkbook = useAtomCommand(design.importWorkbook, { reportFailure: false });
  const readFile = useProjectFileReader();
  if (!canWrite) return null;

  const fail = (description: string): null => {
    toastManager.add(stackedThreadToast({ type: "error", title: tx("Could not make the sheet"), description }));
    return null;
  };
  const gaps = (description: string) =>
    toastManager.add(stackedThreadToast({ type: "info", title: tx("Imported with gaps"), description }));

  const save = async (document: SheetDocument): Promise<CreatedArtifact | null> => {
    const contents = serializeSheetDocument(document);
    if (new TextEncoder().encode(contents).byteLength > SHEET_LIMITS.bytes) {
      return fail(tx("The sheet is larger than a Sheet may hold."));
    }
    // The shelf's list may be behind another window: a name is used only once
    // the file is seen to be absent, so a new Sheet never replaces one.
    const taken = new Set(props.taken);
    let relativePath: string | null = null;
    for (let attempt = 0; attempt < 20 && relativePath === null; attempt += 1) {
      const candidate = newSheetPath(document.title, taken);
      const existing = await readFile(props.environmentId, props.workspaceRoot, candidate, 64);
      if (existing._tag === "gone") relativePath = candidate;
      else if (existing._tag === "contents") taken.add(candidate);
      else return fail(tx("The project folder could not be read."));
    }
    if (relativePath === null) return fail(tx("No free file name for the sheet."));
    const result = await writeFile({
      environmentId: props.environmentId,
      input: { cwd: props.workspaceRoot, relativePath, contents },
    });
    if (result._tag !== "Success") return fail(tx("The file could not be written."));
    return { path: relativePath, title: document.title };
  };

  const importFile = async (file: File): Promise<CreatedArtifact | null> => {
    const name = file.name.replace(/\.(xlsx|csv|tsv)$/i, "").trim() || tx("Imported sheet");
    if (/\.xlsx$/i.test(file.name)) {
      if (capabilities?.officeWorkbookEdit !== true) {
        return fail(tx("This machine's SpecWithCode is too old to import Excel workbooks. Update it first."));
      }
      if (file.size > DESIGN_WORKBOOK_MAX_BYTES) return fail(tx("The workbook is larger than 25 MB, the import limit."));
      const result = await importWorkbook({
        environmentId: props.environmentId,
        input: { title: name.slice(0, 200), data: base64Of(await file.arrayBuffer()) },
      });
      if (result._tag !== "Success") {
        const error = squashAtomCommandFailure(result) as Partial<DesignError> | null;
        return fail(typeof error?.detail === "string" ? error.detail : tx("The workbook could not be read."));
      }
      const parsed = parseSheetDocument(result.value.sheetJson);
      if (!parsed.ok) return fail(parsed.error);
      const notes = [
        result.value.truncatedSheets > 0 ? tx("Some sheets were cut to the grid limits.") : "",
        result.value.unsupportedFeatures.length > 0
          ? tx("Left out: {features}.", { features: result.value.unsupportedFeatures.join(", ") })
          : "",
      ].filter(Boolean);
      if (notes.length > 0) gaps(notes.join(" "));
      return save(parsed.document);
    }
    if (file.size > SHEET_LIMITS.bytes) return fail(tx("The file is larger than a Sheet may hold."));
    const { document, truncated } = csvToSheetDocument(await file.text(), {
      title: name,
      ...(/\.tsv$/i.test(file.name) ? { delimiter: "\t" as const } : {}),
    });
    if (truncated) gaps(tx("Rows or columns past the Sheet's limits were left out."));
    return save(document);
  };

  return {
    id: "sheet",
    label: tx("Sheet"),
    icon: <TableIcon aria-hidden />,
    create: () => save(blankSheet(tx("Untitled sheet"))),
    imports: { extensions: ["xlsx", "csv", "tsv"], run: importFile },
  };
}
