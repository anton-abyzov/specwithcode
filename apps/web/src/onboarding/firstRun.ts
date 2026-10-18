import { useCallback } from "react";
import type { OnboardingMachineRole } from "@specweave-studio/contracts";

import { ensureClientSettingsHydrated, persistClientSettingsUpdate } from "../hooks/useSettings";

/**
 * Marks first-run onboarding finished (or skipped) so FirstRunGate never
 * routes to the welcome wizard again. The gate itself lives in
 * `components/onboarding/FirstRunGate.tsx`.
 */
export function useCompleteOnboarding(): () => Promise<void> {
  return useCallback(async () => {
    await ensureClientSettingsHydrated();
    const onboardingCompletedAt = new Date().toISOString();
    await persistClientSettingsUpdate((current) => ({ ...current, onboardingCompletedAt }));
  }, []);
}

/**
 * Saves what the person chose this machine to be on first run: "joined" opens
 * to its status for the main machine, "main" to the full setup.
 */
export function useSetOnboardingMachineRole(): (role: OnboardingMachineRole) => Promise<void> {
  return useCallback(async (onboardingMachineRole) => {
    await ensureClientSettingsHydrated();
    await persistClientSettingsUpdate((current) => ({ ...current, onboardingMachineRole }));
  }, []);
}
