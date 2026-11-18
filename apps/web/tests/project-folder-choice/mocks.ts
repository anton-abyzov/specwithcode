import { useSyncExternalStore } from "react";

// A small, fixed disk per machine. m1 is a remote Mac whose projects folder
// does not exist yet; m4 is this device.
const HOMES: Record<string, string> = { m4: "/Users/you", m1: "/Users/remote" };
type Entry = { name: string; kind?: "folder" | "git" };
const DISKS: Record<string, Record<string, Entry[]>> = {
  m4: {
    "/Users/you": [
      { name: ".config" },
      { name: "Desktop", kind: "folder" },
      { name: "Documents", kind: "folder" },
      { name: "Projects", kind: "folder" },
    ],
    "/Users/you/Projects": [
      { name: "github", kind: "folder" },
      { name: "playground", kind: "folder" },
    ],
    "/Users/you/Projects/github": [
      { name: "hack26-openai", kind: "git" },
      { name: "notes", kind: "folder" },
      { name: "specweave-umb", kind: "git" },
      { name: "vskill", kind: "git" },
    ],
    "/Users/you/Projects/github/hack26-openai": [
      { name: ".git" },
      { name: "api", kind: "folder" },
      { name: "docs", kind: "folder" },
      { name: "scripts", kind: "folder" },
    ],
    "/Users/you/Projects/github/notes": [],
    "/Users/you/Projects/playground": [],
    // Exists, but this account may not list it.
    "/Users/you/Private": [],
  },
  m1: {
    "/Users/remote": [
      { name: "Desktop", kind: "folder" },
      { name: "work", kind: "folder" },
    ],
    "/Users/remote/work": [{ name: "client-app", kind: "git" }],
  },
};
const UNREADABLE = new Set(["/Users/you/Private"]);
let version = 0;
const listeners = new Set<() => void>();
export const filesystemEnvironment = {
  browse: (value: unknown) => value,
  createDirectory: "create-directory",
};
export const useFilesystemReadAccess = () => ({
  canReadFiles: true,
  isPending: false,
  error: null,
});
export const useAtomCommand = () => async (value: any) => {
  const disk = DISKS[value.environmentId]!;
  const { parentPath, name } = value.input;
  (window as any).createdFolder = { machine: value.environmentId, parentPath, name };
  disk[parentPath]!.push({ name, kind: "folder" });
  disk[`${parentPath}/${name}`] = [];
  version += 1;
  for (const listener of listeners) listener();
  return { _tag: "Success", value: { path: `${parentPath}/${name}` } };
};
// `slow=1`: the server's answer for a folder asked about under a project name
// waits for window.answerFolderChecks(), as a slow machine's would.
let checksAnswered = new URLSearchParams(location.search).get("slow") !== "1";
(window as any).answerFolderChecks = () => {
  checksAnswered = true;
  version += 1;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useEnvironmentQuery = (value: any) => {
  useSyncExternalStore(subscribe, () => version);
  const refresh = () => {};
  if (!value) return { data: null, error: null, isPending: false, refresh };
  if (!checksAnswered && value.input.projectName !== undefined) {
    return { data: null, error: null, isPending: true, refresh };
  }
  (window as any).browsedMachine = value.environmentId;
  const home = HOMES[value.environmentId]!;
  const path = value.input.partialPath.replace(/^~/, home).replace(/\/$/, "") || "/";
  const entries = DISKS[value.environmentId]![path];
  if (entries === undefined) {
    return {
      data: null,
      isPending: false,
      refresh,
      error: `The folder '${path}' does not exist on this machine.`,
    };
  }
  // The server's decision for a folder asked about under its own name, as
  // first-run setup does: used as it is, and empty or not.
  const slug = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-");
  const asked = value.input.projectName as string | undefined;
  const outcome =
    asked !== undefined && slug(path.split("/").pop() ?? "") === slug(asked)
      ? {
          kind: "uses",
          path,
          because: entries.length === 0 ? "empty_named_like_project" : "named_like_project",
        }
      : undefined;
  return {
    error: null,
    isPending: false,
    refresh,
    data: {
      parentPath: path,
      homePath: home,
      version,
      ...(outcome === undefined ? {} : { outcome }),
      ...(UNREADABLE.has(path) ? { unreadable: true } : {}),
      entries: entries
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({ ...entry, fullPath: `${path}/${entry.name}` })),
    },
  };
};
