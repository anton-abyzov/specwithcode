/**
 * Send to another machine…: what each machine already holds of this project, and the one
 * sentence that says what the click will do, before it is clicked. Copy keeps Main where it
 * is; Move hands Main over. A machine with a copy gets that copy updated, not a second one.
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

/** The machine row's note: "Has Main", "Has a copy", "Has 2 copies", "No copy". */
export function holdingLabel(holding: MachineHolding<unknown> | undefined): string {
  if (!holding || holding.kind === "none") return "No copy";
  if (holding.kind === "main") return "Has Main";
  if (holding.kind === "copy") return "Has a copy";
  return `Has ${holding.copies.length} copies`;
}

/** The two choices, in the owner's words; Copy first, the default. */
export const sendChoiceLabel = (choice: SendChoice, there: string) =>
  choice === "copy"
    ? `Copy to ${there}. Keep working here.`
    : `Move to ${there}. Work continues there, and this copy stops starting work.`;

/** Said once under the machines when the chosen one already has the project. */
export function existingCopyLine(input: {
  readonly there: string;
  readonly holding: MachineHolding<{ readonly workspaceRoot: string }>;
  /** The destination brings an existing copy to this machine's commits (1326 T-03). */
  readonly updatesCommits: boolean;
}): string | null {
  const { there, holding } = input;
  if (holding.kind === "none") return null;
  if (holding.kind === "several")
    return `${there} has ${holding.copies.length} copies of this project. Pick the one to send to.`;
  const folder = displayFolder(holding.copy.workspaceRoot);
  if (holding.kind === "main")
    return `${there} already has Main, at ${folder}, so there is nothing to move.`;
  return input.updatesCommits
    ? `${there} already has a copy. It will be updated to this machine's commits.`
    : `${there} already has a copy, at ${folder}.`;
}

const files = (count: number) =>
  count === 1 ? "1 changed local file" : `${count} changed local files`;

/**
 * The plan: exactly what the click does, in one or two sentences.
 * `folder` is the existing copy's folder, or where a new one goes once inspected.
 */
export function sendPlan(input: {
  readonly choice: SendChoice;
  readonly there: string;
  /** The machine Main is on now. */
  readonly main: string;
  readonly holding: "main" | "copy" | "none";
  readonly folder: string | null;
  /** How a machine without a copy gets one: a clone from Git, or the folder copy review. */
  readonly way: "clone" | "copy";
  /** Uncommitted files here. */
  readonly localFiles: number;
  readonly updatesCommits: boolean;
}): string {
  const { there } = input;
  const at = input.folder ? displayFolder(input.folder) : null;
  const move = input.choice === "move" && input.holding !== "main";
  const after = move
    ? `Work continues on ${there}, and this copy stops starting work.`
    : `Main stays on ${input.holding === "main" ? there : input.main}.`;
  if (input.holding !== "none") {
    const copy = at ? `${there}'s copy at ${at}` : `${there}'s copy`;
    if (move)
      return `Push this machine's commits, then move Main to ${copy}. ${after}${input.localFiles > 0 ? ` ${input.localFiles === 1 ? "1 uncommitted file stays" : `${input.localFiles} uncommitted files stay`} here.` : ""}`;
    const update = input.updatesCommits
      ? `Update ${copy} to this machine's commits, then copy ${input.localFiles > 0 ? files(input.localFiles) : "what it is missing"}.`
      : input.localFiles > 0
        ? `Copy ${files(input.localFiles)} into ${copy}. Its commits update from Git when work starts there.`
        : `Compare with ${copy} and copy what it is missing. Its commits update from Git when work starts there.`;
    return `${update} ${after}`;
  }
  if (input.way === "clone")
    return move
      ? `Clone into ${at ?? "a new folder"} on ${there}, then move Main there. ${after}`
      : `Clone into ${at ?? "a new folder"} on ${there}. ${after}`;
  return move
    ? `Copy the folder to ${there}, then move Main there. You review the files first. ${after}`
    : `Copy the folder to ${there}. You review the files first. ${after}`;
}
