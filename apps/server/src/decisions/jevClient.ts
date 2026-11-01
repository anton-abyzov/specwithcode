import {
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResponse,
  parseDecisionResponse,
} from "@specweave-studio/shared/decisionModel";

import { scrubLogSecrets } from "../pullRequest/gitHubCheckFailureLog.ts";

export type JevProvider = "openrouter" | "typesafe";

/** System One endpoints; the request and answer shapes are the same on both. */
export const JEV_ENDPOINTS: Record<JevProvider, string> = {
  openrouter: "https://openrouter.ai/api/v1/systemone",
  typesafe: "https://api.typesafe.ai/v1/systemone",
};
/** The model each provider gets when none is set, as `specweave jev` defaults. */
export const JEV_DEFAULT_MODELS: Record<JevProvider, string> = {
  openrouter: "jev-1.13",
  typesafe: "jev-latest",
};
export const JEV_PROVIDER_LABELS: Record<JevProvider, string> = {
  openrouter: "OpenRouter",
  typesafe: "TypeSafe",
};

export interface JevConfig {
  readonly provider: JevProvider;
  readonly apiKey: string;
  readonly model: string;
}

/** The request with credential shapes, and the key itself, masked in every text. */
export function scrubDecisionRequest(request: DecisionRequest, apiKey: string): DecisionRequest {
  const scrub = (text: string) => scrubLogSecrets(text, [apiKey]);
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]): [string, DecisionQuestion] => {
      if (question.type === "choice")
        return [
          id,
          {
            ...question,
            instructions: scrub(question.instructions),
            criteria: Object.fromEntries(
              Object.entries(question.criteria).map(([name, meaning]) => [name, scrub(meaning)]),
            ),
          },
        ];
      if (question.type === "score")
        return [
          id,
          {
            ...question,
            instructions: scrub(question.instructions),
            criteria: question.criteria.map(scrub),
          },
        ];
      return [
        id,
        {
          ...question,
          instructions: scrub(question.instructions),
          ...(question.criteria === undefined ? {} : { criteria: scrub(question.criteria) }),
        },
      ];
    }),
  );
  return { state: scrub(request.state), questions };
}

/**
 * Asks Jev one or more typed questions about `request.state`, through
 * OpenRouter or TypeSafe. Credential shapes are masked before anything is
 * sent. Throws a user-facing message on any failure; the key and the
 * provider's error body never appear in it.
 */
export async function requestJevDecision(
  config: JevConfig,
  request: DecisionRequest,
  options: { readonly signal: AbortSignal; readonly timeoutMs: number },
  send: typeof fetch = fetch,
): Promise<DecisionResponse> {
  const label = JEV_PROVIDER_LABELS[config.provider];
  const scrubbed = scrubDecisionRequest(request, config.apiKey);
  let response: Response;
  try {
    response = await send(JEV_ENDPOINTS[config.provider], {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        state: scrubbed.state,
        questions: scrubbed.questions,
      }),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
      redirect: "error",
    });
  } catch {
    throw new Error(
      options.signal.aborted
        ? "The decision was cancelled."
        : `Jev did not answer within ${Math.round(options.timeoutMs / 100) / 10} s, or ${label} could not be reached.`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401 || response.status === 403
        ? `${label} refused the API key. Check it in Settings > Providers > Decision model.`
        : response.status === 402
          ? `Your ${label} account has no credit left for Jev.`
          : response.status === 429
            ? `Jev is at its request or usage limit. Check your ${label} account.`
            : response.status === 400 || response.status === 422
              ? "Jev could not read the question. Check the options and try again."
              : `Jev could not answer (HTTP ${response.status}). Try again.`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Jev returned an answer that is not JSON.");
  }
  const parsed = parseDecisionResponse(body);
  if (parsed === null) throw new Error("Jev returned an answer this version cannot read.");
  return parsed;
}
