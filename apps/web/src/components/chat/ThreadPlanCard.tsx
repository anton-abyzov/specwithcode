/**
 * The thread's plan card: done, current and next at a glance, from the
 * SpecWeave increment the thread works on or the agent's own todo list.
 * Collapsed it is one chip-high line that shares the row with the thread's
 * meta chips; open it takes the whole row and lists every step, the
 * increment's acceptance criteria and links to its spec and folder. A worker
 * thread with neither still shows one: what it is doing now, or a small
 * "No plan" chip that opens "Link increment".
 */
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  FileTextIcon,
  FolderOpenIcon,
  Link2Icon,
  Link2OffIcon,
  ListTodoIcon,
  OctagonPauseIcon,
} from "lucide-react";
import { memo, useId, useState } from "react";

import type { PlanStepState } from "@specweave-studio/shared/planProgress";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import {
  BINDING_LABELS,
  isExternalStepLink,
  type ThreadPlanStep,
  type ThreadPlanView,
} from "../../studio/threadPlanProgress";

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

/** The step's text: a link when it has one the card can open, plain text otherwise. */
function StepText({
  step,
  onOpenPath,
}: {
  step: ThreadPlanStep;
  onOpenPath: ((path: string) => void) | null;
}) {
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
  if (href && onOpenPath) {
    return (
      <button
        type="button"
        className="text-left underline decoration-border underline-offset-2 hover:decoration-foreground"
        data-plan-step-link="path"
        onClick={() => onOpenPath(href)}
      >
        {step.text}
      </button>
    );
  }
  return <>{step.text}</>;
}

function StepRow({
  step,
  onOpenPath = null,
}: {
  step: ThreadPlanStep;
  onOpenPath?: ((path: string) => void) | null;
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
          <StepText step={step} onOpenPath={onOpenPath} />
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
            <StepRow key={child.key} step={child} onOpenPath={onOpenPath} />
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
  onLinkIncrement = null,
  onUnlinkIncrement = null,
  status = null,
  defaultExpanded = false,
}: {
  plan: ThreadPlanView;
  /** Opens a file or folder of the thread's host in the preferred editor; null hides the links. */
  onOpenPath: ((path: string) => void) | null;
  /** Opens the "Link increment" picker; null hides it. */
  onLinkIncrement?: (() => void) | null;
  /** Marks the thread as having no increment; null hides it. */
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
  const criteria = fromIncrement ? increment.criteria : [];
  const criteriaMet = criteria.filter((criterion) => criterion.met).length;
  const allDone = plan.total > 0 && plan.completed >= plan.total;
  // Nothing to say yet: a chip, not a full-width bar.
  const empty = plan.source === "none" && status === null;
  const headline =
    plan.source === "none"
      ? (status ?? "No plan")
      : (plan.current ?? (allDone ? "All done" : "No tasks yet"));
  return (
    <section
      className={cn(
        "pointer-events-auto rounded-md border border-border/60 lane-surface text-xs shadow-xs",
        expanded ? "basis-full" : empty ? "shrink-0" : "min-w-[min(100%,16rem)] flex-1",
      )}
      aria-label={fromIncrement ? `Increment ${increment.incrementId} progress` : "Plan progress"}
      data-thread-plan-card={plan.source}
      data-plan-empty={empty || undefined}
    >
      <button
        type="button"
        className="flex h-6 w-full min-w-0 items-center gap-1.5 px-2 text-left"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((open) => !open)}
      >
        <ListTodoIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        {empty ? null : (
          <span className="shrink-0 text-muted-foreground">
            {fromIncrement ? increment.incrementId.replace(/^(\d+)-.*/u, "$1") : "Plan"}
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
          {fromIncrement ? (
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
          {plan.steps.length > 0 ? (
            <ul role="list" aria-label="Steps" className="space-y-0.5">
              {plan.steps.map((step) => (
                <StepRow key={step.key} step={step} onOpenPath={onOpenPath} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              {plan.source === "none"
                ? "No SpecWeave increment and no todo list from the agent yet. Link the increment this thread works on, or the steps appear when the agent writes its todo list."
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
                Acceptance criteria {criteriaMet}/{criteria.length}
              </button>
              {criteriaOpen ? (
                <ul role="list" aria-label="Acceptance criteria" className="mt-1 space-y-0.5">
                  {criteria.map((criterion) => (
                    <StepRow
                      key={criterion.id}
                      step={{
                        key: criterion.id,
                        id: criterion.id,
                        text: criterion.text,
                        state: criterion.met ? "done" : "open",
                        note: null,
                      }}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {(increment && onOpenPath) || onLinkIncrement || (increment && onUnlinkIncrement) ? (
            <div className="mt-2 flex flex-wrap gap-3 text-xs" data-plan-actions>
              {increment && onOpenPath && increment.specPath ? (
                <button
                  type="button"
                  className={LINK_BUTTON}
                  onClick={() => onOpenPath(increment.specPath!)}
                >
                  <FileTextIcon aria-hidden className="size-3.5" />
                  Open spec
                </button>
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
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});
