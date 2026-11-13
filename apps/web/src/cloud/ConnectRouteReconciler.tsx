import {
  RELAY_ROUTE_ID,
  RelayConnectionRegistration,
  RelayConnectionTarget,
  connectionRouteId,
  connectionRoutes,
  hasRelayRoute,
} from "@specweave-studio/client-runtime/connection";
import { useEffect, useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useProjects } from "../state/entities";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  useRelayEnvironmentDiscovery,
} from "../state/environments";
import { relayEnvironmentDiscovery } from "../state/relay";
import { useAtomCommand } from "../state/use-atom-command";
import { usePrimaryFleetSnapshot } from "../studio/fleet";
import { readSkippedFleetEnvironments } from "../studio/fleetAutoConnect";
import {
  connectRouteAddsInFlight,
  grantedAccountMachinesToConnect,
  setConnectRouteAddInFlight,
} from "../studio/grantedAccountMachines";
import { linkedMachinesToConnect } from "../studio/linkedMachines";
import { GrantedAccountMachines } from "./GrantedAccountMachines";
import {
  connectFirstRouteOrder,
  isConnectRouteRemoving,
  machinesMissingConnectRoute,
  onConnectRouteRequest,
  readDeclinedConnectRoutes,
  setConnectRouteDeclined,
  unreachableMachines,
} from "./connectRoutePlan";

const MAX_REORDER_ATTEMPTS = 3;
const MAX_ADD_ATTEMPTS = 3;
/** How often the Connect list is re-read while a saved machine can't be reached. */
const UNREACHABLE_REFRESH_MS = 5 * 60_000;
/**
 * While signed in to SpecWithCode Connect, keeps a Connect route on every
 * saved machine this account reaches, placed first when it is added so
 * Tailscale and other direct routes become fallbacks. A route dropped by a
 * sign-out or a failed add comes back; only one the user removed from the
 * route list stays removed. A machine a shared project names but this device
 * never saved, such as the machine a handed-off project came from, is saved
 * with a Connect route, unless the user removed it here. Account machines
 * that allowed this one to run work on them are saved by
 * {@link GrantedAccountMachines}. The caller keys this by account.
 */
export function ConnectRouteReconciler() {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const discovery = useRelayEnvironmentDiscovery();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fleetSnapshot = usePrimaryFleetSnapshot(primaryEnvironmentId);
  const register = useAtomCommand(environmentCatalog.register, {
    label: "Add SpecWithCode Connect route",
    reportFailure: false,
  });
  const registerRequested = useAtomCommand(environmentCatalog.register, {
    label: "Add SpecWithCode Connect route",
  });
  const reorder = useAtomCommand(environmentCatalog.reorderRoutes, {
    label: "Put SpecWithCode Connect first",
    reportFailure: false,
  });
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    label: "Refresh SpecWithCode Connect machines",
    reportFailure: false,
  });
  const inFlightRef = useRef<Set<string>>(new Set());
  // Adds per machine this session. The registry accepts some machines without
  // adding a route (desktop-managed backends), so adds are capped.
  const addAttemptsRef = useRef<Map<string, number>>(new Map());
  // The discovery list belongs to this account only after a refresh that
  // started once this account was active; before that it can still hold the
  // previous account's machines.
  const sawRefreshRef = useRef(false);
  const reorderAttemptsRef = useRef<Map<string, number>>(new Map());
  const [pendingOrder, setPendingOrder] = useState<ReadonlySet<string>>(() => new Set());
  // Bumped when the user asks for Connect routes from the Connections banner,
  // so the add runs now and gets fresh attempts.
  const [requests, setRequests] = useState(0);
  // Machines the user asked for: a failed add is reported, not retried silently.
  const requestedRef = useRef<Set<string>>(new Set());
  useEffect(
    () =>
      onConnectRouteRequest((environmentIds) => {
        for (const environmentId of environmentIds) addAttemptsRef.current.delete(environmentId);
        for (const environmentId of environmentIds) requestedRef.current.add(environmentId);
        setRequests((current) => current + 1);
        // A fresh listing for this account, so the add runs even if this
        // component missed the refresh that filled the current list.
        void refreshDiscovery();
      }),
    [refreshDiscovery],
  );

  useEffect(() => {
    if (discovery.refreshing) {
      sawRefreshRef.current = true;
      return;
    }
    if (!sawRefreshRef.current || discovery.error._tag === "Some" || discovery.offline) return;
    const declined = readDeclinedConnectRoutes();
    // A Connect route present again (added back by hand) lifts an earlier removal.
    for (const machine of environments) {
      if (
        declined.has(machine.environmentId) &&
        hasRelayRoute(machine.entry) &&
        !isConnectRouteRemoving(machine.environmentId)
      ) {
        setConnectRouteDeclined(machine.environmentId, false);
        declined.delete(machine.environmentId);
      }
    }
    const exhausted = [...addAttemptsRef.current]
      .filter(([, attempts]) => attempts >= MAX_ADD_ATTEMPTS)
      .map(([id]) => id);
    const skip = new Set([...declined, ...inFlightRef.current, ...exhausted]);
    for (const machine of machinesMissingConnectRoute(environments, discovery.environments, skip)) {
      inFlightRef.current.add(machine.environmentId);
      addAttemptsRef.current.set(
        machine.environmentId,
        (addAttemptsRef.current.get(machine.environmentId) ?? 0) + 1,
      );
      const requested = requestedRef.current.delete(machine.environmentId);
      void (requested ? registerRequested : register)(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: machine.environmentId,
            label: machine.label,
          }),
        }),
      ).then((result) => {
        // A failed add is tried again on the next catalog or discovery change,
        // up to MAX_ADD_ATTEMPTS.
        inFlightRef.current.delete(machine.environmentId);
        if (result._tag !== "Success") return;
        reorderAttemptsRef.current.delete(machine.environmentId);
        setPendingOrder((current) => new Set(current).add(machine.environmentId));
      });
    }
    // Linked machines this device has no entry for: Connect is their only route here.
    const savedEnvironmentIds = new Set<string>(
      environments.map((machine) => machine.environmentId),
    );
    // A linked machine that also allowed this one is saved by GrantedAccountMachines.
    const granted = grantedAccountMachinesToConnect({
      snapshot: fleetSnapshot,
      currentEnvironmentId: primaryEnvironmentId,
      savedEnvironmentIds,
      discovered: discovery.environments,
    }).map((machine) => machine.environmentId);
    const linked = linkedMachinesToConnect({
      projects,
      savedEnvironmentIds,
      discovered: discovery.environments,
      skip: new Set([
        ...skip,
        ...readSkippedFleetEnvironments(),
        ...granted,
        ...connectRouteAddsInFlight(),
      ]),
    });
    for (const machine of linked) {
      inFlightRef.current.add(machine.environmentId);
      setConnectRouteAddInFlight(machine.environmentId, true);
      addAttemptsRef.current.set(
        machine.environmentId,
        (addAttemptsRef.current.get(machine.environmentId) ?? 0) + 1,
      );
      void register(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: machine.environmentId,
            label: machine.label,
          }),
        }),
      ).then(() => {
        inFlightRef.current.delete(machine.environmentId);
        setConnectRouteAddInFlight(machine.environmentId, false);
      });
    }
  }, [
    discovery,
    environments,
    fleetSnapshot,
    primaryEnvironmentId,
    projects,
    register,
    registerRequested,
    requests,
  ]);

  // Reorder once the catalog shows the new route, so the order lists every route.
  useEffect(() => {
    for (const machine of environments) {
      if (!pendingOrder.has(machine.environmentId)) continue;
      const attempts = reorderAttemptsRef.current.get(machine.environmentId) ?? 0;
      if (attempts < 0 || attempts >= MAX_REORDER_ATTEMPTS) continue;
      const current = connectionRoutes(machine.entry).map((route) =>
        connectionRouteId(route.target),
      );
      if (!current.includes(RELAY_ROUTE_ID)) continue;
      const order = connectFirstRouteOrder(machine.entry);
      if (order.every((id, index) => id === current[index])) {
        reorderAttemptsRef.current.set(machine.environmentId, -1);
        continue;
      }
      reorderAttemptsRef.current.set(machine.environmentId, attempts + 1);
      // A failed reorder (routes learned in between) is tried again on the
      // next catalog change, up to MAX_REORDER_ATTEMPTS.
      void reorder({ environmentId: machine.environmentId, routeIds: order }).then((result) => {
        if (result._tag === "Success") reorderAttemptsRef.current.set(machine.environmentId, -1);
      });
    }
  }, [environments, pendingOrder, reorder]);

  // Machines linked to Connect later (or whose list failed to load) are found
  // without a sign-out: re-read the list while any saved machine is unreachable.
  const anyUnreachable =
    unreachableMachines(
      environments.filter((machine) => machine.entry.target._tag !== "PrimaryConnectionTarget"),
    ).length > 0;
  useEffect(() => {
    if (!anyUnreachable) return;
    const timer = setInterval(() => void refreshDiscovery(), UNREACHABLE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [anyUnreachable, refreshDiscovery]);

  return <GrantedAccountMachines />;
}
