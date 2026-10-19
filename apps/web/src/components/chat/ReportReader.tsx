import {
  markdownDocument,
  type ReportDocument,
  type ReportDocumentPart,
} from "@specweave-studio/shared/reportDocument";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FolderOpenIcon,
  ListCollapseIcon,
  PanelRightOpenIcon,
  SaveIcon,
  SearchIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { formatViewerDate } from "~/viewerDate";
import { useViewerOverlay } from "~/viewerOverlayStore";

import { useRightPanelStore } from "../../rightPanelStore";
import { ReadOnlySourcePreview } from "../files/AttachmentFilePreview";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import type { ReportSaveState } from "./ReportArtifact";
import { ReportFileHostContext, type ReportFileTarget } from "./reportFileHost";
import {
  type OutlineHeading,
  reportFileName,
  useDocumentOutline,
  useFindInDocument,
} from "./reportOutline";

function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground text-xs leading-5">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-foreground text-sm leading-5">
        {children}
      </dd>
    </>
  );
}

// Chips and the property table follow document viewers: sans and mono, never
// the serif of the prose, on a 5% wash of the text color with a 10% border.
function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-sm border border-foreground/10 bg-foreground/5 px-1 font-mono text-xs leading-5">
      <span className="truncate">{children}</span>
    </span>
  );
}

function PropertyRows(props: {
  readonly properties: ReadonlyArray<ReportDocumentPart>;
  readonly renderMarkdown: (markdown: string) => ReactNode;
}) {
  return props.properties.map((property) => (
    <PropertyRow key={property.label} label={property.label}>
      {property.chips ? (
        property.chips.map((chip) => <Chip key={chip}>{chip}</Chip>)
      ) : (
        <div className="report-document-property-value">
          {props.renderMarkdown(property.markdown)}
        </div>
      )}
    </PropertyRow>
  ));
}

/**
 * A Markdown file on the page: its title, its frontmatter as a property table,
 * then the body as written. Goes inside a `.report-document` page.
 */
export function MarkdownDocumentView(props: {
  readonly text: string;
  readonly renderMarkdown: (markdown: string) => ReactNode;
}) {
  const document = useMemo(() => markdownDocument(props.text), [props.text]);
  return (
    <>
      {document.title ? <h1 className="report-document-title">{document.title}</h1> : null}
      {document.properties.length > 0 ? (
        <dl className="report-document-properties" data-report-properties="true">
          <PropertyRows properties={document.properties} renderMarkdown={props.renderMarkdown} />
        </dl>
      ) : null}
      <div className="report-document-prose" data-markdown-body="true">
        {props.renderMarkdown(document.body)}
      </div>
    </>
  );
}

/**
 * The reader's page for a report with labeled parts or frontmatter: its
 * facts, a serif title, the outcome as the lead, then each section.
 */
export function ReportDocumentView(props: {
  readonly document: ReportDocument;
  readonly title: string;
  readonly save: ReportSaveState | null;
  readonly renderMarkdown: (markdown: string) => ReactNode;
}) {
  const { document, save } = props;
  const hasProperties =
    document.properties.length > 0 || Boolean(save?.increment) || Boolean(save?.savedPath);
  return (
    <>
      <h1 className="report-document-title">{props.title}</h1>
      {document.lead ? (
        <div className="report-document-prose report-document-lead" data-report-lead="true">
          {props.renderMarkdown(document.lead)}
        </div>
      ) : null}
      {hasProperties ? (
        <dl className="report-document-properties" data-report-properties="true">
          {save?.increment ? (
            <PropertyRow label="Increment">
              <Chip>{save.increment}</Chip>
            </PropertyRow>
          ) : null}
          <PropertyRows properties={document.properties} renderMarkdown={props.renderMarkdown} />
          {save?.savedPath ? (
            <PropertyRow label="Saved">
              <Chip>{save.savedPath}</Chip>
            </PropertyRow>
          ) : null}
        </dl>
      ) : null}
      {document.sections.map((section, index) => (
        <section
          key={`${index}-${section.label}`}
          className="report-document-section"
          data-report-section={section.label}
        >
          <h2 className="report-document-heading">{section.label}</h2>
          <div className="report-document-prose">{props.renderMarkdown(section.markdown)}</div>
        </section>
      ))}
    </>
  );
}

const MARKDOWN_FILE = /\.(?:md|mdx|markdown)$/i;

/**
 * A file the report links to, read in the report's place, so nothing opens
 * behind the reader and the page is never split in two. The overlay header
 * names it and offers Back to the report, where it was left; its own actions
 * (editor, file manager, "Open in panel") join the header's.
 */
function ReportFilePane(props: {
  readonly target: ReportFileTarget;
  readonly renderMarkdown: ((markdown: string) => ReactNode) | undefined;
  readonly actionsSlot: HTMLElement | null;
  readonly onOpenInPanel: () => void;
}) {
  const { target } = props;
  const unresolved = target.tried !== undefined && target.tried.length > 0;
  const file = useProjectFileQuery(
    target.threadRef.environmentId,
    target.cwd,
    unresolved ? null : target.path,
  );
  const name = reportFileTargetName(target);
  const contents = file.data?.contents ?? null;
  const actions = (
    <>
      {target.openInEditor ? (
        <Button type="button" size="xs" variant="ghost" onClick={target.openInEditor}>
          <SquarePenIcon aria-hidden />
          Open in editor
        </Button>
      ) : null}
      {target.reveal ? (
        <Button type="button" size="xs" variant="ghost" onClick={target.reveal}>
          <FolderOpenIcon aria-hidden />
          {target.revealLabel ?? "Reveal"}
        </Button>
      ) : null}
    </>
  );
  const headerActions = unresolved ? null : (
    <>
      {actions}
      <Button type="button" size="xs" variant="ghost" onClick={props.onOpenInPanel}>
        <PanelRightOpenIcon aria-hidden />
        Open in panel
      </Button>
    </>
  );
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      aria-label={`File ${name}`}
      data-report-file-pane="true"
    >
      {props.actionsSlot && headerActions ? createPortal(headerActions, props.actionsSlot) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {unresolved ? (
          <div
            className="flex flex-col gap-2 p-4 text-sm"
            role="status"
            data-report-file-unresolved="true"
          >
            <p>
              {name} was not found. The report names it without saying where it lives, and it is in
              none of these places:
            </p>
            <ul className="flex flex-col gap-1 font-mono text-muted-foreground text-xs">
              {target.tried!.map((path) => (
                <li key={path} className="break-all">
                  {path}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Ask the worker for its full path, or look in its worktree.
            </p>
            {target.openInEditor || target.reveal ? (
              <div className="flex gap-1">{actions}</div>
            ) : null}
          </div>
        ) : file.isNotFile ? (
          <p className="p-4 text-muted-foreground text-sm">
            This is a folder. Open it in the panel to browse it.
          </p>
        ) : file.error !== null && contents === null ? (
          <div className="flex flex-col items-start gap-2 p-4 text-sm" role="alert">
            <p className="text-destructive-foreground">{file.error}</p>
            <div className="flex gap-1">{actions}</div>
          </div>
        ) : contents === null ? (
          <p className="p-4 text-muted-foreground text-sm">Loading…</p>
        ) : MARKDOWN_FILE.test(name) && props.renderMarkdown ? (
          <article className="report-document report-document-page">
            <MarkdownDocumentView text={contents} renderMarkdown={props.renderMarkdown} />
          </article>
        ) : (
          <ReadOnlySourcePreview name={name} text={contents} revealLine={target.line} />
        )}
      </div>
    </section>
  );
}

function reportFileTargetName(target: ReportFileTarget): string {
  return target.path.split(/[\\/]/).filter(Boolean).at(-1) ?? target.path;
}

function extensionBadge(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
}

/** One dash per heading, the one being read marked; hovering lists their titles. */
function OutlineRail(props: {
  readonly headings: ReadonlyArray<OutlineHeading>;
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  if (props.headings.length < 2) return <div className="report-outline" aria-hidden />;
  return (
    <nav className="report-outline group/outline" aria-label="Outline" data-report-outline="true">
      <ol className="report-outline-dashes">
        {props.headings.map((heading) => (
          <li key={heading.id}>
            <button
              type="button"
              className="report-outline-dash"
              data-level={heading.level}
              data-active={heading.id === props.activeId ? "true" : undefined}
              aria-label={heading.text}
              onClick={() => props.onSelect(heading.id)}
            />
          </li>
        ))}
      </ol>
      <ol className="report-outline-list">
        {props.headings.map((heading) => (
          <li key={heading.id}>
            <button
              type="button"
              className="report-outline-item"
              data-level={heading.level}
              data-active={heading.id === props.activeId ? "true" : undefined}
              tabIndex={-1}
              onClick={() => props.onSelect(heading.id)}
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function FindBar(props: {
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly count: number;
  readonly index: number;
  readonly onStep: (by: 1 | -1) => void;
  readonly onClose: () => void;
}) {
  return (
    // The find field answers Escape itself (it closes find, not the report).
    <div className="report-find" role="search" data-viewer-escape="own">
      <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        autoFocus
        className="report-find-input"
        value={props.query}
        placeholder="Find in report"
        aria-label="Find in report"
        onChange={(event) => props.onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
          }
        }}
      />
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums" aria-live="polite">
        {props.query.trim() ? `${props.count === 0 ? 0 : props.index + 1} of ${props.count}` : ""}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Previous match"
        onClick={() => props.onStep(-1)}
      >
        <ChevronUpIcon aria-hidden />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        onClick={() => props.onStep(1)}
      >
        <ChevronDownIcon aria-hidden />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Close find"
        onClick={props.onClose}
      >
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}

function downloadReport(text: string, title: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = reportFileName(title);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The report opened as a document beside the conversation, the way document
 * viewers do: a toolbar (find, download, copy, more), an outline rail, the
 * page, and any file it links to read alongside. It opens in the app's one
 * viewer overlay, beside the thread it came from.
 */
export function ReportReader(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly text: string;
  readonly title: string;
  readonly words: number;
  readonly save: ReportSaveState | null;
  readonly layout: ReportDocument | null;
  readonly renderMarkdown?: ((markdown: string) => ReactNode) | undefined;
  readonly renderAttachments?: (() => ReactNode) | undefined;
  readonly onShowInline?: (() => void) | undefined;
  /** Shown beside the title instead of the word count, such as the file's path. */
  readonly subtitle?: string | undefined;
  /** When the report was written, as an ISO timestamp. */
  readonly createdAt?: string | undefined;
  /** The thread the report came from, shown beside it. */
  readonly threadRef?: ScopedThreadRef | null | undefined;
  /** The rendered report, shown when it has no labeled parts. */
  readonly children: ReactNode;
}) {
  const { save } = props;
  const [file, setFile] = useState<ReportFileTarget | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const fileHost = useMemo(() => ({ open: setFile }), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const setOpen = (next: boolean) => {
    props.onOpenChange(next);
    if (!next) {
      setFile(null);
      setFinding(false);
      setQuery("");
    }
  };
  const date = formatViewerDate(props.createdAt);
  // A markdown file opened from a message is a document; a worker's reply is a report.
  const kind = props.subtitle ? "Document" : "Report";
  const fileName = file ? reportFileTargetName(file) : null;
  const slots = useViewerOverlay({
    open: props.open,
    title: fileName ?? props.title,
    kind: file ? "File" : kind,
    badge: fileName ? extensionBadge(fileName) : "MD",
    detail: file
      ? file.line
        ? `line ${file.line}`
        : null
      : [
          date,
          props.subtitle ? null : `${props.words.toLocaleString()} words`,
          save?.savedPath ? "Saved" : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
    threadRef: props.threadRef,
    trail: file ? [{ kind, title: props.title }] : undefined,
    onBack: file ? () => setFile(null) : null,
    onClose: () => setOpen(false),
  });
  const slot = slots?.content ?? null;
  const revision = `${slot !== null}:${props.text}`;
  const outline = useDocumentOutline(scrollRef, articleRef, revision);
  const find = useFindInDocument(articleRef, finding ? query : "", revision);
  const canSave = save !== null && !save.savedPath && save.canSave && save.folder !== null;

  if (slots === null) return null;
  const reportActions = (
    <>
      {finding ? (
        <FindBar
          query={query}
          onQuery={setQuery}
          count={find.count}
          index={find.index}
          onStep={find.step}
          onClose={() => {
            setFinding(false);
            setQuery("");
          }}
        />
      ) : (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Find in report"
          onClick={() => setFinding(true)}
        >
          <SearchIcon aria-hidden />
        </Button>
      )}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Download as markdown"
        onClick={() => downloadReport(props.text, props.title)}
      >
        <DownloadIcon aria-hidden />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={copied ? "Copied" : "Copy report"}
        onClick={() => {
          void navigator.clipboard?.writeText(props.text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          });
        }}
      >
        {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      </Button>
      {props.onShowInline || canSave || save?.savedPath ? (
        <Menu>
          <MenuTrigger render={<Button aria-label="More actions" size="icon-sm" variant="ghost" />}>
            <EllipsisIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end">
            {props.onShowInline ? (
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  props.onShowInline?.();
                }}
              >
                <ListCollapseIcon aria-hidden />
                Show in chat
              </MenuItem>
            ) : null}
            {canSave ? (
              <MenuItem disabled={save.saving} onClick={save.onSave}>
                <SaveIcon aria-hidden />
                {save.saving
                  ? "Saving…"
                  : `${save.increment ? "Save to increment" : "Save to reports"} (${save.folder}/)`}
              </MenuItem>
            ) : null}
            {save?.savedPath ? (
              <MenuItem onClick={() => void navigator.clipboard?.writeText(save.savedPath ?? "")}>
                <CopyIcon aria-hidden />
                Copy saved path
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
  return createPortal(
    <div
      className="viewer-overlay-frame"
      data-report-reader="true"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setFinding(true);
        }
      }}
    >
      {slots.actions && !file ? createPortal(reportActions, slots.actions) : null}
      {save?.error ? (
        <p className="border-b px-4 py-2 text-destructive-foreground text-xs" role="alert">
          {save.error}
        </p>
      ) : null}
      <ReportFileHostContext value={fileHost}>
        <div className="flex min-h-0 flex-1">
          <div
            ref={scrollRef}
            className="report-reader-body"
            data-report-reader-body="true"
            // Kept mounted under an open file, so Back returns to the same place.
            hidden={file !== null}
          >
            <OutlineRail
              headings={outline.headings}
              activeId={outline.activeId}
              onSelect={outline.scrollTo}
            />
            <article ref={articleRef} className="report-document report-document-page">
              {props.layout && props.renderMarkdown ? (
                <ReportDocumentView
                  document={props.layout}
                  title={props.title}
                  save={save}
                  renderMarkdown={props.renderMarkdown}
                />
              ) : (
                <div className="report-document-prose">{props.children}</div>
              )}
              {props.renderAttachments ? (
                <div className="report-document-attachments">{props.renderAttachments()}</div>
              ) : null}
            </article>
          </div>
          {file ? (
            <ReportFilePane
              key={`${file.path}:${file.line ?? ""}`}
              target={file}
              renderMarkdown={props.renderMarkdown}
              actionsSlot={slots.actions}
              onOpenInPanel={() => {
                setOpen(false);
                useRightPanelStore.getState().openFile(file.threadRef, file.path, file.line);
              }}
            />
          ) : null}
        </div>
      </ReportFileHostContext>
    </div>,
    slots.content,
  );
}
