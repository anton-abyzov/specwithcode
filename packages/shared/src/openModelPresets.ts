/**
 * Open-model presets: Claude Code pointed at a vendor's own Anthropic-compatible
 * endpoint with the user's key, or at a local runtime (increment 1513).
 *
 * Presets are data. An instance made from one carries a non-sensitive marker
 * row, {@link OPEN_MODEL_PRESET_ENV}, which the server copies to
 * `ServerProvider.openModelPreset`. Every open-model rule keys on that marker,
 * so instances people built by hand with their own base URL behave as before.
 *
 * Endpoints, key variables and model ids come from each vendor's Claude Code
 * guide, read on {@link OPEN_MODEL_PRESETS_CHECKED_ON}. SpecWithCode never
 * sells, pools or resells model access: the user's key goes from this machine
 * straight to the vendor.
 *
 * This module imports only contracts, so `modelTracks.ts` and
 * `providerFallback.ts` can both use it without an import cycle.
 *
 * @module openModelPresets
 */
import type { ProviderInstanceEnvironment, ServerProvider } from "@specweave-studio/contracts";

/** Environment row naming the preset an instance was made from. Not a secret. */
export const OPEN_MODEL_PRESET_ENV = "SPECWITHCODE_OPEN_MODEL_PRESET";

/** The day the vendors' Claude Code guides were read for the values below. */
export const OPEN_MODEL_PRESETS_CHECKED_ON = "2026-11-28";

export type OpenModelPresetId = "deepseek" | "kimi" | "zai" | "openrouter" | "ollama" | "lmstudio";

/** How the person pays: their own key per token, or their own machine. */
export type OpenModelPresetKind = "key" | "local";

/** Claude Code's model slots, filled with the vendor's ids from its guide. */
export interface OpenModelPresetModels {
  /** The model a thread runs on by default (`opus` and `sonnet` slots). */
  readonly main: string;
  /** Background work: titles, summaries (`haiku` slot). */
  readonly small: string;
}

export interface OpenModelPreset {
  readonly id: OpenModelPresetId;
  /** Shown on the tile and as the instance's default name. */
  readonly label: string;
  /** Key in the web app's `ProviderBrand` set, for the official mark. */
  readonly brand: string;
  readonly kind: OpenModelPresetKind;
  /** `ANTHROPIC_BASE_URL`, the vendor's pay-per-token Anthropic endpoint or the local default. */
  readonly baseUrl: string;
  /**
   * The id `classifyBaseUrlBilling` reads with the base URL: a keyed API id,
   * `openrouter`, or a local runtime id.
   */
  readonly billingProviderId: string;
  /** Where the person creates a key; absent for local runtimes. */
  readonly keyConsoleUrl?: string;
  /** The vendor's Claude Code guide the values were taken from. */
  readonly docsUrl: string;
  /**
   * Fixed ids from the vendor guide. Absent when the person's own models
   * decide (local runtimes list theirs; OpenRouter serves hundreds).
   */
  readonly models?: OpenModelPresetModels;
  /** Bearer value a local runtime accepts without authentication. */
  readonly localToken?: string;
  /** Extra non-secret rows the vendor guide asks for. */
  readonly extraEnvironment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

export const OPEN_MODEL_PRESETS: ReadonlyArray<OpenModelPreset> = [
  {
    id: "deepseek",
    label: "DeepSeek",
    brand: "deepseek",
    kind: "key",
    baseUrl: "https://api.deepseek.com/anthropic",
    billingProviderId: "deepseek",
    keyConsoleUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code",
    models: { main: "deepseek-flash", small: "deepseek-flash" },
  },
  {
    id: "kimi",
    label: "Kimi",
    brand: "kimi",
    kind: "key",
    baseUrl: "https://api.moonshot.ai/anthropic",
    billingProviderId: "moonshot",
    keyConsoleUrl: "https://platform.kimi.ai/console/api-keys",
    docsUrl: "https://platform.kimi.ai/docs/guide/claude-code-kimi",
    models: { main: "kimi-k3", small: "kimi-k3" },
  },
  {
    id: "zai",
    label: "Z.ai GLM",
    brand: "zai",
    kind: "key",
    baseUrl: "https://api.z.ai/api/anthropic",
    billingProviderId: "zai",
    keyConsoleUrl: "https://z.ai/manage-apikey/apikey-list",
    docsUrl: "https://docs.z.ai/devpack/tool/claude",
    models: { main: "glm-5.4", small: "glm-5.3-flash" },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    brand: "openrouter",
    kind: "key",
    baseUrl: "https://openrouter.ai/api",
    billingProviderId: "openrouter",
    keyConsoleUrl: "https://openrouter.ai/settings/keys",
    docsUrl: "https://openrouter.ai/docs/guides/guides/claude-code-integration",
  },
  {
    id: "ollama",
    label: "Ollama",
    brand: "ollama",
    kind: "local",
    baseUrl: "http://localhost:11434",
    billingProviderId: "ollama",
    docsUrl: "https://docs.ollama.com/integrations/claude-code",
    localToken: "ollama",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    brand: "lmstudio",
    kind: "local",
    baseUrl: "http://localhost:1234",
    billingProviderId: "lmstudio",
    docsUrl: "https://lmstudio.ai/docs/integrations/claude-code",
    localToken: "lmstudio",
    extraEnvironment: [{ name: "CLAUDE_CODE_ATTRIBUTION_HEADER", value: "0" }],
  },
];

export function openModelPresetById(id: string | null | undefined): OpenModelPreset | undefined {
  const wanted = id?.trim().toLowerCase();
  return wanted ? OPEN_MODEL_PRESETS.find((preset) => preset.id === wanted) : undefined;
}

/** The preset an instance's environment rows name, if any. */
export function openModelPresetOfEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
): OpenModelPreset | undefined {
  const row = environment?.find((variable) => variable.name === OPEN_MODEL_PRESET_ENV);
  return openModelPresetById(row?.value);
}

/**
 * Whether a provider snapshot is an open-model route: a Claude Code instance
 * made from a preset. Billing alone cannot say this, since a Codex OpenAI key
 * or OpenRouter on Pi bill the same way.
 */
export function isOpenModelRoute(
  provider: Pick<ServerProvider, "openModelPreset"> | null | undefined,
): boolean {
  return openModelPresetById(provider?.openModelPreset) !== undefined;
}

/** Rows that stop Claude Code from reading any credential the preset does not set. */
export const OPEN_MODEL_BLANKED_CREDENTIALS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

export interface OpenModelEnvironmentInput {
  readonly preset: OpenModelPreset;
  /** The person's key; required for `key` presets, ignored for local ones. */
  readonly key?: string;
  /** Another address for a local runtime, such as `http://127.0.0.1:11500`. */
  readonly baseUrl?: string;
  /** A model id the person chose, for presets without fixed ids. */
  readonly model?: string;
}

/**
 * The environment rows for a new instance made from a preset. The key row is
 * always `sensitive: true`, so the server keeps it in its secret store and
 * clients only ever see it redacted. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`
 * keeps the key out of Bash commands, hooks and stdio MCP servers, so a tool
 * call cannot print it into the thread.
 */
export function buildOpenModelEnvironment(
  input: OpenModelEnvironmentInput,
): ProviderInstanceEnvironment {
  const { preset } = input;
  const key = input.key?.trim() ?? "";
  if (preset.kind === "key" && key.length === 0) {
    throw new Error(`${preset.label} needs your API key.`);
  }
  const baseUrl = input.baseUrl?.trim() || preset.baseUrl;
  const model = input.model?.trim();
  const models = preset.models ?? (model ? { main: model, small: model } : undefined);
  const row = (name: string, value: string, sensitive = false) => ({ name, value, sensitive });
  return [
    row(OPEN_MODEL_PRESET_ENV, preset.id),
    row("ANTHROPIC_BASE_URL", baseUrl),
    preset.kind === "key"
      ? row("ANTHROPIC_AUTH_TOKEN", key, true)
      : row("ANTHROPIC_AUTH_TOKEN", preset.localToken ?? preset.id),
    ...OPEN_MODEL_BLANKED_CREDENTIALS.map((name) => row(name, "")),
    row("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "1"),
    ...(models
      ? [
          row("ANTHROPIC_DEFAULT_OPUS_MODEL", models.main),
          row("ANTHROPIC_DEFAULT_SONNET_MODEL", models.main),
          row("ANTHROPIC_DEFAULT_HAIKU_MODEL", models.small),
          row("CLAUDE_CODE_SUBAGENT_MODEL", models.main),
        ]
      : []),
    ...(preset.extraEnvironment ?? []).map((extra) => row(extra.name, extra.value)),
  ];
}

/** The model ids a preset instance lists in the picker before any discovery. */
export function openModelPresetModelIds(
  preset: OpenModelPreset,
  chosenModel?: string,
): ReadonlyArray<string> {
  if (preset.models) return [...new Set([preset.models.main, preset.models.small])];
  const model = chosenModel?.trim();
  return model ? [model] : [];
}

/** The picker and Settings label for a route: who pays for its turns. */
export function openModelRouteLabel(preset: OpenModelPreset): "Your key" | "Local" {
  return preset.kind === "local" ? "Local" : "Your key";
}

/** One line for tooltips: the vendor bills the key at its own list price. No numbers, no savings. */
export function openModelPriceNote(preset: OpenModelPreset): string {
  return preset.kind === "local"
    ? `Runs on your own ${preset.label}.`
    : `${preset.label} bills your key at its own list price.`;
}
