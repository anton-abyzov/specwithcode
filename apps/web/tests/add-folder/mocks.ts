// A small, fixed disk per machine. mac is this Mac, linux is a remote Linux
// machine and pc is a remote Windows PC. Nothing here touches a real disk.
type Entry = { name: string; kind?: "folder" | "git" };
interface Disk {
  readonly home: string;
  readonly separator: "/" | "\\";
  readonly folders: Record<string, Entry[]>;
}
const DISKS: Record<string, Disk> = {
  mac: {
    home: "/Users/you",
    separator: "/",
    folders: {
      "/": [{ name: "Users", kind: "folder" }],
      "/Users": [{ name: "you", kind: "folder" }],
      "/Users/you": [
        { name: ".config" },
        { name: "Desktop", kind: "folder" },
        { name: "Documents", kind: "folder" },
        { name: "Downloads", kind: "folder" },
        { name: "Projects", kind: "folder" },
      ],
      "/Users/you/Desktop": [],
      "/Users/you/Documents": [{ name: "locked", kind: "folder" }],
      "/Users/you/Documents/locked": [],
      "/Users/you/Downloads": [],
      "/Users/you/Projects": [
        { name: "atlas-api", kind: "git" },
        { name: "notes", kind: "folder" },
        { name: "storefront", kind: "git" },
        { name: "weather", kind: "git" },
      ],
      "/Users/you/Projects/atlas-api": [
        { name: ".git" },
        { name: "api", kind: "folder" },
        { name: "docs", kind: "folder" },
      ],
      "/Users/you/Projects/atlas-api/api": [],
      "/Users/you/Projects/atlas-api/docs": [],
      // The photo's state: a folder with no folders inside.
      "/Users/you/Projects/notes": [],
      "/Users/you/Projects/storefront": [{ name: ".git" }],
      "/Users/you/Projects/weather": [{ name: ".git" }],
    },
  },
  linux: {
    home: "/home/you",
    separator: "/",
    folders: {
      "/": [{ name: "home", kind: "folder" }],
      "/home": [{ name: "you", kind: "folder" }],
      "/home/you": [
        { name: "Work", kind: "folder" },
        { name: "work", kind: "folder" },
      ],
      "/home/you/Work": [],
      "/home/you/work": [{ name: "client-app", kind: "git" }],
      "/home/you/work/client-app": [{ name: ".git" }],
    },
  },
  pc: {
    home: "C:\\Users\\you",
    separator: "\\",
    folders: {
      "C:": [{ name: "Users", kind: "folder" }],
      "C:\\Users": [{ name: "you", kind: "folder" }],
      "C:\\Users\\you": [
        { name: "Desktop", kind: "folder" },
        { name: "source", kind: "folder" },
      ],
      "C:\\Users\\you\\Desktop": [],
      "C:\\Users\\you\\source": [{ name: "repos", kind: "folder" }],
      "C:\\Users\\you\\source\\repos": [],
    },
  },
};

declare global {
  interface Window {
    /** Every folder the fixture asked a machine to list, in order. */
    browsed: string[];
  }
}
window.browsed = [];

export const filesystemEnvironment = {
  browse: (value: unknown) => value,
  createDirectory: "create-directory",
};
export const useFilesystemReadAccess = () => ({
  canReadFiles: true,
  isPending: false,
  error: null,
});
export const useAtomCommand = () => async () => ({ _tag: "Failure" });
export const useEnvironmentQuery = (value: any) => {
  const refresh = () => {};
  if (!value) return { data: null, error: null, isPending: false, refresh };
  const disk = DISKS[value.environmentId]!;
  const asked: string = value.input.partialPath;
  const expanded = asked.replace(/^~(?=$|[\\/])/, disk.home);
  const normalized = disk.separator === "\\" ? expanded.replaceAll("/", "\\") : expanded;
  const path = normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") || "/" : normalized;
  const key = `${value.environmentId}:${path}`;
  if (window.browsed.at(-1) !== key) window.browsed.push(key);
  const entries = disk.folders[path];
  if (entries === undefined) {
    return {
      data: null,
      isPending: false,
      refresh,
      error: { message: `The folder '${path}' does not exist on this machine.` },
    };
  }
  const join = (name: string) =>
    path.endsWith(disk.separator) ? `${path}${name}` : `${path}${disk.separator}${name}`;
  return {
    error: null,
    isPending: false,
    refresh,
    data: {
      parentPath: path === "C:" ? "C:\\" : path,
      homePath: disk.home,
      entries: entries
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({ ...entry, fullPath: join(entry.name) })),
    },
  };
};
