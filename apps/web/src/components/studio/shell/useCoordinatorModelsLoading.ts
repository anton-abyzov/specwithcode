/**
 * Whether the host's models are still arriving: before its configuration
 * comes in, and while an enabled provider still shows the placeholder it has
 * before its first check. A view without a model then says models are loading
 * instead of asking for a choice. A provider that never reports (an agent left
 * unconfigured) stops counting after `MODELS_LOADING_LIMIT_MS`, so the choice
 * is offered rather than waiting for good.
 */
import type { ServerProvider } from "@specweave-studio/contracts";
import { providersChecking } from "@specweave-studio/shared/coordinatorDefault";
import { useEffect, useState } from "react";

export const MODELS_LOADING_LIMIT_MS = 30_000;

export function useCoordinatorModelsLoading(
  serverConfig: { readonly providers: ReadonlyArray<ServerProvider> } | null | undefined,
): boolean {
  const checking = serverConfig ? providersChecking(serverConfig.providers) : false;
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    if (!checking) return;
    const timer = setTimeout(() => setWaitedOut(true), MODELS_LOADING_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [checking]);
  return !serverConfig || (checking && !waitedOut);
}
