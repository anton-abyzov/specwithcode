/**
 * What the Agents step tells a person before they leave it: which agents can run
 * work on the chosen machines, from what the server reports, so a problem shows
 * here and not as a refused first chat.
 */

import type { ServerProvider } from "@specweave-studio/contracts";

import { providerCanRunWork } from "../components/studio/whatYouCanDo.logic";
import { getOnboardingProviderState } from "./providerReadiness.logic";

export interface AgentReadinessMachine {
  readonly label: string;
  /** Null until the machine has answered. */
  readonly providers: ReadonlyArray<ServerProvider> | null;
}

export type AgentReadiness =
  | { readonly kind: "checking" }
  | { readonly kind: "none" }
  | {
      readonly kind: "ready" | "unconfirmed";
      /** "Claude on Studio Mac" or, with one machine, "Claude". */
      readonly agents: readonly string[];
      /** Machines with nothing able to run, once they have answered. */
      readonly machinesWithoutAgent: readonly string[];
    };

/** A warning with an unread sign-in can run, but nothing has shown that it will. */
function isUnconfirmed(provider: ServerProvider): boolean {
  return provider.status === "warning" && provider.auth.status === "unknown";
}

function providerName(provider: ServerProvider): string {
  return provider.displayName || provider.driver;
}

export function summarizeAgentReadiness(
  machines: readonly AgentReadinessMachine[],
): AgentReadiness {
  const canRun = machines.map((machine) => ({
    label: machine.label,
    answered: machine.providers !== null,
    providers: (machine.providers ?? []).filter(providerCanRunWork),
    // A probe still running must not read as a finished "nothing is ready".
    checking: (machine.providers ?? []).some(
      (provider) => getOnboardingProviderState(provider) === "checking",
    ),
  }));
  const running = canRun.filter((machine) => machine.providers.length > 0);
  if (running.length === 0) {
    return canRun.some((machine) => !machine.answered || machine.checking)
      ? { kind: "checking" }
      : { kind: "none" };
  }
  const confirmed = running.flatMap((machine) =>
    machine.providers.filter((provider) => !isUnconfirmed(provider)),
  );
  const named =
    confirmed.length > 0 ? (provider: ServerProvider) => !isUnconfirmed(provider) : () => true;
  return {
    kind: confirmed.length > 0 ? "ready" : "unconfirmed",
    agents: running.flatMap((machine) =>
      [...new Set(machine.providers.filter(named).map(providerName))].map((name) =>
        machines.length > 1 ? `${name} on ${machine.label}` : name,
      ),
    ),
    machinesWithoutAgent: canRun
      .filter((machine) => machine.answered && !machine.checking && machine.providers.length === 0)
      .map((machine) => machine.label),
  };
}

/** One sentence for the step's status line. */
export function agentReadinessMessage(readiness: AgentReadiness): string {
  switch (readiness.kind) {
    case "checking":
      return "Checking which agents can run…";
    case "none":
      return "No agent is ready yet, so chats will not start. Sign in above, or add one later in Settings > Providers.";
    case "ready":
    case "unconfirmed": {
      const agents = readiness.agents.join(", ");
      const lead =
        readiness.kind === "ready"
          ? `Ready: ${agents}.`
          : `${agents} could not be confirmed. It may still work; your first chat will tell.`;
      return readiness.machinesWithoutAgent.length > 0
        ? `${lead} Nothing is ready on ${readiness.machinesWithoutAgent.join(", ")}, so chats there will not start.`
        : lead;
    }
  }
}
