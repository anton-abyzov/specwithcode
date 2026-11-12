/**
 * The provider's own page where a person reads their usage or billing. Fixed public
 * URLs only: no account id or email is ever put in a link. A provider without a
 * known page gets no link rather than a guess.
 */
import { CHATGPT_USAGE_URL } from "./usageLimits.ts";

type ProviderUsageLinkKind = "claude" | "chatgpt" | "copilot" | "cursor";

export interface ProviderUsageLink {
  readonly kind: ProviderUsageLinkKind;
  readonly url: string;
  /** The accessible name and tooltip: `Claude usage`. */
  readonly label: string;
}

const LINKS: Record<ProviderUsageLinkKind, ProviderUsageLink> = {
  claude: { kind: "claude", url: "https://claude.ai/settings/usage", label: "Claude usage" },
  chatgpt: { kind: "chatgpt", url: CHATGPT_USAGE_URL, label: "ChatGPT usage" },
  copilot: {
    kind: "copilot",
    url: "https://github.com/settings/copilot",
    label: "Copilot usage",
  },
  cursor: { kind: "cursor", url: "https://cursor.com/dashboard", label: "Cursor usage" },
};

const BY_DRIVER: Record<string, ProviderUsageLinkKind> = {
  claudeagent: "claude",
  claude: "claude",
  codex: "chatgpt",
  cursor: "cursor",
  copilot: "copilot",
};

/**
 * The usage page for a provider instance. ACP registry agents carry no driver of
 * their own, so their registry id or display name decides (`github-copilot`,
 * "Copilot personal").
 */
export function providerUsageLink(input: {
  readonly driver: string | null | undefined;
  readonly agentId?: string | null | undefined;
  readonly label?: string | null | undefined;
  /** False for API-key and cloud accounts: their usage lives in a console, not a plan page. */
  readonly subscription?: boolean;
}): ProviderUsageLink | null {
  if (input.subscription === false) return null;
  const driver = (input.driver ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const kind =
    BY_DRIVER[driver] ??
    (/copilot/i.test(`${input.agentId ?? ""} ${input.label ?? ""}`) ? "copilot" : undefined) ??
    (/cursor/i.test(`${input.agentId ?? ""}`) ? "cursor" : undefined);
  return kind ? LINKS[kind] : null;
}
