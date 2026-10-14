/** Transfer storage is historical execution state, never a saved project destination. */
export function isProjectFolder(folder: string, id = ""): boolean {
  const path = folder.replaceAll("\\", "/");
  return (
    !id.startsWith("machine-handoff:") &&
    !/(^|\/)machine-handoffs\/git\//.test(path) &&
    !/(^|\/)handoff-proof-[^/]+\//.test(path)
  );
}

export function groupMachineFolders<
  T extends { key: string; label: string; environmentId?: string; folder: string },
>(items: readonly T[]) {
  const machines = new Map<string, { key: string; label: string; folders: T[] }>();
  for (const item of items) {
    const key = item.environmentId ?? item.label;
    const machine = machines.get(key) ?? { key, label: item.label, folders: [] };
    if (!machine.folders.some((folder) => folder.folder === item.folder))
      machine.folders.push(item);
    machines.set(key, machine);
  }
  return [...machines.values()];
}
