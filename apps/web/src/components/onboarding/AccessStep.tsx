import { useEffect, useState, type ReactNode } from "react";

import { useT, useTx } from "../../i18n";
import type { AccessRowId, AccessRowPlan } from "../../onboarding/accessRows.logic";
import { FirstRunFullDiskAccess } from "../access/FullDiskAccess";
import {
  AccessRow,
  AccessRowAction,
  AccessRowChip,
  AccessRowList,
  FolderRowGlyph,
  TerminalRowGlyph,
} from "./AccessRow";
import { FullAccessExplanation } from "./FullAccessExplanation";
import { StepShell, WizardStepFooter } from "./WizardFrame";

/** What a row container gets from the list: whether it is the open row, and how to open it. */
export interface AccessRowOpen {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** The Files and commands row's answer on this run. */
export type FilesAnswer = "accepted" | "declined" | null;

export interface FilesRowProps {
  /** The machines the row acts on, named when there are several. */
  readonly machineNames: readonly string[];
  /** New chats there start Supervised; otherwise on another mode below Full access. */
  readonly keepsSupervised: boolean;
  /** Answered on this run. */
  readonly answer: FilesAnswer;
  /**
   * An answer saved before this run, as after Quit & Reopen: the earlier modes
   * are gone, so the line says where the setting lives and offers no Change.
   */
  readonly answeredBefore?: FilesAnswer;
  /** Saves Full access; resolves to an error message when that failed. */
  readonly onAccept: () => Promise<string | null>;
  /** Keeps the current access (or puts back what an accept on this run changed). */
  readonly onKeep: () => Promise<string | null>;
}

/**
 * The Access step of first-run setup: a list where each row has its own state
 * and its own labelled action, and Continue grants nothing. One row is open at
 * a time. The footer is Back and Continue; Continue is the only filled button
 * in the footer and among the rows' own actions (the shared Mac checklist in
 * the open Mac apps row keeps its own buttons, AC-09 and D-14), and it is the
 * neutral action, so Enter moves on without an answer.
 */
export function AccessStep({
  title,
  rows,
  files,
  renderRow,
  onFullDiskAccessAllowed,
  onBack,
  onContinue,
}: {
  readonly title: string;
  /** From `accessRows`, in order. */
  readonly rows: readonly AccessRowPlan[];
  readonly files?: FilesRowProps | undefined;
  /** The rows other tasks own (Your browser, Mac apps, Your iPhone); null leaves one out. */
  readonly renderRow?: (id: AccessRowId, open: AccessRowOpen) => ReactNode;
  /** Whether Full Disk Access is allowed, as 1386's item last read it. */
  readonly onFullDiskAccessAllowed?: ((allowed: boolean) => void) | undefined;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  const t = useT();
  const tx = useTx();
  const [openRow, setOpenRow] = useState<AccessRowId | null>(null);
  const openFor = (id: AccessRowId): AccessRowOpen => ({
    open: openRow === id,
    onOpenChange: (open) => setOpenRow((current) => (open ? id : current === id ? null : current)),
  });
  return (
    <StepShell
      title={title}
      description={tx("Each row has its own button. Change any of it later in Settings.")}
    >
      <AccessRowList>
        {rows.map((row) =>
          row.id === "files" ? (
            files ? (
              <FilesRow key="files" {...files} {...openFor("files")} />
            ) : null
          ) : row.id === "full-disk-access" ? (
            <FullDiskAccessListRow
              key={row.id}
              onAllowedChange={onFullDiskAccessAllowed}
              {...openFor(row.id)}
            />
          ) : (
            <RowSlot key={row.id}>{renderRow?.(row.id, openFor(row.id)) ?? null}</RowSlot>
          ),
        )}
      </AccessRowList>
      <WizardStepFooter
        back={{ onClick: onBack }}
        leading={
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {tx("Continue changes nothing.")}
          </span>
        }
        primary={{ label: t("wizard.continue"), onClick: onContinue, neutral: true }}
      />
    </StepShell>
  );
}

function RowSlot({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}

/**
 * 1386's first-run Full Disk Access item, unchanged, as the list's last row:
 * its own text, states and actions; only its frame is the row's.
 */
function FullDiskAccessListRow({
  onAllowedChange,
  open,
  onOpenChange,
}: AccessRowOpen & {
  readonly onAllowedChange?: ((allowed: boolean) => void) | undefined;
}) {
  return (
    <li
      data-access-row="full-disk-access"
      className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 border-t border-border px-3 py-2.5 first:border-t-0 [&_[data-slot=first-run-fda]]:m-0 [&_[data-slot=first-run-fda]]:rounded-none [&_[data-slot=first-run-fda]]:border-0 [&_[data-slot=first-run-fda]]:bg-transparent [&_[data-slot=first-run-fda]]:p-0 [&_[data-slot=first-run-fda]]:pt-2"
    >
      <span
        aria-hidden
        className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground"
      >
        <FolderRowGlyph />
      </span>
      <div className="min-w-0">
        <FirstRunFullDiskAccess
          onAllowedChange={onAllowedChange}
          open={open}
          onOpenChange={onOpenChange}
        />
      </div>
    </li>
  );
}

function FilesRow({
  machineNames,
  keepsSupervised,
  answer,
  answeredBefore = null,
  onAccept,
  onKeep,
  open,
  onOpenChange,
}: FilesRowProps & AccessRowOpen) {
  const t = useT();
  const tx = useTx();
  const [saving, setSaving] = useState<"accept" | "keep" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Change on this run shows both answers again until one is pressed.
  const [changing, setChanging] = useState(false);
  // The pressed button goes away with the answer: focus moves to the control that replaces it.
  const [focusNext, setFocusNext] = useState<"change" | "accept" | null>(null);
  useEffect(() => {
    if (focusNext === null) return;
    document
      .querySelector<HTMLElement>(`[data-access-row="files"] [data-access-focus="${focusNext}"]`)
      ?.focus();
    setFocusNext(null);
  }, [focusNext]);
  const shown = answer ?? answeredBefore;
  const asking = shown === null || changing;
  const save = async (choice: "accept" | "keep") => {
    if (saving !== null) return;
    setSaving(choice);
    setError(null);
    try {
      const failed = await (choice === "accept" ? onAccept() : onKeep());
      setError(failed);
      if (failed === null) {
        setChanging(false);
        setFocusNext("change");
      }
    } catch {
      setError(t("wizard.access.saveFailed"));
    } finally {
      setSaving(null);
    }
  };
  const keepLabel = t(
    keepsSupervised ? "wizard.access.keepSupervised" : "wizard.access.keepCurrent",
  );
  const where =
    machineNames.length > 1 ? tx("On {machines}.", { machines: machineNames.join(", ") }) : null;
  const state = asking ? (
    <>
      {tx("Full access: agents edit and run without asking each time.")} {where}{" "}
      <button
        type="button"
        className="font-medium text-foreground underline underline-offset-2"
        aria-expanded={open}
        aria-controls="access-row-files-body"
        onClick={() => onOpenChange(!open)}
      >
        {tx("What it allows")}
      </button>
    </>
  ) : (
    <>
      {shown === "accepted"
        ? tx("New chats start with Full access.")
        : keepsSupervised
          ? tx("New chats stay Supervised.")
          : tx("New chats keep their current access.")}{" "}
      {where}
      {answer === null ? ` ${tx("Change it in Settings > General.")}` : null}
    </>
  );
  return (
    <AccessRow
      id="files"
      glyph={<TerminalRowGlyph />}
      title={tx("Files and commands")}
      done={!asking && shown === "accepted"}
      state={
        <>
          {state}
          {error ? (
            <span role="alert" className="mt-1 block text-destructive-foreground">
              {error}
            </span>
          ) : null}
        </>
      }
      actions={
        asking ? (
          <>
            <AccessRowAction
              data-access-answer="accept"
              data-access-focus="accept"
              disabled={saving !== null}
              onClick={() => void save("accept")}
            >
              {saving === "accept" ? t("wizard.access.saving") : t("wizard.access.use")}
            </AccessRowAction>
            <AccessRowAction
              data-access-answer="keep"
              disabled={saving !== null}
              onClick={() => void save("keep")}
            >
              {keepLabel}
            </AccessRowAction>
          </>
        ) : (
          <>
            <AccessRowChip on={shown === "accepted"}>
              {shown === "accepted"
                ? t("wizard.access.fullAccess")
                : keepsSupervised
                  ? t("wizard.access.supervised")
                  : tx("Not changed")}
            </AccessRowChip>
            {answer !== null ? (
              <AccessRowAction
                data-access-focus="change"
                onClick={() => {
                  setChanging(true);
                  setFocusNext("accept");
                }}
              >
                {tx("Change")}
              </AccessRowAction>
            ) : null}
          </>
        )
      }
      open={open && asking}
    >
      <p className="mb-2 text-muted-foreground">{t("wizard.access.allowsIntro")}</p>
      <FullAccessExplanation />
      <p className="mt-2 text-muted-foreground">{t("wizard.access.supervisedDescription")}</p>
    </AccessRow>
  );
}
