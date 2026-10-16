/**
 * The person's order of the sidebar's Projects list. Pinned projects lead, in
 * their saved order. The rest follow: projects the order has never seen come
 * first, so a new project lands at the top, then the saved order. Keys of projects
 * that are not listed right now (archived, or on a machine that is offline)
 * keep their entries so they return to their place.
 */
import type { SidebarProjectOrder } from "@specweave-studio/contracts";

interface OrderedGroup {
  readonly projectKey: string;
  readonly memberProjects?: ReadonlyArray<{ readonly environmentId: string; readonly id: string }>;
}

const memberIds = (group: OrderedGroup) =>
  (group.memberProjects ?? []).map((member) => `${member.environmentId}:${member.id}`);

/**
 * Saved keys rewritten to the listed projects' current keys. A pinned project
 * whose folder moved, or was re-pointed, has a new key; its remembered
 * members still name it, so it stays pinned.
 */
export function resolveProjectOrder(
  order: SidebarProjectOrder,
  groups: ReadonlyArray<OrderedGroup>,
): SidebarProjectOrder {
  const keys = new Set(groups.map((group) => group.projectKey));
  const keyByMember = new Map<string, string>();
  for (const group of groups) {
    for (const id of memberIds(group)) keyByMember.set(id, group.projectKey);
  }
  const current = (key: string) =>
    keys.has(key)
      ? key
      : ((order.pinnedMembers?.[key] ?? []).map((id) => keyByMember.get(id)).find(Boolean) ?? key);
  const pinned = unique(order.pinned.map(current));
  const pinnedMembers = Object.fromEntries(
    Object.entries(order.pinnedMembers ?? {}).map(([key, ids]) => [current(key), ids]),
  );
  return {
    pinned,
    unpinned: order.unpinned.filter((key) => !pinned.includes(key)),
    pinnedMembers,
  };
}

/** Records the members of every pinned project, so a later folder change keeps the pin. */
export function rememberPinnedMembers(
  order: SidebarProjectOrder,
  groups: ReadonlyArray<OrderedGroup>,
): SidebarProjectOrder {
  const byKey = new Map(groups.map((group) => [group.projectKey, group]));
  const pinnedMembers: Record<string, ReadonlyArray<string>> = {};
  for (const key of order.pinned) {
    const group = byKey.get(key);
    const ids = group ? memberIds(group) : order.pinnedMembers?.[key];
    if (ids && ids.length > 0) pinnedMembers[key] = ids;
  }
  return { pinned: order.pinned, unpinned: order.unpinned, pinnedMembers };
}

export interface ArrangedProjects<G> {
  readonly pinned: G[];
  readonly unpinned: G[];
}

/** Splits listed projects into the pinned and unpinned groups, each in saved order. */
export function arrangeProjects<G extends { readonly projectKey: string }>(
  groups: ReadonlyArray<G>,
  order: SidebarProjectOrder,
): ArrangedProjects<G> {
  const byKey = new Map(groups.map((group) => [group.projectKey, group]));
  const pinned = unique(order.pinned).flatMap((key) => byKey.get(key) ?? []);
  const pinnedSet = new Set(pinned);
  const known = new Set(order.unpinned);
  const fresh = groups.filter((group) => !pinnedSet.has(group) && !known.has(group.projectKey));
  const saved = unique(order.unpinned).flatMap((key) => {
    const group = byKey.get(key);
    return group && !pinnedSet.has(group) ? [group] : [];
  });
  return { pinned, unpinned: [...fresh, ...saved] };
}

/** Where a moved project lands: its group and the listed project it goes before. */
export interface ProjectDropTarget {
  readonly pinned: boolean;
  /** The listed project it lands before; `null` puts it last among the listed. */
  readonly beforeKey: string | null;
}

/**
 * The order after moving one project. Every listed project gets an explicit
 * entry, so a project added later is the only one that counts as new.
 */
export function moveProject(
  order: SidebarProjectOrder,
  listedKeys: ArrangedProjects<string>,
  projectKey: string,
  target: ProjectDropTarget,
): SidebarProjectOrder {
  const listed = new Set([...listedKeys.pinned, ...listedKeys.unpinned]);
  const without = (keys: ReadonlyArray<string>) => keys.filter((key) => key !== projectKey);
  const place = (keys: ReadonlyArray<string>, unlisted: ReadonlyArray<string>, into: boolean) => {
    const next = without(keys);
    if (into) {
      const index = target.beforeKey === null ? -1 : next.indexOf(target.beforeKey);
      next.splice(index === -1 ? next.length : index, 0, projectKey);
    }
    // Absent projects keep their entries after the listed ones.
    return [...next, ...without(unlisted).filter((key) => !next.includes(key))];
  };
  const unlistedPinned = order.pinned.filter((key) => !listed.has(key));
  const unlistedUnpinned = order.unpinned.filter(
    (key) => !listed.has(key) && !order.pinned.includes(key),
  );
  return {
    ...order,
    pinned: place(listedKeys.pinned, unlistedPinned, target.pinned),
    unpinned: place(listedKeys.unpinned, unlistedUnpinned, !target.pinned),
  };
}

/** Pins at the end of the pinned group; unpins to the top of the unpinned group. */
export function toggleProjectPin(
  order: SidebarProjectOrder,
  listedKeys: ArrangedProjects<string>,
  projectKey: string,
): SidebarProjectOrder {
  const pinned = listedKeys.pinned.includes(projectKey);
  return moveProject(order, listedKeys, projectKey, {
    pinned: !pinned,
    beforeKey: pinned ? (listedKeys.unpinned[0] ?? null) : null,
  });
}

/**
 * One step up or down. Past the top of the unpinned group a project is
 * pinned; past the bottom of the pinned group it is unpinned. `null` when it
 * cannot move further that way.
 */
export function stepProject(
  listedKeys: ArrangedProjects<string>,
  projectKey: string,
  direction: "up" | "down",
): ProjectDropTarget | null {
  const inPinned = listedKeys.pinned.includes(projectKey);
  const own = inPinned ? listedKeys.pinned : listedKeys.unpinned;
  const index = own.indexOf(projectKey);
  if (index === -1) return null;
  if (direction === "up") {
    if (index > 0) return { pinned: inPinned, beforeKey: own[index - 1]! };
    return inPinned ? null : { pinned: true, beforeKey: null };
  }
  if (index < own.length - 1) {
    return { pinned: inPinned, beforeKey: own[index + 2] ?? null };
  }
  return inPinned ? { pinned: false, beforeKey: listedKeys.unpinned[0] ?? null } : null;
}

export function sameProjectOrder(a: SidebarProjectOrder, b: SidebarProjectOrder): boolean {
  const same = (x: ReadonlyArray<string>, y: ReadonlyArray<string>) =>
    x.length === y.length && x.every((key, index) => key === y[index]);
  return same(a.pinned, b.pinned) && same(a.unpinned, b.unpinned);
}

function unique(keys: ReadonlyArray<string>): string[] {
  return [...new Set(keys)];
}
