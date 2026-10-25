import type { OrchestrationV2TurnItem } from "@specweave-studio/contracts";

type FileChangeTurnItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

/**
 * The whole patch of a file change, read the way the item-level `diffStr` used
 * to be written: each file's headed patch in order, with a newline between two
 * patches when the first does not already end in one. Codex keeps its patches
 * only on `changes`, so readers that want one text call this instead of
 * reading `item.diffStr`. Items that still carry their own `diffStr` (other
 * providers, and rows written before the change) keep it.
 */
export function fileChangePatchText(item: FileChangeTurnItem): string | undefined {
  if (item.diffStr !== undefined) return item.diffStr;
  let joined: string | undefined;
  for (const change of item.changes ?? []) {
    if (change.diffStr === undefined) continue;
    if (joined === undefined) joined = change.diffStr;
    else joined += (joined.endsWith("\n") || joined === "" ? "" : "\n") + change.diffStr;
  }
  return joined;
}
