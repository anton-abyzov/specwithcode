export const projectWorkspace = { skills: () => null };
export const useEnvironmentQuery = () => ({
  data: null,
  error: null,
  failure: null,
  isPending: false,
  refresh() {},
});
export const serverEnvironment = { refreshProviders: {} };
export const useAtomCommand = () => async () => ({});
export const useSettingsProjectGroups = () => [
  {
    projectKey: "demo",
    memberProjects: [{ environmentId: "m3", id: "demo", physicalProjectKey: "m3:/work/demo" }],
  },
];
