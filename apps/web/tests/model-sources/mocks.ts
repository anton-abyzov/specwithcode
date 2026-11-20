import { teamRulesFromSummary } from "../../src/teamRules/teamRulesView";

/** Every action the card takes is recorded here for the verifier, never sent anywhere. */
const fixtureWindow = window as unknown as { fixtureActions: unknown[] };
fixtureWindow.fixtureActions = [];
const record = (action: unknown) => fixtureWindow.fixtureActions.push(action);

export const useNavigate = () => (target: unknown) => record({ navigate: target });
export const useEnvironmentSettings = () => ({ providers: {}, providerInstances: {} });
export const usePersistEnvironmentProviderInstanceMutation = () => (mutation: unknown) =>
  record({ persist: mutation });
export const useEnvironmentScope = () => true;
export const useTeamRules = () => teamRulesFromSummary(undefined);
