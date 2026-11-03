const noop = () => undefined;
export const sourceControlEnvironment = {
  checkRemoteAccess: noop,
  inspectDestination: noop,
  startProjectClone: noop,
};
export const useAtomCommand = () => noop;
export const useProjectClone = () => null;
export const waitForProject = noop;
export const ADD_TO_MACHINE_JOBS_EVENT = "fixture-jobs";
export const messageOf = () => "Fixture";
export const notifyAddToMachineJobs = noop;
export const unwrap = noop;
export const useCopyScope = () => ({
  loading: false,
  notice: null,
  selected: {
    repositories: [
      "repositories/acme/cloud-platform-datadog",
      "repositories/acme/api",
      "local-tools",
    ],
    repositoryOrigins: [
      { path: "repositories/acme/cloud-platform-datadog", kind: "remote" },
      { path: "repositories/acme/api", kind: "remote" },
      { path: "local-tools", kind: "copy" },
    ],
    truncated: false,
  },
});
