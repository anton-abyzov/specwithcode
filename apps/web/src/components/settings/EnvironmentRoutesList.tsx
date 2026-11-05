import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  RELAY_ROUTE_ID,
  type ConnectionRoute,
  connectionRouteAddress,
  connectionRouteId,
  connectionRouteLabel,
  connectionRoutes,
  isLearned,
} from "@specweave-studio/client-runtime/connection";
import { GripVerticalIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { beginConnectRouteRemoval, endConnectRouteRemoval } from "~/cloud/connectRoutePlan";
import { requestConfirmDialog } from "~/confirmDialog";
import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The ways this client reaches one saved machine, preferred first. Drag to
 * reorder; the first route that answers is used and the connection moves back
 * up when a better one is reachable again. Shown under the machine's row.
 */
export function EnvironmentRoutesList({
  environment,
  destinationLabel = environment.label,
  onAddRoute,
}: {
  readonly environment: EnvironmentPresentation;
  readonly destinationLabel?: string;
  readonly onAddRoute: () => void;
}) {
  const tx = useTx();
  const saved = connectionRoutes(environment.entry);
  const savedIds = saved.map((route) => connectionRouteId(route.target));
  // A dropped order shows until the catalog matches it, so the row does not
  // jump back while the reorder is being saved.
  const [pending, setPending] = useState<ReadonlyArray<string> | null>(null);
  const order: Array<string> =
    pending !== null &&
    pending.length === savedIds.length &&
    pending.some((id, index) => id !== savedIds[index])
      ? [...pending]
      : savedIds;
  const byId = new Map(saved.map((route) => [connectionRouteId(route.target), route]));
  const routes = order.flatMap((id) => byId.get(id) ?? []);

  const prepared = usePreparedConnection(environment.environmentId);
  const activeRouteId =
    prepared._tag === "Some" && environment.connection.phase === "connected"
      ? connectionRouteId(prepared.value.target)
      : null;
  const reorder = useAtomCommand(environmentCatalog.reorderRoutes, "Reorder routes");
  const removeRoute = useAtomCommand(environmentCatalog.removeRoute, "Remove route");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Removing a paired route forgets its credential, so it asks first, like
  // on mobile. No mounted confirm host means no removal.
  const confirmRemove = async (route: ConnectionRoute) => {
    const address = connectionRouteAddress(route);
    const confirmed = await requestConfirmDialog(
      `Remove ${connectionRouteLabel(route)} route?${address === null ? "" : `\n${address}`}`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    const routeId = connectionRouteId(route.target);
    // Removing Connect by hand keeps it removed; the automatic Connect route skips this
    // machine. The removal is recorded first so the catalog update can't race it.
    const isConnect = routeId === RELAY_ROUTE_ID;
    if (isConnect) beginConnectRouteRemoval(environment.environmentId);
    const result = await removeRoute({ environmentId: environment.environmentId, routeId });
    if (isConnect) endConnectRouteRemoval(environment.environmentId, result._tag === "Success");
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const next = arrayMove(
      order,
      order.indexOf(String(event.active.id)),
      order.indexOf(String(event.over.id)),
    );
    setPending(next);
    void reorder({ environmentId: environment.environmentId, routeIds: next }).then((result) => {
      if (result._tag === "Failure") setPending(null);
    });
  };

  return (
    <div className="mt-2 rounded-md border border-border/70">
      <div className="border-b border-border/70 p-3 text-xs">
        <p className="font-medium">
          {renderRich(tx("Connection paths to {destinationLabel}"), {
            destinationLabel: destinationLabel,
          })}
        </p>
        <p className="mt-1 text-muted-foreground">
          {tx(
            "Tried in preference order. If one cannot connect, another is tried. Drag to change the order. An address may forward through another machine; the destination identity must still match.",
          )}
        </p>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <ol aria-label={`Routes to ${environment.label}, preferred first`}>
            {routes.map((route, index) => (
              <SortableRouteRow
                key={connectionRouteId(route.target)}
                route={route}
                destinationLabel={destinationLabel}
                position={index + 1}
                inUse={connectionRouteId(route.target) === activeRouteId}
                // The last route goes with the machine; that is "Remove from
                // this device", not a route action. A learned route would be
                // learned again, so it is only reordered.
                removable={routes.length > 1 && !isLearned(route)}
                onRemove={() => void confirmRemove(route)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <div className="border-t border-border/70 px-1 py-1">
        <Button size="xs" variant="ghost-muted" onClick={onAddRoute}>
          <PlusIcon className="size-3" />
          {tx("Add connection path")}
        </Button>
      </div>
    </div>
  );
}

function SortableRouteRow({
  route,
  destinationLabel,
  position,
  inUse,
  removable,
  onRemove,
}: {
  readonly route: ConnectionRoute;
  readonly destinationLabel: string;
  readonly position: number;
  readonly inUse: boolean;
  readonly removable: boolean;
  readonly onRemove: () => void;
}) {
  const tx = useTx();
  const id = connectionRouteId(route.target);
  const label = connectionRouteLabel(route);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 border-b border-border/70 px-1 py-1.5 last:border-b-0",
        isDragging && "relative z-10 rounded-md bg-background shadow-md",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${label}, position ${position}`}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <ConnectionPathDetails
        route={route}
        destinationLabel={destinationLabel}
        position={position}
        inUse={inUse}
      />
      {removable ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Remove ${label} route`}
                onClick={onRemove}
              />
            }
          >
            <XIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">{tx("Remove route")}</TooltipPopup>
        </Tooltip>
      ) : null}
    </li>
  );
}

/** A saved address is not proof of reachability; only the active session verifies identity. */
export function ConnectionPathDetails({
  route,
  destinationLabel,
  position,
  inUse,
}: {
  readonly route: ConnectionRoute;
  readonly destinationLabel: string;
  readonly position: number;
  readonly inUse: boolean;
}) {
  const tx = useTx();
  const address = connectionRouteAddress(route);
  return (
    <div className="min-w-0 flex-1 py-1">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-foreground">
        <span>
          {position}. {connectionRouteLabel(route)}
        </span>
        <span
          className={cn(
            "text-2xs font-normal",
            inUse ? "text-success-foreground" : "text-muted-foreground",
          )}
        >
          {inUse ? tx("In use") : tx("Saved alternative")}
        </span>
      </p>
      <p className="mt-1 text-xs">
        {inUse ? tx("Connected to") : tx("Destination")}: {destinationLabel}
      </p>
      {address !== null && (
        <p className="mt-1 break-all text-2xs text-muted-foreground">
          {renderRich(tx("Address: {address}"), { address: address })}
        </p>
      )}
      <p className="mt-1 text-2xs text-muted-foreground">
        {inUse
          ? tx("Identity verified by the current connection.")
          : tx(
              "Used when selected by connection order and availability. Identity checked when connecting.",
            )}
        {isLearned(route) ? tx(" Found automatically.") : ""}
      </p>
    </div>
  );
}
