import { renderRich } from "../../i18n/rich";
import { useLocale, useTx } from "../../i18n";
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
import {
  addVisibleMachineToStudioFleet,
  allowIncomingStudioFleetWorkers,
  allowStudioFleetWorkers,
  readStudioFleetMachines,
} from "../../studio/fleet";
import {
  DEFAULT_FLEET_WORKER_ACCESS,
  FLEET_WORKER_ACCESS_CHOICES,
} from "../../studio/fleetWorkers";
import { requestConfirmDialog } from "../../confirmDialog";
import { Button } from "../ui/button";

// Lines this page just gave a fresh key. The coordinator keeps the old failure
// note until a grant succeeds, so without this a quick second retry would
// replace that new key too.
const freshKeys = new Set<string>();

/**
 * The remote machine is the coordinator and this machine the destination. A
 * destination the coordinator already lists with a working key keeps it, so a
 * retry never issues another one; a missing or unusable line is added.
 */
export async function setUpIncomingWorkers(
  input: {
    here: EnvironmentId;
    coordinator: EnvironmentId;
    hereLabel: string;
    access: StudioFleetWorkerAccess;
  },
  operations = {
    add: addVisibleMachineToStudioFleet,
    allow: allowStudioFleetWorkers,
    read: readStudioFleetMachines,
  },
) {
  if (input.here === input.coordinator) throw new Error("Choose another machine.");
  const listed = await operations.read(input.coordinator).catch(() => {
    throw new Error(
      `Could not check whether ${input.hereLabel} is already listed, so nothing was changed. Refresh and retry.`,
    );
  });
  const existing = listed.find((machine) => machine.environmentId === input.here);
  if (existing?.status === "identity-mismatch")
    throw new Error(
      `The machine listed as ${input.hereLabel} answers as a different machine. Worker access was not granted. Remove that line in Settings > Machines on the sending machine, then set up again.`,
    );
  // A line without a usable management token can never mint a grant, so
  // adding it again (which replaces that token) is the only way forward.
  const lineKey = `${input.coordinator}:${input.here}`;
  const reusable =
    existing !== undefined &&
    (freshKeys.has(lineKey) ||
      (existing.pairingConfigured && existing.workers?.problem !== "pairing_unavailable"));
  const added =
    existing && reusable
      ? { id: existing.id, environmentId: existing.environmentId }
      : await operations
          .add(input.coordinator, input.here, input.hereLabel)
          .catch((failure: unknown) => {
            throw new Error(
              `Setup did not finish. A management key may already have been issued on ${input.hereLabel}. Before retrying, review Settings > Machines > Authorized clients on ${input.hereLabel} and revoke the unused setup session if present. ${failure instanceof Error ? failure.message : "Could not add this machine."}`,
            );
          });
  if (!reusable) freshKeys.add(lineKey);
  if (added.environmentId !== input.here)
    throw new Error(
      `The added machine's identity did not match. A management key may already have been issued on ${input.hereLabel}; review Settings > Machines > Authorized clients there and revoke the unused setup session. Worker access was not granted.`,
    );
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
      `${input.hereLabel} is listed on that machine, but worker access was not confirmed. A retry reuses that line while its key works. ${failure instanceof Error ? failure.message : "Refresh to retry."}`,
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
  // Kept here, not in the action: a granted machine leaves the candidates once
  // the snapshot refreshes, which unmounts the action.
  const [saved, setSaved] = useState<{
    coordinator: EnvironmentId;
    coordinatorLabel: string;
    access: StudioFleetWorkerAccess;
    expiresAt: string | null;
  } | null>(null);
  const savedGrant = saved
    ? snapshot.grants.find((grant) => grant.coordinatorEnvironmentId === saved.coordinator)
    : undefined;
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
      {saved ? (
        <IncomingWorkerSaved
          coordinatorLabel={saved.coordinatorLabel}
          access={saved.access}
          expiresAt={saved.expiresAt ?? savedGrant?.expiresAt ?? null}
        />
      ) : null}
      {!candidates.length && !saved ? (
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
          onGranted={(grant) => {
            setSaved({
              coordinator: chosen.environmentId,
              coordinatorLabel: name(chosen.environmentId, chosen.label),
              ...grant,
            });
            setSelected(null);
            onGranted();
          }}
        />
      ) : null}
    </div>
  );
}

export function IncomingWorkerSaved({
  coordinatorLabel,
  access,
  expiresAt,
}: {
  coordinatorLabel: string;
  access: StudioFleetWorkerAccess;
  expiresAt: string | null;
}) {
  const tx = useTx();
  const locale = useLocale();
  const accessLabel =
    FLEET_WORKER_ACCESS_CHOICES.find((choice) => choice.value === access)?.label ?? access;
  const date = expiresAt
    ? new Date(expiresAt).toLocaleDateString(locale, {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;
  return (
    <div role="status" className="space-y-1 text-xs">
      <p className="font-medium">
        {date
          ? tx("{coordinatorLabel} can run work here · {access} · until {date}", {
              coordinatorLabel,
              access: accessLabel,
              date,
            })
          : tx("{coordinatorLabel} can run work here · {access}", {
              coordinatorLabel,
              access: accessLabel,
            })}
      </p>
      <p className="text-muted-foreground">
        {tx("On {coordinatorLabel}: done", { coordinatorLabel })}
      </p>
    </div>
  );
}

export function IncomingWorkerAction({
  here,
  coordinator,
  hereLabel,
  coordinatorLabel,
  connected,
  coordinatorFleetId,
  actionLabel,
  onGranted,
}: {
  here: EnvironmentId;
  coordinator: EnvironmentId;
  hereLabel: string;
  coordinatorLabel: string;
  connected: boolean;
  /**
   * The coordinator's id in this machine's own fleet list. With it this
   * machine's server asks the coordinator to add and allow it, so no sign-in
   * with Manage access is needed there.
   */
  coordinatorFleetId?: string | undefined;
  /** The button's words where the card already names the direction; "Allow <machine>" otherwise. */
  actionLabel?: string;
  onGranted: (grant: { access: StudioFleetWorkerAccess; expiresAt: string | null }) => void;
}) {
  const tx = useTx();
  const manageHere = useEnvironmentScope(here, AuthAccessWriteScope);
  const manageThere = useEnvironmentScope(coordinator, AuthAccessWriteScope);
  const [access, setAccess] = useState<StudioFleetWorkerAccess>(DEFAULT_FLEET_WORKER_ACCESS);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Without a sign-in there, this machine's server asks the coordinator itself.
  const fromHere = !manageThere && coordinatorFleetId !== undefined;
  const unavailable = !isElectron
    ? tx("Open the installed desktop app to set this up.")
    : !connected
      ? tx("Connect to {coordinatorLabel} first.", { coordinatorLabel })
      : !manageHere
        ? tx("Manage access is needed on {hereLabel}.", { hereLabel })
        : !manageThere && coordinatorFleetId === undefined
          ? tx(
              "On {hereLabel}, open Settings > Connections > Join a main machine, pick {coordinatorLabel} and copy the line. On {coordinatorLabel}, open Settings > Machines > Add a machine, paste it, then choose Allow workers on {hereLabel}'s card.",
              { hereLabel, coordinatorLabel },
            )
          : null;
  async function allowIncomingFromHere(fleetId: string) {
    const result = await allowIncomingStudioFleetWorkers(here, fleetId, access);
    if (result.workers.status !== "allowed" && result.workers.status !== "expiring")
      throw new Error(
        `${coordinatorLabel} added ${hereLabel}, but worker access was not confirmed. Refresh, then retry.`,
      );
    return result;
  }
  async function allow() {
    if (pending || unavailable) return;
    setPending(true);
    setError(null);
    try {
      const confirmed = await requestConfirmDialog(
        `Allow ${coordinatorLabel} to run work on ${hereLabel}?\n${coordinatorLabel} receives a management key to ${hereLabel} for a year, including access, update and skill management, plus worker access capped at ${FLEET_WORKER_ACCESS_CHOICES.find((choice) => choice.value === access)?.label ?? access}. Existing project and sign-in limits stay in force. Each secret transfer still needs your approval.`,
      );
      if (confirmed !== true) return;
      const result =
        fromHere && coordinatorFleetId !== undefined
          ? await allowIncomingFromHere(coordinatorFleetId)
          : await setUpIncomingWorkers({ here, coordinator, hereLabel, access });
      onGranted({ access, expiresAt: result.workers.expiresAt });
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
              disabled={pending || unavailable !== null}
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
      {/* The selects do not save on their own, so the button always shows. */}
      <div className="space-y-1">
        <Button size="xs" disabled={pending || unavailable !== null} onClick={() => void allow()}>
          {pending
            ? tx("Setting up…")
            : (actionLabel ?? tx("Allow {coordinatorLabel}", { coordinatorLabel }))}
        </Button>
        {unavailable ? (
          <p role="status" className="text-xs text-muted-foreground">
            {unavailable}
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
