// Fixture-only overrides; everything else comes from the real module.
export * from "../../../src/state/query";
import { REGISTRY } from "./server";
export function useEnvironmentQuery(descriptor: { input: { query: string } }) {
  const query = descriptor.input.query.toLowerCase();
  const agents = REGISTRY.filter(
    (agent) => !query || agent.id.includes(query) || agent.name.toLowerCase().includes(query),
  );
  return { data: { agents }, error: null, isPending: false, refresh: () => {} };
}
