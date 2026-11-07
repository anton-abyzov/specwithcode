import type {
  EnvironmentId,
  ProjectStandbyRearmStatus,
  StandbyRearmReason,
} from "@specweave-studio/contracts";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { RearmProblem } from "../../studio/standbyArming";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { SettingsRow } from "../settings/settingsLayout";

/* ---------- Copy: what re-arming after a takeover shows. ---------- */

/** Why the machine that took over has no standby yet. `machine` names the one it tried first. */
export const rearmReasonText = (reason: StandbyRearmReason, machine: string): string => {
  switch (reason) {
    case "unreachable":
      return `${machine} did not answer.`;
    case "needs_grant":
      return `This machine needs access to ${machine}. Prepare machines again.`;
    case "needs_update":
      return `${machine} needs an update.`;
    case "not_member":
      return `${machine} still runs its own coordinator.`;
    case "no_consent":
      return `${machine} is not on your current list. Save the list again.`;
    case "team_rules":
      return "Team rules stop machines working together.";
    case "lease_failed":
      return `${machine} did not answer its first check.`;
    case "standby_missing":
      return `${machine} stopped standing by.`;
    case "no_candidates":
      return "No other machine on your list.";
    default:
      return `${machine} did not take the standby role.`;
  }
};

/** Reasons only the owner can clear; the others retry on their own. */
const WAITS_FOR_OWNER = new Set<StandbyRearmReason>(["needs_grant", "no_consent"]);

/**
 * The status line on the machine that took over automatically, or null when
 * there is nothing to say: re-arming is off, stopped, or the owner chose.
 */
export function rearmStatusText(
  run: ProjectStandbyRearmStatus["run"],
  label: (environmentId: EnvironmentId) => string,
): string | null {
  if (run === null) return null;
  const machine = run.standby
    ? label(run.standby.environmentId)
    : run.detail && run.detail.length > 0
      ? run.detail
      : "The next machine";
  switch (run.state) {
    case "pending":
      // Replaced as often as allowed: the last one stays named until the next attempt.
      if (run.standby)
        return `${machine} is still named as the standby: ${rearmReasonText(
          run.reason ?? "lease_failed",
          machine,
        )} Trying again later.`;
      return `No standby armed yet: ${rearmReasonText(run.reason ?? "no_candidates", machine)} ${
        run.reason !== null && WAITS_FOR_OWNER.has(run.reason)
          ? "Waiting for you."
          : "Trying again."
      }`;
    case "verifying":
      return `Checking ${machine}.`;
    case "armed":
      return `Armed ${machine} automatically after taking over.`;
    default:
      return null;
  }
}

/** What one listed machine still needs, from the last save or the check on opening. */
export const rearmProblemText = (problem: RearmProblem): string =>
  problem === "needs_update"
    ? "Needs an update."
    : problem === "no_consent"
      ? "Not on the saved list. Save the list again."
      : problem === "needs_grant"
        ? "Not ready. Prepare machines again."
        : "Its access runs out soon. Prepare machines again.";

/** Shown when the chosen standby cannot hold a list. */
export const rearmStandbyOldText = (standby: string) =>
  `Update SpecWithCode on ${standby} to arm the next machine after it takes over.`;

/* ---------- View ---------- */

export interface StandbyRearmChoice {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Beside the name: "only after it gives way", "needs an update". */
  readonly note: string | null;
  readonly disabled: boolean;
  /** What this machine still needs, or null. */
  readonly problem: string | null;
}

export interface StandbyRearmListProps {
  readonly standbyLabel: string;
  /** Every machine that may be listed; checked ones come first, in order. */
  readonly choices: ReadonlyArray<StandbyRearmChoice>;
  readonly order: ReadonlyArray<EnvironmentId>;
  readonly max: number;
  /** The list differs from the one saved on the machines. */
  readonly changed: boolean;
  /** Some listed machine is not ready to arm the next one. */
  readonly needsPrepare: boolean;
  readonly disabled: boolean;
  readonly onToggle: (environmentId: EnvironmentId, checked: boolean) => void;
  readonly onMove: (environmentId: EnvironmentId, by: -1 | 1) => void;
  readonly onSave: () => void;
  readonly onPrepare: () => void;
}

/** "If it takes over, arm next": the owner's ordered list under the standby. */
export function StandbyRearmList(props: StandbyRearmListProps) {
  const listed = props.order
    .map((environmentId) => props.choices.find((choice) => choice.environmentId === environmentId))
    .filter((choice) => choice !== undefined);
  const others = props.choices.filter((choice) => !props.order.includes(choice.environmentId));
  const full = props.order.length >= props.max;
  return (
    <div data-standby-rearm="">
      <SettingsRow
        title="If it takes over, arm next"
        description={`When ${props.standbyLabel} takes over, it makes the first machine here that answers its own standby. Up to ${props.max} machines.`}
        control={
          props.changed ? (
            <Button size="sm" variant="outline" disabled={props.disabled} onClick={props.onSave}>
              Save list
            </Button>
          ) : props.needsPrepare ? (
            <Button size="sm" variant="outline" disabled={props.disabled} onClick={props.onPrepare}>
              Prepare machines again
            </Button>
          ) : null
        }
      >
        {props.choices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No other machine has a copy to list.</p>
        ) : (
          <ul className="space-y-1.5 text-sm" aria-label="Arm next">
            {[...listed, ...others].map((choice) => {
              const index = props.order.indexOf(choice.environmentId);
              const checked = index !== -1;
              return (
                <li
                  key={choice.environmentId}
                  className="flex items-center gap-2"
                  data-rearm-machine={choice.environmentId}
                >
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <Checkbox
                      aria-label={`Arm ${choice.label} next`}
                      checked={checked}
                      disabled={props.disabled || choice.disabled || (!checked && full)}
                      onCheckedChange={(next) =>
                        props.onToggle(choice.environmentId, next === true)
                      }
                    />
                    <span className="w-4 text-right text-xs text-muted-foreground tabular-nums">
                      {checked ? index + 1 : ""}
                    </span>
                    <span className="truncate text-foreground">{choice.label}</span>
                    {choice.note ? (
                      <span className="text-muted-foreground">{choice.note}</span>
                    ) : null}
                    {checked && choice.problem ? (
                      <span className="text-destructive-foreground">{choice.problem}</span>
                    ) : null}
                  </label>
                  {checked ? (
                    <>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Move ${choice.label} up`}
                        disabled={props.disabled || index === 0}
                        onClick={() => props.onMove(choice.environmentId, -1)}
                      >
                        <ArrowUpIcon className="size-3" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Move ${choice.label} down`}
                        disabled={props.disabled || index === props.order.length - 1}
                        onClick={() => props.onMove(choice.environmentId, 1)}
                      >
                        <ArrowDownIcon className="size-3" />
                      </Button>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsRow>
    </div>
  );
}
