import { resolveOfficialAcpRegistryIconUrl } from "@specweave-studio/contracts";

import { cn } from "~/lib/utils";
import { GitHubCopilotIcon } from "./GitHubCopilotIcon";
import type { Icon } from "./Icons";
import {
  AmpLogo,
  AntigravityLogo,
  AuggieLogo,
  ClaudeLogo,
  ClineLogo,
  CursorLogo,
  FactoryLogo,
  GeminiLogo,
  GooseLogo,
  GrokLogo,
  JunieLogo,
  KimiLogo,
  KiroLogo,
  MetaLogo,
  MistralLogo,
  OllamaLogo,
  OpenAILogo,
  OpenCodeLogo,
  PiLogo,
  QwenLogo,
} from "./ProviderLogoMarks";

/** A provider's brand; several drivers and registry agents can share one. */
export type ProviderBrand =
  | "claude"
  | "openai"
  | "grok"
  | "gemini"
  | "copilot"
  | "cursor"
  | "opencode"
  | "antigravity"
  | "pi"
  | "meta"
  | "ollama"
  | "qwen"
  | "kimi"
  | "mistral"
  | "kiro"
  | "goose"
  | "cline"
  | "auggie"
  | "factory"
  | "amp"
  | "junie";

const LOGO_BY_BRAND: Readonly<Record<ProviderBrand, Icon>> = {
  claude: ClaudeLogo,
  openai: OpenAILogo,
  grok: GrokLogo,
  gemini: GeminiLogo,
  copilot: GitHubCopilotIcon,
  cursor: CursorLogo,
  opencode: OpenCodeLogo,
  antigravity: AntigravityLogo,
  pi: PiLogo,
  meta: MetaLogo,
  ollama: OllamaLogo,
  qwen: QwenLogo,
  kimi: KimiLogo,
  mistral: MistralLogo,
  kiro: KiroLogo,
  goose: GooseLogo,
  cline: ClineLogo,
  auggie: AuggieLogo,
  factory: FactoryLogo,
  amp: AmpLogo,
  junie: JunieLogo,
};

const BRAND_BY_DRIVER: Readonly<Record<string, ProviderBrand>> = {
  claudeAgent: "claude",
  codex: "openai",
  grok: "grok",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
  pi: "pi",
  muse: "meta",
  ollama: "ollama",
};

/**
 * ACP Registry agent ids, which the registry assigns (never a user-editable
 * name). Exact ids first, then the vendor's id family.
 */
const BRAND_BY_ACP_AGENT: ReadonlyArray<readonly [RegExp, ProviderBrand]> = [
  [/^github-copilot(?:-cli)?$/, "copilot"],
  [/^gemini(?:-cli)?$/, "gemini"],
  [/^grok(?:-|$)/, "grok"],
  [/^(?:codex|openai)(?:-|$)/, "openai"],
  [/^claude(?:-|$)/, "claude"],
  [/^cursor(?:-|$)/, "cursor"],
  [/^opencode$/, "opencode"],
  [/^qwen(?:-|$)/, "qwen"],
  [/^kimi(?:-|$)/, "kimi"],
  [/^mistral(?:-|$)/, "mistral"],
  [/^kiro(?:-|$)/, "kiro"],
  [/^goose$/, "goose"],
  [/^cline$/, "cline"],
  [/^auggie$/, "auggie"],
  [/^(?:factory-)?droid$/, "factory"],
  [/^amp(?:-|$)/, "amp"],
  [/^junie$/, "junie"],
];

function acpAgentIdFromIconUrl(iconUrl: string | null | undefined): string | null {
  const allowed = resolveOfficialAcpRegistryIconUrl(iconUrl);
  if (allowed === null) return null;
  return (
    /\/registry\/v1\/latest\/([a-z0-9._-]+)\.svg$/.exec(new URL(allowed).pathname)?.[1] ?? null
  );
}

/** The bundled brand for a driver, or for an ACP Registry agent by its registry identity. */
export function providerBrandFor(input: {
  readonly driverKind: string;
  readonly acpRegistryAgentId?: string | null | undefined;
  readonly acpRegistryIconUrl?: string | null | undefined;
}): ProviderBrand | null {
  if (input.driverKind !== "acpRegistry") return BRAND_BY_DRIVER[input.driverKind] ?? null;
  const agentId =
    input.acpRegistryAgentId?.trim() || acpAgentIdFromIconUrl(input.acpRegistryIconUrl);
  if (!agentId) return null;
  return BRAND_BY_ACP_AGENT.find(([pattern]) => pattern.test(agentId))?.[1] ?? null;
}

/**
 * The one way the web app draws a provider's mark. Multicolour marks keep their
 * brand colours; monochrome ones follow the surrounding text colour.
 */
export function ProviderLogo({
  brand,
  className,
}: {
  readonly brand: ProviderBrand;
  readonly className?: string | undefined;
}) {
  const Logo = LOGO_BY_BRAND[brand];
  return <Logo className={cn("size-4 shrink-0", className)} data-provider-brand={brand} />;
}
