import type { RunFiles } from "./updateRun.ts";

/** RunFiles over a map, as the agent and main see one updates folder. */
export function memoryRunFiles(files = new Map<string, string>()): RunFiles & {
  readonly files: Map<string, string>;
} {
  return {
    files,
    read: (name) => files.get(name) ?? null,
    writeAtomic: (name, text) => void files.set(name, text),
    createExclusive: (name, text) => {
      if (files.has(name)) return false;
      files.set(name, text);
      return true;
    },
    rename: (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, text);
    },
    list: (directory) =>
      [...files.keys()]
        .filter((name) => name.startsWith(`${directory}/`))
        .map((name) => name.slice(directory.length + 1)),
    remove: (name) => void files.delete(name),
  };
}
