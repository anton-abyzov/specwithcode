import {
  RELAY_ROUTE_ID,
  RelayConnectionRegistration,
  RelayConnectionTarget,
  connectionRouteId,
  connectionRoutes,
} from "@specweave-studio/client-runtime/connection";
import { useEffect, useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useEnvironments, useRelayEnvironmentDiscovery } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import {
  connectFirstRouteOrder,
  machinesMissingConnectRoute,
  readConnectRouteOffers,
  recordConnectRouteOffer,
} from "./connectRoutePlan";

const MAX_REORDER_ATTEMPTS = 3;

/**
 * While signed in to SpecWithCode Connect, gives every saved machine this
 * account reaches a Connect route, placed first so Tailscale and other direct
 * routes become fallbacks. Each machine gets this once per account on this
 * device, so a Connect route the user removes or moves stays that way. The
 * caller keys this by account.
 */
export function ConnectRouteReconciler({ accountId }: { readonly accountId: string }) {
  const { environments } = useEnvironments();
  const discovery = useRelayEnvironmentDiscovery();
  const register = useAtomCommand(environmentCatalog.register, {
    label: "Add SpecWithCode Connect route",
    reportFailure: false,
  });
  const reorder = useAtomCommand(environmentCatalog.reorderRoutes, {
    label: "Put SpecWithCode Connect first",
    reportFailure: false,
  });
  const offeredRef = useRef<Set<string> | null>(null);
  // The discovery list belongs to this account only after a refresh that
  // started once this account was active; before that it can still hold the
  // previous account's machines.
  const sawRefreshRef = useRef(false);
  const reorderAttemptsRef = useRef<Map<string, number>>(new Map());
  const [pendingOrder, setPendingOrder] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (discovery.refreshing) {
      sawRefreshRef.current = true;
      return;
    }
    if (!sawRefreshRef.current || discovery.error._tag === "Some" || discovery.offline) return;
    offeredRef.current ??= readConnectRouteOffers(accountId);
    const offered = offeredRef.current;
    for (const machine of machinesMissingConnectRoute(
      environments,
      discovery.environments,
      offered,
    )) {
      offered.add(machine.environmentId);
      recordConnectRouteOffer(accountId, offered);
      void register(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: machine.environmentId,
            label: machine.label,
          }),
        }),
      ).then((result) => {
        if (result._tag !== "Success") return;
        setPendingOrder((current) => new Set(current).add(machine.environmentId));
      });
    }
  }, [accountId, discovery, environments, register]);

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

  return null;
}
