// One machine this window waits on for a typed code; everything else is the real module.
// ?code= gives the machine's current code, ?state=offline drops the connection and
// ?state=connected is the machine reached another way, and ?state=reapproval is the
// machine no longer accepting this device's approval.
export * from "../../src/state/environments";

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "waiting";
const environments = [
  {
    environmentId: "env-prcty",
    label: "PRCTY-AABYZOV",
    connection:
      state === "connected"
        ? { phase: "connected" }
        : state === "reapproval"
          ? { phase: "error", reapprovalRequired: true }
          : state === "offline"
            ? { phase: "connecting" }
            : { phase: "connecting", deviceApprovalCode: params.get("code") ?? "UN5MBB" },
  },
];
export const useEnvironments = () => ({ environments });
export const usePrimaryEnvironmentId = () => "env-m5";
