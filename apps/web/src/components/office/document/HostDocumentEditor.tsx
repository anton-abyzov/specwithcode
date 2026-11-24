/**
 * A .docx on a machine, open in the Word editor: opens through
 * `design.documentOpen`, saves with a revision check through
 * `design.documentSave`, and exports .docx, PDF and Markdown.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type {
  DesignDocumentOpenResult,
  EnvironmentId,
  OfficeDocument,
} from "@specweave-studio/contracts";
import { documentToMarkdown } from "@specweave-studio/shared/officeDocument";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import { DocumentEditor, type DocumentSaveOutcome, hasUnsavedDraft } from "./DocumentEditor";
import { documentPrintHtml } from "./documentHtml";

const baseName = (name: string) => name.replace(/\.docx$/i, "") || "document";

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function errorDetail(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Something went wrong.";
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function base64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Prints the page in a frame that runs no script, for browsers without the desktop app. */
function printInFrame(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0;";
  frame.srcdoc = html;
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.append(frame);
}

/** The revision each kept draft was edited from, so its save still checks against it. */
const draftRevisions = new Map<string, string>();

export function HostDocumentEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly name: string;
  /** False for a person without write access: the editor opens read only. */
  readonly canWrite: boolean;
}): ReactNode {
  const { environmentId, path, name } = props;
  const open = useAtomCommand(design.documentOpen, { reportFailure: false });
  const saveCommand = useAtomCommand(design.documentSave, { reportFailure: false });
  const build = useAtomCommand(design.documentBuild, { reportFailure: false });
  const [opened, setOpened] = useState<DesignDocumentOpenResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const revision = useRef<string | null>(null);
  const draftKey = `${environmentId}\u0000${path}`;
  useEffect(
    () => () => {
      if (revision.current !== null) draftRevisions.set(draftKey, revision.current);
    },
    [draftKey],
  );

  const load = useCallback(async (): Promise<DesignDocumentOpenResult | null> => {
    const result = await open({ environmentId, input: { path } });
    if (result._tag !== "Success") {
      setFailure(errorDetail(squashAtomCommandFailure(result)));
      return null;
    }
    return result.value;
  }, [environmentId, open, path]);

  useEffect(() => {
    let live = true;
    setOpened(null);
    setFailure(null);
    void load().then((value) => {
      if (!live || value === null) return;
      // Edits kept from before were made on the revision they were made on, not this one.
      revision.current = hasUnsavedDraft(draftKey)
        ? (draftRevisions.get(draftKey) ?? value.revision)
        : value.revision;
      setOpened(value);
    });
    return () => {
      live = false;
    };
  }, [load, generation, draftKey]);

  const save = useCallback(
    async (document: OfficeDocument, options: { readonly force: boolean }): Promise<DocumentSaveOutcome> => {
      if (options.force) {
        // Keep my edits: write over whatever is on disk now.
        const current = await load();
        if (current === null) return "failed";
        revision.current = current.revision;
      }
      const expectedRevision = revision.current ?? undefined;
      const result = await saveCommand({
        environmentId,
        input: {
          path,
          document,
          mode: "replace",
          ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        },
      });
      if (result._tag === "Success") {
        revision.current = result.value.revision;
        return "saved";
      }
      const error = squashAtomCommandFailure(result);
      if (errorCode(error) === "conflict") return "conflict";
      toastManager.add(
        stackedThreadToast({ type: "error", title: "Could not save document", description: errorDetail(error) }),
      );
      return "failed";
    },
    [environmentId, load, path, saveCommand],
  );

  const exportDocx = useCallback(
    async (document: OfficeDocument) => {
      const result = await build({ environmentId, input: { document, basePath: path } });
      if (result._tag !== "Success") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not export",
            description: errorDetail(squashAtomCommandFailure(result)),
          }),
        );
        return;
      }
      downloadBlob(
        new Blob([base64Bytes(result.value.base64)], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
        `${baseName(name)}.docx`,
      );
    },
    [build, environmentId, name, path],
  );

  const exportPdf = useCallback(
    async (document: OfficeDocument) => {
      const html = documentPrintHtml(document, baseName(name));
      const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
      if (bridge?.printDocumentPdf) {
        try {
          const saved = await bridge.printDocumentPdf({ html, name: baseName(name) });
          if (saved.path) {
            toastManager.add(stackedThreadToast({ type: "success", title: "PDF saved", description: saved.path }));
          }
        } catch (error) {
          toastManager.add(
            stackedThreadToast({ type: "error", title: "Could not export PDF", description: errorDetail(error) }),
          );
        }
        return;
      }
      printInFrame(html);
    },
    [name],
  );

  const exportMarkdown = useCallback(
    (document: OfficeDocument) => {
      downloadBlob(new Blob([documentToMarkdown(document)], { type: "text/markdown" }), `${baseName(name)}.md`);
    },
    [name],
  );

  if (opened === null) {
    return (
      <p
        className="m-auto p-6 text-center text-muted-foreground text-sm"
        role={failure ? "alert" : "status"}
      >
        {failure ?? "Opening document…"}
      </p>
    );
  }
  return (
    <DocumentEditor
      key={`${generation}:${opened.revision}`}
      name={name}
      document={opened.document}
      lossOnSave={opened.lossOnSave}
      keptNotShown={opened.keptNotShown}
      onSave={props.canWrite ? save : undefined}
      draftKey={draftKey}
      onReload={() => setGeneration((value) => value + 1)}
      onExportDocx={exportDocx}
      onExportPdf={exportPdf}
      onExportMarkdown={exportMarkdown}
    />
  );
}
