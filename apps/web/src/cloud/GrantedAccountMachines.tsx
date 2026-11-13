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
import { usePrimaryFleetSnapshot } from "../studio/fleet";
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
  accountAutoConnectStates,
  grantedAccountMachinesToConnect,
  grantedMachinesMissingFromAccount,
  onAccountMachineConnectRequest,
  publishAccountAutoConnectStates,
} from "../studio/grantedAccountMachines";
import { linkedMachineIds } from "../studio/linkedMachines";
import { readDeclinedConnectRoutes, setConnectRouteDeclined } from "./connectRoutePlan";

/** Tries per machine before it waits for Connect by hand. */
const MAX_ATTEMPTS = 3;
/** Wait after a try before the next one, and between re-reads of the account list for one machine. */
const RETRY_MS = 60_000;
/** Re-reads of the account list for one fleet machine it does not show, such as one on another account. */
const MAX_LOOKUPS = 3;

interface Attempt {
  readonly count: number;
  readonly at: number;
}

/**
 * Saves, with a SpecWithCode Connect route, each machine of this account that
 * let this one run work on it (so it is in this server's fleet) and has no
 * Tailscale address. The grant given there is the consent: nothing needs
 * pressing here. Runs while Connect automatically is on, and always for a
 * machine a shared project also names (which the reconciler's linked path
 * leaves to this one). Connect by hand (`requestAccountMachineConnect`) saves
 * one in any case, a tailnet machine too, and lifts an earlier removal.
 *
 * Publishes one state per machine for the move dialog, Settings > Machines
 * and the checking state. Mounted by the reconciler, per account.
 */
export function GrantedAccountMachines() {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const discovery = useRelayEnvironmentDiscovery();
  const autoConnect = useClientSettings((settings) => settings.autoConnectPrivateMachines);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const snapshot = usePrimaryFleetSnapshot(primaryEnvironmentId);
  const register = useAtomCommand(environmentCatalog.register, {
    label: "Add SpecWithCode Connect route",
    reportFailure: false,
  });
  const refresh = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    label: "Refresh SpecWithCode Connect machines",
    reportFailure: false,
  });
  const inFlight = useRef(new Set<string>());
  const attempts = useRef(new Map<string, Attempt>());
  const failures = useRef(new Map<string, string>());
  // Machines asked for by hand, with when. A press is in force until the
  // machine is saved; it overrides holds and the wait for one try.
  const requested = useRef(new Map<string, number>());
  const lookedUp = useRef(new Map<string, Attempt>());
  // The list belongs to this account only after a refresh that started once it was active.
  const sawRefresh = useRef(false);
  const [tick, setTick] = useState(0);
  const [retryPending, setRetryPending] = useState(false);

  useEffect(
    () =>
      onAccountMachineConnectRequest((environmentIds) => {
        const now = Date.now();
        const shown = new Map(accountAutoConnectStates());
        for (const id of environmentIds) {
          requested.current.set(id, now);
          // Connecting by hand undoes an earlier removal on this device.
          setFleetEnvironmentSkipped(id as EnvironmentId, false);
          setConnectRouteDeclined(id, false);
          shown.set(id, { phase: "connecting" });
        }
        // Says so at once, also while the account list is being read.
        publishAccountAutoConnectStates(shown);
        setTick((current) => current + 1);
        // Only when this account's list was never read: refreshing empties
        // every machine list for a moment.
        if (!sawRefresh.current) void refresh();
      }),
    [refresh],
  );

  // Nothing stays published once this account signs out.
  useEffect(() => () => publishAccountAutoConnectStates(new Map()), []);

  useEffect(() => {
    // The list is empty while it is read again: keep what is published.
    if (discovery.refreshing) {
      sawRefresh.current = true;
      return;
    }
    const now = Date.now();
    const savedEnvironmentIds = new Set<string>(environments.map((item) => item.environmentId));
    for (const id of requested.current.keys())
      if (savedEnvironmentIds.has(id)) requested.current.delete(id);
    const linked = linkedMachineIds(projects);
    const candidates = grantedAccountMachinesToConnect({
      snapshot,
      currentEnvironmentId: primaryEnvironmentId,
      savedEnvironmentIds,
      discovered: discovery.environments,
      // A linked tailnet machine stays with the reconciler's linked path.
      requested: new Set([...requested.current.keys()].filter((id) => !linked.has(id))),
    });
    const removed = new Set<string>([
      ...readSkippedFleetEnvironments(),
      ...readDeclinedConnectRoutes(),
    ]);
    const unreachable = discovery.error._tag === "Some" || discovery.offline;
    const next = new Map<string, AccountAutoConnectState>();
    let waiting = false;
    for (const machine of candidates) {
      const id = machine.environmentId;
      const tried = attempts.current.get(id);
      const pressedAt = requested.current.get(id);
      // A press made after the last try asks for one more, now.
      const asked = pressedAt !== undefined && (tried === undefined || pressedAt > tried.at);
      const failure = failures.current.get(id);
      if (inFlight.current.has(id) || !sawRefresh.current) {
        next.set(id, { phase: "connecting" });
        continue;
      }
      if (unreachable) {
        next.set(id, { phase: "held", reason: CONNECT_UNREACHABLE_REASON });
        continue;
      }
      const automatic = autoConnect || linked.has(id);
      if (!asked && pressedAt === undefined && (!automatic || removed.has(id))) {
        // A failed try keeps saying why, also while saving is held.
        next.set(
          id,
          failure !== undefined
            ? { phase: "failed", reason: failure }
            : {
                phase: "held",
                reason: removed.has(id) ? REMOVED_HERE_REASON : AUTO_CONNECT_OFF_REASON,
              },
        );
        continue;
      }
      // At most MAX_ATTEMPTS tries a minute apart, also when a try reported
      // success but the catalog has not shown the machine saved.
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

    // A machine that joined a moment ago may be missing from the list read
    // earlier; one on another account never shows, so a few reads only.
    const missing = grantedMachinesMissingFromAccount({
      snapshot,
      currentEnvironmentId: primaryEnvironmentId,
      savedEnvironmentIds,
      discovered: discovery.environments,
    }).filter((id) => {
      const looked = lookedUp.current.get(id);
      return looked === undefined || (looked.count < MAX_LOOKUPS && now - looked.at >= RETRY_MS);
    });
    if (missing.length > 0 && sawRefresh.current && !unreachable) {
      for (const id of missing)
        lookedUp.current.set(id, { count: (lookedUp.current.get(id)?.count ?? 0) + 1, at: now });
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

  // A machine waiting for its next try is tried again after the wait.
  useEffect(() => {
    if (!retryPending) return;
    const timer = setTimeout(() => setTick((current) => current + 1), RETRY_MS);
    return () => clearTimeout(timer);
  }, [retryPending, tick]);

  return null;
}
