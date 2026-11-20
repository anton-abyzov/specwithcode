import type { ProviderOptionDescriptor } from "@specweave-studio/contracts";
import { findEffortDescriptor } from "@specweave-studio/shared/effortLevel";
import { isReasoningCapableModel } from "@specweave-studio/shared/model";

/**
 * The effort option an ACP agent reads, by registry agent id. GitHub Copilot
 * CLI advertises `reasoning_effort` per model, but discovery sees only the
 * probe session's current model, and that model can have none (or the probe
 * can return no options at all). Every model would then show no Effort.
 */
const AGENT_EFFORT_OPTIONS: Readonly<
  Record<string, { readonly id: string; readonly label: string }>
> = {
  "github-copilot-cli": { id: "reasoning_effort", label: "Reasoning Effort" },
};

/** Levels Copilot lists for every reasoning model it serves. */
const FALLBACK_LEVELS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium", isDefault: true },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
] as const;

/**
 * A reasoning model on an agent with a known effort option keeps an Effort
 * setting when discovery did not report one. The session applies it only
 * when the live session offers that option (configureAcpOptions skips it
 * otherwise), so the fallback never fails a turn.
 */
export function withAcpEffortFallback(
  agentId: string,
  slug: string,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ProviderOptionDescriptor> {
  const option = AGENT_EFFORT_OPTIONS[agentId];
  if (!option || findEffortDescriptor(descriptors) || !isReasoningCapableModel(slug))
    return descriptors;
  return [
    ...descriptors,
    {
      id: option.id,
      label: option.label,
      type: "select",
      options: FALLBACK_LEVELS.map((level) => ({ ...level })),
      currentValue: "medium",
    },
  ];
}
