/**
 * The sidebar's Projects list: pinned projects, a divider, then the rest. A
 * project is dragged to a new place the way a Finder sidebar item is: it lifts
 * under the pointer, an insertion line shows where it lands, the list scrolls
 * near its edges and the row settles into place. Dropping it across the
 * divider pins or unpins it. Option+Command+Up/Down (Ctrl+Alt elsewhere) and
 * the row menu move it one place without a pointer.
 */
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import {
  PERSONAL_ASSISTANT_DESCRIPTION,
  PERSONAL_ASSISTANT_LABEL,
} from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { isMacPlatform } from "~/lib/utils";
import { createSidebarListMotion } from "../../Sidebar.motion";
import { ProjectFavicon } from "../../ProjectFavicon";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../../ui/menu";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import { coordinatorMachineKey } from "../../../studio/projectCoordinatorMachine";
import type { ArrangedProjects, ProjectDropTarget } from "../../../studio/projectOrder";
import { Tip } from "./Tip";
import { requestProjectSettings } from "../../../studio/projectSettingsRequests";

// Environments without matchMedia (tests, some embeds) get no motion at all.
const canAnimate = () => typeof window !== "undefined" && typeof window.matchMedia === "function";
const prefersReducedMotion = () =>
  !canAnimate() || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// A slight overshoot, like an AppKit item settling into its slot.
const SETTLE: DropAnimation = { duration: 280, easing: "cubic-bezier(0.32, 1.36, 0.6, 1)" };

const isMac = () => typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
const MOVE_SHORTCUT = { up: isMac() ? "⌥⌘↑" : "Ctrl+Alt+↑", down: isMac() ? "⌥⌘↓" : "Ctrl+Alt+↓" };

/** The step a keydown asks for: Option+Command+arrow on a Mac, Ctrl+Alt+arrow elsewhere. */
export function projectMoveKey(event: {
  key: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): "up" | "down" | null {
  if (!event.altKey || event.shiftKey) return null;
  if (isMac() ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  return event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : null;
}

export interface ProjectRowState {
  displayedProject: SidebarProjectGroupMember | undefined;
  archived: boolean;
  waiting: number;
  current: boolean;
  /** Tells this project apart from another listed under the same name. */
  hint?: string | undefined;
}

interface Insertion {
  target: ProjectDropTarget;
  /** The line's offset from the list's top edge. */
  top: number;
}

export function SidebarProjectList(props: {
  /** The rows shown, each group in order; collapsed lists leave some out. */
  visible: ArrangedProjects<SidebarProjectSnapshot>;
  /** Every listed project's key, each group in order. */
  listedKeys: ArrangedProjects<string>;
  rowState: (group: SidebarProjectSnapshot) => ProjectRowState;
  onOpen: () => void;
  onMove: (projectKey: string, target: ProjectDropTarget) => void;
  onStep: (projectKey: string, direction: "up" | "down") => void;
  canStep: (projectKey: string, direction: "up" | "down") => boolean;
  onPin: (projectKey: string) => void;
  onArchive: (group: SidebarProjectSnapshot, archived: boolean) => void;
}) {
  const { visible, listedKeys } = props;
  const listRef = useRef<HTMLUListElement | null>(null);
  const motionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [insertion, setInsertion] = useState<Insertion | null>(null);
  const insertionRef = useRef<Insertion | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // The click that ends a drag must not also open the project.
  const suppressClick = useRef(false);
  const clickSuppressed = useCallback(() => suppressClick.current, []);
  const focusAfterMove = useRef<string | null>(null);
  // A touch has to rest on a row first, so swiping still scrolls the list.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
  );

  const setListNode = useCallback((node: HTMLUListElement | null) => {
    listRef.current = node;
    motionRef.current?.dispose();
    motionRef.current = node === null || !canAnimate() ? null : createSidebarListMotion(node);
    motionRef.current?.update(false);
  }, []);
  // Rows that change places glide there; reduced motion makes them jump.
  useLayoutEffect(() => {
    motionRef.current?.update(true);
    const key = focusAfterMove.current;
    if (key === null) return;
    focusAfterMove.current = null;
    rowNode(listRef.current, key)?.querySelector<HTMLElement>(".sws-side-row")?.focus();
  });

  const allVisible = [...visible.pinned, ...visible.unpinned];
  const dragged = dragKey ? allVisible.find((group) => group.projectKey === dragKey) : undefined;
  const nameOf = (projectKey: string) => {
    const group = allVisible.find((entry) => entry.projectKey === projectKey);
    return group ? displayNameOf(group, props.rowState(group).displayedProject) : projectKey;
  };
  const describe = (projectKey: string, target: ProjectDropTarget) => {
    const group = target.pinned ? listedKeys.pinned : listedKeys.unpinned;
    const others = group.filter((key) => key !== projectKey);
    const index = target.beforeKey === null ? others.length : others.indexOf(target.beforeKey);
    return `${nameOf(projectKey)} moved to ${target.pinned ? "pinned" : "projects"}, position ${index + 1} of ${others.length + 1}`;
  };

  const locate = (event: DragMoveEvent): Insertion | null => {
    const list = listRef.current;
    const start = event.activatorEvent as (MouseEvent & TouchEvent) | null;
    const startY = start?.touches?.[0]?.clientY ?? start?.clientY;
    if (!list || typeof startY !== "number") return null;
    const y = startY + event.delta.y;
    const origin = list.getBoundingClientRect().top;
    const divider = list.querySelector<HTMLElement>("[data-project-divider]");
    const dividerRect = divider?.getBoundingClientRect();
    const pinned = dividerRect !== undefined && y < dividerRect.top + dividerRect.height / 2;
    const groupKeys = pinned ? listedKeys.pinned : listedKeys.unpinned;
    const rows = (pinned ? visible.pinned : visible.unpinned)
      .map((group) => group.projectKey)
      .flatMap((key) => {
        const node = rowNode(list, key);
        return node ? [{ key, rect: node.getBoundingClientRect() }] : [];
      });
    const below = rows.find((row) => y < row.rect.top + row.rect.height / 2);
    if (below) {
      return { target: { pinned, beforeKey: below.key }, top: below.rect.top - origin };
    }
    const last = rows.at(-1);
    if (!last) {
      // An empty group: the divider is the place to drop.
      const top = dividerRect ? dividerRect.top + dividerRect.height / 2 - origin : 0;
      return { target: { pinned, beforeKey: pinned ? null : (groupKeys[0] ?? null) }, top };
    }
    // After the last row shown, before the next listed one that the collapsed list hides.
    const next = groupKeys.slice(groupKeys.indexOf(last.key) + 1).find((key) => key !== dragKey);
    return { target: { pinned, beforeKey: next ?? null }, top: last.rect.bottom - origin };
  };

  const onDragStart = (event: DragStartEvent) => {
    setDragKey(String(event.active.id));
    setAnnouncement(`Picked up ${nameOf(String(event.active.id))}`);
  };
  const onDragMove = (event: DragMoveEvent) => {
    const next = locate(event);
    insertionRef.current = next;
    setInsertion((current) =>
      current?.top === next?.top && current?.target.pinned === next?.target.pinned ? current : next,
    );
  };
  const onDragEnd = (event: DragEndEvent) => {
    const key = String(event.active.id);
    const target = insertionRef.current?.target ?? null;
    setDragKey(null);
    setInsertion(null);
    insertionRef.current = null;
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    if (target === null || target.beforeKey === key) {
      setAnnouncement(`${nameOf(key)} dropped`);
      return;
    }
    props.onMove(key, target);
    setAnnouncement(describe(key, target));
  };
  const onDragCancel = () => {
    setDragKey(null);
    setInsertion(null);
    insertionRef.current = null;
  };

  const step = (projectKey: string, direction: "up" | "down") => {
    if (!props.canStep(projectKey, direction)) return;
    focusAfterMove.current = projectKey;
    props.onStep(projectKey, direction);
    setAnnouncement(`${nameOf(projectKey)} moved ${direction}`);
  };
  const onRowKeyDown = (projectKey: string, event: KeyboardEvent) => {
    const direction = projectMoveKey(event);
    if (direction === null) return;
    event.preventDefault();
    event.stopPropagation();
    step(projectKey, direction);
  };

  const renderRow = (group: SidebarProjectSnapshot, pinned: boolean): ReactNode => (
    <ProjectRow
      key={group.projectKey}
      group={group}
      {...props.rowState(group)}
      sortable
      pinned={pinned}
      dragging={group.projectKey === dragKey}
      onOpen={props.onOpen}
      clickSuppressed={clickSuppressed}
      onKeyDown={(event) => onRowKeyDown(group.projectKey, event)}
      onPin={() => props.onPin(group.projectKey)}
      onArchive={(archived) => props.onArchive(group, archived)}
      onStep={(direction) => step(group.projectKey, direction)}
      canStep={(direction) => props.canStep(group.projectKey, direction)}
    />
  );
  // The divider exists while something is pinned, and during a drag so the
  // first project can be dropped above it to pin it.
  const showDivider = visible.pinned.length > 0 || dragKey !== null;
  const reducedMotion = prefersReducedMotion();

  return (
    <DndContext
      sensors={sensors}
      autoScroll={{ threshold: { x: 0, y: 0.12 }, acceleration: 12 }}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
      accessibility={{ screenReaderInstructions: { draggable: "" } }}
    >
      <div className="sws-project-list" data-dragging={dragKey !== null || undefined}>
        <ul ref={setListNode} className="sws-side-list" aria-label="Projects">
          {visible.pinned.map((group) => renderRow(group, true))}
          {showDivider ? (
            <li
              role="presentation"
              className="sws-project-pin-divider"
              data-project-divider
              data-empty={visible.pinned.length === 0 || undefined}
            >
              {visible.pinned.length === 0 ? <span>Drop here to pin</span> : null}
            </li>
          ) : null}
          {visible.unpinned.map((group) => renderRow(group, false))}
        </ul>
        {insertion ? (
          <div
            aria-hidden
            className="sws-project-insertion"
            style={{ transform: `translateY(${insertion.top}px)` }}
          />
        ) : null}
      </div>
      <DragOverlay dropAnimation={reducedMotion ? null : SETTLE}>
        {dragged ? (
          <div className="sws-project-lifted" data-reduced-motion={reducedMotion || undefined}>
            <ProjectFavicon
              project={props.rowState(dragged).displayedProject ?? dragged}
              className="size-[18px] shrink-0"
            />
            <span className="sws-side-row-label">
              {displayNameOf(dragged, props.rowState(dragged).displayedProject)}
            </span>
          </div>
        ) : null}
      </DragOverlay>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </DndContext>
  );
}

function rowNode(list: HTMLElement | null, projectKey: string): HTMLElement | null {
  return list?.querySelector<HTMLElement>(`[data-project-key="${CSS.escape(projectKey)}"]`) ?? null;
}

export function displayNameOf(
  group: SidebarProjectSnapshot,
  displayedProject: SidebarProjectGroupMember | undefined,
): string {
  // A logical project keeps the group's name; otherwise the checkout's own title shows.
  return group.memberProjects.some((member) => member.workspaceSettings?.logicalProject)
    ? group.displayName
    : (displayedProject?.title ?? group.displayName);
}

function isPersonalGroup(group: SidebarProjectSnapshot): boolean {
  return group.memberProjects.some((member) => member.workspaceSettings?.kind === "personal");
}

/** One project in the Projects list, with its move, pin and archive actions. */
export function ProjectRow(props: {
  group: SidebarProjectSnapshot;
  displayedProject: SidebarProjectGroupMember | undefined;
  archived: boolean;
  /** Absent in the archived list, which keeps no order. */
  pinned?: boolean;
  dragging?: boolean;
  waiting: number;
  current: boolean;
  hint?: string | undefined;
  onOpen: () => void;
  onPin?: () => void;
  onStep?: (direction: "up" | "down") => void;
  canStep?: (direction: "up" | "down") => boolean;
  onArchive: (archived: boolean) => void;
  /** Rows of the main list can be dragged; archived rows keep no order. */
  sortable?: boolean;
  onKeyDown?: (event: KeyboardEvent) => void;
  clickSuppressed?: () => boolean;
}) {
  const { group, archived, pinned } = props;
  // An archived project never asks for attention from the sidebar.
  const waiting = archived ? 0 : props.waiting;
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: group.projectKey,
    disabled: !props.sortable,
  });
  // dnd-kit's own role and keyboard handling would turn the row into a button.
  const { role: _role, tabIndex: _tabIndex, ...dragAttributes } = attributes;
  // The group keeps repository identity; its visible name and icon belong to
  // the checkout the workspace opens, including an explicit remote checkout.
  const project = props.displayedProject ?? group;
  const displayName = displayNameOf(group, props.displayedProject);
  const personal = isPersonalGroup(group);
  return (
    <li
      ref={setNodeRef}
      {...(props.sortable ? { ...dragAttributes, ...listeners } : {})}
      onKeyDown={props.onKeyDown}
      onClickCapture={(event) => {
        if (props.clickSuppressed?.()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      className="sws-project-row"
      data-project-key={group.projectKey}
      data-archived={archived || undefined}
      data-pinned={pinned || undefined}
      data-dragging={props.dragging || undefined}
    >
      <Tip
        side="right"
        label={
          personal
            ? `${displayName} · ${PERSONAL_ASSISTANT_LABEL}: ${PERSONAL_ASSISTANT_DESCRIPTION}`
            : `${displayName} · ${project.workspaceRoot}${archived ? " · Archived" : ""}`
        }
      >
        <Link
          to="/projects/$projectKey"
          params={{ projectKey: group.projectKey }}
          search={
            props.displayedProject && !props.displayedProject.workspaceSettings?.logicalProject
              ? { checkout: coordinatorMachineKey(props.displayedProject) }
              : {}
          }
          className="sws-side-row"
          aria-current={props.current ? "page" : undefined}
          draggable={false}
          onClick={props.onOpen}
          // A double click opens the project's settings with the name ready to edit.
          onMouseDown={(event) => {
            if (event.detail > 1) event.preventDefault();
          }}
          onDoubleClick={(event) => {
            if (props.clickSuppressed?.()) return;
            event.preventDefault();
            requestProjectSettings(group.projectKey);
          }}
        >
          <ProjectFavicon project={project} className="size-[18px] shrink-0" />
          <span className="sws-side-row-label">{displayName}</span>
          {props.hint ? (
            <span className="sws-side-row-hint sws-side-row-namesake">{props.hint}</span>
          ) : null}
          {pinned ? <PinIcon className="sws-side-row-pin" aria-label="Pinned" role="img" /> : null}
          {/* A fixed slot, so a count never shifts the name or hint, and the row
              menu takes its place on hover. */}
          <span className="sws-side-row-end">
            {waiting > 0 ? (
              <span className="sws-count sws-count-waiting">
                {waiting}
                <span className="sr-only"> waiting on you</span>
              </span>
            ) : null}
          </span>
        </Link>
      </Tip>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              className="sws-icon-button sws-chat-menu"
              aria-label={`Actions for ${displayName}`}
            />
          }
        >
          <MoreHorizontalIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="start" side="bottom">
          {props.onPin ? (
            <MenuItem onClick={props.onPin}>
              {pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
              {pinned ? "Unpin project" : "Pin project"}
            </MenuItem>
          ) : null}
          {props.onStep ? (
            <>
              <MenuItem disabled={!props.canStep?.("up")} onClick={() => props.onStep?.("up")}>
                <ArrowUpIcon aria-hidden />
                Move up
                <MenuShortcut>{MOVE_SHORTCUT.up}</MenuShortcut>
              </MenuItem>
              <MenuItem disabled={!props.canStep?.("down")} onClick={() => props.onStep?.("down")}>
                <ArrowDownIcon aria-hidden />
                Move down
                <MenuShortcut>{MOVE_SHORTCUT.down}</MenuShortcut>
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <MenuItem onClick={() => props.onArchive(!archived)}>
            <ArchiveIcon aria-hidden />
            {archived ? "Restore project" : "Archive project"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </li>
  );
}
