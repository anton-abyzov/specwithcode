import type { ProviderInstanceId, ServerProvider } from "@specweave-studio/contracts";
import {
  isExcludedFallbackModel,
  isGeminiSpendProvider,
  isPaidModelOn,
  type ProviderFallbackRule,
} from "./providerFallback.ts";

/**
 * Why the way back from a usage pre-switch leaves a thread on the fallback
 * for good: the original is a model the user excluded from automatic moves
 * (`providerLimitExcludedModels`), an instance billed per token, or Gemini or
 * Vertex, which bill a Cloud project. The server never moves a thread to one
 * by itself, the way back included.
 */
export type PreswitchReturnBlock = "excluded" | "per-token" | "gemini";

/** The block for `origin`, or null when it may go back once the original has room. */
export function preswitchReturnBlock(
  origin: { readonly modelSelection: { readonly instanceId: string; readonly model: string } },
  providers: ReadonlyArray<ServerProvider>,
  rule: Pick<ProviderFallbackRule, "providerLimitExcludedModels">,
): PreswitchReturnBlock | null {
  const { instanceId, model } = origin.modelSelection;
  if (
    isExcludedFallbackModel(
      rule.providerLimitExcludedModels,
      instanceId as ProviderInstanceId,
      model,
    )
  )
    return "excluded";
  const home = providers.find((provider) => provider.instanceId === instanceId);
  if (isGeminiSpendProvider(home)) return "gemini";
  if (isPaidModelOn(home, model)) return "per-token";
  return null;
}

/** What the thread's banner says about a block, after "It stays on the fallback: ". */
export const PRESWITCH_RETURN_BLOCK_REASON: Readonly<Record<PreswitchReturnBlock, string>> = {
  excluded: "the original model is excluded from automatic moves",
  "per-token": "the original model is billed per token",
  gemini: "Gemini and Vertex bill a Cloud project",
};
