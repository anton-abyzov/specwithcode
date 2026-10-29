import type { ReactNode } from "react";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { hasNotCopied, type CopyNotices } from "./handoffCopyNotices";
import type { CopyStepId, CopyStepTone } from "./handoffCopyWizard";
import type { FolderCopyStatus } from "@specweave-studio/contracts";
import { cn } from "../../lib/utils";
import { copiedProjectFolder, type HandoffFolderMethod } from "../../studio/folderCopy";
import type { PendingCopy } from "./handoffFolderCopyPending";
import { methodLabel } from "./ProjectMoveOptions";
import { Button } from "../ui/button";
import { HandoffCopyActions } from "./HandoffCopyActions";

export interface CopyStepItem {
  readonly id: CopyStepId;
  readonly label: string;
  /** Relative to the live step: behind it, on it, or still ahead. */
  readonly state: "done" | "current" | "next";
  /** Not a screen in this run: a one-click copy chooses files and skips an empty Review. */
  readonly skipped: boolean;
  readonly tone: CopyStepTone | null;
}

const TONE_NAMES: Readonly<Record<CopyStepTone, string>> = {
  failed: "stopped",
  held: "held",
  attention: "waiting for you",
};

const TONE_CLASSES: Readonly<Record<CopyStepTone, string>> = {
  failed: "text-destructive-foreground",
  held: "text-warning-foreground",
  attention: "text-warning-foreground",
};

/**
 * Where › Copy › Done, with only the steps this run shows: What when the person chooses
 * files first, Review when there is something to review, Transfer for a move. Labels wrap
 * rather than truncate. It only shows progress: what was chosen is in Your choices. On a
 * phone, where six steps wrap and strand "› Done" on a line of its own, one line says
 * "Step 5 of 6 · Transfer" instead.
 */
export function CopyStepLine({ steps }: { readonly steps: ReadonlyArray<CopyStepItem> }) {
  // Measuring and comparing in one click are part of copying: a skipped live step hands
  // "current" to the next step shown.
  const live = steps.findIndex((step) => step.state === "current");
  const shown = steps
    .map((step, index) =>
      step.skipped ||
      live < 0 ||
      index <= live ||
      steps.slice(live, index).some((before) => !before.skipped)
        ? step
        : { ...step, state: "current" as const },
    )
    .filter((step) => !step.skipped);
  const at = Math.max(
    0,
    shown.findIndex((step) => step.state === "current" || step.tone),
  );
  const now = shown[at];
  return (
    <>
      {now && (
        <p
          className={cn(
            "flex items-center gap-1 text-xs sm:hidden",
            now.tone ? `font-medium ${TONE_CLASSES[now.tone]}` : "text-muted-foreground",
          )}
          data-slot="copy-steps-compact"
        >
          {now.tone && <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />}
          <span>
            Step {at + 1} of {shown.length} · {now.label}
            {now.tone ? `, ${TONE_NAMES[now.tone]}` : ""}
          </span>
        </p>
      )}
      <ol
        className="hidden flex-wrap items-center gap-x-1.5 gap-y-1 text-xs sm:flex"
        aria-label="Steps"
        data-slot="copy-steps"
      >
        {shown.map((step, index) => {
          const current = step.state === "current";
          return (
            <li key={step.id} className="flex items-center gap-1.5">
              {index > 0 && (
                <span className="text-muted-foreground" aria-hidden>
                  ›
                </span>
              )}
              <span
                data-slot="copy-step"
                data-step-id={step.id}
                data-state={step.state}
                data-tone={step.tone ?? undefined}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "inline-flex items-center gap-1 whitespace-nowrap",
                  step.tone
                    ? `font-medium ${TONE_CLASSES[step.tone]}`
                    : current
                      ? "font-medium text-foreground"
                      : "text-muted-foreground",
                )}
              >
                {step.tone ? (
                  <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
                ) : (
                  step.state === "done" && <CheckIcon className="size-3 shrink-0" aria-hidden />
                )}
                <span data-slot="copy-step-label">{step.label}</span>
                {step.tone && <span className="sr-only">, {TONE_NAMES[step.tone]}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/**
 * What this copy was started with, and the one way to change it: a link that says what
 * changing costs. Null `onChange` hides the link, after Apply or where the footer has it.
 */
export function CopyChoicesSummary({
  pending,
  copy,
  sourceRoot,
  targetLabel,
  method,
  changeDisabled,
  onChange,
}: {
  readonly pending: PendingCopy;
  readonly copy: FolderCopyStatus | null;
  /** The folder copied from, when neither the copy nor the pointer names it. */
  readonly sourceRoot: string;
  readonly targetLabel: string;
  readonly method: HandoffFolderMethod;
  readonly changeDisabled: boolean;
  readonly onChange: (() => void) | null;
}) {
  const source = copy?.copyRoot ?? pending.copyRoot ?? sourceRoot;
  const target = copy?.targetFolder ?? pending.targetFolder;
  const projectFolder =
    copy?.projectFolder ??
    copiedProjectFolder(target, copy?.projectRelativePath ?? pending.projectRelativePath);
  return (
    <div className="space-y-1 rounded-lg border px-3 py-2 text-xs" data-slot="copy-choices">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-sm font-medium">Your choices</p>
        {onChange && (
          <Button
            variant="link"
            size="xs"
            data-slot="copy-change"
            disabled={changeDisabled}
            onClick={onChange}
          >
            {pending.mode === "copy-and-move"
              ? "Change (stops the move)"
              : "Change (stops this copy)"}
          </Button>
        )}
      </div>
      <p className="wrap-anywhere" data-slot="copy-scope-mapping">
        {pending.mode === "copy-and-move" ? "Move" : "Copy"} to {targetLabel}:{" "}
        <span className="font-mono">{target}</span>
        <span className="block text-muted-foreground">
          From <span className="font-mono">{source}</span>
          {target !== projectFolder && (
            <>
              {" "}
              · project folder <span className="font-mono">{projectFolder}</span>
            </>
          )}
        </span>
      </p>
      <p className="text-muted-foreground">{methodLabel(method)}</p>
    </div>
  );
}

/** What happened while the window was closed, or that a reopen came back to the same step. */
export function CopyResumeNote({ children }: { readonly children: ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-lg border bg-muted/40 px-3 py-2 text-sm"
      data-slot="copy-resume-note"
    >
      {children}
    </p>
  );
}

/**
 * A reopened copy while its destination answers, in place of a setup form that would only
 * flash. An unreachable destination keeps this, with its error and Check again.
 */
export function CopyCheckingStep({
  checking,
  folder,
  targetLabel,
  error,
  onCheckAgain,
  onStartNew,
}: {
  readonly checking: "checking" | "unreachable";
  readonly folder: string;
  readonly targetLabel: string;
  readonly error: string | null;
  readonly onCheckAgain: () => void;
  /** The last copy opened with View: put it back and start a new copy instead of waiting. */
  readonly onStartNew?: (() => void) | undefined;
}) {
  return (
    <>
      <p
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
        data-slot="copy-checking"
      >
        {checking === "checking"
          ? `Checking the copy to ${folder} on ${targetLabel}…`
          : `A copy to ${folder} on ${targetLabel} is unfinished. Check it again once ${targetLabel} is reachable.`}
      </p>
      <HandoffCopyActions>
        {error && (
          <p
            role="alert"
            className="max-h-24 basis-full overflow-y-auto wrap-anywhere text-sm text-destructive-foreground"
          >
            {error}
          </p>
        )}
        {checking === "unreachable" && onStartNew && (
          <Button variant="outline" onClick={onStartNew}>
            Start a new copy
          </Button>
        )}
        {checking === "unreachable" && <Button onClick={onCheckAgain}>Check the copy again</Button>}
      </HandoffCopyActions>
    </>
  );
}

/** One plain sentence above the buttons, for the few stages that need it. */
export function CopyNextStep({ children }: { readonly children: ReactNode }) {
  return (
    <p className="text-sm text-muted-foreground" data-slot="copy-next">
      {children}
    </p>
  );
}

/**
 * The helper under the progress line: a working copy carries on with the window closed. A
 * move's last step (starting the coordinator there) runs in this window, so a move says
 * the window comes back for it.
 */
export function CopyWorkingHint({ move = false }: { readonly move?: boolean }) {
  return (
    <p className="text-xs text-muted-foreground" data-slot="copy-close-hint">
      {move
        ? "You can close this window while files copy. We’ll notify you; then reopen it to finish the move."
        : "You can close this window. We’ll notify you when it’s done."}
    </p>
  );
}

function Names({
  names,
  label,
}: {
  readonly names: ReadonlyArray<string>;
  readonly label: string;
}) {
  if (names.length === 0) return null;
  return (
    <details className="mt-1" data-slot="copy-names">
      <summary className="cursor-pointer text-muted-foreground">
        Show names ({names.length.toLocaleString()})
      </summary>
      <ul aria-label={label} className="mt-1 max-h-40 space-y-0.5 overflow-y-auto font-mono">
        {names.map((name) => (
          <li key={name} className="wrap-anywhere">
            {name}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** "name (repository)" as the notices list worktrees of repositories other than the root. */
const WORKTREE_OF = /^(.+) \(([^()]+)\)$/;

/** Names grouped by repository, one line each with a count, so dozens stay readable. */
function GroupedNames({
  names,
  label,
  totals,
}: {
  readonly names: ReadonlyArray<string>;
  readonly label: string;
  readonly totals: Readonly<Record<string, number>>;
}) {
  const groups = new Map<string, Array<string>>();
  for (const name of names) {
    const match = WORKTREE_OF.exec(name);
    const repository = match?.[2] ?? "";
    const list = groups.get(repository) ?? [];
    list.push(match?.[1] ?? name);
    groups.set(repository, list);
  }
  if (groups.size < 2 && Object.values(totals).every((total) => total <= names.length))
    return <Names names={names} label={label} />;
  const sorted = [...groups].toSorted((a, b) => b[1].length - a[1].length);
  return (
    <ul aria-label={label} className="mt-1 space-y-0.5" data-slot="copy-names-grouped">
      {sorted.map(([repository, list]) => (
        <li key={repository}>
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              <span className="font-mono">{repository.split("/").at(-1) || "this folder"}</span>:{" "}
              {(totals[repository] ?? list.length).toLocaleString()}
            </summary>
            <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto pl-3 font-mono">
              {list.map((name) => (
                <li key={name} className="wrap-anywhere">
                  {name}
                </li>
              ))}
              {(totals[repository] ?? 0) > list.length && (
                <li>{totals[repository]! - list.length} more names not included in this scan</li>
              )}
            </ul>
          </details>
        </li>
      ))}
    </ul>
  );
}

/** ": a, b and 3 more", naming the listed worktrees and how many the list left out. */
function NameList({
  names,
  total,
}: {
  readonly names: ReadonlyArray<string>;
  readonly total: number;
}) {
  if (names.length === 0) return null;
  const more = total - names.length;
  return (
    <>
      : <span className="font-mono">{names.join(", ")}</span>
      {more > 0 ? ` and ${more.toLocaleString()} more` : ""}
    </>
  );
}

const count = (value: number, one: string, many: string) =>
  `${value.toLocaleString()} ${value === 1 ? one : many}`;

/** One "Not copied" block, then the few notes that matter as short lines. */
export function CopyNoticesBlock({
  notices,
  targetLabel,
}: {
  readonly notices: CopyNotices;
  readonly targetLabel: string;
}) {
  // Worktrees that may hold work which does not travel are named; the rest fold away.
  const flagged = new Set([
    ...notices.dirtyWorktrees,
    ...notices.uncheckedWorktrees,
    ...notices.strandedWorktrees,
  ]);
  const clean = notices.worktrees.filter((name) => !flagged.has(name));
  if (
    !hasNotCopied(notices) &&
    notices.separateRepositories.length === 0 &&
    notices.linksOutside === 0 &&
    notices.lines.length === 0
  )
    return null;
  return (
    <div className="space-y-2 text-xs" data-slot="copy-notices">
      {hasNotCopied(notices) && (
        <div className="space-y-1.5 rounded-lg border p-3" data-slot="copy-not-copied">
          <p className="text-sm font-medium">Not copied</p>
          <ul className="space-y-1.5">
            {notices.rebuildableFolders > 0 && (
              <li data-slot="copy-not-copied-rebuildable">
                {count(
                  notices.rebuildableFolders,
                  "dependency or build folder",
                  "dependency and build folders",
                )}
                . Reinstall or rebuild them on {targetLabel}.
              </li>
            )}
            {notices.worktreeCount > 0 && (
              <li data-slot="copy-not-copied-worktrees">
                {count(notices.worktreeCount, "worktree", "worktrees")} inside the folder. Their
                committed branches are copied with the main repository.
                {notices.dirtyCount > 0 && (
                  <span className="mt-1 block text-warning-foreground" data-slot="copy-dirty">
                    {count(notices.dirtyCount, "has", "have")} uncommitted changes
                    <NameList names={notices.dirtyWorktrees} total={notices.dirtyCount} />.
                    Uncommitted changes stay on this machine.
                  </span>
                )}
                {notices.uncheckedWorktrees.length > 0 && (
                  <span className="mt-1 block text-warning-foreground" data-slot="copy-unchecked">
                    {count(notices.uncheckedWorktrees.length, "worktree", "worktrees")} could not be
                    checked; {notices.uncheckedWorktrees.length === 1 ? "it" : "they"} may hold
                    uncommitted changes
                    <NameList
                      names={notices.uncheckedWorktrees}
                      total={notices.uncheckedWorktrees.length}
                    />
                    .
                  </span>
                )}
                {notices.strandedWorktrees.length > 0 && (
                  <span className="mt-1 block text-warning-foreground" data-slot="copy-stranded">
                    {count(notices.strandedWorktrees.length, "has", "have")} commits on no branch
                    that would not travel
                    <NameList
                      names={notices.strandedWorktrees}
                      total={notices.strandedWorktrees.length}
                    />
                    . Commit that work to a branch to copy it.
                  </span>
                )}
                <Names
                  names={flagged.size > 0 ? clean : notices.worktrees}
                  label="Worktrees not copied"
                />
              </li>
            )}
            {notices.outsideWorktreeCount > 0 && (
              <li data-slot="copy-not-copied-outside">
                {count(notices.outsideWorktreeCount, "worktree", "worktrees")} outside the folder.
                Their branches travel with a repository copied whole; copy a worktree folder
                separately only to keep its uncommitted changes.
                <GroupedNames
                  names={notices.outsideWorktrees}
                  label="Worktrees outside the folder"
                  totals={notices.outsideWorktreeTotals}
                />
              </li>
            )}
          </ul>
        </div>
      )}
      {notices.separateRepositories.length > 0 && (
        <div data-slot="copy-separate">
          {count(notices.separateRepositories.length, "worktree", "worktrees")} of repositories
          outside the folder {notices.separateRepositories.length === 1 ? "becomes" : "become"} an
          independent repository on {targetLabel}, with its branch, history and stashes.
          <Names names={notices.separateRepositories} label="Worktrees copied as repositories" />
        </div>
      )}
      {notices.linksOutside > 0 && (
        <p className="text-muted-foreground">
          {notices.linksOutside === 1 ? "1 link points" : `${notices.linksOutside} links point`}{" "}
          outside the folder and will arrive as links, not as the files they point to.
        </p>
      )}
      {notices.lines.map((line) => (
        <p key={line} className="wrap-anywhere text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  );
}
