/**
 * The identity of a destination preview: the plan and every choice that shaped it. A window
 * reads it with the preview it shows and names it when the person approves, so an approval
 * never starts a plan another window changed meanwhile.
 *
 * @module destinationPreviewRevision
 */
import type { DestinationRecord } from "./destinationService.ts";
import type { Plan } from "./reconcile.ts";
import { sha256Hex } from "./wire.ts";

type Shaping = Pick<
  DestinationRecord,
  "decisions" | "clone" | "skip" | "mirror" | "selection" | "targetFolder" | "capturedAt"
>;

/** sha256 of the plan and the choices behind it, hex. */
export function previewRevision(record: Shaping, plan: Plan): string {
  const shaping = {
    targetFolder: record.targetFolder,
    selection: record.selection,
    decisions: record.decisions,
    clone: record.clone,
    skip: record.skip ?? [],
    mirror: record.mirror,
    capturedAt: record.capturedAt ?? null,
  };
  return sha256Hex(new TextEncoder().encode(JSON.stringify({ shaping, plan })));
}
