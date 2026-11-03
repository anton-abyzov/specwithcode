/**
 * Whether a provider can run a turn at all on this host, apart from usage:
 * shared by the coordinator's send check and its fallback choice.
 *
 * @module providerSetup
 */
import { isProviderAvailable, type ServerProvider } from "@specweave-studio/contracts";

/**
 * Why a provider cannot start a coordinator turn on `model` at all, which no
 * usage reset fixes: missing from the host, off, not installed or prepared,
 * broken, or signed out. An unreported sign-in counts once the status check
 * passed: ACP providers such as Copilot never report one. Null when it can run.
 */
export function providerSetupProblem(
  provider: ServerProvider | undefined,
  model: string,
): string | null {
  if (provider === undefined) return "is not set up on this machine";
  if (!provider.enabled) return "is turned off in Settings > Providers";
  if (!isProviderAvailable(provider))
    return provider.unavailableReason ?? "is not available on this machine";
  if (!provider.installed) return provider.message ?? "is not installed on this machine";
  if (provider.status === "error") return provider.message ?? "failed its status check";
  const signedIn =
    provider.auth.status === "authenticated" ||
    (provider.auth.status === "unknown" && provider.status === "ready");
  const local = provider.models.some(
    (entry) =>
      (entry.slug === model || entry.aliases?.includes(model)) && entry.billing === "local",
  );
  if (!signedIn && !local) return provider.message ?? "is not signed in";
  return null;
}
