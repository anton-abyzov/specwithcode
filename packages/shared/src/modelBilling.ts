/**
 * Who pays for one model's turns, combining what the provider reports per
 * model with what its sign-in proves for the whole instance.
 *
 * `providerFallback.ts` must not import this module: it imports
 * `isPerTokenProvider` from there, so the reverse import would be a cycle.
 * Code inside `providerFallback.ts` composes the same check from its own
 * `isPerTokenProvider` and the contracts helpers `isPaidModelBilling` and
 * `providerModelBilling`.
 *
 * @module modelBilling
 */
import {
  isPaidModelBilling,
  type ModelBilling,
  providerModelBilling,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { isPerTokenProvider } from "./providerFallback.ts";

/**
 * The billing of `model` (a slug) on `provider`: what the provider reports for
 * that model, else `api` when the instance itself is billed per token, else
 * `unknown`. A model reported as `unknown` on a per-token instance is `api`.
 */
export function modelBilling(
  provider: ServerProvider | undefined,
  model: string | undefined,
): ModelBilling {
  const reported = providerModelBilling(provider, model);
  if (reported !== undefined && reported !== "unknown") return reported;
  return isPerTokenProvider(provider) ? "api" : "unknown";
}

/**
 * Whether a turn on `modelSlug` costs money: the instance is billed per token,
 * or the model is served through a paid router or a keyed cloud API. Nothing
 * may pick such a model by itself.
 */
export function isPaidModel(
  provider: ServerProvider | undefined,
  modelSlug: string | undefined,
): boolean {
  return (
    isPerTokenProvider(provider) || isPaidModelBilling(providerModelBilling(provider, modelSlug))
  );
}

/** Provider ids of keyed cloud APIs, as OpenCode (models.dev) and Pi name them. */
const API_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "azure",
  "google",
  "google-vertex",
  "google-vertex-anthropic",
  "vertex",
  "amazon-bedrock",
  "bedrock",
  "deepseek",
  "moonshot",
  "moonshotai",
  "moonshotai-cn",
  "zai",
  "z-ai",
  "zhipu",
  "zhipuai",
  "xai",
  "mistral",
  "groq",
  "together",
  "togetherai",
  "fireworks",
  "fireworks-ai",
  "cerebras",
  "deepinfra",
  "perplexity",
  "cohere",
  // Gateways that bill a key per token: OpenCode Zen, Vercel AI Gateway, Hugging Face.
  "opencode",
  "vercel",
  "vercel-ai-gateway",
  "huggingface",
]);

/** Local runtime ids already used by provider inventories. */
const LOCAL_RUNTIME_IDS: ReadonlySet<string> = new Set(["ollama", "lmstudio"]);

/** Hosts (and their subdomains) of the same keyed cloud APIs. */
const API_HOST_DOMAINS: ReadonlyArray<string> = [
  "anthropic.com",
  "openai.com",
  "openai.azure.com",
  "googleapis.com",
  "amazonaws.com",
  "deepseek.com",
  "moonshot.ai",
  "moonshot.cn",
  "z.ai",
  "bigmodel.cn",
  "x.ai",
  "mistral.ai",
  "groq.com",
  "together.xyz",
  "together.ai",
  "fireworks.ai",
  "cerebras.ai",
  "deepinfra.com",
  "perplexity.ai",
  "cohere.com",
  "cohere.ai",
  "ai-gateway.vercel.sh",
  "huggingface.co",
];

function onDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function urlOf(baseUrl: string): URL | null {
  const trimmed = baseUrl.trim();
  if (trimmed === "") return null;
  for (const candidate of [trimmed, `http://${trimmed}`]) {
    try {
      const url = new URL(candidate);
      if (url.hostname !== "") return url;
    } catch {
      // Not a URL; try it as a bare host.
    }
  }
  return null;
}

function hostOf(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "::") return true;
  // URL normalizes an IPv4-mapped 127.x.x.x to hex, as in ::ffff:7f00:1.
  return /^127(\.\d{1,3}){3}$/.test(host) || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host);
}

/** Loopback locates the endpoint; it does not prove free inference. */
export function isLoopbackBaseUrl(baseUrl: string | null | undefined): boolean {
  const url = baseUrl ? urlOf(baseUrl) : null;
  return url !== null && isLoopbackHost(hostOf(url));
}

/**
 * The billing a provider adapter can prove from where a model is served:
 * OpenRouter (by provider id or host) is `paid-router`. On loopback only a
 * known local runtime is `local`; keyed API ids stay `api`, and unidentified
 * proxies are `unknown`. Known cloud APIs elsewhere are `api`.
 *
 * OpenRouter wins over loopback, since a local proxy in front of it still
 * bills per token. A subscription login (OpenCode's Claude Pro/Max sign-in,
 * a coding plan) cannot be proven from an id alone, so a provider id here
 * always reads as its keyed API; an adapter that knows the sign-in is a
 * subscription reports `subscription` instead of calling this. Coding-plan
 * ids such as `zai-coding-plan` are not in the list and stay `unknown`, as
 * does any base URL under a `/coding` path.
 */
export function classifyBaseUrlBilling(
  baseUrl: string | null | undefined,
  providerId: string | null | undefined,
): ModelBilling {
  const id = providerId?.trim().toLowerCase() ?? "";
  const url = baseUrl ? urlOf(baseUrl) : null;
  const host = url === null ? null : hostOf(url);
  if (id === "openrouter" || (host !== null && onDomain(host, "openrouter.ai"))) {
    return "paid-router";
  }
  if (host !== null && isLoopbackHost(host)) {
    if (API_PROVIDER_IDS.has(id)) return "api";
    return LOCAL_RUNTIME_IDS.has(id) ? "local" : "unknown";
  }
  // A coding-plan endpoint (Z.ai's /api/coding/paas/v4, Kimi's /coding) is a
  // flat-rate subscription even under a keyed API's id and host.
  if (url !== null && /\/coding(\/|$)/i.test(url.pathname)) return "unknown";
  if (host !== null && API_HOST_DOMAINS.some((domain) => onDomain(host, domain))) return "api";
  return API_PROVIDER_IDS.has(id) ? "api" : "unknown";
}
