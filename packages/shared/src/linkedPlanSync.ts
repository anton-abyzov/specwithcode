import type { EnvironmentId, ProjectId, ProjectPlanLinkExport } from "@specweave-studio/contracts";

/**
 * Two-way replication of a linked project's native plan, driven from one
 * place over export and merge calls on each member: the app window drives it
 * for pairs no server drives, and a member's server drives the pairs it owns
 * (`LinkedPeerSync`), so claims move without an open window.
 *
 * @module linkedPlanSync
 */

export interface LinkedPlanMember {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
}

export interface LinkedPlanTransport {
  /** The member's plan, or null when it cannot be read now. */
  readonly exportPlan: (member: LinkedPlanMember) => Promise<ProjectPlanLinkExport | null>;
  readonly mergePlan: (
    target: LinkedPlanMember,
    peer: LinkedPlanMember,
    exported: ProjectPlanLinkExport,
  ) => Promise<void>;
  /** A pair another driver keeps in step: neither side is merged into the other. */
  readonly skipPair?: (left: LinkedPlanMember, right: LinkedPlanMember) => boolean;
}

/**
 * One two-way pass over a linked project's reachable members: every plan is
 * read before any is changed, so both sides merge the same pair of copies and
 * converge even when one merge fails; the next pass repeats it. Only members
 * of a pair left to this pass are read.
 */
export async function syncLinkedPlans(
  members: ReadonlyArray<LinkedPlanMember>,
  transport: LinkedPlanTransport,
): Promise<void> {
  const skip = (left: LinkedPlanMember, right: LinkedPlanMember) =>
    left.environmentId === right.environmentId || (transport.skipPair?.(left, right) ?? false);
  const needed = members.filter((member) =>
    members.some((other) => other !== member && !skip(member, other)),
  );
  const exports: Array<{ member: LinkedPlanMember; exported: ProjectPlanLinkExport }> = [];
  for (const member of needed) {
    const exported = await transport.exportPlan(member).catch(() => null);
    if (exported) exports.push({ member, exported });
  }
  if (exports.length < 2) return;
  for (const { member: peer, exported } of exports)
    for (const { member: target } of exports) {
      if (skip(target, peer)) continue;
      await transport.mergePlan(target, peer, exported).catch(() => undefined);
    }
}
