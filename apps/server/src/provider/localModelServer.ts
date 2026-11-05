/**
 * Local model server support for the OpenCode driver.
 *
 * An OpenCode instance with `localModelServer` set talks to an OpenAI-compatible
 * server on the user's machine (Ollama, LM Studio, llama.cpp `llama-server`,
 * `mlx_lm.server`). The server's `/models` list becomes an OpenCode provider
 * named `local`, passed to the spawned OpenCode through
 * `OPENCODE_CONFIG_CONTENT`, so no API key or opencode.json edit is needed.
 *
 * @module provider/localModelServer
 */
import type { ProviderInstanceEnvironment } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

export const LOCAL_MODEL_PROVIDER_ID = "local";

/**
 * Whether an OpenCode model slug runs on the local model server. Such turns
 * skip Studio's own MCP tools: their ~150 tool schemas alone (~60K tokens)
 * exceed the context window of the small models local servers run.
 */
export function isLocalModelSlug(model: string | null | undefined): boolean {
  return model?.startsWith(`${LOCAL_MODEL_PROVIDER_ID}/`) ?? false;
}
const MODEL_LIST_TIMEOUT_MS = 3_000;

/**
 * Trims, adds `http://` when no scheme is given, drops trailing slashes and
 * appends `/v1` when the address has no path (`http://localhost:11434`).
 */
export function normalizeLocalServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const hasPath = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/./i.test(withScheme);
  return hasPath ? withScheme : `${withScheme}/v1`;
}

/** Reads model ids from an OpenAI-style `{ data: [{ id }] }` body; anything else yields none. */
export function parseLocalModelIds(body: unknown): ReadonlyArray<string> {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((entry) =>
      typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
  return [...new Set(ids)];
}

/** OpenCode config content that registers the local server as the `local` provider. */
export function buildLocalModelOpenCodeConfig(
  baseUrl: string,
  modelIds: ReadonlyArray<string>,
): string {
  return JSON.stringify({
    provider: {
      [LOCAL_MODEL_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local model",
        // Local servers ignore the key, but the SDK requires one.
        options: { baseURL: baseUrl, apiKey: "local" },
        models: Object.fromEntries(modelIds.map((id) => [id, { name: id }])),
      },
    },
  });
}

/** Lists the server's models; an unreachable server or a bad reply yields none. */
export const fetchLocalModelIds = (
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise(async () => {
    const response = await fetchImpl(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    });
    return response.ok ? parseLocalModelIds(await response.json()) : [];
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

/**
 * Adds the local provider's `OPENCODE_CONFIG_CONTENT` to the instance
 * environment. It does nothing for a disabled instance, when no local server
 * is set, when the instance reaches an external OpenCode server (`serverUrl`),
 * or when an `OPENCODE_CONFIG_CONTENT` already exists (in the instance or
 * inherited), since this config replaces rather than merges it.
 */
export const withLocalModelServerEnvironment = <
  Environment extends ProviderInstanceEnvironment | undefined,
>(input: {
  readonly enabled: boolean;
  readonly localModelServer: string;
  readonly serverUrl: string;
  readonly environment: Environment;
  /** OPENCODE_CONFIG_CONTENT inherited from the app's own environment, kept when set. */
  readonly inheritedConfigContent: string | undefined;
  readonly listModels?: (baseUrl: string) => Effect.Effect<ReadonlyArray<string>>;
}): Effect.Effect<Environment | ProviderInstanceEnvironment> =>
  Effect.gen(function* () {
    const baseUrl = normalizeLocalServerUrl(input.localModelServer);
    if (
      !input.enabled ||
      baseUrl.length === 0 ||
      input.serverUrl.trim().length > 0 ||
      input.inheritedConfigContent !== undefined ||
      input.environment?.some((variable) => variable.name === "OPENCODE_CONFIG_CONTENT")
    ) {
      return input.environment;
    }
    const modelIds = yield* (input.listModels ?? fetchLocalModelIds)(baseUrl);
    const injected: ProviderInstanceEnvironment = [
      ...(input.environment ?? []),
      {
        name: "OPENCODE_CONFIG_CONTENT",
        value: buildLocalModelOpenCodeConfig(baseUrl, modelIds),
        sensitive: false,
      },
    ];
    return injected;
  });
