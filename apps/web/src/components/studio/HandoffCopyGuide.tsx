import type { ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import { hasNotCopied, type CopyNotices } from "./handoffCopyNotices";

/** Where the person is in the copy: Measure, then Copy, then Done, with optional steps between. */
export function CopyStepLine({
  steps,
  current,
}: {
  readonly steps: ReadonlyArray<string>;
  readonly current: string;
}) {
  const at = Math.max(0, steps.indexOf(current));
  return (
    <ol
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
      aria-label="Copy steps"
      data-slot="copy-steps"
    >
      {steps.map((step, index) => (
        <li key={step} className="flex items-center gap-1.5">
          {index > 0 && <span aria-hidden>›</span>}
          <span
            data-slot="copy-step"
            data-state={index < at ? "done" : index === at ? "current" : "next"}
            aria-current={index === at ? "step" : undefined}
            className={`inline-flex items-center gap-1 ${index === at ? "font-medium text-foreground" : ""}`}
          >
            {index < at && <CheckIcon className="size-3" aria-hidden />}
            {step}
          </span>
        </li>
      ))}
    </ol>
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
                folder. Copy those folders separately to keep their uncommitted changes.
                <Names names={notices.outsideWorktrees} label="Worktrees outside the folder" />
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
