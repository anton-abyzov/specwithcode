/**
 * The sidebar's project order lives in the host's server settings, so the
 * desktop app and every browser on that host share it. This browser keeps its
 * own copy too, and that copy is never thrown away for an empty host order:
 * an empty order means the host has never stored one, because it is new or
 * because it is an older service that drops the setting. The copy stands
 * until the host holds an order, and is sent to the host until it does.
 */
import { useAtomValue } from "@effect/atom-react";
import { EMPTY_SIDEBAR_PROJECT_ORDER, SidebarProjectOrder } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { useUpdatePrimarySettings } from "../hooks/useSettings";
import { primaryServerConfigAtom } from "../state/server";
import { sameProjectOrder } from "./projectOrder";

const LOCAL_ORDER_KEY = "studio:sidebar-project-order:v1";
/**
 * Pins saved by builds that kept them in this browser only. Read, never
 * removed: deleting them before the host had stored them lost them once.
 */
const LEGACY_PINS_KEY = "studio:sidebar-pinned-projects:v1";

const decodeLegacyPins = Schema.decodeUnknownSync(Schema.Array(Schema.String));

function readLegacyPins(): ReadonlyArray<string> {
  try {
    const raw = localStorage.getItem(LEGACY_PINS_KEY);
    return raw === null ? [] : decodeLegacyPins(JSON.parse(raw));
  } catch {
    return [];
  }
}

export const isEmptyProjectOrder = (order: SidebarProjectOrder) =>
  order.pinned.length === 0 && order.unpinned.length === 0;

/** The order to show: the host's once it holds one, otherwise this browser's. */
export function effectiveProjectOrder(
  hostOrder: SidebarProjectOrder | null,
  localOrder: SidebarProjectOrder,
  legacyPins: ReadonlyArray<string>,
): SidebarProjectOrder {
  if (hostOrder !== null && !isEmptyProjectOrder(hostOrder)) return hostOrder;
  if (!isEmptyProjectOrder(localOrder)) return localOrder;
  return legacyPins.length > 0 ? { pinned: legacyPins, unpinned: [] } : localOrder;
}

export function useSidebarProjectOrder(): readonly [
  SidebarProjectOrder,
  (next: SidebarProjectOrder) => void,
] {
  const hostOrder: SidebarProjectOrder | null =
    useAtomValue(primaryServerConfigAtom)?.settings?.sidebarProjectOrder ?? null;
  const updatePrimarySettings = useUpdatePrimarySettings();
  const [localOrder, setLocalOrder] = useLocalStorage(
    LOCAL_ORDER_KEY,
    EMPTY_SIDEBAR_PROJECT_ORDER,
    SidebarProjectOrder,
  );
  const legacyPins = useMemo(() => readLegacyPins(), []);
  const shown = effectiveProjectOrder(hostOrder, localOrder, legacyPins);
  // A move shows at once; the host's next settings snapshot replaces it.
  const [pending, setPending] = useState<{
    order: SidebarProjectOrder;
    base: SidebarProjectOrder | null;
  } | null>(null);
  if (pending !== null && hostOrder !== pending.base) setPending(null);

  const save = useCallback(
    (next: SidebarProjectOrder) => {
      setLocalOrder(next);
      if (hostOrder === null) return;
      setPending({ order: next, base: hostOrder });
      updatePrimarySettings({ sidebarProjectOrder: next });
    },
    [hostOrder, setLocalOrder, updatePrimarySettings],
  );

  // A host that holds an order refreshes this browser's copy.
  useEffect(() => {
    if (hostOrder !== null && !isEmptyProjectOrder(hostOrder)) {
      if (!sameProjectOrder(hostOrder, localOrder)) setLocalOrder(hostOrder);
    }
  }, [hostOrder, localOrder, setLocalOrder]);

  // A host with no order gets this browser's, once per settings snapshot. An
  // older service drops it again; the copy here keeps the pins meanwhile.
  const offeredTo = useRef<SidebarProjectOrder | null>(null);
  useEffect(() => {
    if (hostOrder === null || !isEmptyProjectOrder(hostOrder)) return;
    if (isEmptyProjectOrder(shown) || offeredTo.current === hostOrder) return;
    offeredTo.current = hostOrder;
    updatePrimarySettings({ sidebarProjectOrder: shown });
  }, [hostOrder, shown, updatePrimarySettings]);

  return [pending?.order ?? shown, save] as const;
}
