/**
 * The thread's plan card: done, current and next at a glance, from the
 * SpecWeave increment the thread works on ("Increment 0996") or the agent's
 * own todo list ("Checklist", which says it is not an increment).
 * Collapsed it is one chip-high line that shares the row with the thread's
 * meta chips; open it takes the whole row and lists every step, the
 * increment's acceptance criteria and links to its spec and folder. A worker
 * thread with neither still shows one: what it is doing now, or a small
 * "No plan" chip that opens "Link increment". A thread that changed code
 * without an increment says so and offers "Link increment" and "No increment
 * needed". The spec and other files open in the app's viewer; the editor is
 * the secondary way in.
 */
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  CodeIcon,
  FileTextIcon,
  FolderOpenIcon,
  Link2Icon,
  Link2OffIcon,
  ListChecksIcon,
  ListTodoIcon,
  OctagonPauseIcon,
} from "lucide-react";
import { memo, useId, useState } from "react";

import type { PlanStepState } from "@specweave-studio/shared/planProgress";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import {
  BINDING_LABELS,
  CHECKLIST_LABEL,
  incrementNumber,
  isDocumentPath,
  isExternalStepLink,
  type ThreadPlanStep,
  type ThreadPlanView,
} from "../../studio/threadPlanProgress";
import { criteriaSummary, ThreadPlanCriteria } from "./ThreadPlanCriteria";

/** Opens an https step link in the system browser, like the thread's other link cards. */
function openStepLinkExternally(url: string) {
  const api = readLocalApi();
  if (api) void api.shell.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

const STEP_LABEL: Record<PlanStepState, string> = {
  done: "Done",
  current: "In progress",
  open: "Open",
  blocked: "Blocked",
  skipped: "Skipped",
};

export function PlanStepIcon({ state, className }: { state: PlanStepState; className?: string }) {
  const base = cn("size-4 shrink-0", className);
  switch (state) {
    case "done":
      return <CheckCircle2Icon aria-hidden className={cn(base, "fill-foreground/70 text-card")} />;
    case "current":
      return <CircleDotIcon aria-hidden className={cn(base, "text-primary")} />;
    case "blocked":
      return <OctagonPauseIcon aria-hidden className={cn(base, "text-warning-foreground")} />;
    case "skipped":
      return <CircleSlashIcon aria-hidden className={cn(base, "text-muted-foreground")} />;
    default:
      return <CircleDashedIcon aria-hidden className={cn(base, "text-muted-foreground")} />;
  }
}

/** How the card opens a host path, or null when it cannot open that one. */
type PathOpener = (path: string) => (() => void) | null;

/** The step's text: a link when it has one the card can open, plain text otherwise. */
function StepText({ step, openPath }: { step: ThreadPlanStep; openPath: PathOpener | null }) {
  const { href } = step;
  if (href && isExternalStepLink(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-border underline-offset-2 hover:decoration-foreground"
        data-plan-step-link="external"
        onClick={(event) => {
          event.preventDefault();
          openStepLinkExternally(href);
        }}
      >
        {step.text}
      </a>
    );
  }
  const open = href ? (openPath?.(href) ?? null) : null;
  if (open) {
    return (
      <button
        type="button"
        className="text-left underline decoration-border underline-offset-2 hover:decoration-foreground"
        data-plan-step-link="path"
        onClick={open}
      >
        {step.text}
      </button>
    );
  }
  return <>{step.text}</>;
}

function StepRow({
  step,
  openPath = null,
}: {
  step: ThreadPlanStep;
  openPath?: PathOpener | null;
}) {
  const finished = step.state === "done" || step.state === "skipped";
  return (
    <li
      className="py-0.5"
      data-plan-step-state={step.state}
      data-plan-step-mine={step.mine || undefined}
    >
      <div className="flex items-start gap-2">
        <PlanStepIcon state={step.state} className="mt-0.5" />
        <span className="sr-only">{STEP_LABEL[step.state]}: </span>
        <span
          className={cn(
            "min-w-0 flex-1 wrap-anywhere",
            finished ? "text-muted-foreground" : "text-foreground/90",
            step.state === "current" && "font-medium text-foreground",
          )}
        >
          {step.id ? (
            <span className="me-1.5 font-mono text-xs text-muted-foreground">{step.id}</span>
          ) : null}
          <StepText step={step} openPath={openPath} />
          {step.commit ? (
            <span
              className="ms-1.5 font-mono text-2xs text-muted-foreground"
              aria-label={`Commit ${step.commit}`}
              data-plan-step-commit
            >
              {step.commit.slice(0, 7)}
            </span>
          ) : null}
          {step.unverified ? (
            <span
              className="ms-1.5 rounded-full border border-border/70 px-1.5 text-2xs font-normal text-muted-foreground"
              data-plan-step-unverified
            >
              unverified
            </span>
          ) : null}
          {step.mine ? (
            <span className="ms-1.5 rounded-full border border-border/70 px-1.5 text-2xs font-normal text-muted-foreground">
              this thread
            </span>
          ) : null}
          {step.note ? (
            <span className="ms-1.5 text-xs text-muted-foreground">({step.note})</span>
          ) : null}
        </span>
      </div>
      {step.children && step.children.length > 0 ? (
        <ul
          role="list"
          aria-label={`Agent steps for ${step.id ?? step.text}`}
          className="ms-2 mt-0.5 space-y-0.5 border-s border-border/70 ps-3 text-xs"
          data-plan-substeps
        >
          {step.children.map((child) => (
            <StepRow key={child.key} step={child} openPath={openPath} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const LINK_BUTTON =
  "inline-flex items-center gap-1 text-foreground/80 underline-offset-2 hover:text-foreground hover:underline";

export const ThreadPlanCard = memo(function ThreadPlanCard({
  plan,
  onOpenPath,
  onOpenDocument = null,
  onLinkIncrement = null,
  onUnlinkIncrement = null,
  status = null,
  defaultExpanded = false,
}: {
  plan: ThreadPlanView;
  /** Opens a file or folder of the thread's host in the preferred editor; null hides the links. */
  onOpenPath: ((path: string) => void) | null;
  /** Opens a file of the thread's host in the app's viewer: the spec and step files. */
  onOpenDocument?: ((path: string) => void) | null;
  /** Opens the "Link increment" picker; null hides it. */
  onLinkIncrement?: (() => void) | null;
  /** Marks the thread as having no increment ("Unlink", "No increment needed"); null hides it. */
  onUnlinkIncrement?: (() => void) | null;
  /** What the thread is doing now, the headline while it has no plan. */
  status?: string | null;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const listId = useId();
  const { increment } = plan;
  const fromIncrement = plan.source === "increment" && increment !== null;
  // A bound increment names the card even while its steps come from the agent's checklist.
  const bound = increment !== null;
  const criteria = fromIncrement ? increment.criteria : [];
  const allDone = plan.total > 0 && plan.completed >= plan.total;
  const unplanned = plan.unplanned === true && increment === null;
  // Nothing to say yet: a chip, not a full-width bar.
  const empty = plan.source === "none" && status === null && !unplanned;
  const headline =
    plan.source === "none"
      ? unplanned
        ? "Changed code without an increment"
        : (status ?? "No plan")
      : (plan.current ?? (allDone ? "All done" : "No tasks yet"));
  // Files open in the viewer; a folder, or a file with no viewer, in the editor.
  const openPath: PathOpener | null =
    onOpenDocument || onOpenPath
      ? (path) =>
          onOpenDocument && isDocumentPath(path)
            ? () => onOpenDocument(path)
            : onOpenPath
              ? () => onOpenPath(path)
              : null
      : null;
  const specPath = increment?.specPath ?? null;
  const openSpec = specPath ? (openPath?.(specPath) ?? null) : null;
  const editSpec = specPath && onOpenDocument && onOpenPath ? () => onOpenPath(specPath) : null;
  const markNoIncrement = unplanned ? onUnlinkIncrement : null;
  return (
    <section
      className={cn(
        "pointer-events-auto rounded-md border border-border/60 lane-surface text-xs shadow-xs",
        expanded ? "basis-full" : empty ? "shrink-0" : "min-w-[min(100%,16rem)] flex-1",
      )}
      aria-label={
        bound
          ? `Increment ${increment.incrementId} progress`
          : plan.source === "todo"
            ? "Agent checklist progress"
            : "Plan progress"
      }
      data-thread-plan-card={plan.source}
      data-plan-empty={empty || undefined}
      data-plan-unplanned={unplanned || undefined}
    >
      <button
        type="button"
        className="flex h-6 w-full min-w-0 items-center gap-1.5 px-2 text-left"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((open) => !open)}
      >
        {bound ? (
          <ListChecksIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ListTodoIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {empty ? null : (
          <span className="shrink-0 text-muted-foreground" data-plan-source-label>
            {bound
              ? `Increment ${incrementNumber(increment.incrementId)}`
              : plan.source === "todo"
                ? CHECKLIST_LABEL
                : "Plan"}
          </span>
        )}
        <span
          className={cn(
            "min-w-0 truncate",
            empty ? "text-muted-foreground" : "flex-1 text-foreground/85",
          )}
          data-plan-current
        >
          {plan.current ? <span className="sr-only">Now: </span> : null}
          {headline}
        </span>
        {unplanned && plan.source !== "none" ? (
          <span className="shrink-0 rounded-full border border-border/70 px-1.5 text-2xs text-muted-foreground">
            No increment
          </span>
        ) : null}
        {plan.next && !expanded ? (
          <span className="hidden max-w-[35%] shrink truncate text-muted-foreground sm:inline">
            Next: {plan.next}
          </span>
        ) : null}
        {plan.total > 0 ? (
          <span
            className={cn(
              "shrink-0 tabular-nums",
              allDone ? "text-success-foreground" : "text-muted-foreground",
            )}
            data-plan-count
          >
            {/* A bound increment's card counting the agent's checklist says so. */}
            {bound && plan.source === "todo" ? `${CHECKLIST_LABEL} ` : null}
            {plan.completed}/{plan.total}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div
          id={listId}
          className="max-h-[45vh] overflow-y-auto border-t border-border/60 px-3 pt-2 pb-2.5 text-sm"
        >
          {bound ? (
            <p className="mb-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">
                {increment.title ?? increment.incrementId}
              </span>{" "}
              · {increment.status} ·{" "}
              <span data-plan-binding>{BINDING_LABELS[increment.binding]}</span>
              {increment.verify ? (
                <>
                  {" "}
                  · verify{" "}
                  <span
                    className={
                      increment.verify.ok
                        ? "text-success-foreground"
                        : "text-destructive-foreground"
                    }
                  >
                    {increment.verify.ok ? "passed" : "failed"}
                  </span>
                </>
              ) : null}
            </p>
          ) : null}
          {plan.source === "todo" ? (
            <p className="mb-1.5 text-xs text-muted-foreground" data-plan-checklist-note>
              {bound
                ? `Steps from the agent's checklist: the increment's tasks ${increment.readable ? "are not written yet" : "could not be read"}.`
                : "The agent's own checklist from its provider. It is not a SpecWeave increment."}
            </p>
          ) : null}
          {unplanned ? (
            <p className="mb-1.5 text-xs text-muted-foreground" data-plan-unplanned-note>
              This thread changed code without a SpecWeave increment. Increments are recommended,
              not required: link the one it works on, or mark it as not needing one.
            </p>
          ) : null}
          {plan.steps.length > 0 ? (
            <ul role="list" aria-label="Steps" className="space-y-0.5">
              {plan.steps.map((step) => (
                <StepRow key={step.key} step={step} openPath={openPath} />
              ))}
            </ul>
          ) : unplanned ? null : (
            <p className="text-xs text-muted-foreground">
              {plan.source === "none"
                ? "No SpecWeave increment and no checklist from the agent yet. Link the increment this thread works on, or the steps appear when the agent writes its checklist."
                : increment && !increment.readable
                  ? "The increment's tasks or ledger could not be read."
                  : "No steps yet."}
            </p>
          )}
          {criteria.length > 0 ? (
            <div className="mt-2">
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={criteriaOpen}
                onClick={() => setCriteriaOpen((open) => !open)}
              >
                <ChevronDownIcon
                  aria-hidden
                  className={cn("size-3.5 transition-transform", !criteriaOpen && "-rotate-90")}
                />
                Acceptance criteria
                <span className="text-2xs" data-plan-criteria-summary>
                  {criteriaSummary(criteria)}
                </span>
              </button>
              {criteriaOpen ? <ThreadPlanCriteria criteria={criteria} /> : null}
            </div>
          ) : null}
          {openSpec ||
          (increment && onOpenPath) ||
          onLinkIncrement ||
          (increment && onUnlinkIncrement) ||
          markNoIncrement ? (
            <div className="mt-2 flex flex-wrap gap-3 text-xs" data-plan-actions>
              {openSpec ? (
                <span className="inline-flex items-center gap-1.5">
                  <button
                    type="button"
                    className={LINK_BUTTON}
                    onClick={openSpec}
                    data-plan-open-spec
                  >
                    <FileTextIcon aria-hidden className="size-3.5" />
                    Open spec
                  </button>
                  {editSpec ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      aria-label="Open spec in editor"
                      onClick={editSpec}
                    >
                      <CodeIcon aria-hidden className="size-3" />
                      editor
                    </button>
                  ) : null}
                </span>
              ) : null}
              {increment && onOpenPath ? (
                <button
                  type="button"
                  className={LINK_BUTTON}
                  onClick={() => onOpenPath(increment.incrementPath)}
                >
                  <FolderOpenIcon aria-hidden className="size-3.5" />
                  Open increment
                </button>
              ) : null}
              {onLinkIncrement ? (
                <button type="button" className={LINK_BUTTON} onClick={onLinkIncrement}>
                  <Link2Icon aria-hidden className="size-3.5" />
                  {increment ? "Change increment" : "Link increment"}
                </button>
              ) : null}
              {increment && onUnlinkIncrement ? (
                <button type="button" className={LINK_BUTTON} onClick={onUnlinkIncrement}>
                  <Link2OffIcon aria-hidden className="size-3.5" />
                  Unlink
                </button>
              ) : null}
              {markNoIncrement ? (
                <button type="button" className={LINK_BUTTON} onClick={markNoIncrement}>
                  <CircleSlashIcon aria-hidden className="size-3.5" />
                  No increment needed
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});
