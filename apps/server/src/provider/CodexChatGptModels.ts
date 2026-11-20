import type { ServerProviderModel } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

export class ChatGptCatalogError extends Schema.TaggedError<ChatGptCatalogError>()(
  "ChatGptCatalogError",
  { status: Schema.Int },
) {}

const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      display_name: Schema.NonEmptyString,
      visibility: Schema.String,
    }),
  ),
});

/** `gpt-6.1-sol` is version [6, 1] of line "sol"; undefined for a slug off that pattern. */
function codexLine(
  slug: string,
): { readonly line: string; readonly version: number[] } | undefined {
  const match = /^gpt-(\d+(?:\.\d+)*)-([a-z][a-z0-9-]*)$/i.exec(slug);
  return match === null
    ? undefined
    : { line: match[2]!.toLowerCase(), version: match[1]!.split(".").map(Number) };
}

/**
 * Options for a model the account lists but this Codex build's model/list
 * does not: the reasoning levels of the newest listed release of the same
 * line (GPT-6.1 Sol borrows GPT-6 Sol's), else none. Service tiers stay the
 * listed model's own, so none are borrowed.
 */
function borrowedCapabilities(
  slug: string,
  nativeModels: ReadonlyArray<ServerProviderModel>,
): ServerProviderModel["capabilities"] {
  const wanted = codexLine(slug);
  if (wanted === undefined) return null;
  const newer = (a: number[], b: number[]) => {
    for (let at = 0; at < Math.max(a.length, b.length); at++) {
      const diff = (a[at] ?? 0) - (b[at] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };
  return (
    nativeModels
      .flatMap((native) => {
        const line = codexLine(native.slug);
        const effort = native.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.id === "reasoningEffort",
        );
        return line?.line === wanted.line && effort !== undefined
          ? [{ version: line.version, capabilities: { optionDescriptors: [effort] } }]
          : [];
      })
      .sort((a, b) => newer(b.version, a.version))[0]?.capabilities ?? null
  );
}

/** Account choices come from OpenAI; native model/list contributes capability metadata only. */
export const chatGptModels = Effect.fn("chatGptModels")(function* (
  accessToken: string,
  nativeModels: ReadonlyArray<ServerProviderModel>,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(
    HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (response.status !== 200) return yield* new ChatGptCatalogError({ status: response.status });
  const catalog = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Catalog)));
  return catalog.models
    .filter((model) => model.visibility === "list")
    .map(
      (model) =>
        ({
          ...nativeModels.find((native) => native.slug === model.slug),
          capabilities:
            nativeModels.find((native) => native.slug === model.slug)?.capabilities ??
            borrowedCapabilities(model.slug, nativeModels),
          slug: model.slug,
          name: model.display_name,
          isCustom: false,
        }) satisfies ServerProviderModel,
    );
}, Effect.timeout("15 seconds"));
