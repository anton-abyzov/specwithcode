import { englishPhrase, type TranslatePhrase } from "../../i18n";
import type {
  ServerProvider,
  ServerProviderAuth,
  ServerProviderVersionAdvisory,
  ServerProviderCompatibilityAdvisory,
} from "@specweave-studio/contracts";
import { getOnboardingProviderState } from "../../onboarding/providerReadiness.logic";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-muted-foreground/50",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship. A ready provider without account metadata
 * remains available and does not imply an authentication failure.
 */
export function getProviderSummary(
  provider: ServerProvider | undefined,
  tx: TranslatePhrase = englishPhrase,
) {
  if (!provider) {
    return {
      headline: tx("Checking provider status"),
      detail: tx("Waiting for the server to report installation and authentication details."),
    };
  }
  if (!provider.enabled || provider.status === "disabled") {
    return {
      headline: tx("Disabled"),
      detail:
        provider.message ??
        tx("This provider is installed but disabled for new sessions in SpecWithCode."),
    };
  }
  if (!provider.installed) {
    return {
      headline: tx("Not found"),
      detail: provider.message ?? tx("CLI not detected on PATH."),
    };
  }
  if (provider.auth.status === "unauthenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel
        ? tx("Not authenticated · {account}", { account: authLabel })
        : tx("Not authenticated"),
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: tx("Needs attention"),
      detail:
        provider.message ??
        tx("The provider is installed, but the server could not fully verify it."),
    };
  }
  if (provider.status === "error") {
    return {
      headline: tx("Unavailable"),
      detail: provider.message ?? tx("The provider failed its startup checks."),
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel
        ? tx("Authenticated · {account}", { account: authLabel })
        : tx("Authenticated"),
      detail: provider.message ?? null,
    };
  }
  return {
    headline: tx("Available"),
    detail: provider.message ?? null,
  };
}

/** The one thing that moves an agent toward ready from where it is. */
export type ProviderStatusAction = "turnOn" | "signIn" | "install" | "checkAgain";

export interface ProviderStatusView {
  readonly state:
    | "off"
    | "checking"
    | "unavailable"
    | "notInstalled"
    | "signedOut"
    | "noAnswer"
    | "attention"
    | "ready";
  readonly tone: "ready" | "checking" | "quiet" | "attention";
  readonly headline: string;
  /** A second sentence, when it adds something the headline does not say. */
  readonly detail: string | null;
  /** The sign-in to name: the current one, or the last one read when a check gave no answer. */
  readonly account: ServerProviderAuth | null;
  readonly accountIsLastKnown: boolean;
  readonly action: ProviderStatusAction | null;
}

/**
 * Where the selected agent stands, for its status row in Settings > Providers:
 * what to say, whose account to name and the one button that helps.
 */
export function getProviderStatusView(
  provider: ServerProvider | undefined,
  enabled: boolean,
  tx: TranslatePhrase = englishPhrase,
): ProviderStatusView {
  const none = { detail: null, account: null, accountIsLastKnown: false, action: null } as const;
  if (!enabled) {
    return {
      ...none,
      state: "off",
      tone: "quiet",
      headline: tx("Off"),
      detail: tx("Turn it on to use it in chat."),
      action: "turnOn",
    };
  }
  if (!provider) return { ...none, state: "checking", tone: "checking", headline: tx("Checking…") };
  if (provider.availability === "unavailable") {
    return {
      ...none,
      state: "unavailable",
      tone: "attention",
      headline: tx("Unavailable"),
      detail: provider.unavailableReason ?? tx("This agent is unavailable on this machine."),
    };
  }
  const state = getOnboardingProviderState(provider);
  if (state === "checking" || state === "disabled") {
    return { ...none, state: "checking", tone: "checking", headline: tx("Checking…") };
  }
  if (state === "install") {
    return {
      ...none,
      state: "notInstalled",
      tone: "attention",
      headline: tx("Not installed"),
      // Where the app cannot install it, the machine's words are the only lead.
      detail: provider.message ?? null,
      action: "install",
    };
  }
  if (state === "signIn") {
    // The machine's own words here say to run a command; the button does that.
    return {
      ...none,
      state: "signedOut",
      tone: "attention",
      headline: tx("Not signed in"),
      action: "signIn",
    };
  }
  if (state === "ready") {
    const signedIn = provider.auth.status === "authenticated";
    return {
      ...none,
      state: "ready",
      tone: "ready",
      headline: signedIn ? tx("Signed in") : tx("Ready"),
      detail:
        provider.models.length === 0
          ? tx("No models reported yet. Refresh provider status after completing setup.")
          : null,
      account: signedIn ? provider.auth : null,
      action: provider.models.length === 0 ? "checkAgain" : null,
    };
  }
  // Not ready, and not for want of an install or a sign-in. A check that gave
  // no answer keeps the sign-in it read before, so the row can still name it.
  const lastKnown = provider.auth.status === "unknown" ? provider.lastKnownAuth : undefined;
  const signedIn = provider.auth.status === "authenticated";
  return {
    state: lastKnown ? "noAnswer" : "attention",
    tone: "attention",
    headline: provider.message ?? tx("Needs attention"),
    detail: lastKnown?.status === "unauthenticated" ? tx("Last time it was not signed in.") : null,
    account: signedIn ? provider.auth : lastKnown?.status === "authenticated" ? lastKnown : null,
    accountIsLastKnown: !signedIn && lastKnown?.status === "authenticated",
    action: "checkAgain",
  };
}

/**
 * Whether the status row shows the agent's own sign-in or install block, which
 * then leaves the Setup section until the agent is ready. It stays under the
 * row through every state on the way there, so a check in the middle of a
 * sign-in never moves it and loses what was typed.
 */
export function statusRowShowsSetup(provider: ServerProvider | undefined, enabled: boolean) {
  if (!provider) return false;
  const { state } = getProviderStatusView(provider, enabled);
  if (state === "notInstalled") return provider.setup?.canInstall === true;
  return state !== "ready" && state !== "off" && state !== "unavailable";
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  // Antigravity reports a release tag such as `agy_acp_server_20260818_01_RC01`.
  // Show the date and candidate so the row title keeps room for the name.
  const antigravity = /^agy_acp_server_(\d{4})(\d{2})(\d{2})_\d+(?:_(\w+))?$/.exec(version);
  if (antigravity) {
    const [, year, month, day, candidate] = antigravity;
    return `${year}-${month}-${day}${candidate ? ` ${candidate}` : ""}`;
  }
  // Only bare semver-like versions get a `v` prefix. Other tags are shown as-is.
  return /^\d/.test(version) ? `v${version}` : version;
}

const COMPATIBILITY_TITLES = {
  graceful: "Limited support",
  unsupported: "Unsupported version",
  broken: "Known broken version",
} as const;

/** Compatibility guidance shares the version popover, with safe install actions. */
export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
  compatibility?: ServerProviderCompatibilityAdvisory | undefined,
  showCompatibility = true,
): {
  readonly title: string;
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
  readonly targetVersion: string | null;
} | null {
  const latestIsIncompatible =
    compatibility?.latestVersionStatus === "broken" ||
    compatibility?.latestVersionStatus === "unsupported";
  if (
    showCompatibility &&
    compatibility &&
    (compatibility.status === "graceful" ||
      compatibility.status === "unsupported" ||
      compatibility.status === "broken")
  ) {
    const targetVersion = compatibility.recommendedVersion;
    const recommendation = getProviderVersionLabel(targetVersion) ?? compatibility.recommendedRange;
    return {
      title: COMPATIBILITY_TITLES[compatibility.status],
      detail:
        compatibility.message ??
        (recommendation ? `Use ${recommendation} for full support.` : "Update for full support."),
      updateCommand:
        targetVersion || latestIsIncompatible ? null : (advisory?.updateCommand ?? null),
      emphasis: compatibility.status === "graceful" ? "normal" : "strong",
      targetVersion,
    };
  }
  if (
    !advisory ||
    advisory.status === "current" ||
    advisory.status === "unknown" ||
    latestIsIncompatible
  ) {
    return null;
  }

  const label = "Update available";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    title: label,
    detail:
      advisory.message ??
      (versionLabel
        ? `${label}: install ${versionLabel}.`
        : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
    targetVersion: null,
  };
}
