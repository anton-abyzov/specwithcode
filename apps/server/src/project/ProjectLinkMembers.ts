/**
 * Member lists of linked copies. Every copy runs its own coordinator, so an
 * equal (active) copy takes from any other listed copy only the members it
 * does not list yet, never a removal, and never one it unlinked itself
 * (`adoptEqualMembers`). The rest is what copies from before equal
 * coordinators still do with each other. A copy that joined
 * learns machines linked after it from the copy it gave way to (additions and
 * removals), which relays its own coordinator's list when it gave way too; the
 * owner's app may also send a coordinator one takeover later (additions only).
 * A copy that took over learns what its predecessor listed, except members it
 * unlinked since (`removedMembers`). Only `ProjectLink` runs
 * these, under the project lock; the transports are `LinkedPeerSync` (digest
 * pull, `linked-members` push, supersede answer), the peer route and the app
 * (`projectLink.syncMembers`).
 *
 * @module ProjectLinkMembers
 */
import {
  logicalProjectMemberKey,
  type LogicalProject,
  type LogicalProjectMember,
  type Project,
  type ProjectCoordinatorBinding,
  type ProjectId,
  type ProjectLinkError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { stringifyJson } from "../json.ts";
import { sha256 } from "../nodeCrypto.ts";
import type { ProjectOwnershipUpdate } from "../orchestration-v2/ProjectCommands.ts";
import {
  generationOf,
  mergeRelinked,
  mergeRemoved,
  removalEnds,
  removalStands,
  returnsAsNewLink,
  wasRemoved,
  type RelinkedMember,
  type RemovedMember,
} from "./linkMembership.ts";
import type * as ProjectAdmission from "./ProjectAdmission.ts";

/** The most members a shared identity lists (`LogicalProject`). */
const MAX_MEMBERS = 256;

/** The same listed copy and coordinator thread; the folder never decides a match. */
export const memberRef = (member: LogicalProjectMember) =>
  JSON.stringify([member.environmentId, member.projectId, member.coordinatorThreadId]);

/** Whether two lists name the same copies, whatever their order or folders. */
export const sameMemberSet = (
  left: ReadonlyArray<LogicalProjectMember>,
  right: ReadonlyArray<LogicalProjectMember>,
) => {
  const refs = (list: ReadonlyArray<LogicalProjectMember>) =>
    JSON.stringify([...new Set(list.map(memberRef))].toSorted());
  return refs(left) === refs(right);
};

/**
 * The epochs a member `fromKey` may claim to coordinate at, as this
 * transferred copy sees it. The copy it gave way to may send at its epoch or
 * later; any other member only one past it (or at it, when this copy never
 * learned who it gave way to), as a takeover or a coordinator started beside
 * it would be. A longer chain of takeovers is left to the app.
 */
export const coordinatorClaimWindow = (binding: ProjectCoordinatorBinding, fromKey: string) => {
  const isSuccessor =
    binding.successor !== undefined && logicalProjectMemberKey(binding.successor) === fromKey;
  return {
    isSuccessor,
    lowest: isSuccessor || binding.successor === undefined ? binding.epoch : binding.epoch + 1,
    highest: isSuccessor ? Number.MAX_SAFE_INTEGER : binding.epoch + 1,
  };
};

export interface AdoptMembersInput {
  readonly projectId: ProjectId;
  readonly logicalProjectId: string;
  /** The coordinator copy the list is from: a member this copy lists, on another machine. */
  readonly from: LogicalProjectMember;
  /** That copy's epoch, its own word, checked like a replica's. */
  readonly fromEpoch: number;
  /** The coordinator's whole member list. */
  readonly members: ReadonlyArray<LogicalProjectMember>;
  /**
   * Sent by the owner's app (`projectLink.syncMembers`), which read the
   * coordinator itself. Another machine's list is taken only from the copy
   * this one gave way to, since its epoch is its own word.
   */
  readonly viaApp?: boolean;
  /**
   * The members that copy unlinked on purpose (its `removedMembers`). An equal coordinator
   * drops the ones it still lists; a member that copy merely does not list stays.
   */
  readonly removed?: ReadonlyArray<RemovedMember>;
  /** The members that copy linked again after an unlink (its `relinkedMembers`), and when. */
  readonly relinked?: ReadonlyArray<RelinkedMember>;
}

export interface AdoptMembersResult {
  readonly replayed: boolean;
  readonly changed: boolean;
}

export interface AddPredecessorMembersInput {
  readonly projectId: ProjectId;
  /** The copy this one took over from, which answered with its list. */
  readonly predecessor: Pick<LogicalProjectMember, "environmentId" | "projectId">;
  readonly members: ReadonlyArray<LogicalProjectMember>;
}

export interface ProjectLinkMembersDeps {
  readonly admission: ProjectAdmission.ProjectAdmission["Service"];
  readonly fail: (
    code: ProjectLinkError["code"],
    detail?: string,
  ) => Effect.Effect<never, ProjectLinkError>;
  readonly load: (projectId: ProjectId) => Effect.Effect<Project, ProjectLinkError>;
  readonly refusePersonal: (project: Project) => Effect.Effect<void, ProjectLinkError>;
  readonly selfMember: (project: Project) => Effect.Effect<LogicalProjectMember>;
  readonly writeOwnership: (
    project: Project,
    commandPrefix: string,
    operationId: string,
    ownership: Omit<ProjectOwnershipUpdate, "expectedRevision">,
  ) => Effect.Effect<Project, ProjectLinkError>;
}

/** Members keyed by machine and project, the last entry of a key kept. */
const byKey = (members: ReadonlyArray<LogicalProjectMember>) => [
  ...new Map(members.map((member) => [logicalProjectMemberKey(member), member])).values(),
];

/** Names one list, so a retry of the same sync replays its write. */
const listId = (members: ReadonlyArray<LogicalProjectMember>) =>
  sha256([JSON.stringify(members.map(memberRef).toSorted())])
    .toString("hex")
    .slice(0, 16);

/** Names one list with the unlinks or links written beside it, which a list alone repeats. */
const stateId = (members: ReadonlyArray<LogicalProjectMember>, beside: ReadonlyArray<unknown>) =>
  sha256([stringifyJson(members.map(memberRef).toSorted()), stringifyJson(beside)])
    .toString("hex")
    .slice(0, 16);

export const makeProjectLinkMembers = (deps: ProjectLinkMembersDeps) => {
  const { admission, fail, load } = deps;

  /**
   * An equal coordinator adds the members another listed copy holds, and drops
   * the ones that copy says it unlinked on purpose. The caller holds the project
   * lock. A member the other copy only fails to list is never removed, no entry
   * this copy holds is rewritten, and a member this copy unlinked stays unlinked.
   */
  const adoptEqualMembers = (
    project: Project,
    identity: LogicalProject,
    self: LogicalProjectMember,
    input: AdoptMembersInput,
  ): Effect.Effect<AdoptMembersResult, ProjectLinkError> =>
    Effect.gen(function* () {
      const binding = project.workspaceSettings?.coordinatorBinding;
      const fromKey = logicalProjectMemberKey(input.from);
      const remembered = binding?.removedMembers ?? [];
      // A copy this machine unlinked speaks for itself again only with a newer link of its own.
      const ownWord = input.members.find((member) => logicalProjectMemberKey(member) === fromKey);
      const returning =
        wasRemoved(remembered, fromKey) &&
        ownWord !== undefined &&
        returnsAsNewLink(remembered, ownWord);
      if (
        !returning &&
        !identity.members.some(
          (member) =>
            logicalProjectMemberKey(member) === fromKey &&
            member.environmentId !== self.environmentId,
        )
      )
        return yield* fail("not_member");
      const current = binding ?? { epoch: 0, state: "active" as const };
      const ownRelinked = current.relinkedMembers ?? [];
      const theirRelinked = input.relinked ?? [];
      // What the other copy unlinked on purpose, by the membership each unlink ended. One
      // from before link ids also lapses when that copy lists the member again.
      const listedThere = new Set(input.members.map(logicalProjectMemberKey));
      const unlinkedThere = (input.removed ?? []).filter(
        (removal) =>
          logicalProjectMemberKey(removal) !== fromKey &&
          (removal.linkId !== undefined || !listedThere.has(logicalProjectMemberKey(removal))),
      );
      const endedBy = (member: LogicalProjectMember) =>
        unlinkedThere.find((removal) => removalEnds(removal, member, ownRelinked, theirRelinked));
      const dropped = identity.members.filter(
        (member) => member.environmentId !== self.environmentId && endedBy(member) !== undefined,
      );
      if (dropped.length > 0) {
        const droppedKeys = new Set(dropped.map(logicalProjectMemberKey));
        const remaining = identity.members.filter(
          (member) => !droppedKeys.has(logicalProjectMemberKey(member)),
        );
        // Remembered here too, so an older list from a third copy never brings them back.
        const removals = dropped.map((member) => endedBy(member)!);
        const updated = yield* deps.writeOwnership(
          project,
          "project-link-members-removed",
          stateId(remaining, removals),
          {
            mode: "remove-member",
            logicalProject: { ...identity, members: remaining },
            coordinatorBinding: {
              ...current,
              removedMembers: mergeRemoved(current.removedMembers ?? [], removals),
            },
          },
        );
        yield* adoptEqualMembers(
          updated,
          updated.workspaceSettings?.logicalProject ?? { ...identity, members: remaining },
          self,
          { ...input, removed: [] },
        );
        return { replayed: false, changed: true };
      }
      // The other copy's later links end the unlinks this copy remembers of the same copies.
      const relinked = mergeRelinked(ownRelinked, theirRelinked);
      const ownRemoved = current.removedMembers ?? [];
      const stillRemoved = ownRemoved.filter(
        (removal) =>
          removal.linkId !== undefined ||
          removal.generation !== undefined ||
          removalStands(removal, relinked),
      );
      const held = new Map(
        identity.members.map((member) => [logicalProjectMemberKey(member), member]),
      );
      // A membership this copy knows was unlinked stays out, whoever lists it and however
      // late: only a later link of that copy, which counts above the unlink, comes in.
      const offered = byKey(input.members).filter(
        (member) =>
          member.environmentId !== self.environmentId &&
          !stillRemoved.some((removal) => removalEnds(removal, member, relinked)),
      );
      // An unlinked copy comes back only from its own word, as a newer link; another
      // machine's list never brings it back, whatever link it names.
      const mayList = (member: LogicalProjectMember) =>
        !wasRemoved(stillRemoved, logicalProjectMemberKey(member)) ||
        (logicalProjectMemberKey(member) === fromKey && returnsAsNewLink(stillRemoved, member));
      const added = offered
        .filter((member) => !held.has(logicalProjectMemberKey(member)) && mayList(member))
        .slice(0, Math.max(0, MAX_MEMBERS - identity.members.length));
      // The same copy listed there by a later link than here: this list takes that link, as
      // one an older machine relayed without a generation takes the named one.
      const later = new Map(
        offered
          .filter((member) => {
            const mine = held.get(logicalProjectMemberKey(member));
            return (
              mine !== undefined &&
              mayList(member) &&
              // Only to a named link: an entry without a name is no evidence of one.
              member.linkId !== undefined &&
              memberRef(mine) === memberRef(member) &&
              generationOf(member) > generationOf(mine)
            );
          })
          .map((member) => [logicalProjectMemberKey(member), member]),
      );
      const learned =
        later.size > 0 ||
        stillRemoved.length !== ownRemoved.length ||
        stringifyJson(relinked) !== stringifyJson(ownRelinked);
      if (added.length === 0 && !learned) return { replayed: true, changed: false };
      const members = [
        ...identity.members.map((member) => later.get(logicalProjectMemberKey(member)) ?? member),
        ...added,
      ];
      const { removedMembers: _removed, relinkedMembers: _relinked, ...rest } = current;
      yield* deps.writeOwnership(
        project,
        "project-link-members",
        learned || members.some((member) => member.linkId !== undefined)
          ? stateId(members, [
              members.map((member) => [member.linkId ?? null, generationOf(member)]),
              relinked,
            ])
          : listId(members),
        {
          mode: "sync-members",
          logicalProject: { ...identity, members },
          coordinatorBinding: learned
            ? {
                ...rest,
                ...(stillRemoved.length === 0 ? {} : { removedMembers: stillRemoved }),
                ...(relinked.length === 0 ? {} : { relinkedMembers: relinked }),
              }
            : current,
        },
      );
      return { replayed: false, changed: true };
    });

  const adoptMembers = (input: AdoptMembersInput) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        yield* deps.refusePersonal(project);
        const self = yield* deps.selfMember(project);
        const identity: LogicalProject | undefined = project.workspaceSettings?.logicalProject;
        const binding = project.workspaceSettings?.coordinatorBinding;
        if (identity?.id !== input.logicalProjectId) return yield* fail("not_linked");
        if (project.workspaceSettings?.archived) return yield* fail("archived");
        // A moving copy never takes another copy's list; an equal one only adds from it.
        if (binding === undefined || binding.state === "active")
          return yield* adoptEqualMembers(project, identity, self, input);
        if (binding.state !== "transferred") return yield* fail("not_member");
        const fromKey = logicalProjectMemberKey(input.from);
        const from = identity.members.find(
          (member) =>
            logicalProjectMemberKey(member) === fromKey &&
            member.environmentId !== self.environmentId,
        );
        if (from === undefined) return yield* fail("not_member");
        const window = coordinatorClaimWindow(binding, fromKey);
        if (
          (!window.isSuccessor && input.viaApp !== true) ||
          input.fromEpoch < window.lowest ||
          input.fromEpoch > window.highest
        )
          return yield* fail(
            "not_coordinator",
            "That copy is not the coordinator this copy knows of.",
          );
        const incoming = byKey(input.members);
        const selfKey = logicalProjectMemberKey(self);
        const held = new Map(
          identity.members.map((member) => [logicalProjectMemberKey(member), member]),
        );
        const heldSelf = held.get(selfKey);
        if (heldSelf === undefined)
          return yield* fail("invalid", "This copy is not listed in its shared project.");
        // Only the copy this one gave way to removes members; a later coordinator only adds.
        const incomingKeys = new Set(incoming.map(logicalProjectMemberKey));
        if (
          !window.isSuccessor &&
          !identity.members.every((member) => incomingKeys.has(logicalProjectMemberKey(member)))
        )
          return yield* fail(
            "invalid",
            "Only the coordinator this copy gave way to removes members.",
          );
        if (!incomingKeys.has(selfKey))
          return yield* fail("invalid", "The list leaves this copy out; unlink it here instead.");
        if (
          binding.successor !== undefined &&
          !incomingKeys.has(logicalProjectMemberKey(binding.successor))
        )
          return yield* fail(
            "invalid",
            "The list leaves out the coordinator this copy gave way to.",
          );
        if (
          incoming.some(
            (member) =>
              member.environmentId === self.environmentId &&
              logicalProjectMemberKey(member) !== selfKey,
          )
        )
          return yield* fail("invalid", "The list names another copy on this machine.");
        if (
          incoming.some((member) => {
            const known = held.get(logicalProjectMemberKey(member));
            return known !== undefined && known.coordinatorThreadId !== member.coordinatorThreadId;
          })
        )
          return yield* fail("conflict", "A listed copy has another coordinator thread here.");
        if (incoming.length > MAX_MEMBERS) return yield* fail("invalid", "The list is too long.");
        // Entries this copy holds stay as held: its own folder and thread are never rewritten.
        const next = incoming.map((member) => held.get(logicalProjectMemberKey(member)) ?? member);
        if (sameMemberSet(next, identity.members)) return { replayed: true, changed: false };
        yield* deps.writeOwnership(project, "project-link-members", listId(next), {
          mode: "sync-members",
          logicalProject: { ...identity, members: next },
          coordinatorBinding: binding,
        });
        return { replayed: false, changed: true };
      }),
    );

  const addPredecessorMembers = (input: AddPredecessorMembersInput) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        yield* deps.refusePersonal(project);
        const self = yield* deps.selfMember(project);
        const identity = project.workspaceSettings?.logicalProject;
        const binding = project.workspaceSettings?.coordinatorBinding;
        if (identity === undefined) return yield* fail("not_linked");
        if (binding?.state !== "active") return yield* fail("not_coordinator");
        if (
          binding.predecessor === undefined ||
          logicalProjectMemberKey(binding.predecessor) !==
            logicalProjectMemberKey(input.predecessor)
        )
          return yield* fail("invalid", "That copy is not the one this copy took over from.");
        const listed = new Set(identity.members.map(logicalProjectMemberKey));
        // Machines this copy unlinked after the takeover stay unlinked.
        const removed = new Set((binding.removedMembers ?? []).map(logicalProjectMemberKey));
        const added = byKey(input.members)
          .filter(
            (member) =>
              !listed.has(logicalProjectMemberKey(member)) &&
              !removed.has(logicalProjectMemberKey(member)) &&
              member.environmentId !== self.environmentId,
          )
          .slice(0, Math.max(0, MAX_MEMBERS - identity.members.length));
        if (added.length === 0) return { changed: false };
        const members = [...identity.members, ...added];
        yield* deps.writeOwnership(project, "project-link-predecessor-members", listId(members), {
          mode: "link-member",
          logicalProject: { ...identity, members },
          coordinatorBinding: binding,
        });
        return { changed: true };
      }),
    );

  return { adoptMembers, addPredecessorMembers };
};
