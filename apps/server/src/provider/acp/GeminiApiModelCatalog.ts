import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/**
 * A model the Gemini API lists for the instance's own key. Gemini CLI ships a
 * fixed model list in each release, so a model Google releases between CLI
 * releases (Gemini 4 Neon, November 2026) runs through `session/set_model`
 * but never shows in the agent's catalog. The key's own `models.list`
 * answers which models that key can run, including paid-tier-only ones.
 */
export interface GeminiApiListedModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
}

const GEMINI_AGENT_ID = "gemini";
const API_KEY_AUTH_METHOD = "gemini-api-key";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const LIST_TIMEOUT = "5 seconds";

/** Gemini text models: a numbered family such as gemini-3.8-flash or gemini-4-neon. */
const VERSIONED_GEMINI = /^gemini-\d+(?:\.\d+)?-[a-z]/;
/**
 * Variants that are not coding chat models: media, speech, live and
 * embedding models, tool-specific previews, and dated snapshots (…-09-2025)
 * that repeat a family already listed.
 */
const NOT_A_CODING_MODEL =
  /(?:image|tts|embedding|live|audio|transcribe|robotics|computer-use|customtools|omni|-\d{2}-\d{4}$)/;

/**
 * The Gemini API key an instance runs on, when it signs in with one. An
 * instance set to Vertex AI or a Google sign-in bills elsewhere, so the
 * Gemini API's list says nothing about what it can run.
 */
export function geminiApiKeyForInstance(
  settings: { readonly agentId: string; readonly authMethodId?: string | undefined },
  environment: NodeJS.ProcessEnv,
): string | undefined {
  // Only an explicit API-key sign-in proves which account turns run on: with
  // none set, Gemini CLI uses its own saved choice (a Google sign-in or
  // Vertex AI) even when GEMINI_API_KEY is in the environment.
  if (settings.agentId !== GEMINI_AGENT_ID) return undefined;
  if (settings.authMethodId?.trim() !== API_KEY_AUTH_METHOD) return undefined;
  const key = environment.GEMINI_API_KEY?.trim();
  return key ? key : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The coding models in a `models.list` response: generateContent text models
 * that think, newest family first. A preview is left out when its stable
 * release is listed too.
 */
export function parseGeminiApiModels(body: unknown): ReadonlyArray<GeminiApiListedModel> {
  const entries =
    body !== null &&
    typeof body === "object" &&
    Array.isArray((body as { models?: unknown }).models)
      ? (body as { models: ReadonlyArray<unknown> }).models
      : [];
  const models: Array<GeminiApiListedModel> = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.name === "string" ? raw.name.replace(/^models\//, "") : "";
    const methods = Array.isArray(raw.supportedGenerationMethods)
      ? raw.supportedGenerationMethods
      : [];
    if (
      !VERSIONED_GEMINI.test(id) ||
      NOT_A_CODING_MODEL.test(id) ||
      !methods.includes("generateContent") ||
      raw.thinking !== true
    ) {
      continue;
    }
    const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
    const contextWindow = positiveInt(raw.inputTokenLimit);
    const maxOutput = positiveInt(raw.outputTokenLimit);
    models.push({
      id,
      name: displayName || id,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutput ? { maxOutput } : {}),
    });
  }
  const ids = new Set(models.map((model) => model.id));
  return models
    .filter((model) => !(model.id.endsWith("-preview") && ids.has(model.id.slice(0, -8))))
    .toSorted((left, right) => familyVersion(right.id) - familyVersion(left.id));
}

function familyVersion(id: string): number {
  const match = /^gemini-(\d+)(?:\.(\d+))?/.exec(id);
  return match ? Number(match[1]) * 100 + Number(match[2] ?? 0) : 0;
}

/**
 * Lists the models the key can run. Any failure (network, a revoked key, a
 * slow answer) returns an empty list: the agent's own catalog still stands.
 */
export const fetchGeminiApiModels = (input: {
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
}): Effect.Effect<ReadonlyArray<GeminiApiListedModel>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const base = (input.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const response = yield* client
      .execute(
        HttpClientRequest.get(`${base}/v1beta/models?pageSize=1000`).pipe(
          HttpClientRequest.setHeaders({
            "x-goog-api-key": input.apiKey,
            accept: "application/json",
            "user-agent": "SpecWithCode",
          }),
        ),
      )
      .pipe(Effect.timeout(LIST_TIMEOUT));
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap((ok) => ok.json),
      Effect.timeout(LIST_TIMEOUT),
    );
    return parseGeminiApiModels(body);
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<GeminiApiListedModel> => []));

/** The last good list and when to read it again. */
export interface GeminiApiModelCache {
  readonly models: ReadonlyArray<GeminiApiListedModel>;
  readonly expiresAt: number;
}

export const EMPTY_GEMINI_API_MODEL_CACHE: GeminiApiModelCache = { models: [], expiresAt: 0 };
/** A good list is read again after the agent probe's own window. */
export const GEMINI_API_MODELS_TTL_MS = 15 * 60 * 1_000;
/** A failed or empty read waits this long, so a refused key is not re-read on every refresh. */
export const GEMINI_API_MODELS_RETRY_MS = 5 * 60 * 1_000;

/**
 * Returns the cached list, reading it again once it expires. A failed read
 * keeps the last good list and still moves the next try out.
 */
export const refreshGeminiApiModelCache = <R>(
  cache: Ref.Ref<GeminiApiModelCache>,
  read: Effect.Effect<ReadonlyArray<GeminiApiListedModel>, never, R>,
): Effect.Effect<ReadonlyArray<GeminiApiListedModel>, never, R> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(cache);
    if (current.expiresAt > now) return current.models;
    const fetched = yield* read;
    const failed = fetched.length === 0;
    const models = failed ? current.models : fetched;
    yield* Ref.set(cache, {
      models,
      expiresAt: now + (failed ? GEMINI_API_MODELS_RETRY_MS : GEMINI_API_MODELS_TTL_MS),
    });
    return models;
  });
