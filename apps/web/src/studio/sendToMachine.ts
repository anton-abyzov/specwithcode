/**
 * Copy to another machine…: what each machine already holds of this project, where Main is,
 * and the one sentence that says what the click will do, before it is clicked. A copy keeps
 * Main where it is; only Git only (no files copied) and "Make X main" move it. A machine with
 * a copy gets that copy filled in, not a second one.
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
  /**
   * Main's machine, from the one role derivation: a copy in sight, else the successor the
   * source's own binding names. A source registered on its own leads itself. Null when
   * nothing in sight names Main.
   */
  readonly mainEnvironmentId: string | null;
}

/** Words for the dialog: an English phrase and its `{slot}` values, translated where shown. */
export interface SendText {
  readonly text: string;
  readonly values?: Readonly<Record<string, string>>;
}

const keyOf = (copy: { readonly environmentId: string; readonly id: string }) =>
  `${copy.environmentId}:${copy.id}`;

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
  const isMain = (copy: T) => roles.get(keyOf(copy))?.role === "main";
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
  return {
    byMachine,
    mainEnvironmentId:
      main?.environmentId ??
      roles.get(keyOf(input.source))?.mainEnvironmentId ??
      (logical === null ? input.source.environmentId : null),
  };
}

/**
 * The project a destination copy belongs to when the source is not linked to it: the copy
 * is a member of a logical project the source is no member of. `mainEnvironmentId` is that
 * project's Main, from the same role derivation; null when no copy in sight names it.
 * Copying files into such a copy never moves that Main and never links the two.
 */
export function otherProjectOf<T extends SendCopy>(input: {
  readonly source: T;
  /** The destination copy; null when the machine has none, or none is picked yet. */
  readonly copy: T | null;
  /** Every project this app sees, so the destination project's own members are in sight. */
  readonly projects: readonly T[];
  readonly retired?: { has(environmentId: string): boolean } | undefined;
}): { readonly mainEnvironmentId: string | null } | null {
  const logical = input.copy?.workspaceSettings?.logicalProject?.id;
  if (!input.copy || logical === undefined) return null;
  if (logical === input.source.workspaceSettings?.logicalProject?.id) return null;
  const members = input.projects.filter(
    (item) => item.workspaceSettings?.logicalProject?.id === logical,
  );
  const role = copyRoles(members, input.retired).get(keyOf(input.copy));
  return { mainEnvironmentId: role?.mainEnvironmentId ?? null };
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

/**
 * The dialog's line under its title: where the copy comes from and where Main is afterwards.
 * `main` is the machine Main is on now (the destination project's when the source is not
 * linked to it); null when nothing in sight names it. A source that is not linked to the
 * project the destination belongs to is said plainly instead.
 */
export function sendHeader(input: {
  readonly source: string;
  /** The chosen machine; null before one is picked. */
  readonly there: string | null;
  /** Main moves there: Git only, or a move asked for with "Make X main". */
  readonly move: boolean;
  readonly main: string | null;
  /** Set when the destination copy belongs to a project the source is not linked to. */
  readonly otherProject?: { readonly main: string | null } | null | undefined;
}): SendText {
  const { source, there, main } = input;
  if (input.otherProject && there)
    return input.otherProject.main
      ? {
          text: "From {source}. {source}'s copy is not linked to the project {machine} belongs to (Main: {main}).",
          values: { source, machine: there, main: input.otherProject.main },
        }
      : {
          text: "From {source}. {source}'s copy is not linked to the project {machine} belongs to.",
          values: { source, machine: there },
        };
  if (input.move)
    return there
      ? { text: "From {source}. Main moves to {machine}.", values: { source, machine: there } }
      : { text: "From {source}. Main moves to the machine you choose.", values: { source } };
  return main
    ? { text: "From {source}. Main stays on {main}.", values: { source, main } }
    : { text: "From {source}. Main stays where it is.", values: { source } };
}

/**
 * What copying into another project's copy does and does not do, said under the machines:
 * files only. Git only would move Main there, so it is off until the two are linked.
 */
export function otherProjectNote(input: {
  readonly source: string;
  readonly there: string;
  readonly main: string | null;
}): SendText {
  const { source, there, main } = input;
  return main
    ? {
        text: "Only files are copied into {machine}'s copy. Main stays on {main}, and {source} is not linked to that project. To make them one project, link {source} to it from the machine menu.",
        values: { source, machine: there, main },
      }
    : {
        text: "Only files are copied into {machine}'s copy. Its Main does not change, and {source} is not linked to that project. To make them one project, link {source} to it from the machine menu.",
        values: { source, machine: there },
      };
}

const files = (count: number) =>
  count === 1 ? "1 changed local file" : `${count} changed local files`;
const staying = (count: number) =>
  count === 1 ? "1 uncommitted file stays here." : `${count} uncommitted files stay here.`;

/**
 * The plan: exactly what the click does, in one or two sentences. `way` is how files
 * travel: the folder copy (the default), or Git only, which always moves Main. `choice` is
 * "move" for Git only and for a move asked for with "Make X main"; a plain copy is "copy".
 */
export function sendPlan(input: {
  readonly choice: SendChoice;
  readonly there: string;
  /** The machine Main is on now; null when nothing in sight names it. */
  readonly main: string | null;
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
    : holding.kind === "main" || input.main
      ? `Main stays on ${holding.kind === "main" ? there : input.main}.`
      : "Main stays where it is.";
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
