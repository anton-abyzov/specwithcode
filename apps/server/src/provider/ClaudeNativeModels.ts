import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ModelCapabilities } from "@specweave-studio/contracts";
import {
  CLAUDE_ULTRACODE_DESCRIPTOR,
  type ClaudeCatalogModel,
  type ClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const text = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 500 &&
  !/[\u0000-\u001f]/.test(value)
    ? value.trim()
    : undefined;

function capabilities(row: ModelInfo, existing?: ClaudeCatalogModel): ModelCapabilities {
  const descriptors = [...(existing?.model.capabilities?.optionDescriptors ?? [])];
  const replace = (id: string, values: NonNullable<ModelCapabilities["optionDescriptors"]>) => {
    const index = descriptors.findIndex((entry) => entry.id === id);
    if (index >= 0) descriptors.splice(index, 1);
    descriptors.push(...values);
  };
  if (row.supportsEffort === false) replace("effort", []);
  else if (row.supportsEffort === true && Array.isArray(row.supportedEffortLevels)) {
    const levels = [...new Set(row.supportedEffortLevels.filter((level) => EFFORTS.has(level)))];
    const previous = descriptors.find((entry) => entry.id === "effort");
    const options =
      previous?.type === "select"
        ? previous.options.filter((option) => {
            const mapped = existing?.runtime.effortMap?.[option.id];
            return (
              levels.includes((mapped ?? option.id) as (typeof levels)[number]) ||
              previous.promptInjectedValues?.includes(option.id)
            );
          })
        : [];
    for (const level of levels)
      if (!options.some((option) => option.id === level))
        options.push({
          id: level,
          label: level === "xhigh" ? "Extra High" : level[0]!.toUpperCase() + level.slice(1),
        });
    replace(
      "effort",
      options.length
        ? [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options,
              ...(previous?.type === "select" && previous.promptInjectedValues
                ? { promptInjectedValues: previous.promptInjectedValues }
                : {}),
            },
          ]
        : [],
    );
  }
  // Claude Code offers ultracode only on models with xhigh effort.
  if (row.supportsEffort === false) replace("ultracode", []);
  else if (row.supportsEffort === true && Array.isArray(row.supportedEffortLevels))
    replace(
      "ultracode",
      row.supportedEffortLevels.includes("xhigh") ? [CLAUDE_ULTRACODE_DESCRIPTOR] : [],
    );
  // Adaptive thinking is on unless a thread turns it off: the adapter asks for
  // it whenever the selection leaves Thinking unset. The default says so, so an
  // unset Thinking reads "On" instead of "Off".
  if (row.supportsAdaptiveThinking !== undefined)
    replace(
      "thinking",
      row.supportsAdaptiveThinking
        ? [{ id: "thinking", label: "Thinking", type: "boolean", currentValue: true }]
        : [],
    );
  if (row.supportsFastMode !== undefined)
    replace(
      "fastMode",
      row.supportsFastMode ? [{ id: "fastMode", label: "Fast Mode", type: "boolean" }] : [],
    );
  return { optionDescriptors: descriptors };
}

const DATED = /-\d{8}$/;
/** A dated id (claude-haiku-4-5-20251001) joins its undated sibling instead of listing twice. */
function canonicalSlug(base: ClaudeModelCatalog, nativeSlugs: Set<string>, slug: string): string {
  if (!DATED.test(slug)) return slug;
  const undated = slug.replace(DATED, ""),
    lower = slug.toLowerCase();
  if (nativeSlugs.has(undated) || base.models.some((entry) => entry.model.slug === undated))
    return undated;
  return (
    base.models.find((entry) => entry.model.aliases?.some((alias) => alias.toLowerCase() === lower))
      ?.model.slug ?? slug
  );
}

/** Native current rows augment the fallback without rewriting old explicit IDs. */
export function mergeClaudeNativeModels(
  base: ClaudeModelCatalog,
  rows: ReadonlyArray<ModelInfo> | undefined,
): ClaudeModelCatalog {
  if (!rows?.length) return base;
  const nativeDefault = rows.find(
    (row) => row?.value === "default" && text(row.resolvedModel) && row.resolvedModel !== "default",
  )?.resolvedModel;
  const discovered = new Map<string, ClaudeCatalogModel>();
  const nativeAliasOwners = new Map<string, string>();
  const nativeSlugs = new Set(
    rows
      .map((row) => text(row?.resolvedModel) ?? text(row?.value))
      .filter((slug): slug is string => slug !== undefined),
  );
  for (const row of rows.slice(0, 500)) {
    const value = text(row?.value),
      nativeSlug = text(row?.resolvedModel) ?? value;
    if (!value || !nativeSlug || nativeSlug === "default") continue;
    if (value === "default" && nativeDefault !== nativeSlug) continue;
    const slug = canonicalSlug(base, nativeSlugs, nativeSlug);
    nativeAliasOwners.set(value.toLowerCase(), slug);
    if (nativeSlug !== slug) nativeAliasOwners.set(nativeSlug.toLowerCase(), slug);
    const prior = discovered.get(slug),
      existing = base.models.find((entry) => entry.model.slug === slug);
    const aliases = [
      ...new Set([
        ...(prior?.model.aliases ?? existing?.model.aliases ?? []),
        ...(value !== slug ? [value] : []),
        ...(nativeSlug !== slug ? [nativeSlug] : []),
      ]),
    ];
    const versioned = /^claude-(haiku|sonnet|opus|fable)-(\d+(?:-\d+)*)$/.exec(
      slug.replace(DATED, ""),
    );
    const name =
      existing?.model.name ??
      (versioned
        ? `Claude ${versioned[1]![0]!.toUpperCase()}${versioned[1]!.slice(1)} ${versioned[2]!.replaceAll("-", ".")}`
        : (text(row.displayName) ?? slug));
    const wireModel = value.includes("[") ? value : nativeSlug;
    discovered.set(slug, {
      model: {
        ...(existing?.model ?? {}),
        slug,
        name,
        aliases,
        isCustom: false,
        isLegacy: false,
        isDefault:
          value === "default" ||
          prior?.model.isDefault === true ||
          (!nativeDefault && existing?.model.isDefault === true),
        capabilities: capabilities(row, existing),
      },
      runtime: existing?.runtime ?? {},
      compatibility: {},
      nativeDiscovered: true,
      ...(wireModel !== slug
        ? { nativeWireModel: wireModel }
        : prior?.nativeWireModel
          ? { nativeWireModel: prior.nativeWireModel }
          : {}),
    });
  }
  if (!discovered.size) return base;
  const hasDefault = [...discovered.values()].some((entry) => entry.model.isDefault);
  const retainOwnedAliases = (entry: ClaudeCatalogModel): ClaudeCatalogModel => ({
    ...entry,
    model: {
      ...entry.model,
      ...(entry.model.aliases
        ? {
            aliases: entry.model.aliases.filter((alias) => {
              const owner = nativeAliasOwners.get(alias.toLowerCase());
              return owner === undefined || owner === entry.model.slug;
            }),
          }
        : {}),
    },
  });
  return {
    models: [
      ...[...discovered.values()].map(retainOwnedAliases),
      ...base.models
        .filter((entry) => !discovered.has(entry.model.slug))
        .map((entry) =>
          retainOwnedAliases({
            ...entry,
            model: {
              ...entry.model,
              ...(hasDefault ? { isDefault: false } : {}),
            },
          }),
        ),
    ],
  };
}

export function nativeClaudeSupportsThinking(
  catalog: ClaudeModelCatalog | undefined,
  model: string,
): boolean | undefined {
  const entry = catalog?.models.find(
    (item) => item.model.slug === model || item.model.aliases?.includes(model),
  );
  return entry?.nativeDiscovered
    ? (entry.model.capabilities?.optionDescriptors?.some((option) => option.id === "thinking") ??
        false)
    : undefined;
}

/** One state per provider instance; no account shares its discovered models. */
export function createClaudeNativeCatalog(initial: ClaudeModelCatalog) {
  let base = initial,
    native: ReadonlyArray<ModelInfo> | undefined;
  let catalog = initial;
  return {
    current: () => catalog,
    updateBase: (next: ClaudeModelCatalog) => {
      base = next;
      catalog = mergeClaudeNativeModels(base, native);
      return catalog;
    },
    updateNative: (next: ReadonlyArray<ModelInfo> | undefined) => {
      native = next;
      catalog = mergeClaudeNativeModels(base, native);
      return catalog;
    },
  };
}
