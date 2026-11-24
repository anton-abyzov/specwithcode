/**
 * Which side drives each personal pair in `LinkedPeerSync` (1448 D-14,
 * AC-18), read once per pass from the grants each side stores, so a pair
 * whose grant exists one way only still has exactly one driver: the side that
 * can call. Ordinary linked projects keep `drivesPair` (the lower id drives),
 * since both of their sides always hold a grant.
 *
 * @module personalPairDrivers
 */
import type { EnvironmentId, Project, ProjectId } from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { drivesPair, type PairReach, pairDriver } from "@specweave-studio/shared/linkedPairSync";
import * as Effect from "effect/Effect";

/** What this side does in one personal pair: drive it, only read the peer, or skip it. */
export type PersonalPairRole = "drive" | "read" | null;

/** The roles of this machine's personal pairs in one pass, by peer environment id. */
export type PersonalPairRoles = ReadonlyMap<string, PersonalPairRole>;

/** One pair's role from the grants: the driver drives; the other side reads only if it can call. */
export const personalPairRole = (
  self: EnvironmentId,
  peer: EnvironmentId,
  reach: PairReach,
): PersonalPairRole => {
  const driver = pairDriver(self, peer, reach);
  if (driver === "self") return "drive";
  return driver === "peer" && reach.selfCanCall ? "read" : null;
};

/** The role when no reach is known (a server without the share engine): the lower id drives. */
export const fallbackPersonalPairRole = (
  self: EnvironmentId,
  peer: EnvironmentId,
): PersonalPairRole => (drivesPair(self, peer) ? "drive" : "read");

/** Reads the reach of every peer of this machine's linked personal seats, once. */
export const personalPairRoles = (
  self: EnvironmentId,
  projects: ReadonlyArray<Project>,
  reach: (peer: EnvironmentId) => Effect.Effect<PairReach>,
): Effect.Effect<PersonalPairRoles> =>
  Effect.gen(function* () {
    const peers = new Set<EnvironmentId>();
    for (const project of projects) {
      if (!isPersonalAssistantProject(project)) continue;
      for (const member of project.workspaceSettings?.logicalProject?.members ?? [])
        if (member.environmentId !== self) peers.add(member.environmentId);
    }
    const roles = new Map<string, PersonalPairRole>();
    for (const peer of peers) roles.set(peer, personalPairRole(self, peer, yield* reach(peer)));
    return roles;
  });

/**
 * Whether a personal memory pass begun on link `logicalProjectId` may still
 * move this seat's memory (1448 D-12): the owner's switch is still on here,
 * and the seat is still a member of that same link, and so is `peer`, the
 * seat the pass moves memory with. Read again after each outbound page and
 * before each send, so memory written after Percy was turned off, after the
 * seat left, or after the peer was removed, never leaves this machine.
 */
export const personalPassHolds = (
  deps: {
    readonly selfEnvironmentId: EnvironmentId;
    readonly listProjects: Effect.Effect<ReadonlyArray<Project>>;
    readonly personalSwitchOn?: Effect.Effect<boolean> | undefined;
  },
  self: { readonly projectId: ProjectId },
  logicalProjectId: string,
  peer?: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (deps.personalSwitchOn !== undefined && !(yield* deps.personalSwitchOn)) return false;
    const project = (yield* deps.listProjects).find((entry) => entry.id === self.projectId);
    const identity = project?.workspaceSettings?.logicalProject;
    return (
      identity?.id === logicalProjectId &&
      identity.members.some(
        (member) =>
          member.environmentId === deps.selfEnvironmentId && member.projectId === self.projectId,
      ) &&
      (peer === undefined ||
        identity.members.some(
          (member) =>
            member.environmentId === peer.environmentId && member.projectId === peer.projectId,
        ))
    );
  });
