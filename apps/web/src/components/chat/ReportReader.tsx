import type { ReportDocument } from "@specweave-studio/shared/reportDocument";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FileTextIcon,
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
          {document.properties.map((property) => (
            <PropertyRow key={property.label} label={property.label}>
              {property.chips ? (
                property.chips.map((chip) => <Chip key={chip}>{chip}</Chip>)
              ) : (
                <div className="report-document-property-value">
                  {props.renderMarkdown(property.markdown)}
                </div>
              )}
            </PropertyRow>
          ))}
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
 * behind the reader and the page is never split in two. Back returns to the
 * report where it was left; "Open in panel" hands the file to the side panel.
 */
function ReportFilePane(props: {
  readonly target: ReportFileTarget;
  readonly reportTitle: string;
  readonly renderMarkdown: ((markdown: string) => ReactNode) | undefined;
  readonly onClose: () => void;
  readonly onOpenInPanel: () => void;
}) {
  const { target } = props;
  const unresolved = target.tried !== undefined && target.tried.length > 0;
  const file = useProjectFileQuery(
    target.threadRef.environmentId,
    target.cwd,
    unresolved ? null : target.path,
  );
  const name = target.path.split(/[\\/]/).filter(Boolean).at(-1) ?? target.path;
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
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      aria-label={`File ${name}`}
      data-report-file-pane="true"
    >
      <div className="flex shrink-0 items-center gap-1 border-b py-2 pr-2 pl-2">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={props.onClose}
          aria-label={`Back to ${props.reportTitle}`}
          title={`Back to ${props.reportTitle}`}
        >
          <ArrowLeftIcon aria-hidden />
          Back
        </Button>
        <FileTextIcon aria-hidden className="mr-1 ml-1 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm">
            {name}
            {target.line ? (
              <span className="ml-1.5 font-normal text-muted-foreground">line {target.line}</span>
            ) : null}
          </span>
          <span className="block truncate text-muted-foreground text-xs" dir="rtl">
            <bdi>{target.path}</bdi>
          </span>
        </span>
        {unresolved ? null : actions}
        {unresolved ? null : (
          <Button type="button" size="xs" variant="ghost" onClick={props.onOpenInPanel}>
            <PanelRightOpenIcon aria-hidden />
            Open in panel
          </Button>
        )}
      </div>
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
          <div className="report-document report-document-page report-document-prose">
            {props.renderMarkdown(contents)}
          </div>
        ) : (
          <ReadOnlySourcePreview name={name} text={contents} revealLine={target.line} />
        )}
      </div>
    </section>
  );
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
    <div className="report-find" role="search">
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
  const slot = useViewerOverlay({
    open: props.open,
    title: props.title,
    threadRef: props.threadRef,
    onClose: () => setOpen(false),
  });
  const revision = `${slot !== null}:${props.text}`;
  const outline = useDocumentOutline(scrollRef, articleRef, revision);
  const find = useFindInDocument(articleRef, finding ? query : "", revision);
  const canSave = save !== null && !save.savedPath && save.canSave && save.folder !== null;
  const date = formatViewerDate(props.createdAt);

  if (slot === null) return null;
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
      <header className="report-reader-toolbar">
        <span className="report-reader-badge" aria-hidden>
          MD
        </span>
        <h2 className="report-reader-title">{props.title}</h2>
        {date ? (
          <time className="shrink-0 text-muted-foreground text-xs" dateTime={props.createdAt}>
            {date}
          </time>
        ) : null}
        {props.subtitle ? (
          <span className="report-reader-subtitle" dir="rtl">
            <bdi>{props.subtitle}</bdi>
          </span>
        ) : (
          <span className="shrink-0 text-muted-foreground text-xs">
            {props.words.toLocaleString()} words
            {save?.savedPath ? " · Saved" : ""}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
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
              <MenuTrigger
                render={<Button aria-label="More actions" size="icon-sm" variant="ghost" />}
              >
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
                  <MenuItem
                    onClick={() => void navigator.clipboard?.writeText(save.savedPath ?? "")}
                  >
                    <CopyIcon aria-hidden />
                    Copy saved path
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close report"
            onClick={() => setOpen(false)}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      </header>
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
              reportTitle={props.title}
              renderMarkdown={props.renderMarkdown}
              onClose={() => setFile(null)}
              onOpenInPanel={() => {
                setOpen(false);
                useRightPanelStore.getState().openFile(file.threadRef, file.path, file.line);
              }}
            />
          ) : null}
        </div>
      </ReportFileHostContext>
    </div>,
    slot,
  );
}
