import type { ReactNode } from "react";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { hasNotCopied, type CopyNotices } from "./handoffCopyNotices";
import type { CopyStepId, CopyStepTone } from "./handoffCopyWizard";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { HandoffCopyActions } from "./HandoffCopyActions";

export interface CopyStepItem {
  readonly id: CopyStepId;
  readonly label: string;
  /** Relative to the live step: behind it, on it, or still ahead. */
  readonly state: "done" | "current" | "next";
  /** Skipped by a one-click copy: chosen automatically, still open to look at. */
  readonly auto: boolean;
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
 * Where › What › Review › Copy › Done, with Transfer for a move. Steps the copy has passed
 * are buttons that open a read-only look at them; the step text stays the bare label.
 */
export function CopyStepLine({
  steps,
  viewing = null,
  onStepChange,
  isStepDisabled,
}: {
  readonly steps: ReadonlyArray<CopyStepItem>;
  /** The earlier step on screen instead of the live one; null shows the live step. */
  readonly viewing?: CopyStepId | null;
  readonly onStepChange?: (id: CopyStepId) => void;
  readonly isStepDisabled?: (id: CopyStepId) => boolean;
}) {
  return (
    <ol
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
      aria-label="Copy steps"
      data-slot="copy-steps"
    >
      {steps.map((step, index) => {
        const current = step.state === "current";
        const shown = step.id === viewing;
        // What the tooltip says; the visible text stays the bare label.
        const note = [step.auto ? "chosen automatically" : null, step.tone && TONE_NAMES[step.tone]]
          .filter((part) => !!part)
          .join(", ");
        const extra = [note, shown ? "on screen" : null].filter((part) => !!part).join(", ");
        const props = {
          "data-slot": "copy-step",
          "data-step-id": step.id,
          "data-state": step.state,
          "data-auto": step.auto ? "true" : undefined,
          "data-tone": step.tone ?? undefined,
          "data-viewing": shown ? "true" : undefined,
          "aria-current": current ? ("step" as const) : undefined,
          "aria-label": extra ? `${step.label}, ${extra}` : undefined,
          onClick: () => onStepChange?.(step.id),
          className: `-mx-1 inline-flex items-center gap-1 rounded px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:cursor-pointer enabled:hover:text-foreground enabled:hover:underline ${current ? "font-medium" : ""} ${shown ? "underline underline-offset-4" : ""} ${step.tone ? TONE_CLASSES[step.tone] : current || shown ? "text-foreground" : ""}`,
        };
        const disabled = !onStepChange || (isStepDisabled?.(step.id) ?? false);
        const content = (
          <>
            {step.tone ? (
              <TriangleAlertIcon className="size-3" aria-hidden />
            ) : (
              step.state === "done" && <CheckIcon className="size-3" aria-hidden />
            )}
            {step.label}
          </>
        );
        return (
          <li key={step.id} className="flex items-center gap-1.5">
            {index > 0 && <span aria-hidden>›</span>}
            {note ? (
              <Tooltip>
                <TooltipTrigger render={<button type="button" disabled={disabled} />} {...props}>
                  {content}
                </TooltipTrigger>
                <TooltipPopup>
                  {step.label}: {note}
                </TooltipPopup>
              </Tooltip>
            ) : (
              <button type="button" disabled={disabled} {...props}>
                {content}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Says an earlier step is on screen for looking only, and where the copy really is. */
export function CopyViewingBanner({
  viewing,
  live,
}: {
  readonly viewing: string;
  readonly live: string;
}) {
  return (
    <p
      role="status"
      className="rounded-lg border bg-muted/40 px-3 py-2 text-sm"
      data-slot="copy-viewing"
    >
      You're viewing {viewing}. The copy is at {live}.
    </p>
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

/** One plain sentence above the buttons saying what the next click or wait does. */
export function CopyNextStep({ children }: { readonly children: ReactNode }) {
  return (
    <p className="text-sm" data-slot="copy-next">
      <span className="font-medium">What happens next: </span>
      {children}
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
}: {
  readonly names: ReadonlyArray<string>;
  readonly label: string;
}) {
  const groups = new Map<string, Array<string>>();
  for (const name of names) {
    const match = WORKTREE_OF.exec(name);
    const repository = match?.[2] ?? "";
    const list = groups.get(repository) ?? [];
    list.push(match?.[1] ?? name);
    groups.set(repository, list);
  }
  if (groups.size < 2) return <Names names={names} label={label} />;
  const sorted = [...groups].toSorted((a, b) => b[1].length - a[1].length);
  return (
    <ul aria-label={label} className="mt-1 space-y-0.5" data-slot="copy-names-grouped">
      {sorted.map(([repository, list]) => (
        <li key={repository}>
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              <span className="font-mono">{repository.split("/").at(-1) || "this folder"}</span>:{" "}
              {list.length.toLocaleString()}
            </summary>
            <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto pl-3 font-mono">
              {list.map((name) => (
                <li key={name} className="wrap-anywhere">
                  {name}
                </li>
              ))}
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
            {notices.outsideWorktrees.length > 0 && (
              <li data-slot="copy-not-copied-outside">
                {count(notices.outsideWorktrees.length, "worktree", "worktrees")} outside the
                folder. Their branches travel with a repository copied whole; copy a worktree folder
                separately only to keep its uncommitted changes.
                <GroupedNames
                  names={notices.outsideWorktrees}
                  label="Worktrees outside the folder"
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

/** The helper that explains the two ways out while a copy runs. */
export function CloseOrCancelHint() {
  return (
    <p className="basis-full text-xs text-muted-foreground" data-slot="copy-close-hint">
      Close keeps the copy going; Cancel copy stops it.
    </p>
  );
}
