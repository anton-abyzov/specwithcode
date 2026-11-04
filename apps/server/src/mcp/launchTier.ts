/**
 * The model a worker starts on when the caller names a provider but no model:
 * that provider's tier model (see `tierModelFor`). Regular unless the caller
 * asked for frontier, or judged the task complex. An explicit model always
 * wins and never comes through here.
 */
import type {
  ModelLane,
  ProviderModelTier,
  ProviderModelTiers,
  ServerProvider,
} from "@specweave-studio/contracts";
import { tierModelFor } from "@specweave-studio/shared/modelTiers";

export function launchTier(
  tier: ProviderModelTier | undefined,
  taskLane: ModelLane | undefined,
): ProviderModelTier {
  return tier ?? (taskLane === "complex" ? "frontier" : "regular");
}

export function launchTierModel(input: {
  readonly provider: Pick<ServerProvider, "instanceId" | "driver" | "models">;
  readonly tier: ProviderModelTier | undefined;
  readonly taskLane: ModelLane | undefined;
  readonly tiers: ProviderModelTiers | undefined;
}): string | undefined {
  return tierModelFor(input.provider, launchTier(input.tier, input.taskLane), input.tiers);
}
