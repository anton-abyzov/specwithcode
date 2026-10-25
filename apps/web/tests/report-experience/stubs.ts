export function useAssetUrlState(_environmentId?: string, resource?: unknown) {
  // As the app does, nothing is asked for a resource it was not given.
  if (resource === null) return { _tag: "Loading" };
  return {
    _tag: "Success",
    url: "/report.html" + location.search,
    expiresAt: Date.now() + 3600000,
  };
}
export function useAssetUrlRefresh() {
  return async () => "/report.html" + location.search;
}
export function useTheme() {
  return {
    theme: "system",
    resolvedTheme: new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light",
    themeHalves: null,
  };
}
export function useClientSettings(select: (value: Record<string, string>) => unknown) {
  return select({ fontFamilySans: "system", fontFamilyCode: "system" });
}

/** The connection may read files unless the page asks for `&no-read`. */
export function useFilesystemReadAccess() {
  return { canReadFiles: !new URLSearchParams(location.search).has("no-read") };
}
/** A file the focused reader opens: synthetic text naming the path it was asked for. */
export function useProjectFileQuery(_environmentId: string, _cwd: string, path: string | null) {
  return {
    data: path === null ? null : { contents: `Fixture file\n${path}\n` },
    error: null,
    readError: null,
    isNotFile: false,
    isPending: false,
    refresh: () => {},
  };
}

/** A missing file's folder on the host: names beside it that look like what was meant. */
export async function folderEntriesOnHost(_environmentId: string, folder: string) {
  if (!folder.endsWith("/archive")) return null;
  return [
    { path: "report-final-v2.md", kind: "file" },
    { path: "report-draft.md", kind: "file" },
    { path: "summary.csv", kind: "file" },
  ];
}
