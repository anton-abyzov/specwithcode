/**
 * Send to another machine…: what each machine already holds of this project, and the one
 * sentence that says what the click will do, before it is clicked. Copy keeps Main where it
 * is; Move hands Main over. A machine with a copy gets that copy filled in, not a second one.
 *
 * @module sendToMachine
 */
import { existingCopyOn, type CopyCandidate } from "@specweave-studio/shared/existingCopy";
import { displayFolder } from "../lib/displayFolder";
import { copyRoles, type CoordinatedCopy } from "./projectDomain";

export type SendChoice = "copy" | "move";

type SendCopy = CopyCandidate & CoordinatedCopy;

/**
 * What one machine holds: Main, one copy, several (the person picks; `mainId` names the
 * one among them that is Main, if any), or nothing.
 */
export type MachineHolding<T> =
  | { readonly kind: "main"; readonly copy: T }
  | { readonly kind: "copy"; readonly copy: T }
  | { readonly kind: "several"; readonly copies: readonly T[]; readonly mainId: string | null }
  | { readonly kind: "none" };

/** Each machine's holding, and the machine Main is on whatever the destinations hold. */
export interface MachineHoldings<T> {
  readonly byMachine: ReadonlyMap<string, MachineHolding<T>>;
  /** Main's machine, from the one role derivation; null when no copy is Main. */
  readonly mainEnvironmentId: string | null;
}

/**
 * Each machine's holding, keyed by environment id. `projects` is every project this app
 * sees; `source` is the copy the dialog sends from. One detection rule (existingCopyOn)
 * and one role derivation (copyRoles), the same ones the menus and Settings use.
 */
export function machineHoldings<T extends SendCopy>(input: {
  readonly source: T;
  readonly machineIds: readonly string[];
  readonly projects: readonly T[];
  /** Old records of machines that joined again; the same set Settings passes. */
  readonly retired?: { has(environmentId: string): boolean } | undefined;
}): MachineHoldings<T> {
  const logical = input.source.workspaceSettings?.logicalProject?.id ?? null;
  const members =
    logical === null
      ? []
      : input.projects.filter((item) => item.workspaceSettings?.logicalProject?.id === logical);
  const roles = copyRoles(members, input.retired);
  const isMain = (copy: T) => roles.get(`${copy.environmentId}:${copy.id}`)?.role === "main";
  const main = members.find(isMain) ?? null;
  const byMachine = new Map<string, MachineHolding<T>>();
  for (const environmentId of input.machineIds) {
    const there = input.projects.filter((item) => item.environmentId === environmentId);
    const found = existingCopyOn({ source: input.source, candidates: there });
    if (found.kind === "none") byMachine.set(environmentId, { kind: "none" });
    else if (found.kind === "several")
      byMachine.set(environmentId, {
        kind: "several",
        copies: found.copies,
        mainId: found.copies.find(isMain)?.id ?? null,
      });
    else
      byMachine.set(environmentId, {
        kind: isMain(found.copy) ? "main" : "copy",
        copy: found.copy,
      });
  }
  return { byMachine, mainEnvironmentId: main?.environmentId ?? null };
}

/**
 * The holding once the person picked among several copies: the picked one, as Main or a
 * copy; still "several" until they pick. Every other holding is itself.
 */
export function pickedHolding<T extends { readonly id: string }>(
  holding: MachineHolding<T>,
  pickedId: string | null,
): MachineHolding<T> {
  if (holding.kind !== "several") return holding;
  const copy = holding.copies.find((item) => item.id === pickedId);
  if (!copy) return holding;
  return { kind: copy.id === holding.mainId ? "main" : "copy", copy };
}

/** The two choices, in the owner's words; Copy first, the default. */
export const SEND_CHOICES: Readonly<
  Record<SendChoice, { readonly label: (there: string) => string; readonly detail: string }>
> = {
  copy: { label: (there) => `Copy to ${there}`, detail: "Keep working here." },
  move: {
    label: (there) => `Move to ${there}`,
    detail: "Work continues there, and this copy stops starting work.",
  },
};

/** Said once under the machines when the chosen one already has the project. */
export function existingCopyLine(input: {
  readonly there: string;
  readonly holding: MachineHolding<{ readonly workspaceRoot: string }>;
}): string | null {
  const { there, holding } = input;
  if (holding.kind === "none") return null;
  if (holding.kind === "several")
    return `${there} has ${holding.copies.length} copies of this project. Pick the one to send to.`;
  const folder = displayFolder(holding.copy.workspaceRoot);
  if (holding.kind === "main")
    return `${there} already has Main, at ${folder}, so there is nothing to move.`;
  return `${there} already has a copy, at ${folder}. Only what it is missing is copied.`;
}

const files = (count: number) =>
  count === 1 ? "1 changed local file" : `${count} changed local files`;
const staying = (count: number) =>
  count === 1 ? "1 uncommitted file stays here." : `${count} uncommitted files stay here.`;

/**
 * The plan: exactly what the click does, in one or two sentences. `way` is how files
 * travel: the folder copy (the default), or Git only, which always moves Main.
 */
export function sendPlan(input: {
  readonly choice: SendChoice;
  readonly there: string;
  /** The machine Main is on now. */
  readonly main: string;
  readonly holding: MachineHolding<{ readonly workspaceRoot: string }>;
  readonly way: "copy" | "git";
  /** Uncommitted files here; null when unknown. */
  readonly localFiles: number | null;
}): string | null {
  const { there, holding } = input;
  if (holding.kind === "several") return null;
  const move = input.choice === "move" && holding.kind !== "main";
  const after = move
    ? `Work continues on ${there}, and this copy stops starting work.`
    : `Main stays on ${holding.kind === "main" ? there : input.main}.`;
  const into =
    holding.kind === "none"
      ? null
      : `${there}'s copy at ${displayFolder(holding.copy.workspaceRoot)}`;
  if (input.way === "git") {
    const left = input.localFiles ? ` ${staying(input.localFiles)}` : "";
    return `Push this machine's commits, then move Main to ${into ?? there}. ${after}${left}`;
  }
  const what = input.localFiles ? files(input.localFiles) : null;
  const first =
    into === null
      ? `Copy the folder to ${there}`
      : what
        ? `Copy ${what} into ${into}`
        : `Compare with ${into} and copy what it is missing`;
  return move ? `${first}, then move Main there. ${after}` : `${first}. ${after}`;
}
