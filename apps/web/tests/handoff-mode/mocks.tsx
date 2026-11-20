import { Atom } from "effect/reactivity";

// Stand-ins for the data modules the handoff views import; the views get their
// state through props in this fixture.
export const handoffMode = {};
export const runHandoffMode = async () => ({ ok: false, error: "fixture" });
export const refreshHandoffMode = async () => {};
export const useHandoffModeSnapshot = () => ({ snapshot: null, error: null });
export const useHandoffModeSnapshots = () => new Map();
export const useLinkMachines = () => ({ label: (id: string) => id });
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
export const serverEnvironment = new Proxy({}, { get: (_, key) => ({ label: String(key) }) });
export const useHandoffModelSummary = () => null;
export const continueHereFailure = (error: string) => ({
  title: "Couldn't continue here",
  description: error,
});
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
// A real atom: machine identity derives from it at module level.
export const environmentServerConfigsAtom = Atom.make(new Map());
export const useClientSettings = (() => null) as never;
export const useUnreachableEnvironmentIds = () => new Set<string>();
// Added since 1.0.345: reach states, the fleet snapshot and nickname lookups the dialogs import.
export const useMachineReachStates = () => new Map();
export const usePrimaryFleetSnapshot = () => null;
export const resolveMachineNickname = (_names: unknown, id: string, fallback?: string | null) =>
  fallback ?? id;
export const useMachineNameSources = () => ({ nicknames: new Map(), labels: new Map() });
export const useKnownMachineSources = () => ({
  saved: new Map(),
  fleet: new Map(),
  removed: new Set<string>(),
});
export const useThreadShells = () => [];
export const useThreadShell = () => null;
export const useThreadVisibleTurnItems = () => [];
export const useEnvironment = () => null;
// state/session: the settings rows read the window's write scope; the fixture has none.
export const useEnvironmentScope = () => null;
export const useEnvironmentsWithScope = () => [];
export const readEnvironmentScope = () => null;
export const readEnvironmentScopeAccess = () => "unknown";
export const environmentSession = () => null;
export const usePreparedConnection = () => null;
export const awaitEnvironmentScope = async () => null;
