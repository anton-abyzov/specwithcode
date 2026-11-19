/**
 * The vendor family of a model, read from its slug or name: Claude through
 * GitHub Copilot is still Claude. No imports, so every model module can use it.
 *
 * @module modelVendor
 */
export type ModelFamily = "claude" | "openai" | "google" | "xai" | "meta" | "other";

const FAMILY_RULES: ReadonlyArray<readonly [RegExp, ModelFamily]> = [
  [/claude|opus|sonnet|haiku|fable/, "claude"],
  [/(?:^|[^a-z])(?:gpt|codex|o\d+)(?:$|[^a-z])/, "openai"],
  [/gemini|gemma|argon/, "google"],
  [/grok/, "xai"],
  [/llama|wonder|muse|(?:^|[^a-z])meta(?:$|[^a-z])/, "meta"],
];

/** The family a model belongs to, from its slug or name; never from the provider. */
export function modelFamily(model: {
  readonly slug: string;
  readonly name?: string | undefined;
}): ModelFamily {
  for (const spelling of [model.slug, model.name]) {
    if (spelling === undefined) continue;
    const key = spelling.toLowerCase();
    for (const [pattern, family] of FAMILY_RULES) if (pattern.test(key)) return family;
  }
  return "other";
}
