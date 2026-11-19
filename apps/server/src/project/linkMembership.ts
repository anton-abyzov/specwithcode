/**
 * Which link an unlink ended. A copy remembers whom it unlinked and when
 * (`removedMembers`), and when it linked one of them again (`relinkedMembers`).
 * An unlink stands only against the link it ended: a later link of the same
 * copy supersedes it, on every machine that hears of both, in any order.
 * Each time is set after the one it answers, so a machine's clock never
 * reorders an unlink and the link that followed it there.
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

/** The newest unlink of each copy, the last `MAX_REMEMBERED` kept. */
export const mergeRemoved = (
  own: ReadonlyArray<RemovedMember>,
  added: ReadonlyArray<RemovedMember>,
): ReadonlyArray<RemovedMember> => {
  const addedKeys = new Set(added.map(logicalProjectMemberKey));
  return [...own.filter((entry) => !addedKeys.has(logicalProjectMemberKey(entry))), ...added].slice(
    -MAX_REMEMBERED,
  );
};

/** This copy unlinks `member` now: after any link of it this copy knows of. */
export const rememberRemoval = (
  binding: ProjectCoordinatorBinding,
  member: MemberKey,
  nowMs: number,
): ProjectCoordinatorBinding => {
  const linkedAt = linkedAtIn(binding.relinkedMembers ?? [], logicalProjectMemberKey(member));
  const removedAt = iso(Math.max(nowMs, (linkedAt ?? 0) + 1));
  return {
    ...binding,
    removedMembers: mergeRemoved(binding.removedMembers ?? [], [{ ...ref(member), removedAt }]),
  };
};

/**
 * This copy links `member` again after unlinking it: the unlink is forgotten
 * here and the link is dated after it. The binding is returned as it is for
 * a copy this one never unlinked.
 */
export const rememberRelink = (
  binding: ProjectCoordinatorBinding,
  member: MemberKey,
  nowMs: number,
): ProjectCoordinatorBinding => {
  const key = logicalProjectMemberKey(member);
  const removal = (binding.removedMembers ?? []).find(
    (entry) => logicalProjectMemberKey(entry) === key,
  );
  if (removal === undefined) return binding;
  const linkedAt = iso(Math.max(nowMs, millis(removal.removedAt) + 1));
  const { removedMembers, ...rest } = binding;
  const remaining = (removedMembers ?? []).filter(
    (entry) => logicalProjectMemberKey(entry) !== key,
  );
  return {
    ...rest,
    ...(remaining.length === 0 ? {} : { removedMembers: remaining }),
    relinkedMembers: mergeRelinked(binding.relinkedMembers ?? [], [{ ...ref(member), linkedAt }]),
  };
};
