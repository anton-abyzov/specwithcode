/**
 * A linked copy whose main moved to another machine (internally "workers only"):
 * where its work is started, and what its badge and composer say.
 * Kept free of UI imports so routing hooks can use it.
 *
 * @module workersOnlyCopy
 */
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { LogicalProjectMember } from "@specweave-studio/contracts";

/**
 * What a copy whose main is on `machine` says when a message cannot be sent from it
 * (internally a workers-only copy): it cannot start work itself. `project` names the
 * project. The history wording is added for a copy that ran a coordinator before; a copy
 * that never did has no conversation to keep. The message box says the same through
 * `CoordinatorBlockedNotice`, translated, with the two ways out.
 */
export function workersOnlyProblem(
  machine: string | null,
  hadConversation: boolean,
  project: string | null = null,
): string {
  const where = machine ? `is ${machine}` : "is on another machine";
  const takesWork = `Main for ${project ?? "this project"} ${where}. This copy takes work from there.`;
  return hadConversation ? `${takesWork} The conversation here is kept as history.` : takesWork;
}

/**
 * The copy this one took over from by a person's offline switch, or null. Read from the
 * new main's own binding, which keeps it until main moves again: the old main's state is
 * not reliably in sight. Its conversation stayed on its machine, and the page says so.
 */
export function offlineSwitchPredecessor(
  member: Pick<EnvironmentProject, "environmentId" | "workspaceSettings">,
): LogicalProjectMember | null {
  const binding = member.workspaceSettings?.coordinatorBinding;
  if (binding?.state !== "active" || binding.takenOverBy !== "person" || !binding.predecessor)
    return null;
  return binding.predecessor.environmentId === member.environmentId ? null : binding.predecessor;
}

/** Words about a copy: an English phrase and its `{slot}` values, translated where shown. */
export interface CopyRoleText {
  readonly text: string;
  readonly values?: { readonly machine: string };
}

/**
 * The badge for a copy's role (`copyRoles`): "Main", "Copy · main on m4", "Moving main".
 * `mainMachine` names where main is; without it a copy reads "Copy".
 */
export function copyRoleLabel(
  role: "main" | "also-main" | "copy" | "moving",
  mainMachine: string | null,
): CopyRoleText {
  if (role === "main") return { text: "Main" };
  if (role === "moving") return { text: "Moving main" };
  return mainMachine
    ? { text: "Copy · main on {machine}", values: { machine: mainMachine } }
    : { text: "Copy" };
}

/** The role in a sentence, for the badge's tooltip. */
export function copyRoleHelp(
  role: "main" | "also-main" | "copy" | "moving",
  mainMachine: string | null,
): CopyRoleText {
  const machine = mainMachine ?? "another machine";
  switch (role) {
    case "main":
      return {
        text: "Work for this project starts here. Copies on other machines take work from it.",
      };
    case "also-main":
      return {
        text: "Main is on {machine}. This copy can also start work of its own.",
        values: { machine },
      };
    case "copy":
      return {
        text: "Work starts on {machine}. This copy takes work from there.",
        values: { machine },
      };
    case "moving":
      return { text: "Main is moving between machines right now." };
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
