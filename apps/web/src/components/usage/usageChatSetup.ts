import type { EnvironmentId, ServerProvider } from "@specweave-studio/contracts";

import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../../providerInstances";

/**
 * Whether a machine can start a chat now: at least one provider instance the
 * model picker would offer (enabled, available, probed ready) that is
 * installed and not signed out. Quota reports and hub accounts never count;
 * they read usage without proving an agent can run here.
 */
export function hasChatReadyProvider(providers: ReadonlyArray<ServerProvider>): boolean {
  return deriveProviderInstanceEntries(providers).some(
    (entry) =>
      isProviderInstancePickerReady(entry) &&
      entry.installed &&
      entry.snapshot.auth.status !== "unauthenticated",
  );
}

export interface ChatSetupPresentation {
  readonly entry: { readonly target: { readonly label: string } };
  readonly connection: { readonly phase: string };
  readonly serverConfig: { readonly providers?: ReadonlyArray<ServerProvider> | undefined } | null;
}

/**
 * The connected machines that need chat set up, in presentation order. A
 * machine still connecting, or whose provider list has not arrived, is left
 * out: an unknown is not a missing provider.
 */
export function environmentsNeedingChatSetup(
  presentations: ReadonlyMap<EnvironmentId, ChatSetupPresentation>,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }> {
  const needing: Array<{ readonly environmentId: EnvironmentId; readonly label: string }> = [];
  for (const [environmentId, presentation] of presentations) {
    if (presentation.connection.phase !== "connected") continue;
    const providers = presentation.serverConfig?.providers;
    if (providers === undefined) continue;
    if (hasChatReadyProvider(providers)) continue;
    needing.push({ environmentId, label: presentation.entry.target.label });
  }
  return needing;
}
