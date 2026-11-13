import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@specweave-studio/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentId } from "@specweave-studio/contracts";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
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
import {
  fleetMachineHasTailnetAddress,
  readSkippedFleetEnvironments,
  setFleetEnvironmentSkipped,
} from "../studio/fleetAutoConnect";
import {
  AUTO_CONNECT_OFF_REASON,
  type AccountAutoConnectState,
  CONNECT_FAILED_REASON,
  CONNECT_NO_ANSWER_REASON,
  CONNECT_NOT_ADDED_REASON,
  connectRouteAddsInFlight,
  fleetMachineGranted,
  onConnectRouteAddsChange,
  setConnectRouteAddInFlight,
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
/** Re-reads of the account list for a fleet machine it does not show; one on another account never shows. */
const MAX_LOOKUPS = 2;

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
 * leaves to this one). Every Connect press for a machine in this fleet
 * (`requestAccountMachineConnect`) is saved here, a tailnet machine too, so
 * its state and any failure are published; it also lifts an earlier removal.
 *
 * Publishes one state per machine for the move dialog, Settings > Machines
 * and the checking state. Mounted by the reconciler, per account.
 */
export function GrantedAccountMachines({
  snapshot,
}: {
  /** This app's own server's fleet, from the reconciler. */
  readonly snapshot: StudioFleetSnapshot | null;
}) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const discovery = useRelayEnvironmentDiscovery();
  const autoConnect = useClientSettings((settings) => settings.autoConnectPrivateMachines);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const register = useAtomCommand(environmentCatalog.register, {
    label: "Add SpecWithCode Connect route",
    reportFailure: false,
  });
  const refresh = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    label: "Refresh SpecWithCode Connect machines",
    reportFailure: false,
  });
  // Machines whose last try reported success yet were not added here.
  const accepted = useRef(new Set<string>());
  const attempts = useRef(new Map<string, Attempt>());
  const failures = useRef(new Map<string, string | undefined>());
  // Machines asked for by hand, a tailnet one too. A press is in force until
  // the machine is saved; it overrides holds and the wait for one try. The
  // shared in-flight set keeps the reconciler's linked path from adding it too.
  const requested = useRef(new Set<string>());
  const lookedUp = useRef(new Map<string, Attempt & { readonly sign: string }>());
  // The list belongs to this account only after a refresh that started once it was active.
  const sawRefresh = useRef(false);
  // Presses not acted on yet: each one asks for one try now.
  const unanswered = useRef(new Set<string>());
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const savedRef = useRef(new Set<string>());
  savedRef.current = new Set(environments.map((item) => item.environmentId));
  const discoveredRef = useRef(discovery.environments);
  if (!discovery.refreshing) discoveredRef.current = discovery.environments;
  // Machines the account list has shown this session: while it cannot be
  // read, only these are said to wait for Connect.
  const onAccount = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const [retryPending, setRetryPending] = useState(false);

  useEffect(
    () =>
      onAccountMachineConnectRequest((environmentIds) => {
        const shown = new Map(accountAutoConnectStates());
        // Saving needs the machine's entry on this Connect account; without
        // it (another account, not signed in) the caller pairs instead.
        if (environmentIds.some((id) => !discoveredRef.current.has(id))) return false;
        // A saved machine's Connect is about its address or approval: the caller's.
        if (environmentIds.some((id) => savedRef.current.has(id))) return false;
        const tailnet = new Set<string>(
          (snapshotRef.current?.machines ?? [])
            .filter((machine) => fleetMachineHasTailnetAddress(machine))
            .map((machine) => machine.environmentId),
        );
        for (const id of environmentIds) {
          // Connecting by hand undoes an earlier removal on this device. A
          // tailnet machine keeps its fleet skip, so the Tailscale pairing
          // does not race this Connect route.
          if (!tailnet.has(id)) setFleetEnvironmentSkipped(id as EnvironmentId, false);
          setConnectRouteDeclined(id, false);
          requested.current.add(id);
          // A try already running answers this press.
          if (!connectRouteAddsInFlight().has(id)) unanswered.current.add(id);
          shown.set(id, { phase: "connecting" });
        }
        // Says so at once, also while the account list is being read.
        publishAccountAutoConnectStates(shown);
        setTick((current) => current + 1);
        return true;
      }),
    [],
  );

  // An add by the reconciler's linked path ended: act on its result.
  useEffect(() => onConnectRouteAddsChange(() => setTick((current) => current + 1)), []);

  // Nothing stays published once this account signs out.
  useEffect(() => () => publishAccountAutoConnectStates(new Map()), []);

  useEffect(() => {
    // The list is empty while it is read again: keep what is published.
    if (discovery.refreshing) {
      sawRefresh.current = true;
      return;
    }
    const now = Date.now();
    for (const id of discovery.environments.keys()) onAccount.current.add(id);
    const savedEnvironmentIds = new Set<string>(environments.map((item) => item.environmentId));
    for (const id of requested.current)
      if (savedEnvironmentIds.has(id)) {
        requested.current.delete(id);
        unanswered.current.delete(id);
      }
    const linked = linkedMachineIds(projects);
    const candidates = grantedAccountMachinesToConnect({
      snapshot,
      currentEnvironmentId: primaryEnvironmentId,
      savedEnvironmentIds,
      discovered: discovery.environments,
      requested: requested.current,
    });
    const removed = new Set<string>([
      ...readSkippedFleetEnvironments(),
      ...readDeclinedConnectRoutes(),
    ]);
    const unreachable = discovery.error._tag === "Some" || discovery.offline;
    const next = new Map<string, AccountAutoConnectState>();
    let waiting = false;
    // Machines to save that wait for the account list to be read.
    const needList: string[] = [];
    for (const machine of candidates) {
      const id = machine.environmentId;
      const tried = attempts.current.get(id);
      // A press not acted on yet asks for one more try, now.
      const asked = unanswered.current.has(id);
      const detail = failures.current.get(id);
      const failure: AccountAutoConnectState | undefined = !failures.current.has(id)
        ? undefined
        : detail === undefined
          ? { phase: "failed", reason: CONNECT_FAILED_REASON }
          : { phase: "failed", reason: CONNECT_FAILED_REASON, detail };
      if (connectRouteAddsInFlight().has(id)) {
        next.set(id, { phase: "connecting" });
        continue;
      }
      if (unreachable) {
        next.set(id, { phase: "held", reason: CONNECT_UNREACHABLE_REASON });
        continue;
      }
      const automatic = autoConnect || linked.has(id);
      // Once a press has had its try, later holds (removed here, Connect
      // automatically off) apply again; a failure keeps saying why.
      if (!asked && (!automatic || removed.has(id))) {
        // A failed try keeps saying why, also while saving is held.
        next.set(
          id,
          failure !== undefined
            ? failure
            : {
                phase: "held",
                reason: removed.has(id) ? REMOVED_HERE_REASON : AUTO_CONNECT_OFF_REASON,
              },
        );
        continue;
      }
      // The list may still be the previous account's until it is read again.
      if (!sawRefresh.current) {
        next.set(id, { phase: "connecting" });
        needList.push(id);
        continue;
      }
      // At most MAX_ATTEMPTS tries a minute apart, also when a try reported
      // success but the catalog has not shown the machine saved.
      if (
        !asked &&
        tried !== undefined &&
        (tried.count >= MAX_ATTEMPTS || now - tried.at < RETRY_MS)
      ) {
        if (failure !== undefined) next.set(id, failure);
        else if (tried.count >= MAX_ATTEMPTS)
          next.set(id, {
            phase: "failed",
            reason: accepted.current.has(id) ? CONNECT_NOT_ADDED_REASON : CONNECT_NO_ANSWER_REASON,
          });
        else next.set(id, { phase: "connecting" });
        if (tried.count < MAX_ATTEMPTS) waiting = true;
        continue;
      }
      unanswered.current.delete(id);
      attempts.current.set(id, { count: (tried?.count ?? 0) + 1, at: now });
      setConnectRouteAddInFlight(id, true);
      next.set(id, { phase: "connecting" });
      void register(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({ environmentId: id, label: machine.label }),
        }),
      ).then((result) => {
        setConnectRouteAddInFlight(id, false);
        // An interrupted try counts as a try, so the wait and the cap still apply.
        if (result._tag === "Success") {
          failures.current.delete(id);
          accepted.current.add(id);
        } else if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          // The message is the relay's own, shown as a detail next to a translated reason.
          failures.current.set(
            id,
            cause instanceof Error && cause.message ? cause.message : undefined,
          );
        }
        setTick((current) => current + 1);
      });
    }
    // A failed read empties the account list: machines this app would save
    // still say why they wait, instead of falling back to a Tailscale pairing.
    if (unreachable)
      for (const machine of snapshot?.machines ?? []) {
        const id = machine.environmentId;
        if (
          next.has(id) ||
          id === primaryEnvironmentId ||
          savedEnvironmentIds.has(id) ||
          !onAccount.current.has(id) ||
          machine.status === "identity-mismatch" ||
          !fleetMachineGranted(machine) ||
          fleetMachineHasTailnetAddress(machine)
        )
          continue;
        next.set(id, { phase: "held", reason: CONNECT_UNREACHABLE_REASON });
      }
    publishAccountAutoConnectStates(next);

    // The account list is read again, at most MAX_LOOKUPS times a minute
    // apart per machine, only for machines this app would save: one the list
    // missed (it joined a moment ago, or this component mounted after the
    // sign-in read). A read empties every machine list for a moment, and a
    // machine on another account never shows, so never more than that.
    const missing = grantedMachinesMissingFromAccount({
      snapshot,
      currentEnvironmentId: primaryEnvironmentId,
      savedEnvironmentIds,
      discovered: discovery.environments,
    }).filter(
      (id) => !removed.has(id) && (autoConnect || linked.has(id) || requested.current.has(id)),
    );
    const fleetSign = new Map(
      (snapshot?.machines ?? []).map((machine) => [
        machine.environmentId as string,
        `${machine.status}:${machine.transport ?? ""}`,
      ]),
    );
    let readNow = false;
    if (!unreachable)
      for (const id of [...needList, ...missing]) {
        let looked = lookedUp.current.get(id);
        // Read again once how the fleet reaches it changes (it came online,
        // or now answers over Connect): it may have signed in to Connect.
        const sign = fleetSign.get(id) ?? "";
        if (looked !== undefined && looked.sign !== sign) {
          lookedUp.current.delete(id);
          looked = undefined;
        }
        if (looked !== undefined && looked.count >= MAX_LOOKUPS) continue;
        if (looked === undefined || now - looked.at >= RETRY_MS) {
          lookedUp.current.set(id, { count: (looked?.count ?? 0) + 1, at: now, sign });
          readNow = true;
        }
        if ((lookedUp.current.get(id)?.count ?? 0) < MAX_LOOKUPS) waiting = true;
      }
    setRetryPending(waiting);
    if (readNow) void refresh();
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
