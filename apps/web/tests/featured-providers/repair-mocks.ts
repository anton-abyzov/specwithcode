// Only the fixture Vite config injects these commands into the production repair component.
// No environment RPC or native provider is reached.
const state = () => new URLSearchParams(location.search).get("state");
const calls: Array<{ command: string; input: unknown }> = [];
Object.assign(window, { __repairCalls: calls });
export const serverEnvironment = {
  prepareAcpRegistryAgent: "prepare",
  refreshProviders: "refresh",
};
export const useEnvironmentScope = () => state() !== "readonly";
export const readEnvironmentScope = useEnvironmentScope;
export const useAtomCommand = (command: string) => async (input: unknown) => {
  calls.push({ command, input });
  if (state() === "preparing") return new Promise(() => {});
  if (state() === "error") throw new Error("Fixture environment unavailable");
  return { _tag: "Success", value: { agentId: "github-copilot-cli", version: "1.2.3-fixture" } };
};
