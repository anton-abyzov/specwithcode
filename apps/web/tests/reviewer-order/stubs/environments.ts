import { fixtureStore } from "./store";

export const useEnvironments = () => ({
  environments: [{ environmentId: "m4", serverConfig: { providers: fixtureStore.providers } }],
});
