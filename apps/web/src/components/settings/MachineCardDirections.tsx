/**
 * The machine card's two direction rows and the grant changes behind them. Each row
 * is one sentence with one button: Stop, Allow… (1 hour, 1 day, 1 week, Until I stop
 * it), Set up… or Change…. A stopped or ended row says what happened above its button.
 *
 * @module MachineCardDirections
 */
import { useState, type ReactNode } from "react";
import { AuthAccessWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import type {
  StudioWorkGrantDuration,
  StudioWorkGrantUpdateInput,
} from "@specweave-studio/contracts/studioFleet";
import { useTx } from "../../i18n";
import { requestConfirmDialog } from "../../confirmDialog";
import { changeMachineWorkGrant, type useMachineWorkGrants } from "../../studio/fleet";
import { machineNickname } from "../../studio/machineNickname";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  DEFAULT_WORK_GRANT_DURATION,
  WORK_GRANT_DURATION_CHOICES,
  formatTime,
  workGrantMachineLabel,
} from "./machineWorkGrants.logic";
import { DIRECTION_ACTION_LABELS, type DirectionLine } from "./machineDirections.logic";

export type GrantChange =
  | { readonly action: "update"; readonly input: StudioWorkGrantUpdateInput }
  | {
      readonly action: "revoke" | "restore";
      readonly input: { readonly coordinatorEnvironmentId: EnvironmentId };
    };

/**
 * Saving a change to a grant on this machine, for the card rows and the Who can run
 * work here list alike: confirm a Stop, save, and say what happened.
 */
export function useWorkGrantChanges(
  environmentId: EnvironmentId | null,
  grants: ReturnType<typeof useMachineWorkGrants>,
) {
  const { snapshot } = grants;
  const canManage = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const [pending, setPending] = useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The machine the last notice or error is about, so its card row shows it too. */
  const [about, setAbout] = useState<EnvironmentId | null>(null);
  async function change(next: GrantChange) {
    if (pending || !canManage || environmentId === null) return;
    const before = snapshot?.grants.find(
      (candidate) => candidate.coordinatorEnvironmentId === next.input.coordinatorEnvironmentId,
    );
    if (next.action === "revoke") {
      const label = before?.machineLabel ?? "this machine";
      // Fail closed: no mounted confirm host means no revoke.
      const confirmed = await requestConfirmDialog(
        `Stop ${label}?\n${label} can no longer start work here. Threads it started here stop in 2 minutes; their worktrees and changes stay. To undo, choose Allow… on its card.`,
        { variant: "destructive" },
      );
      if (confirmed !== true) return;
    }
    const wasStopped = before !== undefined && before.status !== "active";
    setPending(next.input.coordinatorEnvironmentId);
    setAbout(next.input.coordinatorEnvironmentId);
    setError(null);
    setNotice(null);
    try {
      const changed = await changeMachineWorkGrant(environmentId, next);
      const label =
        before?.machineLabel ?? workGrantMachineLabel(changed, (id) => machineNickname(id));
      if (next.action === "revoke")
        setNotice(
          changed.runningThreads > 0 && changed.interruptAt
            ? `${label} can no longer start work here. Its ${changed.runningThreads} running thread${changed.runningThreads === 1 ? "" : "s"} stop at ${formatTime(changed.interruptAt)}.`
            : `${label} can no longer start work here.`,
        );
      else if (
        next.action === "restore" ||
        (next.action === "update" && next.input.duration !== undefined && wasStopped)
      )
        setNotice(
          `${label} may start work here again. If its card on ${label} still says it can't, choose Allow there once.`,
        );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this change.");
    } finally {
      setPending(null);
    }
  }
  return { canManage, pending, error, notice, about, change };
}

export type WorkGrantChanges = ReturnType<typeof useWorkGrantChanges>;

/** Allow…: the time limits, one week first as the default, then Until I stop it. */
function AllowMenu({
  label,
  disabled,
  onAllow,
}: {
  label: string;
  disabled: boolean;
  onAllow: (duration: StudioWorkGrantDuration) => void;
}) {
  const tx = useTx();
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={disabled}
            aria-label={label}
            data-direction-action="allow"
          />
        }
      >
        {tx("Allow…")}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>{tx("Allow for")}</MenuGroupLabel>
          {WORK_GRANT_DURATION_CHOICES.map((choice) => (
            <MenuItem
              key={choice.value}
              data-allow-duration={choice.value}
              onClick={() => onAllow(choice.value)}
            >
              {tx(choice.label)}
              {choice.value === DEFAULT_WORK_GRANT_DURATION ? (
                <span className="ms-auto ps-4 text-muted-foreground text-xs">{tx("default")}</span>
              ) : null}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/** One direction: the sentence, its short facts, what happened, and its one button. */
export function DirectionRow({
  line,
  direction,
  button,
  message,
}: {
  line: DirectionLine;
  direction: "incoming" | "outgoing";
  /** The row's one action; null when there is nothing to do from here. */
  button: ReactNode;
  /** The answer to the last change made from this row. */
  message?: { readonly text: string; readonly alert: boolean } | null;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5"
      data-direction={direction}
      data-direction-allowed={line.allowed ? "yes" : "no"}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${line.allowed ? "bg-success" : "bg-muted-foreground/40"}`}
        />
        <p className="min-w-0 flex-1 text-xs">
          <span className={line.allowed ? "text-foreground" : "text-foreground/80"}>
            {line.sentence}
          </span>
          {line.facts.map((fact) => (
            <span key={fact} className="text-muted-foreground">
              {" · "}
              {fact}
            </span>
          ))}
        </p>
        {button}
      </div>
      {line.note ? (
        <p className="pl-3.5 text-xs text-muted-foreground" data-direction-note="">
          {line.note}
        </p>
      ) : null}
      {message ? (
        <p
          role={message.alert ? "alert" : "status"}
          className={`pl-3.5 text-xs ${message.alert ? "text-destructive-foreground" : "text-muted-foreground"}`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

/** The incoming row's button: Stop, Allow… with the time limits, or the first-time setup. */
export function IncomingButton({
  line,
  there,
  coordinatorEnvironmentId,
  durations,
  changes,
  onSetUp,
  details,
}: {
  line: DirectionLine;
  there: string;
  coordinatorEnvironmentId: EnvironmentId;
  durations: boolean;
  changes: WorkGrantChanges | null;
  /** Opens the first-time setup in Connection details. */
  onSetUp: () => void;
  /** The Connection details panel Allow… opens, for assistive technology. */
  details: DetailsPanel;
}) {
  const tx = useTx();
  if (line.action === "allow-setup")
    return (
      <Button
        size="xs"
        variant="outline"
        className="shrink-0"
        aria-label={tx("Allow {there} to start work here", { there })}
        aria-expanded={details.open}
        aria-controls={details.id}
        data-direction-action="allow-setup"
        onClick={onSetUp}
      >
        {tx(DIRECTION_ACTION_LABELS["allow-setup"])}
      </Button>
    );
  if (!changes || (line.action !== "stop" && line.action !== "allow")) return null;
  const busy = changes.pending !== null || !changes.canManage;
  if (line.action === "stop")
    return (
      <Button
        size="xs"
        variant="outline"
        className="shrink-0"
        disabled={busy}
        aria-label={tx("Stop {there} starting work here", { there })}
        data-direction-action="stop"
        onClick={() =>
          void changes.change({ action: "revoke", input: { coordinatorEnvironmentId } })
        }
      >
        {tx(DIRECTION_ACTION_LABELS.stop)}
      </Button>
    );
  // A machine from before time limits takes Allow again without one.
  if (!durations)
    return (
      <Button
        size="xs"
        variant="outline"
        className="shrink-0"
        disabled={busy}
        aria-label={tx("Allow {there} again to start work here", { there })}
        data-direction-action="allow"
        onClick={() =>
          void changes.change({ action: "restore", input: { coordinatorEnvironmentId } })
        }
      >
        {tx("Allow again")}
      </Button>
    );
  return (
    <AllowMenu
      label={tx("Allow {there} to start work here for", { there })}
      disabled={busy}
      onAllow={(duration) =>
        void changes.change({
          action: "update",
          input: { coordinatorEnvironmentId, duration },
        })
      }
    />
  );
}

/** The Connection details panel a row's button opens: its element id and whether it shows. */
export interface DetailsPanel {
  readonly id: string;
  readonly open: boolean;
}

/** The outgoing row's button: Set up… or Change…, both opening Connection details. */
export function OutgoingButton({
  line,
  there,
  details,
  onOpen,
}: {
  line: DirectionLine;
  there: string;
  details: DetailsPanel;
  onOpen: () => void;
}) {
  const tx = useTx();
  if (line.action !== "set-up" && line.action !== "change") return null;
  return (
    <Button
      size="xs"
      variant={line.action === "set-up" ? "outline" : "ghost-muted"}
      className="shrink-0"
      aria-label={
        line.action === "set-up"
          ? tx("Set up this machine to start work on {there}", { there })
          : tx("Change what this machine may do on {there}", { there })
      }
      aria-expanded={details.open}
      aria-controls={details.id}
      data-direction-action={line.action}
      onClick={onOpen}
    >
      {tx(DIRECTION_ACTION_LABELS[line.action])}
    </Button>
  );
}
