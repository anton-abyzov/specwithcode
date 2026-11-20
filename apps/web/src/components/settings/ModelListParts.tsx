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
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SourceStatus } from "@specweave-studio/shared/modelTrackRules";
import { GripVerticalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useTx } from "../../i18n";
import { cn } from "../../lib/utils";
import { clock } from "./FallbackOrderList";

type Tx = ReturnType<typeof useTx>;

/** The chip a source shows on a track row and in the Sources list. */
export function statusChip(
  status: SourceStatus,
  tx: Tx,
): { readonly label: string; readonly variant: "success" | "warning" | "outline" } {
  switch (status.state) {
    case "ready":
      return { label: tx("Ready"), variant: "success" };
    case "limited":
      return {
        label:
          status.until === null
            ? tx("Limit reached")
            : `${tx("Limit until")} ${clock(status.until)}`,
        variant: "warning",
      };
    case "sign-in":
      return { label: tx("Not signed in"), variant: "warning" };
    case "not-installed":
      return { label: tx("Not installed"), variant: "outline" };
    case "not-ready":
      return { label: tx("Not ready"), variant: "outline" };
    case "off":
      return { label: tx("Off"), variant: "outline" };
  }
}

/** A grip, a position and the row's content; the grip also reorders by keyboard. */
export function SortableRow(props: {
  readonly id: string;
  readonly position: number;
  readonly label: string;
  readonly locked?: boolean;
  readonly children: ReactNode;
}) {
  const tx = useTx();
  const sortable = useSortable({ id: props.id, disabled: props.locked === true });
  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        "flex items-center gap-2 border-b border-border/70 px-3 py-2 last:border-b-0",
        sortable.isDragging && "relative z-10 rounded-md bg-background shadow-md",
      )}
    >
      <button
        type="button"
        ref={sortable.setActivatorNodeRef}
        {...sortable.attributes}
        {...sortable.listeners}
        disabled={props.locked === true}
        aria-label={`${tx("Reorder")} ${props.label}, ${tx("position")} ${props.position}`}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">
        {props.position}
      </span>
      {props.children}
    </li>
  );
}

export function SortableList(props: {
  readonly label: string;
  readonly ids: ReadonlyArray<string>;
  readonly onMove: (from: number, to: number) => void;
  readonly children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (event: DragEndEvent) => {
    const from = props.ids.indexOf(String(event.active.id));
    const to = event.over === null ? -1 : props.ids.indexOf(String(event.over.id));
    if (from !== -1 && to !== -1 && from !== to) props.onMove(from, to);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={[...props.ids]} strategy={verticalListSortingStrategy}>
        <ol aria-label={props.label} className="flex flex-col">
          {props.children}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

export function Card(props: {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly control?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      id={props.id}
      aria-label={props.title}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-2.5">
        <h3 className="text-sm font-semibold">{props.title}</h3>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{props.hint}</p>
        {props.control}
      </header>
      {props.children}
    </section>
  );
}

export const Note = (props: { readonly tone?: "warning"; readonly children: ReactNode }) => (
  <p
    role={props.tone === "warning" ? "alert" : undefined}
    className={cn(
      "border-t border-border/70 px-3 py-2 text-xs",
      props.tone === "warning" ? "text-warning-foreground" : "text-muted-foreground",
    )}
  >
    {props.children}
  </p>
);
