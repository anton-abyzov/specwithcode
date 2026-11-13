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
import { useProjects } from "../state/entities";
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
import { linkedMachineIds } from "../studio/linkedMachines";
import { onConnectRouteRequest, readDeclinedConnectRoutes } from "./connectRoutePlan";

// The fleet atom needs an id; one that matches no environment reads as no fleet.
const NO_ENVIRONMENT = "" as EnvironmentId;
/** Automatic tries per machine before it waits for Connect by hand. */
const MAX_ATTEMPTS = 3;
/** Wait after a failed try, and between re-reads of the account list for one machine. */
const RETRY_MS = 60_000;

/**
 * Saves, with a SpecWithCode Connect route, each machine of this account that
 * let this one run work on it (so it is in this server's fleet) and has no
 * Tailscale address. The grant given there is the consent: nothing needs
 * pressing here. Runs while Connect automatically is on; Connect by hand
 * (`requestConnectRoutes`) saves one in any case, and lifts an earlier
 * removal. Publishes one state per machine for the move dialog, Settings >
 * Machines and the checking state. Mounted by the reconciler, per account.
 */
export function GrantedAccountMachines() {
  const { environments } = useEnvironments();
  const projects = useProjects();
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
  const requested = useRef(new Set<string>());
  const lookedUp = useRef(new Map<string, number>());
  // The list belongs to this account only after a refresh that started once it was active.
  const sawRefresh = useRef(false);
  const [tick, setTick] = useState(0);
  const [failedCount, setFailedCount] = useState(0);

  useEffect(
    () =>
      onConnectRouteRequest((environmentIds) => {
        for (const id of environmentIds) {
          requested.current.add(id);
          attempts.current.delete(id);
          failures.current.delete(id);
          // Connecting by hand undoes an earlier removal on this device.
          setFleetEnvironmentSkipped(id as EnvironmentId, false);
        }
        setTick((current) => current + 1);
        void refresh();
      }),
    [refresh],
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
    // Machines a shared project names are saved by the reconciler itself.
    const linked = linkedMachineIds(projects);
    const candidates = grantedAccountMachinesToConnect({
      snapshot,
      currentEnvironmentId: primaryEnvironmentId,
      savedEnvironmentIds,
      discovered: discovery.environments,
      skip: new Set([...linked].filter((id) => !requested.current.has(id))),
      requested: requested.current,
    });
    const removed = new Set<string>([
      ...readSkippedFleetEnvironments(),
      ...readDeclinedConnectRoutes(),
    ]);
    const unreachable = discovery.error._tag === "Some" || discovery.offline;
    const next = new Map<string, AccountAutoConnectState>();
    for (const machine of candidates) {
      const id = machine.environmentId;
      const asked = requested.current.has(id);
      const tried = attempts.current.get(id);
      const failure = failures.current.get(id);
      if (inFlight.current.has(id) || !sawRefresh.current) {
        next.set(id, { phase: "connecting" });
        continue;
      }
      if (!asked && !autoConnect) {
        next.set(id, { phase: "held", reason: AUTO_CONNECT_OFF_REASON });
        continue;
      }
      if (!asked && removed.has(id)) {
        next.set(id, { phase: "held", reason: REMOVED_HERE_REASON });
        continue;
      }
      if (unreachable) {
        next.set(id, { phase: "held", reason: CONNECT_UNREACHABLE_REASON });
        continue;
      }
      if (
        !asked &&
        failure !== undefined &&
        tried !== undefined &&
        (tried.count >= MAX_ATTEMPTS || now - tried.at < RETRY_MS)
      ) {
        next.set(id, { phase: "failed", reason: failure });
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
        if (result._tag === "Success") failures.current.delete(id);
        else if (isAtomCommandInterrupted(result)) attempts.current.delete(id);
        else {
          const cause = squashAtomCommandFailure(result);
          failures.current.set(
            id,
            cause instanceof Error && cause.message ? cause.message : CONNECT_NO_ANSWER_REASON,
          );
        }
        setFailedCount(failures.current.size);
        setTick((current) => current + 1);
      });
    }
    publishAccountAutoConnectStates(next);

    // A machine that joined a moment ago may be missing from the list read earlier.
    const missing = grantedMachinesMissingFromAccount({
      snapshot,
      currentEnvironmentId: primaryEnvironmentId,
      savedEnvironmentIds,
      discovered: discovery.environments,
    }).filter((id) => now - (lookedUp.current.get(id) ?? 0) >= RETRY_MS);
    if (missing.length > 0 && !unreachable) {
      for (const id of missing) lookedUp.current.set(id, now);
      void refresh();
    }
  }, [
    autoConnect,
    discovery,
    environments,
    primaryEnvironmentId,
    projects,
    refresh,
    register,
    snapshot,
    tick,
  ]);

  // Failed machines are tried again after the wait, up to MAX_ATTEMPTS.
  useEffect(() => {
    if (failedCount === 0) return;
    const timer = setTimeout(() => setTick((current) => current + 1), RETRY_MS);
    return () => clearTimeout(timer);
  }, [failedCount, tick]);

  return null;
}
