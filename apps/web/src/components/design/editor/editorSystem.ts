/**
 * Which design system the editor shows and offers. A design normally names
 * its system by id. A design made with a system "Found in this repository"
 * names none and carries a `reuse` record instead; the editor then follows
 * that found system: the owner's imported copy of it once one exists, else
 * the import proposal filed when the design was made. Either way the header
 * names it and the Properties panel and Fill list offer its tokens.
 */
import type {
  DesignDocument,
  DesignOperation,
  DesignOwnerInput,
  DesignReuse,
  DesignSystemId,
  DesignSystemSummary,
} from "@specweave-studio/contracts";

import { ownerOfSummary, sameOwner } from "../systems/reviewModel";

export const SYSTEM_NONE = "__none__";
export const SYSTEM_FOUND = "__found__";
export const SYSTEM_OPEN = "__open__";
export const SYSTEM_MANAGE = "__manage__";
export const SYSTEM_COPY = "copy:";
/** A new copy of another owner's system whose existing copy here predates it. */
export const SYSTEM_FRESH = "fresh:";

const sameName = (left: string, right: string) =>
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

/** The owner's imported system that a found-system design follows, matched by name. */
export function importedReuseSystem(
  reuse: DesignReuse,
  owner: DesignOwnerInput,
  systems: readonly DesignSystemSummary[],
): DesignSystemSummary | null {
  return (
    systems.find(
      (system) => sameOwner(ownerOfSummary(system), owner) && sameName(system.name, reuse.name),
    ) ?? null
  );
}

/** Where the editor's tokens come from. */
export type EditorSystemSource =
  | { readonly kind: "none" }
  /** The design names the system. */
  | { readonly kind: "design"; readonly systemId: DesignSystemId }
  /** A found-system design whose system the owner has since imported. */
  | { readonly kind: "imported"; readonly systemId: DesignSystemId }
  /** A found-system design read from its import proposal. */
  | { readonly kind: "proposal"; readonly proposalId: string }
  /** A found-system design whose proposal is gone (the server restarted) and nothing imported. */
  | { readonly kind: "found-unavailable" };

export function editorSystemSource(
  document: Pick<DesignDocument, "designSystem" | "reuse"> | null,
  owner: DesignOwnerInput | null,
  systems: readonly DesignSystemSummary[] | null,
): EditorSystemSource {
  if (document === null) return { kind: "none" };
  if (document.designSystem !== null) return { kind: "design", systemId: document.designSystem };
  const reuse = document.reuse;
  if (reuse === undefined || owner === null) return { kind: "none" };
  const imported = systems === null ? null : importedReuseSystem(reuse, owner, systems);
  if (imported !== null) return { kind: "imported", systemId: imported.ref.systemId };
  if (reuse.proposalId !== undefined) return { kind: "proposal", proposalId: reuse.proposalId };
  return { kind: "found-unavailable" };
}

export interface EditorSystemChoices {
  /** The owner's own systems. */
  readonly own: readonly DesignSystemSummary[];
  /** Other owners' systems, offered as a copy into this owner. */
  readonly others: readonly DesignSystemSummary[];
  /** The found system the design follows while it names none. */
  readonly found: {
    readonly name: string;
    /** The owner's imported copy, which picking the found item links by id. */
    readonly importedId: DesignSystemId | null;
  } | null;
  /** The picker's value. */
  readonly value: string;
  /** The trigger's text. */
  readonly label: string;
  /** The system page "Open design system" goes to; null when there is none to open. */
  readonly open: { readonly owner: DesignOwnerInput; readonly systemId: DesignSystemId } | null;
}

export function editorSystemChoices(input: {
  readonly owner: DesignOwnerInput;
  readonly systems: readonly DesignSystemSummary[] | null;
  readonly value: DesignSystemId | null;
  readonly reuse: DesignReuse | null;
  readonly canCopy: boolean;
  /** A system just copied in, before the list refreshes. */
  readonly copied?: { readonly id: DesignSystemId; readonly name: string } | null;
}): EditorSystemChoices {
  const all = input.systems ?? [];
  const own = all.filter((system) => sameOwner(ownerOfSummary(system), input.owner));
  const others = input.canCopy ? all.filter((system) => !own.includes(system)) : [];
  const reuse = input.value === null ? input.reuse : null;
  const imported = reuse === null ? null : importedReuseSystem(reuse, input.owner, all);
  const found =
    reuse === null ? null : { name: reuse.name, importedId: imported?.ref.systemId ?? null };
  const named =
    own.find((system) => system.ref.systemId === input.value)?.name ??
    (input.copied != null && input.copied.id === input.value ? input.copied.name : null);
  const label =
    input.value !== null
      ? (named ?? (input.systems === null ? "Loading…" : "Unknown system"))
      : (found?.name ?? "None");
  const openId = input.value ?? found?.importedId ?? null;
  return {
    own,
    others,
    found,
    value: input.value ?? (found === null ? SYSTEM_NONE : SYSTEM_FOUND),
    label,
    open: openId === null ? null : { owner: input.owner, systemId: openId },
  };
}

/**
 * The operations a system pick commits. None also drops the found system the
 * design was reusing; otherwise the header would still name it.
 */
export function systemChangeOperations(
  systemId: DesignSystemId | null,
  reuse: DesignReuse | null,
): DesignOperation[] {
  return [
    { op: "set_design_system", systemId },
    ...(systemId === null && reuse !== null ? [{ op: "set_reuse" as const, reuse: null }] : []),
  ];
}
