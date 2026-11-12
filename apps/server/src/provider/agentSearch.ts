/**
 * The search for installed agents, as the rest of the server sees it. The
 * probes live in `providerDiscovery.ts`; this file holds only the service, so
 * the provider registry can offer the search without importing them.
 */
import type { AgentSearch as AgentSearchSnapshot } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class AgentSearch extends Context.Service<
  AgentSearch,
  {
    /**
     * Answers at once with what has been found so far. Starts a search when
     * none is running and the last one is stale, or always with `fresh`.
     */
    readonly search: (options: { readonly fresh: boolean }) => Effect.Effect<AgentSearchSnapshot>;
  }
>()("specweave-studio/provider/agentSearch") {}
