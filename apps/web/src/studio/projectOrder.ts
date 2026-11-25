/**
 * The person's order of the sidebar's Projects list. Pinned projects lead, in
 * their saved order. The rest follow: projects the order has never seen come
 * first, so a new project lands at the top, then the saved order. Keys of projects
 * that are not listed right now (archived, or on a machine that is offline)
 * keep their entries so they return to their place.
 */
import type { SidebarProjectOrder } from "@specweave-studio/contracts";
import { LOGICAL_PROJECT_KEY_PREFIX as LINKED_KEY_PREFIX } from "../logicalProject";

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

/** A listed project and its copies, as much as a link move needs. */
export interface LinkedOrderGroup<M = { readonly environmentId: string; readonly id: string }> {
  readonly projectKey: string;
  readonly memberProjects: ReadonlyArray<
    M & { readonly environmentId: string; readonly id: string }
  >;
}

/** The keys a linked group's copies had before the link, other than its own. */
function preLinkKeys<M>(group: LinkedOrderGroup<M>, unlinkedKey: (member: M) => string | null) {
  return unique(group.memberProjects.flatMap((member) => unlinkedKey(member) ?? [])).filter(
    (key) => key !== group.projectKey,
  );
}

/**
 * A link moves a copy from its repository's key to its logical project's key. A linked
 * project takes the pin of the key its copies had before when that pin's recorded
 * members include one of its copies, even if the linked key was already saved among the
 * unpinned (a window on an older build may have saved it there). A pin with no recorded
 * members moves only when nothing is listed under the old key any more: with copies
 * still there, it cannot tell whose pin it was, and it stays. A linked project the order
 * has never seen and that takes no pin goes where its copies' unpinned key is. The old
 * key keeps no pin it gave up. Derived from the current groups alone, so it repeats
 * safely and needs no record of the grouping before the link. An unlink moves a pinned linked project, no longer
 * listed, to the group its recorded copies are in now.
 */
export function followLinkedProjects<M>(
  order: SidebarProjectOrder,
  groups: ReadonlyArray<LinkedOrderGroup<M>>,
  unlinkedKey: (member: M) => string | null,
  /**
   * Every machine has sent its projects, so a key that is not listed is gone rather than
   * late. Until then an unrecorded pin never moves: its old group may only be loading.
   */
  allListed = true,
): SidebarProjectOrder {
  const listed = new Set(groups.map((group) => group.projectKey));
  const known = new Set([...order.pinned, ...order.unpinned]);
  const pinned = [...order.pinned];
  const unpinned = [...order.unpinned];
  const pinnedMembers: Record<string, ReadonlyArray<string>> = { ...order.pinnedMembers };
  let changed = false;
  for (const group of groups) {
    const key = group.projectKey;
    if (!key.startsWith(LINKED_KEY_PREFIX) || pinned.includes(key)) continue;
    const ids = memberIds(group);
    const sources = preLinkKeys(group, unlinkedKey);
    const pinSource = sources.find((source) => {
      if (!pinned.includes(source)) return false;
      const recorded = pinnedMembers[source] ?? [];
      return recorded.length === 0
        ? allListed && !listed.has(source)
        : recorded.some((id) => ids.includes(id));
    });
    if (pinSource === undefined && known.has(key)) continue;
    if (pinSource !== undefined) {
      const saved = unpinned.indexOf(key);
      if (saved !== -1) unpinned.splice(saved, 1);
      pinned[pinned.indexOf(pinSource)] = key;
      pinnedMembers[key] = ids;
      delete pinnedMembers[pinSource];
      // Listed and in neither list it would count as new; it goes first among the rest.
      if (listed.has(pinSource) && !unpinned.includes(pinSource)) unpinned.unshift(pinSource);
    } else {
      const source = sources.find((candidate) => unpinned.includes(candidate));
      if (source === undefined) continue;
      unpinned.splice(unpinned.indexOf(source), 0, key);
    }
    known.add(key);
    changed = true;
  }
  const keyByMember = new Map<string, string>();
  for (const group of groups)
    for (const id of memberIds(group)) keyByMember.set(id, group.projectKey);
  // A copy: the loop replaces entries as it goes.
  const pinnedBefore = pinned.slice();
  for (const key of pinnedBefore) {
    if (!key.startsWith(LINKED_KEY_PREFIX) || listed.has(key)) continue;
    const destination = (pinnedMembers[key] ?? [])
      .map((id) => keyByMember.get(id))
      .find((found) => found !== undefined);
    if (destination === undefined) continue;
    const group = groups.find((candidate) => candidate.projectKey === destination)!;
    if (pinned.includes(destination)) pinned.splice(pinned.indexOf(destination), 1);
    pinned[pinned.indexOf(key)] = destination;
    delete pinnedMembers[key];
    pinnedMembers[destination] = memberIds(group);
    const at = unpinned.indexOf(destination);
    if (at !== -1) unpinned.splice(at, 1);
    changed = true;
  }
  return changed ? { pinned, unpinned, pinnedMembers } : order;
}

/**
 * The saved machine choice of a copy's pre-link key moves to its linked project, when
 * the choice names a machine that project holds and the old key's copies cannot honor
 * it. A linked project with its own choice keeps it. After an unlink, a linked project's
 * choice moves to the group that now holds the exact copy it names.
 */
export function followLinkedMachineChoices<M>(
  saved: Readonly<Record<string, string>>,
  groups: ReadonlyArray<LinkedOrderGroup<M>>,
  unlinkedKey: (member: M) => string | null,
): Readonly<Record<string, string>> {
  const byKey = new Map(groups.map((group) => [group.projectKey, group]));
  const machineOf = (choice: string) => {
    const separator = choice.indexOf(":");
    return separator > 0 ? choice.slice(0, separator) : choice;
  };
  const honors = (group: LinkedOrderGroup<M> | undefined, choice: string) =>
    group !== undefined &&
    group.memberProjects.some(
      (member) =>
        `${member.environmentId}:${member.id}` === choice ||
        member.environmentId === machineOf(choice),
    );
  let next: Record<string, string> | null = null;
  for (const group of groups) {
    const key = group.projectKey;
    if (!key.startsWith(LINKED_KEY_PREFIX) || (next ?? saved)[key] !== undefined) continue;
    for (const source of preLinkKeys(group, unlinkedKey)) {
      const choice = (next ?? saved)[source];
      if (choice === undefined || !honors(group, choice) || honors(byKey.get(source), choice))
        continue;
      next ??= { ...saved };
      next[key] = choice;
      delete next[source];
      break;
    }
  }
  for (const [key, choice] of Object.entries(next ?? saved)) {
    if (!key.startsWith(LINKED_KEY_PREFIX) || byKey.has(key)) continue;
    const holder = groups.find((group) =>
      group.memberProjects.some((member) => `${member.environmentId}:${member.id}` === choice),
    );
    if (holder === undefined || (next ?? saved)[holder.projectKey] !== undefined) continue;
    next ??= { ...saved };
    next[holder.projectKey] = choice;
    delete next[key];
  }
  return next ?? saved;
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

/**
 * One step up or down while the unpinned group shows in two sections: projects this
 * device can run, then projects only on other machines. `elsewhereKeys` names every
 * project with no copy here, pinned or not. A step stays inside the project's own
 * section, since the list puts each project back there; the first project on other
 * machines steps up into the pinned group, and a pinned project steps down to the
 * top of its own section.
 */
export function stepProjectInSection(
  listedKeys: ArrangedProjects<string>,
  elsewhereKeys: ReadonlySet<string>,
  projectKey: string,
  direction: "up" | "down",
): ProjectDropTarget | null {
  const elsewhere = elsewhereKeys.has(projectKey);
  return stepProject(
    {
      pinned: listedKeys.pinned,
      unpinned: listedKeys.unpinned.filter((key) => elsewhereKeys.has(key) === elsewhere),
    },
    projectKey,
    direction,
  );
}

/** Pins at the end of the pinned group; unpins to the top of the project's own section. */
export function toggleProjectPinInSection(
  order: SidebarProjectOrder,
  listedKeys: ArrangedProjects<string>,
  elsewhereKeys: ReadonlySet<string>,
  projectKey: string,
): SidebarProjectOrder {
  if (!listedKeys.pinned.includes(projectKey)) {
    return toggleProjectPin(order, listedKeys, projectKey);
  }
  const elsewhere = elsewhereKeys.has(projectKey);
  const section = listedKeys.unpinned.filter((key) => elsewhereKeys.has(key) === elsewhere);
  return moveProject(order, listedKeys, projectKey, {
    pinned: false,
    beforeKey: section[0] ?? null,
  });
}

export function sameProjectOrder(a: SidebarProjectOrder, b: SidebarProjectOrder): boolean {
  const same = (x: ReadonlyArray<string>, y: ReadonlyArray<string>) =>
    x.length === y.length && x.every((key, index) => key === y[index]);
  return same(a.pinned, b.pinned) && same(a.unpinned, b.unpinned);
}

function unique(keys: ReadonlyArray<string>): string[] {
  return [...new Set(keys)];
}
