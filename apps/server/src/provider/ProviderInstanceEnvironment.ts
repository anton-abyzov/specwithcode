import type { ProviderInstanceEnvironment } from "@specweave-studio/contracts";

import { expandHomePath } from "../pathExpansion.ts";

// Only Codex/Claude consumer launch boundaries use native sanitization.
// Generic drivers, terminals, installation hooks and explicit API instances
// retain their configured environment through the ordinary merge helper.
const NATIVE_AUTH_ENVIRONMENT_KEYS = [
  "OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY", "CLAUDECODE",
] as const;
const COPIED_OAUTH_KEYS = new Set(["OPENAI_ACCESS_TOKEN", "CODEX_ACCESS_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDECODE"]);
const EXPLICIT_API_KEYS = new Set<string>(NATIVE_AUTH_ENVIRONMENT_KEYS.filter((key) => !COPIED_OAUTH_KEYS.has(key)));

export function hasExplicitProviderApiEnvironment(environment: ProviderInstanceEnvironment | undefined, provider?: "codex" | "claudeAgent"): boolean {
  return environment?.some((variable) => EXPLICIT_API_KEYS.has(variable.name) && (provider === undefined || (provider === "codex" ? variable.name.startsWith("OPENAI_") : variable.name.startsWith("ANTHROPIC_") || variable.name.startsWith("CLAUDE_CODE_USE_"))) && variable.value.trim().length > 0 && variable.value !== "0" && variable.value !== "false") ?? false;
}

/**
 * Whether a Claude launch environment sends its turns to Anthropic's own API
 * on an API key: a key is set and nothing redirects or replaces it. A router
 * or cloud instance (custom base URL, bearer token, Bedrock, Vertex, Foundry)
 * is billed elsewhere and does not count.
 */
export function isDirectAnthropicApiKeyEnvironment(environment: NodeJS.ProcessEnv): boolean {
  const set = (name: string) => {
    const value = environment[name]?.trim() ?? "";
    return value.length > 0 && value !== "0" && value !== "false";
  };
  return (
    set("ANTHROPIC_API_KEY") &&
    !["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(set)
  );
}

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) return baseEnv;
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment ?? []) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  return next;
}

/** Empty overrides prevent extendEnv:true from restoring parent API credentials. */
export function mergeNativeSubscriptionEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  provider?: "codex" | "claudeAgent",
): NodeJS.ProcessEnv {
  if (hasExplicitProviderApiEnvironment(environment, provider)) return mergeProviderInstanceEnvironment(environment, baseEnv);
  const next = { ...mergeProviderInstanceEnvironment(environment, baseEnv) };
  for (const key of NATIVE_AUTH_ENVIRONMENT_KEYS) next[key] = "";
  return next;
}
