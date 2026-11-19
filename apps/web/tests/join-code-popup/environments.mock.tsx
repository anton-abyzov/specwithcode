// One machine this window waits on for a typed code; everything else is the real module.
export * from "../../src/state/environments";

const environments = [
  {
    environmentId: "env-prcty",
    label: "PRCTY-AABYZOV",
    connection: { deviceApprovalCode: "UN5MBB" },
  },
];
export const useEnvironments = () => ({ environments });
export const usePrimaryEnvironmentId = () => "env-m5";
