import type { ProviderAccountRefusal } from "@specweave-studio/contracts";

/**
 * Google closed Gemini CLI to personal accounts (free Code Assist for
 * individuals, Google AI Pro and Ultra) on June 18, 2026. Google's sign-in
 * page still says "Authentication successful", then every session fails with
 * "This client is no longer supported for Gemini Code Assist for individuals.
 * ... migrate to the Antigravity suite of products". Signing in again cannot
 * help, so the app names the refusal instead of "not signed in".
 */
const PERSONAL_ACCOUNT_UNSUPPORTED = [
  /no longer supported for Gemini Code Assist for individuals/iu,
  /migrate to the Antigravity suite/iu,
];
// Google's structured code alone is generic; it counts only beside Gemini's own names.
const UNSUPPORTED_CLIENT = /\bUNSUPPORTED_CLIENT\b/u;
const GEMINI_CONTEXT = /\b(?:Gemini|Code Assist|cloudcode-pa)\b/iu;

export const PERSONAL_ACCOUNT_UNSUPPORTED_MESSAGE =
  "Google accepted the sign-in, but no longer serves Gemini CLI on personal Google accounts (free, Google AI Pro or Ultra). Sign in with a Gemini API key, Vertex AI, or a Gemini Code Assist Standard or Enterprise licence.";

export function providerAccountRefusalInText(
  text: string | undefined,
): ProviderAccountRefusal | undefined {
  if (text === undefined || text.length === 0) return undefined;
  const sample = text.slice(0, 8_192);
  return PERSONAL_ACCOUNT_UNSUPPORTED.some((pattern) => pattern.test(sample)) ||
    (UNSUPPORTED_CLIENT.test(sample) && GEMINI_CONTEXT.test(sample))
    ? "personal_account_unsupported"
    : undefined;
}

const TEXT_FIELDS = ["errorMessage", "message", "detail", "reason"] as const;

/** Looks through an error, its ACP `data` and its causes; never returns the text itself. */
export function providerAccountRefusal(cause: unknown): ProviderAccountRefusal | undefined {
  try {
    return findRefusal(cause);
  } catch {
    // An accessor that throws hides nothing worth failing for.
    return undefined;
  }
}

function findRefusal(cause: unknown): ProviderAccountRefusal | undefined {
  const seen = new Set<unknown>();
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (typeof current === "string") return providerAccountRefusalInText(current);
    if (typeof current !== "object") return undefined;
    const record = current as Record<string, unknown>;
    for (const field of TEXT_FIELDS) {
      const value = record[field];
      if (typeof value === "string") {
        const found = providerAccountRefusalInText(value);
        if (found !== undefined) return found;
      }
    }
    const data = record.data;
    if (data !== undefined && data !== null) {
      // The code may sit in `data` while Gemini's name is in the message.
      const own = TEXT_FIELDS.map((field) => record[field])
        .filter((value): value is string => typeof value === "string")
        .join("\n");
      const found = providerAccountRefusalInText(
        `${own}\n${(typeof data === "string" ? data : safeJson(data)) ?? ""}`,
      );
      if (found !== undefined) return found;
    }
    current = record.cause;
  }
  return undefined;
}

export function providerAccountRefusalMessage(refusal: ProviderAccountRefusal): string {
  switch (refusal) {
    case "personal_account_unsupported":
      return PERSONAL_ACCOUNT_UNSUPPORTED_MESSAGE;
  }
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)?.slice(0, 8_192);
  } catch {
    return undefined;
  }
}
