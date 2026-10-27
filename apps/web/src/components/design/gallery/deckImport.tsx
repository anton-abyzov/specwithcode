/**
 * "Import PowerPoint…": a .pptx becomes a new slides document on the server
 * (`design.importDeck`, gated by the `designDeckImport` capability, so older
 * servers hide the entry). What the import could not keep is shown in a
 * dialog before the deck opens.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  DESIGN_DECK_IMPORT_MAX_BYTES,
  type DesignId,
  type DesignImportSkipped,
  type DesignOwnerInput,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { useState, type ReactNode } from "react";

import { useServerConfigs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import type { NewDesignRequest } from "./NewDesignDialog";
import { connectionMessage, whenConnected } from "./whenConnected";

/** What the file picker offers. */
export const PPTX_ACCEPT =
  ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** A plain sentence when the file cannot be imported, before it is read. */
export function pptxFileProblem(file: { readonly name: string; readonly size: number }) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pptm") || name.endsWith(".potm") || name.endsWith(".ppsm")) {
    return "Decks with macros (.pptm) cannot be imported. Save it as a .pptx without macros.";
  }
  if (!name.endsWith(".pptx")) return "Choose a PowerPoint file (.pptx).";
  if (file.size > DESIGN_DECK_IMPORT_MAX_BYTES) {
    return "The file is larger than 50 MB, the import limit.";
  }
  return null;
}

/** The deck's title from its file name: "Q3 review.pptx" is "Q3 review". */
export const deckTitleFromFile = (name: string) =>
  name
    .replace(/\.pptx$/i, "")
    .trim()
    .slice(0, 180) || "Imported slides";

/** Whether this server imports PowerPoint decks. */
export const canImportDecks = (capabilities: { readonly designDeckImport?: boolean } | undefined) =>
  capabilities?.designDeckImport === true;

const readBase64 = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });

const failureMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.trim() !== "" ? cause.message : fallback;

/** The per-slide list of what the import left out, with a way into the deck. */
export function NotImportedDialog({
  title,
  notImported,
  onOpenDeck,
  onClose,
}: {
  title: string;
  notImported: readonly DesignImportSkipped[];
  onOpenDeck: () => void;
  onClose: () => void;
}) {
  const count = notImported.reduce((total, entry) => total + entry.items.length, 0);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogPopup className="sm:max-w-md" data-testid="deck-not-imported">
        <DialogHeader>
          <DialogTitle>Some parts were not imported</DialogTitle>
          <DialogDescription>
            “{title}” is ready. {count === 1 ? "One part" : `${count} parts`} could not be kept as
            editable slides content:
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="flex flex-col gap-2 text-sm">
            {notImported.map((entry) => (
              <li key={entry.slide}>
                <span className="font-medium">Slide {entry.slide}</span>
                <ul className="list-disc ps-5 text-muted-foreground">
                  {entry.items.map((item, index) => (
                    <li key={`${entry.slide}-${index}`}>{item}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" onClick={onOpenDeck} data-testid="deck-not-imported-open">
            Open slides
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The import for one window: whether the server offers it, the call, and the
 * not-imported dialog. `onImported` runs once the deck exists; `open` opens it.
 */
export function useDeckImport(
  environmentId: EnvironmentId,
  callbacks: {
    readonly onImported: () => void;
    readonly open: (owner: DesignOwnerInput, designId: DesignId) => void;
  },
): {
  readonly available: boolean;
  readonly importDeck: (request: NewDesignRequest, file: File) => Promise<string | null>;
  readonly dialog: ReactNode;
} {
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const run = useAtomCommand(design.importDeck, { reportFailure: false });
  const [report, setReport] = useState<{
    readonly owner: DesignOwnerInput;
    readonly designId: DesignId;
    readonly title: string;
    readonly notImported: readonly DesignImportSkipped[];
  } | null>(null);

  const importDeck = async (request: NewDesignRequest, file: File) => {
    const problem = pptxFileProblem(file);
    if (problem !== null) return problem;
    const connection = await whenConnected(environmentId);
    if (!connection.ok) return connectionMessage(connection);
    let data: string;
    try {
      data = await readBase64(file);
    } catch {
      return "The file could not be read.";
    }
    const result = await run({
      environmentId,
      input: {
        owner: request.owner,
        title: request.title,
        designSystem: request.designSystem,
        data,
      },
    });
    if (result._tag === "Failure") {
      return failureMessage(squashAtomCommandFailure(result), "The deck was not imported.");
    }
    callbacks.onImported();
    const { ref, notImported } = result.value;
    if (notImported.length === 0) {
      callbacks.open(request.owner, ref.designId);
    } else {
      setReport({
        owner: request.owner,
        designId: ref.designId,
        title: request.title,
        notImported,
      });
    }
    return null;
  };

  return {
    available: canImportDecks(capabilities),
    importDeck,
    dialog:
      report === null ? null : (
        <NotImportedDialog
          title={report.title}
          notImported={report.notImported}
          onClose={() => setReport(null)}
          onOpenDeck={() => {
            setReport(null);
            callbacks.open(report.owner, report.designId);
          }}
        />
      ),
  };
}
