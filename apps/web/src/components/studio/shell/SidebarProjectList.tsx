import { useProjectReturnSearch } from "../../../studio/projectReturnNavigation";
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
  type EnvironmentId,
  type ProjectId,
  type ProjectOrigin,
} from "@specweave-studio/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BellIcon,
  BellOffIcon,
  BotIcon,
  BotOffIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { isMacPlatform } from "~/lib/utils";
import { createSidebarListMotion } from "../../Sidebar.motion";
import { ProjectFavicon } from "../../ProjectFavicon";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import {
  PROJECT_NOTIFICATION_LEVEL_COPY,
  PROJECT_NOTIFICATION_LEVELS,
  projectShowsWaitingCount,
  type ProjectNotificationLevel,
} from "@specweave-studio/shared/projectNotifications";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import { coordinatorMachineKey } from "../../../studio/projectCoordinatorMachine";
import { useMachineNicknames } from "../../../studio/machineNickname";
import { copyRolesSummary } from "../../../studio/projectDomain";
import type { ArrangedProjects, ProjectDropTarget } from "../../../studio/projectOrder";
import { isScratchMember, type ScratchRootLookup } from "../../../studio/projectListVisibility";
import { Tip } from "./Tip";
import { requestProjectSettings } from "../../../studio/projectSettingsRequests";
import type { ProjectNameCheck } from "../../../studio/projectRename";

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
  attentionLabel?: string | undefined;
  attentionComplete?: boolean | undefined;
  current: boolean;
  /** Tells this project apart from another listed under the same name. */
  hint?: string | undefined;
  rename?: ProjectRename | undefined;
  /** The project the Designs item opens; absent where the row has no Designs item. */
  designsProjectId?: ProjectId | undefined;
  /** True for a project a check or agent made for itself; see projectOrigin. */
  automated?: boolean | undefined;
  /** The project's notification level; absent where the row has no Notifications item. */
  notifications?: ProjectNotificationLevel | undefined;
}

/** Renames a project in place: `check` validates a draft, `commit` saves it or says why not. */
export interface ProjectRename {
  check: (draft: string) => ProjectNameCheck;
  commit: (name: string) => Promise<string | null>;
}

interface Insertion {
  target: ProjectDropTarget;
  /** The line's offset from the list's top edge. */
  top: number;
}

// Outside the component: the React Compiler cannot compile optional chains in
// a logical test, and would skip the whole list.
function sameInsertion(a: Insertion | null, b: Insertion | null): boolean {
  if (a === null || b === null) return a === b;
  return a.top === b.top && a.target.pinned === b.target.pinned;
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
  onOriginChange?: ((group: SidebarProjectSnapshot, origin: ProjectOrigin) => void) | undefined;
  onNotificationsChange?:
    | ((group: SidebarProjectSnapshot, level: ProjectNotificationLevel) => void)
    | undefined;
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

  // Fetch the project page's code once the window is idle, so the first project
  // opened does not wait for it after the click.
  const router = useRouter();
  useEffect(() => {
    const route = router.routesById["/projects/$projectKey"];
    if (!route) return;
    const load = () => void Promise.resolve(router.loadRouteChunk(route)).catch(() => undefined);
    if (typeof requestIdleCallback !== "function") {
      const timer = setTimeout(load, 1_000);
      return () => clearTimeout(timer);
    }
    const idle = requestIdleCallback(load, { timeout: 3_000 });
    return () => cancelIdleCallback(idle);
  }, [router]);

  const setListNode = useCallback((node: HTMLUListElement | null) => {
    listRef.current = node;
    motionRef.current?.dispose();
    motionRef.current = node === null || !canAnimate() ? null : createSidebarListMotion(node);
    motionRef.current?.update(false);
  }, []);
  // Rows that change places glide there; reduced motion makes them jump. Rows
  // move only when the order changes; measuring them after every render forced
  // a layout of the whole window each time the open project changed.
  const rowOrder = [
    ...visible.pinned.map((group) => group.projectKey),
    "",
    ...visible.unpinned.map((group) => group.projectKey),
  ].join("\n");
  useLayoutEffect(() => {
    motionRef.current?.update(true);
    const key = focusAfterMove.current;
    if (key === null) return;
    focusAfterMove.current = null;
    rowNode(listRef.current, key)?.querySelector<HTMLElement>(".sws-side-row")?.focus();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Measures only when rows reorder.
  }, [rowOrder]);

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
    setInsertion((current) => (sameInsertion(current, next) ? current : next));
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
      {...(props.onOriginChange
        ? { onOriginChange: (origin: ProjectOrigin) => props.onOriginChange?.(group, origin) }
        : {})}
      {...(props.onNotificationsChange
        ? {
            onNotificationsChange: (level: ProjectNotificationLevel) =>
              props.onNotificationsChange?.(group, level),
          }
        : {})}
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

/**
 * The project whose designs the row's Designs item shows: the group's checkout on
 * the primary environment, preferring the one the row displays. A scratch folder
 * and a project with no checkout there have none.
 */
export function designsProjectId(
  group: SidebarProjectSnapshot,
  displayedProject: SidebarProjectGroupMember | undefined,
  primaryEnvironmentId: EnvironmentId | null,
  scratchRootFor: ScratchRootLookup,
): ProjectId | undefined {
  if (primaryEnvironmentId === null) return undefined;
  const candidates = group.memberProjects.filter(
    (member) =>
      member.environmentId === primaryEnvironmentId && !isScratchMember(member, scratchRootFor),
  );
  const displayed = candidates.find(
    (member) =>
      member.id === displayedProject?.id && member.environmentId === displayedProject.environmentId,
  );
  return (displayed ?? candidates[0])?.id;
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
  attentionLabel?: string | undefined;
  attentionComplete?: boolean | undefined;
  current: boolean;
  hint?: string | undefined;
  onOpen: () => void;
  onPin?: () => void;
  onStep?: (direction: "up" | "down") => void;
  canStep?: (direction: "up" | "down") => boolean;
  onArchive: (archived: boolean) => void;
  /** Moves the project to or from the Automated list; absent where it cannot move. */
  onOriginChange?: ((origin: ProjectOrigin) => void) | undefined;
  /** True for a project a check or agent made for itself; see projectOrigin. */
  automated?: boolean | undefined;
  /** The project's notification level; see projectNotifications. */
  notifications?: ProjectNotificationLevel | undefined;
  /** Saves a new level; absent where the row has no Notifications item. */
  onNotificationsChange?: ((level: ProjectNotificationLevel) => void) | undefined;
  /** Rows of the main list can be dragged; archived rows keep no order. */
  sortable?: boolean;
  onKeyDown?: (event: KeyboardEvent) => void;
  clickSuppressed?: () => boolean;
  /** Absent where the name cannot change; a double click then opens settings. */
  rename?: ProjectRename | undefined;
  /** Absent where the project has no designs to show, such as a remote-only project. */
  designsProjectId?: ProjectId | undefined;
}) {
  const { group, archived, pinned, designsProjectId } = props;
  const navigate = useNavigate();
  // An archived project never asks for attention from the sidebar, nor does one
  // whose notifications the person turned off.
  const muted = props.notifications !== undefined && !projectShowsWaitingCount(props.notifications);
  const quiet = archived || muted;
  const waiting = quiet ? 0 : props.waiting;
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  // Losing the right to rename mid-edit ends the edit; it does not come back later.
  if (renaming !== null && !props.rename) setRenaming(null);
  const refocusRow = useRef(false);
  // Renaming from the menu: the closing menu must not take focus back from the field.
  const renameFromMenu = useRef(false);
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  useLayoutEffect(() => {
    if (renaming !== null || !refocusRow.current) return;
    refocusRow.current = false;
    linkRef.current?.focus();
  }, [renaming]);
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: group.projectKey,
    disabled: !props.sortable || renaming !== null,
  });
  // dnd-kit's own role and keyboard handling would turn the row into a button.
  const { role: _role, tabIndex: _tabIndex, ...dragAttributes } = attributes;
  // The group keeps repository identity; its visible name and icon belong to
  // the checkout the workspace opens, including an explicit remote checkout.
  const project = props.displayedProject ?? group;
  const returnSearch = useProjectReturnSearch(
    group.projectKey,
    props.displayedProject && !props.displayedProject.workspaceSettings?.logicalProject
      ? coordinatorMachineKey(props.displayedProject)
      : undefined,
  );
  const displayName = displayNameOf(group, props.displayedProject);
  const personal = isPersonalGroup(group);
  const nickname = useMachineNicknames();
  const copies = copyRolesSummary(group.memberProjects, (member) =>
    nickname(member.environmentId, member.environmentLabel),
  );
  return (
    <li
      ref={setNodeRef}
      {...(props.sortable && renaming === null ? { ...dragAttributes, ...listeners } : {})}
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
      data-renaming={(renaming !== null && props.rename !== undefined) || undefined}
    >
      {renaming !== null && props.rename ? (
        <SidebarNameEditor
          icon={<ProjectFavicon project={project} className="size-[18px] shrink-0" />}
          label="Project name"
          rename={props.rename}
          state={renaming}
          onChange={setRenaming}
          onDone={(refocus) => {
            refocusRow.current = refocus;
            setRenaming(null);
          }}
        />
      ) : (
        <Tip
          side="right"
          label={
            personal
              ? `${displayName} · ${PERSONAL_ASSISTANT_LABEL}: ${PERSONAL_ASSISTANT_DESCRIPTION}`
              : `${displayName} · ${project.workspaceRoot}${copies ? ` · ${copies}` : ""}${archived ? " · Archived" : ""}`
          }
        >
          <Link
            to="/projects/$projectKey"
            params={{ projectKey: group.projectKey }}
            search={returnSearch}
            ref={linkRef}
            className="sws-side-row"
            aria-current={props.current ? "page" : undefined}
            draggable={false}
            onClick={props.onOpen}
            // A double click renames the project in place, or opens its settings where it cannot be renamed.
            onMouseDown={(event) => {
              if (event.detail > 1) event.preventDefault();
            }}
            onDoubleClick={(event) => {
              if (props.clickSuppressed?.()) return;
              event.preventDefault();
              if (props.rename) setRenaming({ draft: displayName, error: null });
              else requestProjectSettings(group.projectKey);
            }}
          >
            <ProjectFavicon project={project} className="size-[18px] shrink-0" />
            <span className="sws-side-row-label">{displayName}</span>
            {copies ? <span className="sr-only">, {copies}</span> : null}
            {props.hint ? (
              <span className="sws-side-row-hint sws-side-row-namesake" title={props.hint}>
                {props.hint}
              </span>
            ) : null}
            {muted && !archived ? (
              <BellOffIcon className="sws-side-row-pin" aria-label="Notifications off" role="img" />
            ) : null}
            {pinned ? (
              <PinIcon className="sws-side-row-pin" aria-label="Pinned" role="img" />
            ) : null}
            {/* Count and availability stay visible while the adjacent menu opens. */}
            <span className="sws-side-row-end">
              {waiting > 0 ? (
                <span
                  className="sws-count sws-count-waiting"
                  title={props.attentionLabel ?? `${waiting} waiting on you`}
                >
                  <span aria-hidden="true">{waiting}</span>
                  <span className="sr-only">
                    {props.attentionLabel ?? `${waiting} waiting on you`}
                  </span>
                </span>
              ) : null}
              {!quiet && props.attentionComplete === false ? (
                <span
                  className="sws-project-coverage"
                  role="img"
                  aria-label={props.attentionLabel ?? "Attention unavailable"}
                  title={props.attentionLabel ?? "Attention unavailable"}
                />
              ) : null}
            </span>
          </Link>
        </Tip>
      )}
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
        <MenuPopup
          align="start"
          side="bottom"
          finalFocus={() => {
            const keep = !renameFromMenu.current;
            renameFromMenu.current = false;
            return keep;
          }}
        >
          {designsProjectId ? (
            <>
              <MenuItem
                onClick={() => {
                  props.onOpen();
                  void navigate({ to: "/design", search: { project: designsProjectId } });
                }}
              >
                <PaletteIcon aria-hidden />
                Designs
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          {props.rename ? (
            <>
              <MenuItem
                onClick={() => {
                  renameFromMenu.current = true;
                  setRenaming({ draft: displayName, error: null });
                }}
              >
                <PencilIcon aria-hidden />
                Rename project
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
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
          {props.onNotificationsChange && props.notifications ? (
            <>
              <ProjectNotificationsMenu
                level={props.notifications}
                onChange={props.onNotificationsChange}
              />
              <MenuSeparator />
            </>
          ) : null}
          {props.onOriginChange ? (
            <MenuItem
              onClick={() => props.onOriginChange?.(props.automated ? "user" : "automated")}
            >
              {props.automated ? <BotOffIcon aria-hidden /> : <BotIcon aria-hidden />}
              {props.automated ? "Move to my projects" : "Move to Automated"}
            </MenuItem>
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

/**
 * The row menu's Notifications item: the current level beside it, and a
 * submenu that picks another, each with what it lets through.
 */
function ProjectNotificationsMenu(props: {
  level: ProjectNotificationLevel;
  onChange: (level: ProjectNotificationLevel) => void;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        {props.level === "none" ? <BellOffIcon aria-hidden /> : <BellIcon aria-hidden />}
        <span className="flex-1">Notifications</span>
        <span className="text-muted-foreground text-xs">
          {PROJECT_NOTIFICATION_LEVEL_COPY[props.level].short}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup className="w-64">
        <MenuRadioGroup
          value={props.level}
          onValueChange={(value) => {
            if (value !== props.level) props.onChange(value as ProjectNotificationLevel);
          }}
        >
          {PROJECT_NOTIFICATION_LEVELS.map((level) => (
            <MenuRadioItem key={level} value={level} closeOnClick>
              <span className="flex items-start gap-3 py-0.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{PROJECT_NOTIFICATION_LEVEL_COPY[level].label}</span>
                  <span className="text-muted-foreground text-xs">
                    {PROJECT_NOTIFICATION_LEVEL_COPY[level].description}
                  </span>
                </span>
                <MenuRadioItemIndicator className="mt-0.5" />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}

export interface RenameState {
  draft: string;
  /** Why the last save was refused; cleared as soon as the name changes. */
  error: string | null;
  saving?: boolean;
}

/** Focus taken without the person pointing or tabbing away is given back this many times. */
const MAX_FOCUS_RETURNS = 3;

/**
 * A project's or chat's name as a text field, in the row's place. Enter saves
 * and Esc cancels; leaving the field saves a valid new name and drops anything
 * else. `rename.check` refuses a bad name as it is typed. Only the person leaves
 * the field: the double click's first click opens the chat or project, whose
 * composer then takes focus by itself, and that must not end the edit.
 */
export function SidebarNameEditor(props: {
  icon: ReactNode;
  /** The field's accessible name, such as "Project name". */
  label: string;
  rename: ProjectRename;
  state: RenameState;
  onChange: (state: RenameState) => void;
  /** `refocus` returns the keyboard to the row; leaving the field by pointer does not. */
  onDone: (refocus: boolean) => void;
}) {
  const { state, rename } = props;
  const errorId = useId();
  // Escape removes the field, and a field removed while focused may still report a blur.
  const closed = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectedOnce = useRef(false);
  const focusReturns = useRef(0);
  // When the person last pointed outside the field or pressed Tab.
  const leftAt = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target !== inputRef.current) leftAt.current = event.timeStamp;
    };
    // Tab, F6 and shortcuts are the person moving on; plain typing is not.
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key === "Tab" ||
        event.key === "F6" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        leftAt.current = event.timeStamp;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
  const onBlur = (event: FocusEvent) => {
    const leaving =
      event.timeStamp - leftAt.current < 1_000 ||
      !document.hasFocus() ||
      focusReturns.current >= MAX_FOCUS_RETURNS;
    if (leaving || closed.current) {
      void submit(true);
      return;
    }
    focusReturns.current += 1;
    requestAnimationFrame(() => {
      if (!closed.current) inputRef.current?.focus({ preventScroll: true });
    });
  };
  const done = (refocus: boolean) => {
    closed.current = true;
    props.onDone(refocus);
  };
  const check = rename.check(state.draft);
  const error = state.error ?? (check.kind === "invalid" ? check.error : null);
  const submit = async (leaving: boolean) => {
    if (state.saving || closed.current) return;
    if (check.kind !== "valid") {
      // Enter keeps the field open on a refused name; leaving it gives up the edit.
      if (check.kind === "unchanged" || leaving) done(!leaving);
      return;
    }
    props.onChange({ ...state, saving: true });
    const refused = await rename.commit(check.name);
    if (refused === null) done(!leaving);
    else props.onChange({ draft: state.draft, error: refused });
  };
  return (
    <div className="sws-project-rename">
      <div className="sws-side-row" data-invalid={error !== null || undefined}>
        {props.icon}
        <input
          className="sws-project-rename-input"
          aria-label={props.label}
          aria-invalid={error !== null || undefined}
          aria-describedby={error !== null ? errorId : undefined}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          value={state.draft}
          // Read-only, not disabled, while saving: a disabled field drops focus, and a
          // refused name should stay ready to correct.
          readOnly={state.saving}
          aria-busy={state.saving || undefined}
          ref={inputRef}
          // Selected once, so typing replaces the name; focus given back keeps what was typed.
          onFocus={(event) => {
            if (selectedOnce.current) return;
            selectedOnce.current = true;
            event.currentTarget.select();
          }}
          onChange={(event) => props.onChange({ draft: event.currentTarget.value, error: null })}
          onBlur={onBlur}
          onKeyDown={(event) => {
            // The row's move shortcuts and the sidebar's chat keys stay out of the field.
            event.stopPropagation();
            // Safari confirms a composed candidate with keyCode 229 and isComposing false.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void submit(false);
            } else if (event.key === "Escape") {
              event.preventDefault();
              done(true);
            }
          }}
        />
      </div>
      {error !== null ? (
        <p id={errorId} className="sws-project-rename-error" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  );
}
