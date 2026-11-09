// Stand-ins for the data modules the Away views import; the views get their
// state through props in this fixture.
export const handoffMode = {};
export const handoffModeFailureText = (outcome: unknown) => String(outcome);
export const useHandoffModeSnapshot = () => ({ snapshot: null, error: null });
export const useMachineNicknames = () => (id: string, fallback?: string | null) => fallback ?? id;
export const useStudioFleet = () => ({ snapshot: null, loading: false, failed: false });
export const useProjects = () => [];
export const useServerConfigs = () => new Map();
export const usePrimaryEnvironmentId = () => null;
export const useConnectedEnvironmentIds = () => [];
export const useEnvironmentScope = () => null;
export const useEnvironmentsWithScope = () => [];
export const useHandoffDestinations = () => [];
// Module-level code builds atoms from these; any call returns another stand-in.
const inert: any = new Proxy(function () {}, {
  get: (_, key) => (key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : inert),
  apply: () => inert,
});
export const connectionAtomRuntime = inert;
export const appAtomRegistry = inert;
export const awayRpc = new Proxy({}, { get: (_, key) => String(key) });
export const runAway = async () => ({ ok: false, error: "fixture" });
export const environmentSession = () => null;
export const readEnvironmentScope = () => null;
export const useEnvironments = () => ({ environments: [] });
export const usePreparedConnection = () => null;
