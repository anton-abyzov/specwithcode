import { renderRich } from "../../i18n/rich";
import { useLocale, useTx } from "../../i18n";
import { useState } from "react";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import type { StudioFleetWorkerAccess } from "@specweave-studio/contracts/studioFleet";
import { isElectron } from "../../env";
import { useEnvironmentScope } from "../../state/session";
import {
  addVisibleMachineToStudioFleet,
  allowIncomingStudioFleetWorkers,
  allowStudioFleetWorkers,
  joinAccountMachineForWorkers,
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

/**
 * The account's machines the card offers beside the ones this app already
 * opened: never this machine, and never one already listed or allowed.
 */
export function accountMachinesToOffer<
  Record extends { readonly environmentId: EnvironmentId },
>(input: {
  readonly discovered: ReadonlyArray<Record>;
  readonly here: EnvironmentId;
  readonly known: ReadonlyArray<EnvironmentId>;
}): Record[] {
  const skip = new Set<EnvironmentId>([input.here, ...input.known]);
  return input.discovered.filter((record) => !skip.has(record.environmentId));
}

/** The join line could not be made because this machine is not linked to SpecWithCode Connect. */
function isConnectOffHere(failure: unknown): boolean {
  return (
    typeof failure === "object" &&
    failure !== null &&
    (failure as { readonly reason?: unknown }).reason === "connect_not_linked"
  );
}

function connectOffHereMessage(hereLabel: string, coordinatorLabel: string): string {
  return `SpecWithCode Connect is off on ${hereLabel}, so ${coordinatorLabel} has no address to reach it. On ${hereLabel}, turn on the SpecWithCode Connect switch in Settings > Machines, then choose Allow again.`;
}

export function IncomingWorkerSaved({
  coordinatorLabel,
  access,
  expiresAt,
  renewable = false,
}: {
  coordinatorLabel: string;
  access: StudioFleetWorkerAccess;
  expiresAt: string | null;
  /** That machine renews the grant itself, so no end date is shown. */
  renewable?: boolean;
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
        {renewable
          ? tx("{coordinatorLabel} can run work here · {access} · renews by itself", {
              coordinatorLabel,
              access: accessLabel,
            })
          : date
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

/** What Allow needs to know about the two machines. */
export interface IncomingWorkerAllowInput {
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
  /**
   * The coordinator takes this machine's line from a sign-in through its own
   * SpecWithCode Connect account (`fleetAccountJoinWorkers`). With neither a
   * sign-in that manages access there nor a fleet line, this app hands the
   * line over through its Connect sign-in.
   */
  accountJoin?: boolean | undefined;
  /** The cap, when the caller keeps it across choices; kept here otherwise. */
  access?: StudioFleetWorkerAccess | undefined;
  onAccessChange?: ((access: StudioFleetWorkerAccess) => void) | undefined;
  /**
   * False where the surface already states what Allow hands over, so the
   * press is the decision: the first-run card. Asked everywhere else.
   */
  confirm?: boolean | undefined;
  /** Told while Allow runs, so the caller can hold its own controls still. */
  onPendingChange?: ((pending: boolean) => void) | undefined;
  onGranted: (grant: {
    access: StudioFleetWorkerAccess;
    expiresAt: string | null;
    renewable: boolean;
  }) => void;
}

/**
 * Allowing one machine to run work on this one: which route applies, why it
 * cannot run yet, and the call itself. Shared by the card and the machine rows.
 */
export function useIncomingWorkerAllow({
  here,
  coordinator,
  hereLabel,
  coordinatorLabel,
  connected,
  coordinatorFleetId,
  accountJoin,
  confirm,
  access: controlledAccess,
  onAccessChange,
  onPendingChange,
  onGranted,
}: IncomingWorkerAllowInput) {
  const tx = useTx();
  const manageHere = useEnvironmentScope(here, AuthAccessWriteScope);
  const manageThere = useEnvironmentScope(coordinator, AuthAccessWriteScope);
  const operateThere = useEnvironmentScope(coordinator, AuthOrchestrationOperateScope);
  const [ownAccess, setOwnAccess] = useState<StudioFleetWorkerAccess>(DEFAULT_FLEET_WORKER_ACCESS);
  const access = controlledAccess ?? ownAccess;
  const setAccess = (next: StudioFleetWorkerAccess) => {
    setOwnAccess(next);
    onAccessChange?.(next);
  };
  const [pending, setOwnPending] = useState(false);
  const setPending = (next: boolean) => {
    setOwnPending(next);
    onPendingChange?.(next);
  };
  const [error, setError] = useState<string | null>(null);
  // Without a sign-in there, this machine's server asks the coordinator itself.
  const fromHere = !manageThere && coordinatorFleetId !== undefined;
  // With neither, the two machines' shared SpecWithCode Connect account carries the line.
  const throughAccount =
    !manageThere && coordinatorFleetId === undefined && accountJoin === true && operateThere;
  const unavailable = !isElectron
    ? tx("Open the installed desktop app to set this up.")
    : !connected
      ? tx("Connect to {coordinatorLabel} first.", { coordinatorLabel })
      : !manageHere
        ? tx("Manage access is needed on {hereLabel}.", { hereLabel })
        : !manageThere && coordinatorFleetId === undefined && !throughAccount
          ? tx(
              "On {hereLabel}, open Settings > Machines > Join a main machine, pick {coordinatorLabel} and copy the line. On {coordinatorLabel}, open Settings > Machines > Add a machine, paste it, then choose Allow on {hereLabel}'s card.",
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
  async function allowThroughAccount() {
    const result = await joinAccountMachineForWorkers({
      here,
      coordinator,
      coordinatorLabel,
      access,
    }).catch((failure: unknown) => {
      // This machine has no Connect address to hand over: name the switch that gives it one.
      if (isConnectOffHere(failure))
        throw new Error(connectOffHereMessage(hereLabel, coordinatorLabel), { cause: failure });
      throw failure;
    });
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
      if (confirm !== false) {
        const confirmed = await requestConfirmDialog(
          `Allow ${coordinatorLabel} to run work on ${hereLabel}?\n${coordinatorLabel} receives a management key to ${hereLabel} for a year, including access, update and skill management, plus worker access capped at ${FLEET_WORKER_ACCESS_CHOICES.find((choice) => choice.value === access)?.label ?? access}. Existing project and sign-in limits stay in force. Each secret transfer still needs your approval.`,
        );
        if (confirmed !== true) return;
      }
      const result = throughAccount
        ? await allowThroughAccount()
        : fromHere && coordinatorFleetId !== undefined
          ? await allowIncomingFromHere(coordinatorFleetId)
          : await setUpIncomingWorkers({ here, coordinator, hereLabel, access });
      onGranted({
        access,
        expiresAt: result.workers.expiresAt,
        renewable: result.workers.renewable,
      });
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
  return { access, setAccess, pending, error, unavailable, throughAccount, allow };
}

export function IncomingWorkerAction({
  actionLabel,
  ...input
}: IncomingWorkerAllowInput & {
  /** The button's words where the card already names the direction; "Allow <machine>" otherwise. */
  actionLabel?: string;
}) {
  const tx = useTx();
  const { hereLabel, coordinatorLabel } = input;
  const { access, setAccess, pending, error, unavailable, allow } = useIncomingWorkerAllow(input);
  return (
    <div className="space-y-2">
      {/* A caller's own label already names the direction. */}
      {actionLabel ? null : (
        <p className="text-xs">
          {coordinatorLabel} → {hereLabel}
        </p>
      )}
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
