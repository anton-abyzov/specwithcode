/**
 * A linked machine whose coordinator is on another machine (internally "workers only"):
 * where its work is started, and what its badge and message box say.
 * Kept free of UI imports so routing hooks can use it.
 *
 * @module workersOnlyCopy
 */
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { LogicalProjectMember } from "@specweave-studio/contracts";

/**
 * What a machine whose coordinator is on `machine` says when a message cannot be sent from
 * it. `project` names the project. The history wording is added for a machine that ran a
 * coordinator before; one that never did has no conversation to keep. The message box says
 * the same through `CoordinatorBlockedNotice`, translated, with "Continue here".
 */
export function workersOnlyProblem(
  machine: string | null,
  hadConversation: boolean,
  project: string | null = null,
): string {
  const named = project ?? "this project";
  const where = machine
    ? `The coordinator for ${named} is on ${machine}. Send opens it there.`
    : `The coordinator for ${named} is on another machine that this window cannot reach.`;
  return hadConversation ? `${where} The conversation here is kept as history.` : where;
}

/**
 * The machine this one continued the coordinator from by a person's offline switch, or null.
 * Read from the new coordinator's own binding, which keeps it until the coordinator moves
 * again: the old machine's state is not reliably in sight. Its conversation stayed on its machine, and the page says so.
 */
export function offlineSwitchPredecessor(
  member: Pick<EnvironmentProject, "environmentId" | "workspaceSettings">,
): LogicalProjectMember | null {
  const binding = member.workspaceSettings?.coordinatorBinding;
  if (binding?.state !== "active" || binding.takenOverBy !== "person" || !binding.predecessor)
    return null;
  return binding.predecessor.environmentId === member.environmentId ? null : binding.predecessor;
}

/** Words about a machine's part: an English phrase and its `{slot}` values, translated where shown. */
export interface CopyRoleText {
  readonly text: string;
  readonly values?: { readonly machine: string };
}

/**
 * The words for a machine's part in a linked project (`copyRoles`): "Coordinator" on the one
 * that holds the coordinator conversation, "Extra coordinator" on a linked machine that
 * still runs one of its own, "Handing off the coordinator…" mid-move. Every other machine
 * has no role word, so its text is empty.
 */
export function copyRoleLabel(
  role: "main" | "also-main" | "copy" | "moving",
  // Kept for callers that still pass where the coordinator is; no label names it.
  _coordinatorMachine: string | null = null,
): CopyRoleText {
  if (role === "main") return { text: "Coordinator" };
  if (role === "also-main") return { text: "Extra coordinator" };
  if (role === "moving") return { text: "Handing off the coordinator…" };
  return { text: "" };
}

/** The same in a sentence, for the badge's tooltip. */
export function copyRoleHelp(
  role: "main" | "also-main" | "copy" | "moving",
  mainMachine: string | null,
): CopyRoleText {
  const machine = mainMachine ?? "another machine";
  switch (role) {
    case "main":
      return { text: "The coordinator conversation is on this machine." };
    case "also-main":
      return {
        text: "The coordinator is on {machine}. This machine also runs a coordinator of its own, which should be fixed.",
        values: { machine },
      };
    case "copy":
      return {
        text: "The coordinator is on {machine}. Messages typed here go to it.",
        values: { machine },
      };
    case "moving":
      return { text: "The coordinator is being handed off right now." };
  }
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
