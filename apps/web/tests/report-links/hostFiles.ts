/* The host as it was on October 20, 2026: the audit folder the report named. */
export const AUDIT = "/Users/you/.specwithcode/audits/2026-10-20";

export const HOST_FILES = new Map<string, string>([
  ...["A", "B", "C", "D", "E"].map(
    (batch) =>
      [
        `${AUDIT}/findings-${batch}.md`,
        `# Batch ${batch} findings\n\nOwner threads audited in batch ${batch}, with each missing gate.\n`,
      ] as const,
  ),
  [
    `${AUDIT}/INVENTORY.md`,
    "# Inventory\n\nEvery owner thread, its acceptance evidence and next action.\n",
  ],
]);

/** The names directly in `folder`, or null when the host has no such folder. */
export function listFolder(folder: string): Array<{ path: string; kind: "file" }> | null {
  const prefix = `${folder.replace(/\/+$/, "")}/`;
  const names = [...HOST_FILES.keys()]
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
    .map((path) => ({ path: path.slice(prefix.length), kind: "file" as const }));
  return names.length > 0 ? names : null;
}
