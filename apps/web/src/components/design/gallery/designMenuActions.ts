/**
 * Rename and Duplicate from the design menu, over injected `design.apply` and
 * `design.copy` calls so the rules are tested without a server.
 */
import type {
  DesignApplyInput,
  DesignCopyInput,
  DesignRef,
  DesignSummary,
} from "@specweave-studio/contracts";

import { ownerInputOf } from "./galleryModel";

/** The longest title the contract accepts. */
export const DESIGN_TITLE_MAX = 180;

export type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

/** Saves a new title at the revision the list showed; resolves to an error message or null. */
export async function renameDesign(
  apply: (input: DesignApplyInput) => Promise<Outcome<unknown>>,
  summary: DesignSummary,
  title: string,
): Promise<string | null> {
  const next = title.trim();
  if (next === "") return "Enter a title.";
  if (next.length > DESIGN_TITLE_MAX) return `Use at most ${DESIGN_TITLE_MAX} characters.`;
  if (next === summary.title) return null;
  const result = await apply({
    owner: ownerInputOf(summary),
    designId: summary.ref.designId,
    expectedRevision: summary.revision,
    operations: [{ op: "set_title", title: next }],
  });
  return result.ok ? null : result.message;
}

/** "Pricing page" becomes "Pricing page copy", cut so it stays within the title limit. */
export function duplicateTitle(title: string): string {
  const base = (title.trim() || "Untitled").slice(0, DESIGN_TITLE_MAX - " copy".length).trimEnd();
  return `${base} copy`;
}

export type DuplicateResult =
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: true;
      readonly ref: DesignRef;
      readonly title: string;
      /** Set when the copy exists but kept the original title. */
      readonly renameProblem: string | null;
    };

/** Copies a design into its own owner, then titles the copy "<title> copy". */
export async function duplicateDesign(
  calls: {
    readonly copy: (
      input: DesignCopyInput,
    ) => Promise<Outcome<{ readonly ref: DesignRef; readonly document: { revision: number } }>>;
    readonly apply: (input: DesignApplyInput) => Promise<Outcome<unknown>>;
  },
  summary: DesignSummary,
): Promise<DuplicateResult> {
  const owner = ownerInputOf(summary);
  const copied = await calls.copy({ owner, designId: summary.ref.designId, to: owner });
  if (!copied.ok) return copied;
  const title = duplicateTitle(summary.title);
  const renamed = await calls.apply({
    owner,
    designId: copied.value.ref.designId,
    expectedRevision: copied.value.document.revision,
    operations: [{ op: "set_title", title }],
  });
  return renamed.ok
    ? { ok: true, ref: copied.value.ref, title, renameProblem: null }
    : { ok: true, ref: copied.value.ref, title: summary.title, renameProblem: renamed.message };
}
