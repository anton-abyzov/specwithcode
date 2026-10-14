import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import type { ServerProviderModel, ServerProviderUsageLimits } from "@specweave-studio/contracts";
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** A bundled catalog is not account entitlement. Full additionally requires a native subscription observation. */
export function museModels(
  catalog: unknown,
  subscription: boolean,
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
      (!subscription || apiKey)
    )
      return [];
    const efforts = Array.isArray(row.variants)
      ? row.variants.filter((v): v is string => typeof v === "string")
      : [];
    return [
      {
        slug: row.modelId,
        name: row.displayLabel,
        isDefault: row.isDefault === true,
        isCustom: false,
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
  return {
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(observed)),
    windows,
    ordinaryUsageAllowed: windows.every((w) => w.usedPercent < 100),
  };
}
export function museSubscription(result: unknown): boolean {
  return museUsage(result) !== undefined;
}
