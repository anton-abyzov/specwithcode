import type { ModelSelection } from "@specweave-studio/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  resolvePromptInjectedEffort,
} from "@specweave-studio/shared/model";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
  isClaudeCatalogUltracodeEffort,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  type ClaudeModelCatalog,
} from "./provider/ClaudeModelCatalog.ts";

export interface CompiledClaudeModelSelection {
  readonly apiModelId: string;
  readonly effort: string | undefined;
  readonly promptEffort: string | undefined;
  readonly settings: Readonly<Record<string, boolean>>;
  readonly queryIdentity: string;
}

const DEFERRED_SETTING_LABELS: Readonly<Record<string, string>> = {
  alwaysThinkingEnabled: "thinking",
  fastMode: "fast mode",
};

const BACKGROUND_WORK_NOUNS: Readonly<Record<string, string>> = {
  subagent: "subagent",
  command: "command",
  monitor: "monitor",
  workflow: "workflow",
};
const MAX_NAMED_BACKGROUND_WORK = 3;
const MAX_BACKGROUND_WORK_NAME_LENGTH = 80;

export interface DescribedBackgroundWork {
  /** `subagent "Review the diff" and command "pnpm dev"`. */
  readonly label: string;
  readonly count: number;
}

/**
 * Names the work a process still runs, for the notes and refusals that
 * mention it. Null when there is none to name.
 */
export function describeBackgroundWork(
  work: ReadonlyArray<{ readonly kind: string; readonly description?: string | null | undefined }>,
): DescribedBackgroundWork | null {
  if (work.length === 0) return null;
  const names = work.slice(0, MAX_NAMED_BACKGROUND_WORK).map(({ kind, description }) => {
    const noun = BACKGROUND_WORK_NOUNS[kind] ?? "background task";
    const line =
      description
        ?.split(/[\n\r\u2028\u2029]/u)[0]
        ?.replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .replaceAll('"', "'")
        .trim() ?? "";
    if (line.length === 0) return `a ${noun}`;
    const name =
      line.length > MAX_BACKGROUND_WORK_NAME_LENGTH
        ? `${line.slice(0, MAX_BACKGROUND_WORK_NAME_LENGTH - 1).trimEnd()}…`
        : line;
    return `${noun} "${name}"`;
  });
  const more = work.length - names.length;
  if (more > 0) names.push(`${more} more`);
  return {
    label: names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`,
    count: work.length,
  };
}

/**
 * The quiet note shown when a process that still runs background work keeps
 * its selection: what was chosen, and what it waits for. The first two
 * arguments are `queryIdentity` values.
 */
export function describeDeferredClaudeSelection(
  openIdentity: string,
  nextIdentity: string,
  work: DescribedBackgroundWork | null = null,
): string {
  type Identity = {
    readonly apiModelId: string;
    readonly effort: string | null;
    readonly settings: Readonly<Record<string, boolean | undefined>>;
  };
  const open = JSON.parse(openIdentity) as Identity;
  const next = JSON.parse(nextIdentity) as Identity;
  const parts: Array<string> = [];
  if (open.apiModelId !== next.apiModelId) parts.push(`model ${next.apiModelId}`);
  if (open.effort !== next.effort) parts.push(`effort ${next.effort ?? "default"}`);
  for (const [key, label] of Object.entries(DEFERRED_SETTING_LABELS)) {
    if (open.settings[key] !== next.settings[key]) {
      parts.push(`${label} ${next.settings[key] === true ? "on" : "off"}`);
    }
  }
  const until =
    work === null
      ? "background work finishes"
      : `${work.label} ${work.count === 1 ? "finishes" : "finish"}`;
  if (parts.length === 0) return `The new model options apply when ${until}.`;
  const list =
    parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} ${parts.length === 1 ? "applies" : "apply"} when ${until}.`;
}

/** Compile every Claude model option at the provider boundary. */
export function compileClaudeModelSelection(
  selection: ModelSelection,
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): CompiledClaudeModelSelection {
  const capabilities = getClaudeCatalogModelCapabilities(catalog, selection.model);
  const descriptors = getProviderOptionDescriptors({ caps: capabilities });
  const supportsBoolean = (id: string) =>
    descriptors.some((descriptor) => descriptor.type === "boolean" && descriptor.id === id);
  const storedEffort = getModelSelectionStringOptionValue(selection, "effort");
  // Selections saved before the toggle stored Ultracode as the effort; they ran at xhigh.
  const legacyUltracode = isClaudeCatalogUltracodeEffort(storedEffort);
  const rawEffort = legacyUltracode ? "xhigh" : storedEffort;
  const resolvedEffort = resolveClaudeCatalogEffort(catalog, selection.model, rawEffort);
  const effort = normalizeClaudeCatalogEffort(catalog, resolvedEffort, selection.model);
  const fastMode = supportsBoolean("fastMode")
    ? (getModelSelectionBooleanOptionValue(selection, "fastMode") ?? false)
    : undefined;
  const thinking = supportsBoolean("thinking")
    ? getModelSelectionBooleanOptionValue(selection, "thinking")
    : undefined;
  // Unset follows the Claude workflow mode; the policy decides what reaches the CLI.
  const ultracode =
    getModelSelectionBooleanOptionValue(selection, "ultracode") ??
    (legacyUltracode ? true : undefined);
  const settings = {
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    ...(supportsBoolean("ultracode") && typeof ultracode === "boolean" ? { ultracode } : {}),
  };
  const apiModelId = resolveClaudeCatalogApiModelId(catalog, selection);
  const promptEffort = resolvePromptInjectedEffort(capabilities, rawEffort) ?? undefined;
  return {
    apiModelId,
    effort,
    promptEffort,
    settings,
    // Ultracode is launch context like the workflow mode it merges with; the
    // adapter keys the process on the value that reaches the CLI instead.
    queryIdentity: JSON.stringify({
      apiModelId,
      effort: effort ?? null,
      settings: { ...settings, ultracode: undefined },
    }),
  };
}
