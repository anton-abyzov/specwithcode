/**
 * Which membership an unlink ended, and when a copy comes back. Where a
 * machine cannot tell, it keeps what it has.
 *
 * Every link names the membership it makes (`linkId`, its operation id) and
 * counts it (`generation`, one above every link of the copy its accept knew
 * of). Both travel with the member entry, and an unlink records both
 * (`removedMembers`). Machines from before send neither, or relay an entry
 * without its count. So:
 *
 * - an unlink ends a member only when their link ids match, or when both are
 *   from before link ids (dated: `relinkedMembers`). An unlink that names a
 *   link never ends an entry with another id, or with none;
 * - a link's commit is refused once that link was unlinked or replaced, and a
 *   commit without a count never brings back a copy this machine unlinked;
 * - an unlinked copy is listed again only from its own word, or by a new
 *   commit here. Another machine's list never brings it back.
 */
import {
  logicalProjectMemberKey,
  type LogicalProjectMember,
  type ProjectCoordinatorBinding,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

type MemberKey = Pick<LogicalProjectMember, "environmentId" | "projectId">;
export type RemovedMember = NonNullable<ProjectCoordinatorBinding["removedMembers"]>[number];
export type RelinkedMember = NonNullable<ProjectCoordinatorBinding["relinkedMembers"]>[number];

const MAX_REMEMBERED = 256;

/** An unlink from before unlinks were dated is older than any link. */
const millis = (iso: string | undefined) => {
  const parsed = iso === undefined ? 0 : Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
};
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const ref = ({ environmentId, projectId }: MemberKey) => ({ environmentId, projectId });

const linkedAtIn = (relinked: ReadonlyArray<RelinkedMember>, key: string) =>
  relinked.reduce<number | undefined>(
    (latest, entry) =>
      logicalProjectMemberKey(entry) !== key
        ? latest
        : Math.max(latest ?? 0, millis(entry.linkedAt)),
    undefined,
  );

/** Whether an unlink still holds, given every later link these lists know of. */
export const removalStands = (
  removal: RemovedMember,
  ...relinked: ReadonlyArray<ReadonlyArray<RelinkedMember>>
) => {
  const key = logicalProjectMemberKey(removal);
  return relinked.every((list) => {
    const linkedAt = linkedAtIn(list, key);
    return linkedAt === undefined || millis(removal.removedAt) > linkedAt;
  });
};

/** The newest link of each copy that either list names. */
export const mergeRelinked = (
  own: ReadonlyArray<RelinkedMember>,
  other: ReadonlyArray<RelinkedMember>,
): ReadonlyArray<RelinkedMember> => {
  const merged = new Map<string, RelinkedMember>();
  for (const entry of [...own, ...other]) {
    const key = logicalProjectMemberKey(entry);
    const held = merged.get(key);
    if (held === undefined || millis(entry.linkedAt) > millis(held.linkedAt)) {
      merged.delete(key);
      merged.set(key, entry);
    }
  }
  return [...merged.values()].slice(-MAX_REMEMBERED);
};

type Membership = MemberKey & Pick<LogicalProjectMember, "linkId" | "generation">;

/** Which link of its copy an entry is; 0 for one without a generation. */
export const generationOf = (entry: { readonly generation?: number | undefined }) =>
  entry.generation ?? 0;

/** The highest generation of `key`'s copy these unlinks ended; 0 when none names one. */
export const removedGeneration = (removed: ReadonlyArray<RemovedMember>, key: string) =>
  removed.reduce(
    (highest, entry) =>
      logicalProjectMemberKey(entry) === key ? Math.max(highest, generationOf(entry)) : highest,
    0,
  );

/** One unlink per link of a copy, and one for its memberships from before link ids. */
export const mergeRemoved = (
  own: ReadonlyArray<RemovedMember>,
  added: ReadonlyArray<RemovedMember>,
): ReadonlyArray<RemovedMember> => {
  const slot = (entry: RemovedMember) =>
    `${logicalProjectMemberKey(entry)}\u0000${entry.linkId ?? ""}`;
  const merged = new Map<string, RemovedMember>();
  for (const entry of [...own, ...added]) {
    merged.delete(slot(entry));
    merged.set(slot(entry), entry);
  }
  return [...merged.values()].slice(-MAX_REMEMBERED);
};

/** Whether an entry is from before link ids: it carries neither a name nor a count. */
const isLegacy = (entry: {
  readonly linkId?: string | undefined;
  readonly generation?: number | undefined;
}) => entry.linkId === undefined && entry.generation === undefined;

/**
 * Whether an unlink ends the membership `member` is listed with: the same link, or both
 * from before link ids while no later link of the copy is known. Nothing else.
 */
export const removalEnds = (
  removal: RemovedMember,
  member: Membership,
  ...relinked: ReadonlyArray<ReadonlyArray<RelinkedMember>>
) =>
  logicalProjectMemberKey(removal) === logicalProjectMemberKey(member) &&
  (removal.linkId !== undefined
    ? member.linkId === removal.linkId
    : isLegacy(removal) && isLegacy(member) && removalStands(removal, ...relinked));

/** Whether this machine remembers an unlink of `key`'s copy, of any link. */
export const wasRemoved = (removed: ReadonlyArray<RemovedMember>, key: string) =>
  removed.some((entry) => logicalProjectMemberKey(entry) === key);

/**
 * Whether `entry`, sent by its own copy, is a link newer than every unlink of it this
 * machine remembers: named, counted above them, and not one of the links they ended.
 */
export const returnsAsNewLink = (removed: ReadonlyArray<RemovedMember>, entry: Membership) => {
  const key = logicalProjectMemberKey(entry);
  return (
    entry.linkId !== undefined &&
    entry.generation !== undefined &&
    entry.generation > removedGeneration(removed, key) &&
    !removed.some(
      (removal) => logicalProjectMemberKey(removal) === key && removal.linkId === entry.linkId,
    )
  );
};

/** The generation a copy takes as it accepts a link: above all it and the kept copy know. */
export const nextGeneration = (input: {
  readonly self: Membership;
  readonly keptMembers: ReadonlyArray<LogicalProjectMember>;
  readonly keptRemoved: ReadonlyArray<RemovedMember>;
  readonly ownRemoved: ReadonlyArray<RemovedMember>;
}) => {
  const key = logicalProjectMemberKey(input.self);
  return (
    Math.max(
      generationOf(input.self),
      removedGeneration(input.keptRemoved, key),
      removedGeneration(input.ownRemoved, key),
      ...input.keptMembers
        .filter((member) => logicalProjectMemberKey(member) === key)
        .map(generationOf),
    ) + 1
  );
};

/**
 * What an unlink request removes here: the listed entry of the same link, or a listed
 * entry from before link ids when the request is from before them too. Nothing else:
 * a late call, or one about a link this machine cannot match, changes nothing.
 */
export const unlinkTarget = (
  members: ReadonlyArray<LogicalProjectMember>,
  request: Membership,
): { readonly listed: LogicalProjectMember; readonly ended: Membership } | undefined => {
  const key = logicalProjectMemberKey(request);
  const listed = members.find((member) => logicalProjectMemberKey(member) === key);
  if (listed === undefined) return undefined;
  const matches =
    request.linkId !== undefined
      ? listed.linkId === request.linkId
      : isLegacy(request) && isLegacy(listed);
  if (!matches) return undefined;
  return {
    listed,
    ended: {
      ...ref(listed),
      ...(listed.linkId === undefined ? {} : { linkId: listed.linkId }),
      ...(listed.generation === undefined ? {} : { generation: listed.generation }),
    },
  };
};

/**
 * What the last step of a link does on the kept copy. `replay`: this link is listed
 * already. `refused`: the link was unlinked since, or a later link of the copy is
 * listed, so a late retry never brings it back. `add`: list `joining`, ending
 * `earlier`, an older link of the same copy this machine still lists.
 */
export const commitStep = (input: {
  readonly members: ReadonlyArray<LogicalProjectMember>;
  readonly removed: ReadonlyArray<RemovedMember>;
  readonly joining: LogicalProjectMember;
  readonly operationId: string;
}):
  | { readonly kind: "replay" }
  | { readonly kind: "refused"; readonly detail: string }
  | {
      readonly kind: "add";
      readonly joining: LogicalProjectMember;
      readonly earlier: LogicalProjectMember | undefined;
    } => {
  const key = logicalProjectMemberKey(input.joining);
  const listed = input.members.find((member) => logicalProjectMemberKey(member) === key);
  if (listed?.linkId === input.operationId) return { kind: "replay" };
  if (input.joining.linkId !== undefined && input.joining.linkId !== input.operationId)
    return { kind: "refused", detail: "That copy accepted another link." };
  const joining: LogicalProjectMember = { ...input.joining, linkId: input.operationId };
  const generation = generationOf(joining);
  // A caller from before generations: its copy is listed, or is added as such a member.
  if (generation === 0 && listed !== undefined && generationOf(listed) === 0)
    return { kind: "replay" };
  const unlinked = {
    kind: "refused",
    detail: "That link was unlinked since. Link the machine again.",
  } as const;
  // This link was unlinked, or a later one was; and with no count, any unlink of the copy wins.
  if (
    input.removed.some(
      (removal) => logicalProjectMemberKey(removal) === key && removal.linkId === input.operationId,
    ) ||
    (joining.generation === undefined
      ? wasRemoved(input.removed, key)
      : removedGeneration(input.removed, key) >= generation)
  )
    return unlinked;
  if (listed !== undefined && generationOf(listed) >= generation)
    return { kind: "refused", detail: "That copy was linked again since." };
  return { kind: "add", joining, earlier: listed };
};

/** This copy ends `member`'s link now; one without a generation is dated after any link known. */
export const rememberRemoval = (
  binding: ProjectCoordinatorBinding,
  member: Membership,
  nowMs: number,
): ProjectCoordinatorBinding => {
  const linkedAt = linkedAtIn(binding.relinkedMembers ?? [], logicalProjectMemberKey(member));
  const removedAt = iso(Math.max(nowMs, (linkedAt ?? 0) + 1));
  return {
    ...binding,
    removedMembers: mergeRemoved(binding.removedMembers ?? [], [
      {
        ...ref(member),
        ...(member.generation === undefined ? {} : { generation: member.generation }),
        ...(member.linkId === undefined ? {} : { linkId: member.linkId }),
        removedAt,
      },
    ]),
  };
};

/**
 * This copy links `member` again after an unlink that named no generation: that unlink
 * is forgotten here and the link is dated after it. Unlinks that name one stay, since
 * the new link counts above them. The binding is returned as it is without such an unlink.
 */
export const rememberRelink = (
  binding: ProjectCoordinatorBinding,
  member: MemberKey,
  nowMs: number,
): ProjectCoordinatorBinding => {
  const key = logicalProjectMemberKey(member);
  const dated = (entry: RemovedMember) =>
    logicalProjectMemberKey(entry) === key && entry.generation === undefined;
  const removal = (binding.removedMembers ?? []).find(dated);
  if (removal === undefined) return binding;
  const linkedAt = iso(Math.max(nowMs, millis(removal.removedAt) + 1));
  const { removedMembers, ...rest } = binding;
  const remaining = (removedMembers ?? []).filter((entry) => !dated(entry));
  return {
    ...rest,
    ...(remaining.length === 0 ? {} : { removedMembers: remaining }),
    relinkedMembers: mergeRelinked(binding.relinkedMembers ?? [], [{ ...ref(member), linkedAt }]),
  };
};
