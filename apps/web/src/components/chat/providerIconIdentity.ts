/**
 * The icon props a provider entry carries, kept apart from the icon component
 * so tests that stub `ProviderInstanceIcon` still get it (increment 1513).
 *
 * @module components/chat/providerIconIdentity
 */

/** The identity props a provider entry gives its icon: ACP agent, icon URL and open-model preset. */
export function providerIconIdentity(
  entry:
    | {
        readonly acpRegistryAgentId?: string | undefined;
        readonly acpRegistryIconUrl?: string | undefined;
        readonly openModelPreset?: string | undefined;
      }
    | null
    | undefined,
) {
  return {
    acpRegistryAgentId: entry?.acpRegistryAgentId,
    acpRegistryIconUrl: entry?.acpRegistryIconUrl,
    openModelPreset: entry?.openModelPreset,
  };
}
