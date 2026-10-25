/**
 * The design system a new design starts with, as the creation dialogs offer
 * it: the owner's own systems, systems a read-only scan found in the
 * project's repository, and other owners' systems, which are copied in only
 * when the person creates the design (never on selection, never on Cancel).
 */
import type {
  DesignOwnerInput,
  DesignSystemId,
  DesignSystemSummary,
} from "@specweave-studio/contracts";

import type { CopyOptions, CopyOutcome } from "../systems/DesignSystemPicker";
import { ownerKey, ownerOfSummary, sameOwner, systemKey } from "../systems/reviewModel";
import type { FoundSystem } from "./foundSystems";

/** One project's repository scan, as the page keeps it. */
export type ScanState =
  | { readonly status: "scanning" }
  | {
      readonly status: "done";
      readonly found: readonly FoundSystem[];
      /** The scan stopped at its file or time budget; some folders were skipped. */
      readonly truncated: boolean;
    }
  | { readonly status: "failed"; readonly message: string };

/**
 * What the person picked; `null` until they pick (the best found system stands
 * in). A `fresh` copy is made again even though the owner holds an older one.
 */
export type SystemChoice =
  | { readonly kind: "none" }
  | { readonly kind: "own"; readonly systemId: DesignSystemId }
  | { readonly kind: "found"; readonly key: string }
  | { readonly kind: "copy"; readonly key: string; readonly fresh?: true };

export interface SystemOptions {
  /** Systems the owner holds. */
  readonly own: readonly DesignSystemSummary[];
  /** Systems found in the owner's repository; offered only while it has none of its own. */
  readonly found: readonly FoundSystem[];
  /** Other owners' systems, offered for a copy at creation. */
  readonly others: readonly DesignSystemSummary[];
  /** A project's own confirmed system a new design starts with until the person picks. */
  readonly preferred?: DesignSystemId | null;
}

/** The project's most recently updated own system; the Playground keeps no default. */
const preferredOwn = (owner: DesignOwnerInput, own: readonly DesignSystemSummary[]) =>
  owner.kind !== "project" || own.length === 0
    ? null
    : own.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!.ref.systemId;

export function systemOptions(input: {
  readonly systems: readonly DesignSystemSummary[];
  readonly owner: DesignOwnerInput | null;
  readonly scan: ScanState | null;
  readonly canCopy: boolean;
}): SystemOptions {
  const { owner } = input;
  if (owner === null) return { own: [], found: [], others: [] };
  const own = input.systems.filter((system) => sameOwner(ownerOfSummary(system), owner));
  return {
    own,
    found:
      owner.kind === "project" && own.length === 0 && input.scan?.status === "done"
        ? input.scan.found
        : [],
    others: input.canCopy ? input.systems.filter((system) => !own.includes(system)) : [],
    preferred: preferredOwn(owner, own),
  };
}

const NONE = "none";

export function encodeChoice(choice: SystemChoice | null): string | null {
  if (choice === null) return null;
  switch (choice.kind) {
    case "none":
      return NONE;
    case "own":
      return `own:${choice.systemId}`;
    case "found":
      return `found:${choice.key}`;
    case "copy":
      return `${choice.fresh === true ? "fresh" : "copy"}:${choice.key}`;
  }
}

export function decodeChoice(value: string | null): SystemChoice | null {
  if (value === null) return null;
  if (value === NONE) return { kind: "none" };
  const colon = value.indexOf(":");
  const kind = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  if (kind === "own") return { kind: "own", systemId: rest as DesignSystemId };
  if (kind === "found") return { kind: "found", key: rest };
  if (kind === "copy") return { kind: "copy", key: rest };
  if (kind === "fresh") return { kind: "copy", key: rest, fresh: true };
  return null;
}

/**
 * The choice in effect: the person's, while the options still hold it, else
 * the project's own confirmed system, else the best system found in the
 * repository, else none chosen yet. An own system stays chosen while the list
 * loads; the server checks it on create.
 */
export function effectiveChoice(
  choice: SystemChoice | null,
  options: SystemOptions,
): SystemChoice | null {
  if (choice !== null) {
    if (choice.kind === "none" || choice.kind === "own") return choice;
    if (choice.kind === "found" && options.found.some((found) => found.key === choice.key))
      return choice;
    if (choice.kind === "copy" && options.others.some((system) => systemKey(system) === choice.key))
      return choice;
  }
  if (options.preferred != null) return { kind: "own", systemId: options.preferred };
  const best = options.found[0];
  return best === undefined ? null : { kind: "found", key: best.key };
}

export function chosenFound(choice: SystemChoice | null, options: SystemOptions) {
  return choice?.kind === "found"
    ? (options.found.find((found) => found.key === choice.key) ?? null)
    : null;
}

export function chosenCopy(choice: SystemChoice | null, options: SystemOptions) {
  return choice?.kind === "copy"
    ? (options.others.find((system) => systemKey(system) === choice.key) ?? null)
    : null;
}

export type ResolvedSystem =
  | {
      readonly ok: true;
      readonly designSystem: DesignSystemId | null;
      /** The chosen system's name, for the agent brief when the list has yet to show a copy. */
      readonly name: string | null;
      readonly found: FoundSystem | null;
    }
  | { readonly ok: false; readonly message: string };

/**
 * What the design is created with. A copy happens here, at the person's
 * Create or Start, once per source and owner: `copied` remembers it, so a
 * retry after a failed start does not copy again. The server returns the
 * owner's newest copy instead of another, and copies a `fresh` choice again
 * only when that copy predates the source.
 */
export async function resolveChoice(input: {
  readonly choice: SystemChoice | null;
  readonly options: SystemOptions;
  readonly owner: DesignOwnerInput;
  readonly copy:
    | ((system: DesignSystemSummary, options: CopyOptions) => Promise<CopyOutcome>)
    | null;
  readonly copied: Map<string, { readonly systemId: DesignSystemId; readonly name: string }>;
}): Promise<ResolvedSystem> {
  const { choice, options } = input;
  if (choice === null || choice.kind === "none")
    return { ok: true, designSystem: null, name: null, found: null };
  if (choice.kind === "own")
    return {
      ok: true,
      designSystem: choice.systemId,
      name: options.own.find((system) => system.ref.systemId === choice.systemId)?.name ?? null,
      found: null,
    };
  if (choice.kind === "found") {
    const found = chosenFound(choice, options);
    return { ok: true, designSystem: null, name: null, found };
  }
  const source = chosenCopy(choice, options);
  if (source === null || input.copy === null)
    return { ok: false, message: "That design system is no longer offered. Choose another." };
  const fresh = choice.fresh === true;
  const memo = `${ownerKey(input.owner)}|${systemKey(source)}${fresh ? "|fresh" : ""}`;
  const earlier = input.copied.get(memo);
  if (earlier !== undefined)
    return { ok: true, designSystem: earlier.systemId, name: earlier.name, found: null };
  const outcome = await input.copy(source, fresh ? { fresh: true } : {});
  if (!outcome.ok) return { ok: false, message: outcome.message };
  input.copied.set(memo, { systemId: outcome.systemId, name: outcome.name });
  return { ok: true, designSystem: outcome.systemId, name: outcome.name, found: null };
}
