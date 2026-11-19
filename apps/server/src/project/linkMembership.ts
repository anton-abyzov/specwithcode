/**
 * Which membership an unlink ended. Every link gives the copy it lists a link
 * id (`LogicalProjectMember.linkId`), the same on every machine, and an unlink
 * names the id it ended (`removedMembers`). It removes that membership and an
 * older one from before ids, never a later link of the same copy, whichever
 * machine made that link and whatever the clocks say.
 *
 * Unlinks of memberships from before link ids carry none. Those are dated, and
 * a later link of the copy on the machine that unlinked it (`relinkedMembers`)
 * ends them; each time is set after the one it answers.
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

/** The membership an unlink names: the copy, and the link id it ended when it had one. */
const removalKey = (removal: RemovedMember) =>
  `${logicalProjectMemberKey(removal)}\u0000${removal.linkId ?? ""}`;

/** One unlink per membership, the newest kept, the last `MAX_REMEMBERED` of them. */
export const mergeRemoved = (
  own: ReadonlyArray<RemovedMember>,
  added: ReadonlyArray<RemovedMember>,
): ReadonlyArray<RemovedMember> => {
  const addedKeys = new Set(added.map(removalKey));
  return [...own.filter((entry) => !addedKeys.has(removalKey(entry))), ...added].slice(
    -MAX_REMEMBERED,
  );
};

/**
 * Whether an unlink ends the membership `member` is listed with. One that names a
 * link id ends that membership, and one from before ids, which is older. One without
 * an id ends only a membership without one, and only while no later link is known.
 */
export const removalEnds = (
  removal: RemovedMember,
  member: Pick<LogicalProjectMember, "environmentId" | "projectId" | "linkId">,
  ...relinked: ReadonlyArray<ReadonlyArray<RelinkedMember>>
) =>
  logicalProjectMemberKey(removal) === logicalProjectMemberKey(member) &&
  (removal.linkId !== undefined
    ? member.linkId === undefined || member.linkId === removal.linkId
    : member.linkId === undefined && removalStands(removal, ...relinked));

/** This copy unlinks `member` now: the membership it lists, dated after any link it knows of. */
export const rememberRemoval = (
  binding: ProjectCoordinatorBinding,
  member: MemberKey & Pick<LogicalProjectMember, "linkId">,
  nowMs: number,
): ProjectCoordinatorBinding => {
  const linkedAt = linkedAtIn(binding.relinkedMembers ?? [], logicalProjectMemberKey(member));
  const removedAt = iso(Math.max(nowMs, (linkedAt ?? 0) + 1));
  return {
    ...binding,
    removedMembers: mergeRemoved(binding.removedMembers ?? [], [
      {
        ...ref(member),
        ...(member.linkId === undefined ? {} : { linkId: member.linkId }),
        removedAt,
      },
    ]),
  };
};

/**
 * This copy links `member` again after unlinking a membership from before link ids:
 * that unlink is forgotten here and the link is dated after it. Unlinks that name a
 * link id stay, since the new link has another. The binding is returned as it is for
 * a copy with no such unlink.
 */
export const rememberRelink = (
  binding: ProjectCoordinatorBinding,
  member: MemberKey,
  nowMs: number,
): ProjectCoordinatorBinding => {
  const key = logicalProjectMemberKey(member);
  const undated = (entry: RemovedMember) =>
    logicalProjectMemberKey(entry) === key && entry.linkId === undefined;
  const removal = (binding.removedMembers ?? []).find(undated);
  if (removal === undefined) return binding;
  const linkedAt = iso(Math.max(nowMs, millis(removal.removedAt) + 1));
  const { removedMembers, ...rest } = binding;
  const remaining = (removedMembers ?? []).filter((entry) => !undated(entry));
  return {
    ...rest,
    ...(remaining.length === 0 ? {} : { removedMembers: remaining }),
    relinkedMembers: mergeRelinked(binding.relinkedMembers ?? [], [{ ...ref(member), linkedAt }]),
  };
};
