import type { ModelSelection } from "@specweave-studio/contracts";
import { advisorRouteForContext, type AdvisorRoute } from "@specweave-studio/shared/advisor";
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

/**
 * What a Claude session is told about Claude's own advisor once the context
 * size has picked the route: switched off, or on with a model.
 */
export type ClaudeSessionAdvisorOutcome =
  | { readonly kind: "disable" }
  | { readonly kind: "model"; readonly model: string };

/** Turns Claude's own advisor off, also on a resumed session that used it before. */
export const CLAUDE_DISABLE_ADVISOR_ENV = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";

/**
 * The runtime policy's `claudeAdvisor` and what the session knows: the
 * outcome for the next process, and the route a `model` value took (null for
 * `disable`). Past `contextLimit` tokens the thread uses the studio-code
 * advisor instead, so Claude's own is switched off; it comes back under half
 * the limit. An unknown size keeps the previous route.
 */
export function resolveClaudeSessionAdvisor(input: {
  readonly claudeAdvisor:
    | { readonly kind: "disable" }
    | { readonly kind: "model"; readonly model: string; readonly contextLimit: number }
    | undefined;
  readonly contextTokens: number | null | undefined;
  readonly previousRoute: AdvisorRoute | null | undefined;
}): {
  readonly outcome: ClaudeSessionAdvisorOutcome | undefined;
  readonly route: AdvisorRoute | null;
} {
  const advisor = input.claudeAdvisor;
  if (advisor === undefined) return { outcome: undefined, route: null };
  if (advisor.kind === "disable") return { outcome: { kind: "disable" }, route: null };
  const route = advisorRouteForContext({
    contextTokens: input.contextTokens,
    limit: advisor.contextLimit,
    previous: input.previousRoute,
  });
  return {
    outcome: route === "built-in" ? { kind: "model", model: advisor.model } : { kind: "disable" },
    route,
  };
}

/** The flag settings a model selection passes to Claude Code. */
export interface ClaudeSelectionSettings {
  readonly alwaysThinkingEnabled?: boolean;
  readonly fastMode?: boolean;
  readonly ultracode?: boolean;
  /** Claude's own advisor runs on this model, whatever the person's settings name. */
  readonly advisorModel?: string;
}

export interface CompiledClaudeModelSelection {
  readonly apiModelId: string;
  readonly effort: string | undefined;
  readonly promptEffort: string | undefined;
  readonly settings: ClaudeSelectionSettings;
  /** Variables the session's environment gets on top of the provider's. */
  readonly environment: Readonly<Record<string, string>>;
  readonly queryIdentity: string;
}

function advisorIdentity(advisor: ClaudeSessionAdvisorOutcome | undefined): string | undefined {
  return advisor === undefined
    ? undefined
    : advisor.kind === "disable"
      ? "disable"
      : `model:${advisor.model}`;
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
    readonly advisor?: string;
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
  if (open.advisor !== next.advisor) {
    parts.push(
      next.advisor === undefined
        ? "Claude's advisor from your Claude settings"
        : next.advisor === "disable"
          ? "Claude's built-in advisor off"
          : `Claude's built-in advisor on ${next.advisor.slice("model:".length)}`,
    );
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

/**
 * Compile every Claude model option at the provider boundary. `advisor` is
 * the session's resolved advisor (`resolveClaudeSessionAdvisor`); absent
 * passes nothing, so the person's own Claude setting applies.
 */
export function compileClaudeModelSelection(
  selection: ModelSelection,
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  advisor?: ClaudeSessionAdvisorOutcome,
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
  const settings: ClaudeSelectionSettings = {
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    ...(supportsBoolean("ultracode") && typeof ultracode === "boolean" ? { ultracode } : {}),
    // A flag setting outranks the person's own advisorModel.
    ...(advisor?.kind === "model" ? { advisorModel: advisor.model } : {}),
  };
  // An empty advisorModel does not turn Claude's advisor off; the variable does.
  const environment: Record<string, string> =
    advisor?.kind === "disable" ? { [CLAUDE_DISABLE_ADVISOR_ENV]: "1" } : {};
  const apiModelId = resolveClaudeCatalogApiModelId(catalog, selection);
  const promptEffort = resolvePromptInjectedEffort(capabilities, rawEffort) ?? undefined;
  return {
    apiModelId,
    effort,
    promptEffort,
    settings,
    environment,
    // Ultracode is launch context like the workflow mode it merges with; the
    // adapter keys the process on the value that reaches the CLI instead. The
    // advisor has its own key, absent when nothing is passed, so a change of
    // it opens a new process at the thread's next turn.
    queryIdentity: JSON.stringify({
      apiModelId,
      effort: effort ?? null,
      settings: { ...settings, ultracode: undefined, advisorModel: undefined },
      advisor: advisorIdentity(advisor),
    }),
  };
}
