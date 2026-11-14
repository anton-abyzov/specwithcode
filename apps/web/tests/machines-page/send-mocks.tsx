// Stand-ins for the Send screen's server calls (`?scene=send`). The destination folder
// check answers from `?folder=` (free, taken); nothing is cloned or saved.
const folderState = new URLSearchParams(location.search).get("folder") ?? "free";

export const useAtomCommand = (command: unknown) => command;
export const sourceControlEnvironment = {
  checkRemoteAccess: async () => ({ _tag: "Success", value: { status: "ok" } }),
  inspectDestination: async ({ input }: { input: { path: string } }) => ({
    _tag: "Success",
    value: {
      path: input.path,
      state: folderState === "taken" && !input.path.endsWith("-2") ? "not-repository" : "missing",
    },
  }),
  startProjectClone: async () => ({ _tag: "Success", value: {} }),
};
export const waitForProject = async () => undefined;
export const useProjectClone = () => null;
export const ADD_TO_MACHINE_JOBS_EVENT = "fixture-jobs";
export const messageOf = (_cause: unknown, fallback: string) => fallback;
export const notifyAddToMachineJobs = () => undefined;
export const unwrap = (result: { value: unknown }) => result.value;
export const useCopyScope = () => ({
  loading: false,
  notice: null,
  selected: { repositories: [], repositoryOrigins: [], truncated: false },
});
export const isAtomCommandInterrupted = () => false;
export const squashAtomCommandFailure = (failure: unknown) => failure;
export const scopeProjectRef = (environmentId: string, projectId: string) => ({
  environmentId,
  projectId,
});
