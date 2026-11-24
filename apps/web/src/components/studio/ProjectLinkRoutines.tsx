import {
  PROJECT_LINK_ROUTINES_MAX,
  type ProjectLinkMoveRoutineResult,
  type ProjectLinkRoutine,
  type ProjectLinkRoutineChoice,
} from "@specweave-studio/contracts";
import { Button } from "../ui/button";
import { Radio, RadioGroup } from "../ui/radio-group";

/** What the person chose for one of the joining copy's routines in the link review (1472). */
export type LinkRoutineChoice = ProjectLinkRoutineChoice | "keep";

/** Every listed routine starts on Move to the kept machine (1472 D-01). */
export const routineChoiceOf = (
  choices: Readonly<Record<string, LinkRoutineChoice>>,
  routine: ProjectLinkRoutine,
): LinkRoutineChoice | null => (routine.webhook === true ? null : (choices[routine.id] ?? "move"));

/** The routines the link's last step sends to the joining machine, in listed order. */
export const routineRequests = (
  routines: ReadonlyArray<ProjectLinkRoutine>,
  choices: Readonly<Record<string, LinkRoutineChoice>>,
): ReadonlyArray<{ readonly routineId: string; readonly choice: ProjectLinkRoutineChoice }> =>
  routines.flatMap((routine) => {
    const choice = routineChoiceOf(choices, routine);
    return choice === null || choice === "keep" ? [] : [{ routineId: routine.id, choice }];
  });

/** A routine's result after the link: running, its answer, or why the call itself failed. */
export type LinkRoutineResult =
  | { readonly kind: "running" }
  | { readonly kind: "answered"; readonly result: ProjectLinkMoveRoutineResult }
  | { readonly kind: "unreached"; readonly detail: string };

export function LinkRoutineChoices({
  routines,
  keptLabel,
  joiningLabel,
  choices,
  onChoice,
  disabled,
}: {
  readonly routines: ReadonlyArray<ProjectLinkRoutine>;
  readonly keptLabel: string;
  readonly joiningLabel: string;
  readonly choices: Readonly<Record<string, LinkRoutineChoice>>;
  readonly onChoice: (routineId: string, choice: LinkRoutineChoice) => void;
  readonly disabled: boolean;
}) {
  if (routines.length === 0) return null;
  const options = [
    ["move", `Move to ${keptLabel}`],
    ["keep", `Keep on ${joiningLabel}`],
    ["leave-off", "Leave off"],
  ] as const;
  return (
    <section aria-label="Routines" className="space-y-2">
      <h3 className="font-medium">Routines</h3>
      <p className="text-muted-foreground">
        {routines.length >= PROJECT_LINK_ROUTINES_MAX
          ? `${PROJECT_LINK_ROUTINES_MAX} or more routines on ${joiningLabel}; the first ${PROJECT_LINK_ROUTINES_MAX} are listed.`
          : routines.length === 1
            ? `1 routine on ${joiningLabel}.`
            : `${routines.length} routines on ${joiningLabel}.`}{" "}
        A moved routine is turned on on {keptLabel} once and off on {joiningLabel}, so it never runs
        on both.
      </p>
      <ul className="space-y-2">
        {routines.map((routine) => {
          const choice = routineChoiceOf(choices, routine);
          return (
            <li
              key={routine.id}
              className="space-y-2 rounded-lg border p-2"
              data-slot="link-routine"
            >
              <span className="block break-all font-medium">{routine.title}</span>
              {choice === null ? (
                <span className="block text-xs text-muted-foreground">
                  Stays on {joiningLabel}: a webhook routine&apos;s address belongs to that machine.
                </span>
              ) : (
                <RadioGroup
                  value={choice}
                  onValueChange={(value) => onChoice(routine.id, value as LinkRoutineChoice)}
                  aria-label={`Where ${routine.title} runs`}
                  className="flex flex-wrap gap-4"
                >
                  {options.map(([value, label]) => (
                    <label key={value} className="flex cursor-pointer items-center gap-2 text-xs">
                      <Radio value={value} disabled={disabled} />
                      {label}
                    </label>
                  ))}
                </RadioGroup>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const OUTCOME_LABEL: Record<ProjectLinkMoveRoutineResult["outcome"], string> = {
  moved: "Moved",
  "left-off": "Left off",
  stays: "Stays",
  failed: "Not moved",
};

export function LinkRoutineResults({
  routines,
  results,
  keptLabel,
  joiningLabel,
  onRetry,
}: {
  readonly routines: ReadonlyArray<ProjectLinkRoutine>;
  readonly results: Readonly<Record<string, LinkRoutineResult>>;
  readonly keptLabel: string;
  readonly joiningLabel: string;
  readonly onRetry: (routineId: string) => void;
}) {
  const shown = routines.filter(
    (routine) => results[routine.id] !== undefined || routine.webhook === true,
  );
  if (shown.length === 0) return null;
  return (
    <section aria-label="Routine results" className="mt-4 space-y-2 text-sm">
      <h3 className="font-medium">Routines</h3>
      <ul className="space-y-2">
        {shown.map((routine) => {
          const entry = results[routine.id];
          const failed =
            entry?.kind === "unreached" ||
            (entry?.kind === "answered" && entry.result.outcome === "failed");
          const label =
            entry === undefined
              ? "Stays"
              : entry.kind === "running"
                ? "Moving…"
                : entry.kind === "unreached"
                  ? "Not moved"
                  : OUTCOME_LABEL[entry.result.outcome];
          const detail =
            entry === undefined
              ? `Stays on ${joiningLabel}: a webhook routine's address belongs to that machine.`
              : entry.kind === "running"
                ? null
                : entry.kind === "unreached"
                  ? `${entry.detail} ${joiningLabel} did not answer for this routine; Try again is safe and never turns it on twice. If ${joiningLabel} runs an older SpecWithCode, update it first, or turn it off there and create it on ${keptLabel}.`
                  : entry.result.detail;
          return (
            <li
              key={routine.id}
              className="space-y-1 rounded-lg border p-2"
              data-slot="link-routine-result"
              data-outcome={
                entry === undefined
                  ? "stays"
                  : entry.kind === "answered"
                    ? entry.result.outcome
                    : entry.kind
              }
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-all font-medium">{routine.title}</span>
                <span
                  className={`shrink-0 text-xs ${failed ? "text-destructive-foreground" : "text-muted-foreground"}`}
                >
                  {label}
                </span>
              </div>
              {detail && <p className="wrap-anywhere text-xs text-muted-foreground">{detail}</p>}
              {entry?.kind === "answered" && entry.result.setup.length > 0 && (
                <div className="text-xs">
                  <span className="text-muted-foreground">May need setting up on {keptLabel}:</span>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {entry.result.setup.map((note) => (
                      <li key={note} className="wrap-anywhere">
                        {note}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {failed && (
                <Button size="sm" variant="outline" onClick={() => onRetry(routine.id)}>
                  Try again
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
