/**
 * A linked copy that only runs workers because its coordinator moved to
 * another machine: where its work is started, and what its composer says.
 * Kept free of UI imports so routing hooks can use it.
 *
 * @module workersOnlyCopy
 */
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { LogicalProjectMember } from "@specweave-studio/contracts";

/**
 * The notice on a workers-only copy whose coordinator runs on `machine`. The
 * history wording is kept for a copy that ran a coordinator before; a copy that
 * never did has no conversation to keep.
 */
export function workersOnlyProblem(machine: string | null, hadConversation: boolean): string {
  const there = machine ?? "another machine";
  return hadConversation
    ? `This project now runs on ${there}. The conversation here is kept as history. Start work for this copy from ${machine ?? "there"}.`
    : `This copy runs workers only. Its coordinator is on ${there}. Start work for this copy from there.`;
}

/**
 * The checkout that starts work for a workers-only copy: the one its coordinator
 * moved to, followed along later moves. Null when the copy is not workers-only,
 * names no successor, or its coordinator is on this same machine.
 */
export function coordinatorElsewhere(
  member: EnvironmentProject,
  members: ReadonlyArray<EnvironmentProject>,
): LogicalProjectMember | null {
  const binding = member.workspaceSettings?.coordinatorBinding;
  if (binding?.state !== "transferred" || !binding.successor) return null;
  const keyOf = (candidate: EnvironmentProject) => `${candidate.environmentId}:${candidate.id}`;
  const seen = new Set([keyOf(member)]);
  let successor = binding.successor;
  for (;;) {
    const key = `${successor.environmentId}:${successor.projectId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const next = members.find((candidate) => keyOf(candidate) === key)?.workspaceSettings
      ?.coordinatorBinding;
    if (next?.state !== "transferred" || !next.successor) break;
    successor = next.successor;
  }
  return successor.environmentId === member.environmentId ? null : successor;
}

/**
 * The checkout to open for new work on `member`: its coordinator's checkout when
 * it is a workers-only copy whose coordinator is loaded here on another machine,
 * else `member` itself. A workers-only copy's composer cannot send.
 */
export function coordinatorCheckout<T extends EnvironmentProject>(
  member: T,
  members: readonly T[],
): T {
  const ref = coordinatorElsewhere(member, members);
  return (
    (ref &&
      members.find(
        (candidate) =>
          candidate.environmentId === ref.environmentId && candidate.id === ref.projectId,
      )) ||
    member
  );
}
