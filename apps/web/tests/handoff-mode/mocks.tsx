// Stand-ins for the data modules the handoff views import; the views get their
// state through props in this fixture.
export const handoffMode = {};
export const runHandoffMode = async () => ({ ok: false, error: "fixture" });
export const useHandoffModeSnapshot = () => ({ snapshot: null, error: null });
export const handoffMachineCandidates = () => [];
export const useMachineNicknames = () => (id: string, fallback?: string | null) => fallback ?? id;
export const useStudioFleet = () => ({ snapshot: null, loading: false, failed: false });
export const readThreadShell = () => null;
export const useProjects = () => [];
export const usePrimaryEnvironmentId = () => null;
export const useRouter = () => ({ navigate: async () => {} });
export const useNavigate = () => async () => {};
export const useEnvironmentSettings = () => ({});
export const EMPTY_SERVER_PROVIDERS = [];
export const serverEnvironment = {};
export function HandoffModelPicker() {
  return null;
}
export const handoffBadgeFor = () => null;
export const incomingReplicaFor = () => null;
export const unreachableBadgeFor = () => null;
export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE = "Settings are unavailable.";
export const usePrimarySettingsAvailable = () => true;
export const mergeEnvironmentSettings = (() => null) as never;
export const persistClientSettingsPatch = (() => null) as never;
export const useEnvironments = (() => null) as never;
export const useServerConfigs = (() => null) as never;
export const environmentServerConfigsAtom = (() => null) as never;
export const useClientSettings = (() => null) as never;
