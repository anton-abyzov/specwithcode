import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { useState } from "react";
import { AuthAccessWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import type {
  StudioFleetWorkerAccess,
  StudioWorkGrantsSnapshot,
} from "@specweave-studio/contracts/studioFleet";
import { isElectron } from "../../env";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useMachineNicknames } from "../../studio/machineNickname";
import { addVisibleMachineToStudioFleet, allowStudioFleetWorkers } from "../../studio/fleet";
import {
  DEFAULT_FLEET_WORKER_ACCESS,
  FLEET_WORKER_ACCESS_CHOICES,
} from "../../studio/fleetWorkers";
import { requestConfirmDialog } from "../../confirmDialog";
import { Button } from "../ui/button";

/** Both steps use the remote machine as coordinator and this machine as destination. */
export async function setUpIncomingWorkers(
  input: {
    here: EnvironmentId;
    coordinator: EnvironmentId;
    hereLabel: string;
    access: StudioFleetWorkerAccess;
  },
  operations = { add: addVisibleMachineToStudioFleet, allow: allowStudioFleetWorkers },
) {
  if (input.here === input.coordinator) throw new Error("Choose another machine.");
  const added = await operations
    .add(input.coordinator, input.here, input.hereLabel)
    .catch((failure: unknown) => {
      throw new Error(
        `Setup did not finish. A management key may already have been issued on ${input.hereLabel}. Before retrying, review Settings > Machines > Authorized clients on ${input.hereLabel} and revoke the unused setup session if present. ${failure instanceof Error ? failure.message : "Could not add this machine."}`,
      );
    });
  if (added.environmentId !== input.here)
    throw new Error("The added machine's identity did not match. Worker access was not granted.");
  try {
    const result = await operations.allow(input.coordinator, {
      id: added.id,
      access: input.access,
    });
    if (result.workers.status !== "allowed" && result.workers.status !== "expiring") {
      throw new Error("Worker access was not confirmed.");
    }
    return result;
  } catch (failure) {
    throw new Error(
      `This machine was added there, but worker access was not confirmed. Open Settings > Machines on that machine and choose Allow workers on ${input.hereLabel}'s card. ${failure instanceof Error ? failure.message : "Refresh to retry."}`,
    );
  }
}

export function IncomingWorkerSetup({
  environmentId,
  snapshot,
  onGranted,
}: {
  environmentId: EnvironmentId;
  snapshot: StudioWorkGrantsSnapshot;
  onGranted: () => void;
}) {
  const tx = useTx();
  const { environments } = useEnvironments();
  const name = useMachineNicknames();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const candidates = environments.filter(
    (environment) =>
      environment.environmentId !== environmentId &&
      !snapshot.grants.some(
        (grant) => grant.coordinatorEnvironmentId === environment.environmentId,
      ),
  );
  const chosen = candidates.find((environment) => environment.environmentId === selected);
  const here = environments.find((environment) => environment.environmentId === environmentId);
  return (
    <div className="space-y-2 border-t border-border/60 px-3 py-3 sm:px-4">
      <p className="text-sm font-medium">{tx("Allow another machine to run work here")}</p>
      <p className="text-xs text-muted-foreground">
        {tx(
          "Choose the machine that will send work to this one. This does not grant automatic access to secrets; each secret transfer still needs your approval.",
        )}
      </p>
      <label className="flex flex-wrap items-center gap-2 text-xs">
        {renderRich(tx("Machine sending work{select}"), {
          select: (
            <select
              aria-label={tx("Machine sending work")}
              className="min-w-0 max-w-full rounded-md border border-input bg-background px-2 py-1"
              value={chosen?.environmentId ?? ""}
              onChange={(event) =>
                setSelected(
                  candidates.find((item) => item.environmentId === event.target.value)
                    ?.environmentId ?? null,
                )
              }
            >
              <option value="">{tx("Choose a machine")}</option>
              {candidates.map((environment) => (
                <option key={environment.environmentId} value={environment.environmentId}>
                  {name(environment.environmentId, environment.label)}
                </option>
              ))}
            </select>
          ),
        })}
      </label>
      {!candidates.length ? (
        <p className="text-xs text-muted-foreground">
          Connect the other machine in Settings &gt; Machines first. Machines already listed above
          use their existing access controls.
        </p>
      ) : null}
      {chosen ? (
        <IncomingWorkerAction
          key={chosen.environmentId}
          here={environmentId}
          coordinator={chosen.environmentId}
          hereLabel={name(environmentId, here?.label ?? "this machine")}
          coordinatorLabel={name(chosen.environmentId, chosen.label)}
          connected={chosen.connection.phase === "connected"}
          onGranted={onGranted}
        />
      ) : null}
    </div>
  );
}

function IncomingWorkerAction({
  here,
  coordinator,
  hereLabel,
  coordinatorLabel,
  connected,
  onGranted,
}: {
  here: EnvironmentId;
  coordinator: EnvironmentId;
  hereLabel: string;
  coordinatorLabel: string;
  connected: boolean;
  onGranted: () => void;
}) {
  const tx = useTx();
  const manageHere = useEnvironmentScope(here, AuthAccessWriteScope);
  const manageThere = useEnvironmentScope(coordinator, AuthAccessWriteScope);
  const [access, setAccess] = useState<StudioFleetWorkerAccess>(DEFAULT_FLEET_WORKER_ACCESS);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const unavailable = !isElectron
    ? "Open the installed desktop app to set this up."
    : !connected
      ? `Connect to ${coordinatorLabel} first.`
      : !manageHere || !manageThere
        ? `Manage access is needed on both ${hereLabel} and ${coordinatorLabel}.`
        : null;
  async function allow() {
    if (pending || done || unavailable) return;
    setPending(true);
    setError(null);
    try {
      const confirmed = await requestConfirmDialog(
        `Allow ${coordinatorLabel} to run work on ${hereLabel}?\n${coordinatorLabel} receives a management key to ${hereLabel} for a year, including access, update and skill management, plus worker access capped at ${FLEET_WORKER_ACCESS_CHOICES.find((choice) => choice.value === access)?.label ?? access}. Existing project and sign-in limits stay in force. Each secret transfer still needs your approval.`,
      );
      if (confirmed !== true) return;
      await setUpIncomingWorkers({ here, coordinator, hereLabel, access });
      setDone(true);
      onGranted();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not allow this machine. Refresh and retry.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-2">
      <p className="text-xs">
        {coordinatorLabel} → {hereLabel}
      </p>
      <label className="flex flex-wrap items-center gap-2 text-xs">
        {renderRich(tx("Most access for this work{select}"), {
          select: (
            <select
              aria-label={tx("Most access for incoming work")}
              className="min-w-0 max-w-full rounded-md border border-input bg-background px-2 py-1"
              value={access}
              disabled={pending || done || unavailable !== null}
              onChange={(event) => setAccess(event.target.value as StudioFleetWorkerAccess)}
            >
              {FLEET_WORKER_ACCESS_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          ),
        })}
      </label>
      {unavailable ? (
        <p role="status" className="text-xs text-muted-foreground">
          {renderRich(
            tx(
              "{unavailable} On {coordinatorLabel}, open Settings > Machines, expand Access, routes and worker permissions on {hereLabel}'s card, and choose Allow workers.",
            ),
            { unavailable: unavailable, coordinatorLabel: coordinatorLabel, hereLabel: hereLabel },
          )}
        </p>
      ) : (
        <Button size="xs" disabled={pending || done} onClick={() => void allow()}>
          {pending
            ? tx("Setting up…")
            : done
              ? tx("Worker access allowed")
              : `Allow ${coordinatorLabel} to run work here`}
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
