import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@specweave-studio/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useEffect, useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useClientSettings } from "../hooks/useSettings";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  useRelayEnvironmentDiscovery,
} from "../state/environments";
import { relayEnvironmentDiscovery } from "../state/relay";
import { useAtomCommand } from "../state/use-atom-command";
import { useStudioFleet } from "../studio/fleet";
import {
  readSkippedFleetEnvironments,
  setFleetEnvironmentSkipped,
} from "../studio/fleetAutoConnect";
import {
  AUTO_CONNECT_OFF_REASON,
  type AccountAutoConnectState,
  CONNECT_NO_ANSWER_REASON,
  CONNECT_UNREACHABLE_REASON,
  REMOVED_HERE_REASON,
  grantedAccountMachinesToConnect,
  grantedMachinesMissingFromAccount,
  publishAccountAutoConnectStates,
} from "../studio/grantedAccountMachines";
import { onConnectRouteRequest, readDeclinedConnectRoutes } from "./connectRoutePlan";

// The fleet atom needs an id; one that matches no environment reads as no fleet.
const NO_ENVIRONMENT = "" as EnvironmentId;
/** Automatic tries per machine before it waits for Connect by hand. */
const MAX_ATTEMPTS = 3;
/** Wait after a try before the next one, and between re-reads of the account list for one machine. */
const RETRY_MS = 60_000;
/** A Connect press stays in force this long, for the pass that acts on it. */
const REQUEST_MS = 2 * RETRY_MS;
/** Re-reads of the account list for one fleet machine it does not show, such as one on another account. */
const MAX_LOOKUPS = 3;

/**
 * Saves, with a SpecWithCode Connect route, each machine of this account that
 * let this one run work on it (so it is in this server's fleet) and has no
 * Tailscale address. The grant given there is the consent: nothing needs
 * pressing here. Runs while Connect automatically is on; Connect by hand
 * (`requestConnectRoutes`) saves one in any case, and lifts an earlier
 * removal. Publishes one state per machine for the move dialog, Settings >
 * Machines and the checking state. Mounted by the reconciler, per account; a
 * machine a shared project also names is saved here, not by its linked path.
 */
export function GrantedAccountMachines() {
  const { environments } = useEnvironments();
  const discovery = useRelayEnvironmentDiscovery();
  const autoConnect = useClientSettings((settings) => settings.autoConnectPrivateMachines);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fleet = useStudioFleet(primaryEnvironmentId ?? NO_ENVIRONMENT);
  const snapshot = primaryEnvironmentId === null ? null : fleet.snapshot;
  const register = useAtomCommand(environmentCatalog.register, {
    label: "Add SpecWithCode Connect route",
    reportFailure: false,
  });
  const refresh = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    label: "Refresh SpecWithCode Connect machines",
    reportFailure: false,
  });
  const inFlight = useRef(new Set<string>());
  const attempts = useRef(new Map<string, { count: number; at: number }>());
  const failures = useRef(new Map<string, string>());
  // Machines asked for by hand, with when.
  const requested = useRef(new Map<string, number>());
  const lookedUp = useRef(new Map<string, { count: number; at: number }>());
  // The list belongs to this account only after a refresh that started once it was active.
  const sawRefresh = useRef(false);
  const [tick, setTick] = useState(0);
  const [retryPending, setRetryPending] = useState(false);

  useEffect(
    () =>
      onConnectRouteRequest((environmentIds) => {
        const now = Date.now();
        for (const id of environmentIds) {
          requested.current.set(id, now);
          attempts.current.delete(id);
          failures.current.delete(id);
          // Connecting by hand undoes an earlier removal on this device.
          setFleetEnvironmentSkipped(id as EnvironmentId, false);
        }
        // The reconciler, which hears the same press, reads the account list again.
        setTick((current) => current + 1);
      }),
    [],
  );

  // A fresh list for this account, and nothing left published once it signs out.
  useEffect(() => {
    void refresh();
    return () => publishAccountAutoConnectStates(new Map());
  }, [refresh]);

  useEffect(() => {
    if (discovery.refreshing) {
      sawRefresh.current = true;
      return;
    }
    const now = Date.now();
    const savedEnvironmentIds = new Set<string>(environments.map((item) => item.environmentId));
    // A press acts once: dropped when the machine is saved or the press is old.
    for (const [id, at] of requested.current)
      if (savedEnvironmentIds.has(id) || now - at >= REQUEST_MS) requested.current.delete(id);
    const candidates = grantedAccountMachinesToConnect({
      snapshot,
      currentEnvironmentId: primaryEnvironmentId,
      savedEnvironmentIds,
      discovered: discovery.environments,
      requested: new Set(requested.current.keys()),
    });
    const removed = new Set<string>([
      ...readSkippedFleetEnvironments(),
      ...readDeclinedConnectRoutes(),
    ]);
    const unreachable = discovery.error._tag === "Some" || discovery.offline;
    const next = new Map<string, AccountAutoConnectState>();
    // Some machine waits for its next try.
    let waiting = false;
    for (const machine of candidates) {
      const id = machine.environmentId;
      const asked = requested.current.has(id);
      const tried = attempts.current.get(id);
      const failure = failures.current.get(id);
      if (inFlight.current.has(id) || !sawRefresh.current) {
        next.set(id, { phase: "connecting" });
        continue;
      }
      // A press that failed keeps saying why, also while saving is held.
      if (!asked && (!autoConnect || removed.has(id))) {
        next.set(
          id,
          failure !== undefined
            ? { phase: "failed", reason: failure }
            : {
                phase: "held",
                reason: autoConnect ? REMOVED_HERE_REASON : AUTO_CONNECT_OFF_REASON,
              },
        );
        continue;
      }
      if (unreachable) {
        next.set(id, { phase: "held", reason: CONNECT_UNREACHABLE_REASON });
        continue;
      }
      // Each machine is tried at most MAX_ATTEMPTS times, a minute apart, also
      // when a try reported success but the catalog has not shown it saved.
      if (
        !asked &&
        tried !== undefined &&
        (tried.count >= MAX_ATTEMPTS || now - tried.at < RETRY_MS)
      ) {
        if (failure !== undefined) next.set(id, { phase: "failed", reason: failure });
        else if (tried.count >= MAX_ATTEMPTS)
          next.set(id, { phase: "failed", reason: CONNECT_NO_ANSWER_REASON });
        else next.set(id, { phase: "connecting" });
        if (tried.count < MAX_ATTEMPTS) waiting = true;
        continue;
      }
      requested.current.delete(id);
      attempts.current.set(id, { count: (tried?.count ?? 0) + 1, at: now });
      inFlight.current.add(id);
      next.set(id, { phase: "connecting" });
      void register(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({ environmentId: id, label: machine.label }),
        }),
      ).then((result) => {
        inFlight.current.delete(id);
        // An interrupted try counts as a try, so the wait and the cap still apply.
        if (result._tag === "Success") failures.current.delete(id);
        else if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          failures.current.set(
            id,
            cause instanceof Error && cause.message ? cause.message : CONNECT_NO_ANSWER_REASON,
          );
        }
        setTick((current) => current + 1);
      });
    }
    publishAccountAutoConnectStates(next);
    setRetryPending(waiting);

    // A machine that joined a moment ago may be missing from the list read earlier.
    const missing = grantedMachinesMissingFromAccount({
      snapshot,
      currentEnvironmentId: primaryEnvironmentId,
      savedEnvironmentIds,
      discovered: discovery.environments,
    }).filter((id) => {
      const looked = lookedUp.current.get(id);
      return looked === undefined || (looked.count < MAX_LOOKUPS && now - looked.at >= RETRY_MS);
    });
    if (missing.length > 0 && !unreachable) {
      for (const id of missing)
        lookedUp.current.set(id, { count: (lookedUp.current.get(id)?.count ?? 0) + 1, at: now });
      void refresh();
    }
  }, [
    autoConnect,
    discovery,
    environments,
    primaryEnvironmentId,
    refresh,
    register,
    snapshot,
    tick,
  ]);

  // A machine waiting for its next try is tried again after the wait.
  useEffect(() => {
    if (!retryPending) return;
    const timer = setTimeout(() => setTick((current) => current + 1), RETRY_MS);
    return () => clearTimeout(timer);
  }, [retryPending, tick]);

  return null;
}
