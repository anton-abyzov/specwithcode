import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
/**
 * The plan card's acceptance criteria: each AC with how far it is proven,
 * the tasks that cover it and its user story. A tick in the spec or a task
 * marked done is a declaration, not proof, so only `verified` (ledger
 * evidence plus a passing `specweave verify` after it) gets a check.
 */
import type { ThreadIncrementCriterion } from "@specweave-studio/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleSlashIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import {
  criterionState,
  verifiedCriteriaCount,
  type CriterionPresentationState,
} from "../../studio/threadCriteria";

export { criterionState, verifiedCriteriaCount };

export const CRITERION_LABEL: Record<CriterionPresentationState, string> = {
  verified: "verified",
  mixed: "Mixed acceptance",
  "skipped-accepted": "Skipped (accepted)",
  evidenced: "evidence, not verified",
  declared: "declared only",
  skipped: "skipped",
  open: "open",
  uncovered: "no task",
  unknown: "unknown",
};

const ORDER: ReadonlyArray<CriterionPresentationState> = [
  "verified",
  "mixed",
  "skipped-accepted",
  "evidenced",
  "declared",
  "skipped",
  "open",
  "uncovered",
  "unknown",
];

/** "2 verified · 1 open · 1 no task", strongest first, zero counts left out. */
export function criteriaSummary(criteria: ReadonlyArray<ThreadIncrementCriterion>): string {
  const counts = new Map<CriterionPresentationState, number>();
  for (const criterion of criteria) {
    const state = criterionState(criterion);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return ORDER.filter((state) => counts.has(state))
    .map((state) => `${counts.get(state)} ${CRITERION_LABEL[state]}`)
    .join(" · ");
}

function CriterionIcon({ state }: { state: CriterionPresentationState }) {
  const base = "mt-0.5 size-4 shrink-0";
  switch (state) {
    case "verified":
      return <ShieldCheckIcon aria-hidden className={cn(base, "text-success-foreground")} />;
    case "evidenced":
      return <CircleCheckIcon aria-hidden className={cn(base, "text-foreground/70")} />;
    case "declared":
      return <CircleDotIcon aria-hidden className={cn(base, "text-muted-foreground")} />;
    case "mixed":
    case "skipped-accepted":
    case "skipped":
      return <CircleSlashIcon aria-hidden className={cn(base, "text-muted-foreground")} />;
    case "uncovered":
      return <TriangleAlertIcon aria-hidden className={cn(base, "text-warning-foreground")} />;
    case "unknown":
      return <CircleHelpIcon aria-hidden className={cn(base, "text-muted-foreground")} />;
    default:
      return <CircleDashedIcon aria-hidden className={cn(base, "text-muted-foreground")} />;
  }
}

/** A date-only authorization is a calendar date, not midnight in the reader's timezone. */
export function formatAcceptanceDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: "UTC" } : {}),
  });
}

function CriterionRow({ criterion }: { criterion: ThreadIncrementCriterion }) {
  const tx = useTx();
  const state = criterionState(criterion);
  const tasks = criterion.tasks ?? [];
  return (
    <li className="py-0.5" data-plan-criterion-state={state}>
      <div className="flex items-start gap-2">
        <CriterionIcon state={state} />
        <span className="min-w-0 flex-1 wrap-anywhere text-foreground/90">
          <span className="me-1.5 font-mono text-xs text-muted-foreground">{criterion.id}</span>
          {criterion.text}
          <span
            className={cn(
              "ms-1.5 rounded-full border px-1.5 text-2xs font-normal",
              state === "verified"
                ? "border-success/50 text-success-foreground"
                : state === "uncovered"
                  ? "border-warning/60 text-warning-foreground"
                  : "border-border/70 text-muted-foreground",
            )}
            data-plan-criterion-label
          >
            {CRITERION_LABEL[state]}
          </span>
          {tasks.length > 0 ? (
            <span
              className="ms-1.5 font-mono text-2xs text-muted-foreground"
              aria-label={`Covered by ${tasks.join(", ")}`}
              data-plan-criterion-tasks
            >
              ← {tasks.join(", ")}
            </span>
          ) : null}
        </span>
      </div>
      {(criterion.waivers?.length ?? 0) > 0 ? (
        <details className="ms-6 mt-1 text-xs text-muted-foreground" data-accepted-skips>
          <summary className="cursor-pointer">
            {tx(
              criterion.waivers!.length === 1
                ? "{length} accepted skip{value2}"
                : "{length} accepted skips{value2}",
              {
                length: criterion.waivers!.length,
                value2: state === "open" ? tx("; other requirements remain open") : "",
              },
            )}
          </summary>
          <ul className="mt-1 space-y-2">
            {criterion.waivers!.map((waiver) => (
              <li key={waiver.check.toLowerCase()}>
                <strong className="font-medium text-foreground">{waiver.check}</strong>
                <p>{waiver.reason}</p>
                <p>
                  {renderRich(tx("Accepted by {acceptedBy} · {time}"), {
                    acceptedBy: waiver.acceptedBy,
                    time: (
                      <time dateTime={waiver.acceptedAt}>
                        {formatAcceptanceDate(waiver.acceptedAt)}
                      </time>
                    ),
                  })}
                </p>
                <p className="whitespace-pre-wrap wrap-anywhere">
                  {renderRich(tx("Authorization: {authorization}"), {
                    authorization: waiver.authorization,
                  })}
                </p>
                <p className="wrap-anywhere">
                  {renderRich(tx("Recorded by {by} · {at}"), { by: waiver.by, at: waiver.at })}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

/** Groups by user story when the spec names any, in first-appearance order. */
export function ThreadPlanCriteria({
  criteria,
}: {
  criteria: ReadonlyArray<ThreadIncrementCriterion>;
}) {
  const tx = useTx();
  const groups = new Map<string, ThreadIncrementCriterion[]>();
  for (const criterion of criteria) {
    const story = criterion.story ?? "";
    groups.set(story, [...(groups.get(story) ?? []), criterion]);
  }
  const storied = [...groups.keys()].some((story) => story !== "");
  return (
    <div className="mt-1 space-y-1" data-plan-criteria>
      {[...groups].map(([story, members]) => (
        <ul
          key={story || "none"}
          role="list"
          aria-label={story ? `Acceptance criteria for ${story}` : tx("Acceptance criteria")}
          className="space-y-0.5"
        >
          {storied ? (
            <li className="text-2xs font-medium text-muted-foreground" aria-hidden>
              {story || tx("No story")}
            </li>
          ) : null}
          {members.map((criterion) => (
            <CriterionRow key={criterion.id} criterion={criterion} />
          ))}
        </ul>
      ))}
    </div>
  );
}
