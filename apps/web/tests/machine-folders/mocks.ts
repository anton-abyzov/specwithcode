export const filesystemEnvironment = { browse: (value: unknown) => value };
export const useFilesystemReadAccess = () => ({
  canReadFiles: true,
  isPending: false,
  error: null,
});
export const projectEnvironment = { create: {} };
export const useAtomCommand = () => async (value: unknown) => {
  (window as any).savedFolder = value;
  return { _tag: "Success", value: {} };
};
export const useEnvironmentQuery = (value: any) => {
  if (!value) return { data: null, error: null, isPending: false };
  (window as any).browsedMachine = value.environmentId;
  // Mirrors the server: a trailing slash lists a folder, otherwise siblings by prefix.
  const raw = value.input.partialPath.replace("~", "/Users/you");
  const listing = raw.endsWith("/");
  const path = listing ? raw.replace(/\/$/, "") : raw.slice(0, raw.lastIndexOf("/"));
  const prefix = listing ? "" : raw.slice(raw.lastIndexOf("/") + 1);
  return {
    error: null,
    isPending: false,
    data: {
      parentPath: path,
      entries: path.endsWith("/Projects")
        ? [
            { name: "sw-easychamp", fullPath: `${path}/sw-easychamp` },
            { name: "another-project", fullPath: `${path}/another-project` },
          ].filter((entry) => entry.name.startsWith(prefix))
        : [],
    },
  };
};
