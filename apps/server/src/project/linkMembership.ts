/**
 * Which membership an unlink ended, and which of two memberships is the later.
 *
 * A copy counts its own links: each time it accepts one it takes the next
 * generation (`nextGeneration`), above every one it or the kept copy has seen
 * for it. The link also has a name, its operation id (`linkId`). Both travel
 * with the member entry to every machine. An unlink records the generation it
 * ended (`removedMembers`). From there the order needs no clock:
 *
 * - a membership at or below a generation this machine knows was unlinked
 *   stays out, whoever lists it and whenever that list arrives;
 * - an unlink acts only on the membership it names, or an older one;
 * - a link's commit is refused once that link was unlinked or replaced.
 *
 * Machines from before generations send members and unlinks without one. An
 * entry without a generation counts as 0: it never outranks a recorded unlink
 * and gives way to a named entry of the same copy. An unlink without one ends
 * only a membership without one, by its date (`relinkedMembers`), and never a
 * named link.
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

/** One unlink with a generation and one without per copy; the highest generation is kept. */
export const mergeRemoved = (
  own: ReadonlyArray<RemovedMember>,
  added: ReadonlyArray<RemovedMember>,
): ReadonlyArray<RemovedMember> => {
  const slot = (entry: RemovedMember) =>
    `${logicalProjectMemberKey(entry)}\u0000${entry.generation === undefined ? "dated" : "counted"}`;
  const merged = new Map<string, RemovedMember>();
  for (const entry of [...own, ...added]) {
    const held = merged.get(slot(entry));
    if (held !== undefined && generationOf(held) > generationOf(entry)) continue;
    merged.delete(slot(entry));
    merged.set(slot(entry), entry);
  }
  return [...merged.values()].slice(-MAX_REMEMBERED);
};

/**
 * Whether an unlink ends the membership `member` is listed with. One that names a
 * generation ends that link and every earlier one, an entry without a generation
 * among them. One without ends only an entry without, while no later link is known.
 */
export const removalEnds = (
  removal: RemovedMember,
  member: Membership,
  ...relinked: ReadonlyArray<ReadonlyArray<RelinkedMember>>
) =>
  logicalProjectMemberKey(removal) === logicalProjectMemberKey(member) &&
  (removal.generation !== undefined
    ? generationOf(member) <= removal.generation
    : member.generation === undefined && removalStands(removal, ...relinked));

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
 * What an unlink request removes here: the listed entry it names, or an older one,
 * with the unlink to remember. Nothing when the copy is not listed, or is listed by
 * a later link than the request names: that call arrived late and changes nothing.
 */
export const unlinkTarget = (
  members: ReadonlyArray<LogicalProjectMember>,
  request: Membership,
): { readonly listed: LogicalProjectMember; readonly ended: Membership } | undefined => {
  const key = logicalProjectMemberKey(request);
  const listed = members.find((member) => logicalProjectMemberKey(member) === key);
  if (listed === undefined) return undefined;
  const named = generationOf(request);
  if (generationOf(listed) > named) return undefined;
  if (
    named > 0 &&
    generationOf(listed) === named &&
    request.linkId !== undefined &&
    listed.linkId !== undefined &&
    request.linkId !== listed.linkId
  )
    return undefined;
  const linkId = request.linkId ?? listed.linkId;
  return {
    listed,
    ended:
      named === 0
        ? ref(request)
        : { ...ref(request), generation: named, ...(linkId === undefined ? {} : { linkId }) },
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
  if (removedGeneration(input.removed, key) >= Math.max(generation, 1))
    return { kind: "refused", detail: "That link was unlinked since. Link the machine again." };
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
