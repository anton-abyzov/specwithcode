export const filesystemEnvironment = { browse: (value: unknown) => value };
export const useFilesystemReadAccess = () => ({
  canReadFiles: true,
  isPending: false,
  error: null,
});
export const useEnvironmentQuery = (value: any) => {
  if (!value) return { data: null, error: null, isPending: false };
  (window as any).browsedMachine = value.environmentId;
  const path = value.input.partialPath
    .replace("~", value.environmentId === "m1" ? "/Users/remote" : "/Users/you")
    .replace(/\/$/, "");
  return {
    error: null,
    isPending: false,
    data: {
      parentPath: path,
      entries: path.endsWith("/Projects")
        ? []
        : [{ name: "Projects", fullPath: `${path}/Projects` }],
    },
  };
};
