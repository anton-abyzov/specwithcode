import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  reportKey,
  reportSummary,
  reportTitle,
  reportWordCount,
} from "@specweave-studio/shared/threadReport";
import {
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  ListCollapseIcon,
  FolderCheckIcon,
  Maximize2Icon,
  MilestoneIcon,
  SaveIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";

/** Where a report can be saved: its own thread in a project. */
export interface ReportArtifactSource {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

export interface ReportSaveState {
  readonly increment: string | null;
  /** Project-relative path once saved. */
  readonly savedPath: string | null;
  /** Where saving would put it; null when the project has no `.specweave`. */
  readonly folder: string | null;
  readonly canSave: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onSave: () => void;
}

/** The line under the card's title: kind, size, and where the report lives. */
function ReportMeta({ words, save }: { words: number; save: ReportSaveState | null }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
      <span>Report · {words.toLocaleString()} words</span>
      {save?.increment ? (
        <span
          className="inline-flex min-w-0 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-1.5 py-px font-medium text-foreground/80"
          data-report-increment={save.increment}
          title={`SpecWeave increment ${save.increment}`}
        >
          <MilestoneIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{save.increment}</span>
        </span>
      ) : null}
      {save?.savedPath ? (
        <span className="inline-flex items-center gap-1" title={save.savedPath}>
          <FolderCheckIcon aria-hidden className="size-3 shrink-0" />
          Saved
        </span>
      ) : null}
    </div>
  );
}

function SaveButton({ save, size }: { save: ReportSaveState; size: "xs" | "sm" }) {
  if (save.savedPath || !save.canSave || save.folder === null) return null;
  return (
    <Button
      type="button"
      size={size}
      variant="outline"
      disabled={save.saving}
      onClick={save.onSave}
      title={`Save as markdown in ${save.folder}`}
    >
      <SaveIcon aria-hidden />
      {save.saving ? "Saving…" : save.increment ? "Save to increment" : "Save to reports"}
    </Button>
  );
}

/**
 * A long report shown the way an artifact is: a card with its title,
 * opening lines and increment, which opens the whole report in a reader.
 */
export function ReportArtifactCard(props: {
  readonly text: string;
  readonly fallbackTitle: string;
  readonly save: ReportSaveState | null;
  /**
   * Opens the whole report in the conversation instead, where its text can be
   * quoted like any reply. Absent where the report has no place in a timeline.
   */
  readonly onShowInline?: () => void;
  /** The rendered report, shown in the reader. */
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const title = reportTitle(props.text, props.fallbackTitle);
  const summary = reportSummary(props.text);
  const words = reportWordCount(props.text);
  const save = props.save;

  return (
    <>
      <div
        className="group/report flex w-full min-w-0 max-w-2xl flex-col gap-2 rounded-xl border border-border bg-card/60 p-3 text-card-foreground shadow-xs"
        data-report-artifact="true"
      >
        <button
          type="button"
          className="flex min-w-0 items-start gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          onClick={() => setOpen(true)}
          aria-label={`Open report: ${title}`}
          data-scroll-anchor-ignore
        >
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/50 text-muted-foreground">
            <FileTextIcon aria-hidden className="size-4" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate font-medium text-foreground text-sm group-hover/report:underline">
              {title}
            </span>
            <ReportMeta words={words} save={save} />
            {summary ? (
              <span className="line-clamp-3 text-foreground/80 text-sm leading-relaxed">
                {summary}
              </span>
            ) : null}
          </span>
        </button>
        <div className="flex flex-wrap items-center gap-2 sm:pl-12">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            onClick={() => setOpen(true)}
            data-scroll-anchor-ignore
          >
            <Maximize2Icon aria-hidden />
            Open report
          </Button>
          {save ? <SaveButton save={save} size="xs" /> : null}
          {save?.error ? (
            <span className="text-destructive text-xs" role="alert">
              {save.error}
            </span>
          ) : null}
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup
          className="flex h-[min(88vh,900px)] max-w-4xl flex-col overflow-hidden p-0 sm:max-w-4xl"
          data-report-reader="true"
        >
          <div className="flex shrink-0 flex-col gap-1.5 border-b px-6 pt-5 pb-3 pr-14">
            <DialogTitle className="text-lg leading-snug">{title}</DialogTitle>
            <DialogDescription render={<div />}>
              <ReportMeta words={words} save={save} />
            </DialogDescription>
          </div>
          {/* Long reading stays on an opaque page, whatever the dialog glass lets through. */}
          <div
            className="min-h-0 flex-1 overflow-y-auto bg-background px-6 py-4"
            data-report-reader-body="true"
          >
            {props.children}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t bg-muted/40 px-6 py-3">
            <span
              className="min-w-0 truncate text-muted-foreground text-xs"
              title={save?.savedPath ?? undefined}
            >
              {save?.savedPath
                ? `Saved as ${save.savedPath}`
                : save?.folder
                  ? `Not saved yet. Saving puts it in ${save.folder}/`
                  : null}
            </span>
            <div className="flex items-center gap-2">
              {props.onShowInline ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setOpen(false);
                    props.onShowInline?.();
                  }}
                  title="Show the whole report in the conversation, where it can be quoted"
                >
                  <ListCollapseIcon aria-hidden />
                  Show in chat
                </Button>
              ) : null}
              {save ? <SaveButton save={save} size="sm" /> : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(props.text).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1_500);
                  });
                }}
              >
                {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/** The save state of one report of a thread in a project, read from and written to disk. */
export function useReportSaveState(source: ReportArtifactSource, text: string): ReportSaveState {
  const reports = useEnvironmentQuery(
    projectWorkspace.threadReports({
      environmentId: source.environmentId,
      input: { projectId: source.projectId, threadId: source.threadId },
    }),
  );
  const saveReport = useAtomCommand(projectWorkspace.threadReportSave);
  const canSave = useEnvironmentScope(source.environmentId, AuthFilesystemWriteScope);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = reportKey(source.threadId, text);
  const saved = reports.data?.reports.find((report) => report.key === key) ?? null;
  return {
    increment: reports.data?.increment?.id ?? null,
    savedPath: saved?.path ?? null,
    folder: reports.data?.folder ?? null,
    canSave,
    saving,
    error,
    onSave: () => {
      setSaving(true);
      setError(null);
      void saveReport({
        environmentId: source.environmentId,
        input: { projectId: source.projectId, threadId: source.threadId, text },
      }).then((result) => {
        setSaving(false);
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "The report was not saved.");
          return;
        }
        reports.refresh();
      });
    },
  };
}

function SavedReportArtifact(props: {
  readonly source: ReportArtifactSource;
  readonly text: string;
  readonly fallbackTitle: string;
  readonly onShowInline?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  const save = useReportSaveState(props.source, props.text);
  return (
    <ReportArtifactCard
      text={props.text}
      fallbackTitle={props.fallbackTitle}
      save={save}
      {...(props.onShowInline ? { onShowInline: props.onShowInline } : {})}
    >
      {props.children}
    </ReportArtifactCard>
  );
}

/** A report card, with save state when the report belongs to a project thread. */
export function ReportArtifact(props: {
  readonly source: ReportArtifactSource | null;
  readonly text: string;
  readonly fallbackTitle: string;
  readonly onShowInline?: () => void;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const inline = props.onShowInline ? { onShowInline: props.onShowInline } : {};
  return (
    <div className={cn("py-0.5", props.className)}>
      {props.source ? (
        <SavedReportArtifact
          source={props.source}
          text={props.text}
          fallbackTitle={props.fallbackTitle}
          {...inline}
        >
          {props.children}
        </SavedReportArtifact>
      ) : (
        <ReportArtifactCard
          text={props.text}
          fallbackTitle={props.fallbackTitle}
          save={null}
          {...inline}
        >
          {props.children}
        </ReportArtifactCard>
      )}
    </div>
  );
}
