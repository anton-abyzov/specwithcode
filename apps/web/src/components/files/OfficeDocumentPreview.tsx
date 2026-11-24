/**
 * Native read-only previews for host Office files:
 * - `.xlsx` via `design.previewWorkbook` -> canonical `SheetView` (tabs, formulas,
 *   formatting, sorting, column resize/hide, CSV/TSV/HTML/Markdown export).
 * - `.docx` via `design.previewDocument` -> structured React AST (`DocxPreviewBlock[]`)
 *   with zero raw HTML (`dangerouslySetInnerHTML` is never used), fragment-only `#anchor`
 *   links, bounded raster images, and explicit unsupported-feature disclosure.
 */
import type {
  DesignError,
  DesignPreviewDocumentResult,
  DesignPreviewWorkbookResult,
  DocxPreviewBlock,
  DocxPreviewRun,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { AuthFilesystemWriteScope } from "@specweave-studio/contracts";
import type { MouseEvent, ReactNode } from "react";

import { useTheme } from "~/hooks/useTheme";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { design } from "~/studio/design";

import { HostDocumentEditor } from "../office/document/HostDocumentEditor";
import { SheetView } from "../office/SheetView";
import { FilePreviewCard } from "./DeckPreview";

/** Why an Office file has no preview, from the server's refusal. */
export function officeFailureReason(
  failure: unknown,
  fallback: string | null,
  kind: "workbook" | "document",
): string {
  const error = failure as Partial<DesignError> | null;
  if (error?._tag === "DesignError" && typeof error.detail === "string") {
    if (error.code === "too_large" || error.code === "invalid") {
      return `No preview: ${error.detail}`;
    }
    return error.detail;
  }
  return (
    fallback ??
    (kind === "workbook"
      ? "The workbook could not be read for a preview."
      : "The document could not be read for a preview.")
  );
}

/** One-line summary of an Excel workbook preview and any omitted/unsupported parts. */
export function workbookSummary(preview: DesignPreviewWorkbookResult): string {
  const sheets = preview.sheetCount === 1 ? "1 sheet" : `${preview.sheetCount} sheets`;
  const notes: string[] = [];
  if (preview.truncatedSheets > 0) {
    notes.push(
      preview.truncatedSheets === 1
        ? "1 sheet truncated to grid limits"
        : `${preview.truncatedSheets} sheets truncated to grid limits`,
    );
  }
  if (preview.unsupportedFeatures.length > 0) {
    notes.push(`not shown here: ${preview.unsupportedFeatures.join(", ")}`);
  }
  if (notes.length === 0) return `${sheets} · Read-only Excel preview`;
  return `${sheets} · ${notes.join("; ")}. Open in Excel for full fidelity.`;
}

/** One-line summary of a Word document preview and any omitted/unsupported parts. */
export function documentSummary(preview: DesignPreviewDocumentResult): string {
  const notes: string[] = [];
  if (preview.truncated) notes.push("truncated for preview length");
  if (preview.imagesOmitted > 0) {
    notes.push(
      preview.imagesOmitted === 1
        ? "1 large image omitted"
        : `${preview.imagesOmitted} large images omitted`,
    );
  }
  if (preview.unsupportedFeatures.length > 0) {
    notes.push(`not shown here: ${preview.unsupportedFeatures.join(", ")}`);
  }
  if (notes.length === 0) return "Read-only Word preview";
  return `Read-only Word preview · ${notes.join("; ")}. Open in Word for full fidelity.`;
}

/**
 * The element id of a bookmark. The prefix keeps a document's names apart from
 * the app's own ids, and links never go through the address bar.
 */
function bookmarkElementId(name: string): string {
  return `docx-${encodeURIComponent(name)}`;
}

/** Scroll to a bookmark inside the same preview; the app's route stays as it is. */
function goToBookmark(event: MouseEvent<HTMLAnchorElement>, name: string): void {
  event.preventDefault();
  const id = bookmarkElementId(name);
  const preview = event.currentTarget.closest("[data-docx-preview]");
  const target = preview
    ? Array.from(preview.querySelectorAll("[id]")).find((element) => element.id === id)
    : undefined;
  if (target && typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "start" });
  }
}

function renderRun(run: DocxPreviewRun, key: number): ReactNode {
  let content: ReactNode = run.text;
  if (run.code) {
    content = (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{content}</code>
    );
  }
  if (run.bold) content = <strong>{content}</strong>;
  if (run.italic) content = <em>{content}</em>;
  if (run.underline) content = <span className="underline">{content}</span>;
  if (run.strike) content = <span className="line-through">{content}</span>;
  if (run.color) content = <span style={{ color: run.color }}>{content}</span>;
  if (run.anchor) {
    const anchor = run.anchor;
    content = (
      <a
        href={`#${bookmarkElementId(anchor)}`}
        className="text-primary underline"
        data-docx-link={anchor}
        onClick={(event) => goToBookmark(event, anchor)}
        onAuxClick={(event) => event.preventDefault()}
      >
        {content}
      </a>
    );
  }
  return <span key={key}>{content}</span>;
}

function renderRuns(runs: ReadonlyArray<DocxPreviewRun>): ReactNode {
  return runs.map((run, index) => renderRun(run, index));
}

function alignClass(align?: "left" | "center" | "right" | "justify"): string {
  switch (align) {
    case "center":
      return "text-center";
    case "right":
      return "text-right";
    case "justify":
      return "text-justify";
    default:
      return "text-left";
  }
}

function renderBlock(
  block: DocxPreviewBlock,
  images: Readonly<Record<string, string>>,
  key: number,
): ReactNode {
  switch (block.type) {
    case "heading": {
      const id = block.id ? bookmarkElementId(block.id) : undefined;
      const children = renderRuns(block.runs);
      switch (block.level) {
        case 1:
          return (
            <h1 key={key} id={id} className="mt-6 mb-3 font-semibold text-2xl tracking-tight">
              {children}
            </h1>
          );
        case 2:
          return (
            <h2 key={key} id={id} className="mt-5 mb-2 font-semibold text-xl tracking-tight">
              {children}
            </h2>
          );
        case 3:
          return (
            <h3 key={key} id={id} className="mt-4 mb-2 font-semibold text-lg">
              {children}
            </h3>
          );
        case 4:
          return (
            <h4 key={key} id={id} className="mt-3 mb-1.5 font-semibold text-base">
              {children}
            </h4>
          );
        case 5:
          return (
            <h5 key={key} id={id} className="mt-3 mb-1 font-medium text-sm">
              {children}
            </h5>
          );
        case 6:
          return (
            <h6 key={key} id={id} className="mt-3 mb-1 font-medium text-muted-foreground text-sm">
              {children}
            </h6>
          );
      }
    }
    case "paragraph":
      return (
        <p
          key={key}
          id={block.id ? bookmarkElementId(block.id) : undefined}
          className={`my-2.5 whitespace-pre-wrap text-sm leading-relaxed ${alignClass(block.align)}`}
        >
          {renderRuns(block.runs)}
        </p>
      );
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      const listClass = block.ordered
        ? "my-3 list-decimal space-y-1.5 pl-6 text-sm leading-relaxed"
        : "my-3 list-disc space-y-1.5 pl-6 text-sm leading-relaxed";
      return (
        <ListTag key={key} className={listClass}>
          {block.items.map((item, idx) => (
            <li key={idx} className="whitespace-pre-wrap">
              {renderRuns(item.runs)}
            </li>
          ))}
        </ListTag>
      );
    }
    case "table":
      return (
        <div key={key} className="my-4 overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-left text-sm">
            <tbody>
              {block.rows.map((row, rIdx) => (
                <tr key={rIdx} className="border-b last:border-b-0">
                  {row.cells.map((cell, cIdx) => {
                    const CellTag = cell.header ? "th" : "td";
                    return (
                      <CellTag
                        key={cIdx}
                        className={
                          cell.header
                            ? "border-r bg-muted/50 px-3 py-2 font-medium last:border-r-0"
                            : "border-r px-3 py-2 whitespace-pre-wrap align-top last:border-r-0"
                        }
                      >
                        {renderRuns(cell.runs)}
                      </CellTag>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image": {
      const src = images[block.asset];
      if (!src) return null;
      return (
        <figure key={key} className="my-4">
          <img
            src={src}
            alt={block.alt ?? ""}
            className="max-h-[480px] max-w-full rounded-md border object-contain"
          />
          {block.alt ? (
            <figcaption className="mt-1.5 text-muted-foreground text-xs">{block.alt}</figcaption>
          ) : null}
        </figure>
      );
    }
    case "divider":
      return <hr key={key} className="my-4 border-border" />;
  }
}

/** Pure presentational renderer for a parsed `.docx` preview result. */
export function DocxDocumentView(props: {
  readonly name: string;
  readonly preview: DesignPreviewDocumentResult;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background"
      data-docx-preview={props.name}
    >
      <div className="border-b bg-muted/30 px-6 py-2 text-muted-foreground text-xs" role="status">
        {documentSummary(props.preview)}
      </div>
      <article className="mx-auto w-full max-w-3xl px-8 py-6 text-foreground">
        {props.preview.blocks.length === 0 ? (
          <p className="text-muted-foreground text-sm">This document has no readable text blocks.</p>
        ) : (
          props.preview.blocks.map((block, index) =>
            renderBlock(block, props.preview.images, index),
          )
        )}
      </article>
    </div>
  );
}

/** A host `.xlsx` workbook rendered through `SheetView`, or a card on refusal. */
export function HostWorkbookPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly name: string;
}) {
  const { resolvedTheme } = useTheme();
  const capabilities = useServerConfigs().get(props.environmentId)?.environment.capabilities;
  const supported = capabilities?.officeDocumentPreview === true;
  const workbook = useEnvironmentQuery(
    supported
      ? design.previewWorkbook({ environmentId: props.environmentId, input: { path: props.path } })
      : null,
  );
  const card = (reason: string, role?: "alert") => (
    <FilePreviewCard
      environmentId={props.environmentId}
      path={props.path}
      name={props.name}
      reason={reason}
      role={role}
    />
  );
  if (!supported) {
    return card(
      "This machine's SpecWithCode is too old to preview Excel workbooks. Update it to see sheets.",
    );
  }
  if (workbook.data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-xlsx-preview={props.name}>
        <div
          className="shrink-0 border-b bg-muted/30 px-4 py-1.5 text-muted-foreground text-xs"
          role="status"
        >
          {workbookSummary(workbook.data)}
        </div>
        <div className="min-h-0 flex-1">
          <SheetView text={workbook.data.sheetJson} mode={resolvedTheme} />
        </div>
      </div>
    );
  }
  if (workbook.error !== null) {
    return card(officeFailureReason(workbook.failure, workbook.error, "workbook"), "alert");
  }
  return (
    <p className="m-auto p-6 text-center text-muted-foreground text-sm" role="status">
      Reading workbook…
    </p>
  );
}

/** A host `.docx` document rendered as typed blocks, or a card on refusal. */
export function HostDocumentPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly name: string;
}) {
  const capabilities = useServerConfigs().get(props.environmentId)?.environment.capabilities;
  const supported = capabilities?.officeDocumentPreview === true;
  const editing = capabilities?.officeDocumentEditing === true;
  const canWrite = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const doc = useEnvironmentQuery(
    supported && !editing
      ? design.previewDocument({ environmentId: props.environmentId, input: { path: props.path } })
      : null,
  );
  const card = (reason: string, role?: "alert") => (
    <FilePreviewCard
      environmentId={props.environmentId}
      path={props.path}
      name={props.name}
      reason={reason}
      role={role}
    />
  );
  if (!supported) {
    return card(
      "This machine's SpecWithCode is too old to preview Word documents. Update it to read them here.",
    );
  }
  if (editing) {
    return (
      <HostDocumentEditor
        environmentId={props.environmentId}
        path={props.path}
        name={props.name}
        canWrite={canWrite}
      />
    );
  }
  if (doc.data) {
    return <DocxDocumentView name={props.name} preview={doc.data} />;
  }
  if (doc.error !== null) {
    return card(officeFailureReason(doc.failure, doc.error, "document"), "alert");
  }
  return (
    <p className="m-auto p-6 text-center text-muted-foreground text-sm" role="status">
      Reading document…
    </p>
  );
}
