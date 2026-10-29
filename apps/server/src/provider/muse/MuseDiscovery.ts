import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import { parseJson } from "../../json.ts";
import type { ServerProviderModel, ServerProviderUsageLimits } from "@specweave-studio/contracts";
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const positiveInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

/**
 * Whether Wonder Full may be offered for this account. Full is a Muse
 * Code subscription model, never a Meta Model API one, so an API-key route
 * excludes it. Otherwise the signed-in host's own provider catalog is the
 * entitlement surface: a cold host has observed no usage yet (`usage/read`
 * returns {} until one of its turns lands), and that truthful absence must
 * not read as "not subscribed" — it hid Full for every subscription
 * account whose provider check ran before a turn. An observed non-tier
 * usage payload still counts as observed-and-not-subscription only when it
 * carries usage rows without a tier; `museUsage` stays the parser of record
 * for limits.
 */
export function museFullEntitled(usageResult: unknown, apiKey: boolean): boolean {
  if (apiKey) return false;
  if (museUsage(usageResult) !== undefined) return true;
  const usage = record(record(usageResult).usage);
  // Nothing observed yet: the catalog decides. Observed usage rows with no
  // subscription tier are an account that reports usage without a plan.
  return !("window" in usage || "weekly" in usage || "observedAtMs" in usage);
}

/** A bundled catalog is not account entitlement; only the host's provider catalog lists models. */
export function museModels(
  catalog: unknown,
  fullEntitled: boolean,
  apiKey: boolean,
): ServerProviderModel[] {
  const data = record(catalog);
  if (data.source !== "providerCatalog" || !Array.isArray(data.models)) return [];
  return data.models.flatMap((value) => {
    const row = record(value);
    if (
      typeof row.modelId !== "string" ||
      !row.modelId.startsWith("muse-") ||
      typeof row.displayLabel !== "string"
    )
      return [];
    if (
      (/(?:^|[-_])full(?:$|[-_])/i.test(row.modelId) || /\bfull\b/i.test(row.displayLabel)) &&
      (!fullEntitled || apiKey)
    )
      return [];
    const efforts = Array.isArray(row.variants)
      ? row.variants.filter((v): v is string => typeof v === "string")
      : [];
    const contextWindow = positiveInt(row.contextLimit);
    const maxOutput = positiveInt(row.outputLimit);
    return [
      {
        slug: row.modelId,
        name: row.displayLabel,
        isDefault: row.isDefault === true,
        isCustom: false,
        billing: apiKey ? ("api" as const) : ("subscription" as const),
        toolCalls: true,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxOutput === undefined ? {} : { maxOutput }),
        capabilities: {
          optionDescriptors: efforts.length
            ? [
                {
                  id: "reasoningEffort",
                  label: "Reasoning effort",
                  type: "select" as const,
                  options: efforts.map((id) => ({ id, label: id })),
                },
              ]
            : [],
        },
      },
    ];
  });
}
export function museUsage(result: unknown): ServerProviderUsageLimits | undefined {
  const usage = record(record(result).usage);
  const observed = usage.observedAtMs;
  if (
    typeof observed !== "number" ||
    !Number.isFinite(
      DateTime.make(observed).pipe(
        Option.map(DateTime.toEpochMillis),
        Option.getOrElse(() => Number.NaN),
      )) ||
    observed <= 0 ||
    typeof usage.tier !== "string"
  )
    return undefined;
  const windows: ServerProviderUsageLimits["windows"][number][] = [];
  for (const [id, kind, label] of [
    ["window", "session", "Session"],
    ["weekly", "weekly", "Week"],
  ] as const) {
    const row = record(usage[id]);
    if (
      typeof row.usedPercent !== "number" ||
      !Number.isFinite(row.usedPercent) ||
      row.usedPercent < 0 ||
      typeof row.resetsAtMs !== "number" ||
      !Number.isFinite(
        DateTime.make(row.resetsAtMs).pipe(
          Option.map(DateTime.toEpochMillis),
          Option.getOrElse(() => Number.NaN),
        )) ||
      row.resetsAtMs <= 0
    )
      return undefined;
    windows.push({
      id,
      kind,
      label,
      usedPercent: Math.min(100, row.usedPercent),
      resetsAt: DateTime.formatIso(DateTime.makeUnsafe(row.resetsAtMs)),
    });
  }
  const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(observed));
  return {
    checkedAt,
    nativeAllowanceObservedAt: checkedAt,
    windows,
    ordinaryUsageAllowed: windows.every((w) => w.usedPercent < 100),
  };
}

/**
 * Usage as `muse usage --json` prints it: one JSON object, either the MSP
 * `{usage}` envelope or the usage payload itself. A payload without an
 * observation stamp is stamped with the read time — the CLI fetched it
 * live, so the read is the observation. Unparseable output is no usage.
 */
export function museUsageFromCliJson(
  text: string,
  nowMs: number,
): ServerProviderUsageLimits | undefined {
  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch {
    return undefined;
  }
  const direct = museUsage(parsed) ?? museUsage({ usage: parsed });
  if (direct !== undefined) return direct;
  const usage = record(record(parsed).usage);
  const payload = Object.keys(usage).length > 0 ? usage : record(parsed);
  if (!("window" in payload) && !("weekly" in payload)) return undefined;
  return museUsage({ usage: { observedAtMs: nowMs, ...payload } });
}
export function museSubscription(result: unknown): boolean {
  return museUsage(result) !== undefined;
}
