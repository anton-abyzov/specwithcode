/**
 * Team rules engine. Pure: the server reads the file and enforces the answers,
 * clients render them. Rules only tighten and never rewrite stored settings,
 * so a person's own choices come back when the rules are removed.
 *
 * @module teamRules
 */
import {
  TEAM_RULES_FILE_NAME,
  type ModelSelection,
  type ProviderInstanceConfig,
  type RuntimeMode,
  type ServerSettings,
  TEAM_RULES_MAX_BYTES,
  type TeamRulesCarried,
  TeamRulesFile,
  type TeamRulesMachines,
  type TeamRulesPeerRules,
  type TeamRulesProviderPin,
  type TeamRulesRefusal,
  type TeamRulesSummary,
} from "@specweave-studio/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** No file, valid rules, or a broken file holding every agent turn. */
export type TeamRulesState =
  | { readonly status: "none" }
  | {
      readonly status: "active";
      readonly rules: TeamRulesFile;
      readonly fingerprint: string;
      readonly warnings: ReadonlyArray<string>;
    }
  | {
      readonly status: "hold";
      readonly issues: ReadonlyArray<string>;
      /** From a file that parsed far enough to name them. */
      readonly owner?: string;
      readonly contact?: string;
    };

export const TEAM_RULES_NONE: TeamRulesState = { status: "none" };

const RUNTIME_MODE_ORDER: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
const modeRank = (mode: RuntimeMode) => RUNTIME_MODE_ORDER.indexOf(mode);

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};
export const teamRulesModeLabel = (mode: RuntimeMode) => RUNTIME_MODE_LABELS[mode];

/** Sections this version validates but does not enforce yet. */
export const TEAM_RULES_DECLARED_ONLY = ["connections", "updates", "zones"] as const;

/** Providers whose agents the app knows how to run, for spotting a typo in `ai.providers`. */
export const TEAM_RULES_KNOWN_PROVIDERS: ReadonlyArray<string> = [
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
  "antigravity",
  "copilot",
  "acpRegistry",
  "muse",
  "openrouter",
  "typesafe",
  "elevenLabs",
];

const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE/i;
/** Launch flags that change a provider's permission mode. */
const MODE_FLAGS =
  /(^|\s)(--dangerously-\S*|--permission-mode\S*|--yolo|--full-auto|--ask-for-approval\S*|--sandbox\S*)/;

const decodeFile = Schema.decodeUnknownResult(TeamRulesFile);

const issueLines = (message: string): ReadonlyArray<string> => {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const issues: Array<string> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const next = lines[index + 1];
    if (next?.startsWith("at ")) {
      issues.push(`${next}: ${line}`);
      index++;
    } else {
      issues.push(line);
    }
  }
  return issues;
};

const objectText = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" && found.trim().length > 0 ? found.trim() : undefined;
};

export type TeamRulesParse =
  | {
      readonly ok: true;
      readonly rules: TeamRulesFile;
      readonly warnings: ReadonlyArray<string>;
    }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<string>;
      readonly owner?: string;
      readonly contact?: string;
    };

/** Parses the file's text. Unknown keys and credentials are errors, not warnings. */
export function parseTeamRulesText(text: string): TeamRulesParse {
  if (text.length > TEAM_RULES_MAX_BYTES) {
    return { ok: false, issues: [`The file is larger than ${TEAM_RULES_MAX_BYTES} bytes.`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      // The parser's message can quote the file, and this text reaches every client.
      issues: ["Not valid JSON. Run a JSON validator on the file to find the error."],
    };
  }
  const owner = objectText(json, "owner");
  const contact = objectText(json, "contact");
  const named = {
    ...(owner === undefined ? {} : { owner }),
    ...(contact === undefined ? {} : { contact }),
  };
  const decoded = decodeFile(json, { errors: "all", onExcessProperty: "error" });
  if (Result.isFailure(decoded)) {
    return { ok: false, issues: issueLines(decoded.failure.message), ...named };
  }
  const rules = decoded.success;
  const credentials = Object.entries(rules.ai?.pin ?? {}).flatMap(([driver, pin]) =>
    Object.keys(pin.environment ?? {})
      .filter((name) => CREDENTIAL_NAME.test(name))
      .map(
        (name) =>
          `at ["ai"]["pin"]["${driver}"]["environment"]["${name}"]: this looks like a credential. Every user on the machine can read this file, so keep credentials out of it.`,
      ),
  );
  if (credentials.length > 0) return { ok: false, issues: credentials, ...named };
  const ceiling = rules.agents?.ceiling;
  const modeFlags =
    ceiling === undefined || ceiling === "full-access"
      ? []
      : Object.entries(rules.ai?.pin ?? {})
          .filter(([, pin]) => MODE_FLAGS.test(pin.launchArgs ?? ""))
          .map(
            ([driver]) =>
              `at ["ai"]["pin"]["${driver}"]["launchArgs"]: these flags change the permission mode, which agents.ceiling limits.`,
          );
  if (modeFlags.length > 0) return { ok: false, issues: modeFlags, ...named };
  const warnings: Array<string> = [];
  for (const provider of rules.ai?.providers ?? []) {
    if (!TEAM_RULES_KNOWN_PROVIDERS.includes(provider)) {
      warnings.push(`ai.providers lists "${provider}", which this version does not know.`);
    }
  }
  if (rules.ai?.providers?.length === 0) warnings.push("ai.providers is empty: no agent can run.");
  if (rules.ai?.models?.length === 0) warnings.push("ai.models is empty: no model can run.");
  for (const section of TEAM_RULES_DECLARED_ONLY) {
    if (rules[section] !== undefined) {
      warnings.push(`${section} is declared, but this version does not enforce it yet.`);
    }
  }
  return { ok: true, rules, warnings };
}

/** Stable text of the rules, for a fingerprint that ignores key order and spacing. */
export function canonicalTeamRules(rules: TeamRulesFile): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  };
  return JSON.stringify(sorted(rules));
}

/** The broadest mode a person or agent may run in; undefined when nothing limits it. */
export function teamRulesCeiling(state: TeamRulesState): RuntimeMode | undefined {
  return state.status === "active" ? state.rules.agents?.ceiling : undefined;
}

/** The broadest mode a routine may run in: the tighter of the two limits. */
export function teamRulesRoutineCeiling(state: TeamRulesState): RuntimeMode | undefined {
  if (state.status !== "active") return undefined;
  const { ceiling, routines } = state.rules.agents ?? {};
  if (ceiling === undefined) return routines;
  if (routines === undefined) return ceiling;
  return modeRank(routines) < modeRank(ceiling) ? routines : ceiling;
}

/** Whether a limit is below Full access; Full access as a ceiling limits nothing. */
const limits = (ceiling: RuntimeMode | undefined) =>
  ceiling !== undefined && ceiling !== "full-access";

const signature = (state: TeamRulesState) => {
  if (state.status === "active") {
    return {
      owner: state.rules.owner,
      ...(state.rules.contact === undefined ? {} : { contact: state.rules.contact }),
    };
  }
  if (state.status === "hold") {
    return {
      ...(state.owner === undefined ? {} : { owner: state.owner }),
      ...(state.contact === undefined ? {} : { contact: state.contact }),
    };
  }
  return {};
};

const refusal = (
  state: TeamRulesState,
  reason: TeamRulesRefusal["reason"],
  message: string,
  allowedMode?: RuntimeMode,
): TeamRulesRefusal => {
  const named = signature(state);
  const contact = named.contact === undefined ? "" : ` See ${named.contact}.`;
  return {
    reason,
    message: `${message}${contact}`,
    ...named,
    ...(allowedMode === undefined ? {} : { allowedMode }),
  };
};

const setBy = (state: TeamRulesState) => {
  const { owner } = signature(state);
  return owner === undefined ? "Your team's rules" : `${owner}'s rules`;
};

/** Refuses every agent turn while the rules file is broken. */
export function teamRulesHoldRefusal(state: TeamRulesState): TeamRulesRefusal | null {
  if (state.status !== "hold") return null;
  const { owner } = signature(state);
  return refusal(
    state,
    "hold",
    `Agents are paused because the team rules file has an error${
      owner === undefined ? "" : `, set by ${owner}`
    }. Run specweave-studio rules check to see it.`,
  );
}

/** Refuses a mode above the machine's ceiling. */
export function teamRulesModeRefusal(
  state: TeamRulesState,
  mode: RuntimeMode,
): TeamRulesRefusal | null {
  const ceiling = teamRulesCeiling(state);
  if (ceiling === undefined || modeRank(mode) <= modeRank(ceiling)) return null;
  return refusal(
    state,
    "ceiling",
    `${setBy(state)} allow up to ${teamRulesModeLabel(ceiling)}, so ${teamRulesModeLabel(mode)} is not available.`,
    ceiling,
  );
}

/** Refuses a routine's mode above the tighter of the ceiling and the routine limit. */
export function teamRulesRoutineRefusal(
  state: TeamRulesState,
  mode: RuntimeMode,
): TeamRulesRefusal | null {
  const hold = teamRulesHoldRefusal(state);
  if (hold !== null) return hold;
  const ceiling = teamRulesRoutineCeiling(state);
  if (ceiling === undefined || modeRank(mode) <= modeRank(ceiling)) return null;
  return refusal(
    state,
    "routine-ceiling",
    `${setBy(state)} allow routines up to ${teamRulesModeLabel(ceiling)}, so this routine cannot run in ${teamRulesModeLabel(mode)}.`,
    ceiling,
  );
}

const patternMatches = (pattern: string, model: string) => {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "i").test(model);
};

export function teamRulesProviderAllowed(state: TeamRulesState, driver: string): boolean {
  if (state.status !== "active") return true;
  const providers = state.rules.ai?.providers;
  return providers === undefined || providers.includes(driver);
}

/** Whether a model fits a list of patterns; no list allows everything. */
export function teamRulesModelMatches(
  models: ReadonlyArray<string> | undefined,
  model: string,
): boolean {
  return models === undefined || models.some((pattern) => patternMatches(pattern, model));
}

export function teamRulesModelAllowed(state: TeamRulesState, model: string): boolean {
  if (state.status !== "active") return true;
  return teamRulesModelMatches(state.rules.ai?.models, model);
}

/** Refuses a final provider and model outside the allowlist. */
export function teamRulesSelectionRefusal(
  state: TeamRulesState,
  selection: { readonly driver: string; readonly model: string },
): TeamRulesRefusal | null {
  if (!teamRulesProviderAllowed(state, selection.driver)) {
    return refusal(
      state,
      "provider",
      `${setBy(state)} do not approve the provider ${selection.driver}.`,
    );
  }
  if (!teamRulesModelAllowed(state, selection.model)) {
    return refusal(state, "model", `${setBy(state)} do not approve the model ${selection.model}.`);
  }
  return null;
}

/** The one check every turn passes: hold, then mode, then the carried ceiling, then the final model. */
export function teamRulesTurnRefusal(
  state: TeamRulesState,
  turn: {
    readonly runtimeMode: RuntimeMode;
    readonly driver: string;
    readonly model: string;
    readonly carried?: TeamRulesCarried | undefined;
  },
): TeamRulesRefusal | null {
  return (
    teamRulesHoldRefusal(state) ??
    teamRulesModeRefusal(state, turn.runtimeMode) ??
    teamRulesCarriedRefusal(turn.carried, turn.runtimeMode) ??
    teamRulesSelectionRefusal(state, turn)
  );
}

/** Refuses a mode above the ceiling a thread brought from another machine. */
export function teamRulesCarriedRefusal(
  carried: TeamRulesCarried | undefined,
  mode: RuntimeMode,
): TeamRulesRefusal | null {
  if (carried === undefined || modeRank(mode) <= modeRank(carried.ceiling)) return null;
  const contact = carried.contact === undefined ? "" : ` See ${carried.contact}.`;
  return {
    reason: "ceiling",
    message: `This work came from a machine where ${carried.owner}'s rules allow up to ${teamRulesModeLabel(carried.ceiling)}, so ${teamRulesModeLabel(mode)} is not available.${contact}`,
    owner: carried.owner,
    ...(carried.contact === undefined ? {} : { contact: carried.contact }),
    allowedMode: carried.ceiling,
  };
}

/** Lowers a mode that must exist to be repaired, such as a thread arriving here. */
export function teamRulesClampToCarried(
  mode: RuntimeMode,
  carried: TeamRulesCarried | undefined,
): RuntimeMode {
  return carried !== undefined && modeRank(mode) > modeRank(carried.ceiling)
    ? carried.ceiling
    : mode;
}

/** The tighter of two modes; undefined means no limit. */
export function teamRulesStricterMode(
  left: RuntimeMode | undefined,
  right: RuntimeMode | undefined,
): RuntimeMode | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return modeRank(right) < modeRank(left) ? right : left;
}

/**
 * What work leaving this machine carries: the stricter of this machine's ceiling
 * and the one the thread already brought. Full access limits nothing, so it never travels.
 */
export function teamRulesOutgoingCarried(
  state: TeamRulesState,
  inherited: TeamRulesCarried | undefined,
  environmentId: TeamRulesCarried["from"],
): TeamRulesCarried | undefined {
  const own = teamRulesCeiling(state);
  if (!limits(own) || state.status !== "active") return inherited;
  if (inherited !== undefined && modeRank(inherited.ceiling) <= modeRank(own!)) return inherited;
  return {
    ceiling: own!,
    owner: state.rules.owner,
    ...(state.rules.contact === undefined ? {} : { contact: state.rules.contact }),
    from: environmentId,
  };
}

/**
 * The carried ceiling a thread keeps when it arrives. Back on the machine that
 * set it, that machine's live rules decide, so removing them restores the thread.
 */
export function teamRulesArrivingCarried(
  carried: TeamRulesCarried | undefined,
  environmentId: TeamRulesCarried["from"],
): TeamRulesCarried | undefined {
  return carried?.from === environmentId ? undefined : carried;
}

/** Whether this thread's next mode fits; the same answer a menu needs. */
export function teamRulesThreadModeAllowed(
  state: TeamRulesState,
  carried: TeamRulesCarried | undefined,
  mode: RuntimeMode,
): boolean {
  return (
    teamRulesModeRefusal(state, mode) === null && teamRulesCarriedRefusal(carried, mode) === null
  );
}

export type TeamRulesReachPath = "phones" | "connect" | "webhooks";
export type TeamRulesTool = "chrome" | "computerUse" | "google" | "telegram";

const REACH_LABELS: Record<TeamRulesReachPath, string> = {
  phones: "phones",
  connect: "SpecWithCode Connect",
  webhooks: "webhooks",
};

const TOOL_LABELS: Record<TeamRulesTool, string> = {
  chrome: "agent use of Chrome",
  computerUse: "agent use of this computer",
  google: "Google accounts",
  telegram: "Telegram",
};

/** Whether valid rules turn this path off. A hold says nothing, so what exists keeps working. */
export function teamRulesReachOff(state: TeamRulesState, path: TeamRulesReachPath): boolean {
  return state.status === "active" && state.rules.reach?.[path] === false;
}

/** Refuses opening this path. A broken file could be hiding a `false`, so a hold refuses too. */
export function teamRulesReachRefusal(
  state: TeamRulesState,
  path: TeamRulesReachPath,
): TeamRulesRefusal | null {
  if (!teamRulesReachOff(state, path)) return teamRulesPairingHoldRefusal(state);
  return refusal(state, "reach", `${setBy(state)} turn off ${REACH_LABELS[path]} on this machine.`);
}

/** Nothing new opens during a hold; what is already connected stays so it can be repaired. */
function teamRulesPairingHoldRefusal(state: TeamRulesState): TeamRulesRefusal | null {
  if (state.status !== "hold") return null;
  return refusal(
    state,
    "hold",
    "The team rules file has an error, so nothing new can connect until it is fixed. Run specweave-studio rules check to see it.",
  );
}

/** Whether valid rules turn this tool off. */
export function teamRulesToolOff(state: TeamRulesState, tool: TeamRulesTool): boolean {
  return state.status === "active" && state.rules.tools?.[tool] === false;
}

/** Refuses an agent tool. A hold refuses too: a running turn can reach a tool the file may ban. */
export function teamRulesToolRefusal(
  state: TeamRulesState,
  tool: TeamRulesTool,
): TeamRulesRefusal | null {
  if (state.status === "hold") return teamRulesHoldRefusal(state);
  if (!teamRulesToolOff(state, tool)) return null;
  return refusal(state, "tools", `${setBy(state)} turn off ${TOOL_LABELS[tool]} on this machine.`);
}

/** The machine rule in force; `any` with no rules. */
export function teamRulesMachines(state: TeamRulesState): TeamRulesMachines {
  return state.status === "active" ? (state.rules.reach?.machines ?? "any") : "any";
}

const machineName = (label: string | undefined) => label ?? "that machine";

/**
 * Refuses a call between this machine and another. `same-rules` compares
 * fingerprints: no rules, a hold, or a build too old to say are all different.
 * Self-reported, so it catches drift rather than a hostile machine.
 */
export function teamRulesMachineRefusal(
  state: TeamRulesState,
  peer: { readonly label?: string | undefined; readonly fingerprint: string | undefined },
): TeamRulesRefusal | null {
  const rule = teamRulesMachines(state);
  if (rule === "any" || state.status !== "active") return null;
  if (rule === "none") {
    return refusal(state, "machines", `${setBy(state)} turn off working across machines here.`);
  }
  if (peer.fingerprint === state.fingerprint) return null;
  return refusal(
    state,
    "machines",
    `${setBy(state)} allow only machines with the same rules, and ${machineName(peer.label)} has different rules.`,
  );
}

/** Refuses a new machine link, where the other machine is not known yet. A hold refuses too. */
export function teamRulesMachineLinkRefusal(state: TeamRulesState): TeamRulesRefusal | null {
  if (teamRulesMachines(state) === "none") {
    return refusal(state, "machines", `${setBy(state)} turn off working across machines here.`);
  }
  return teamRulesPairingHoldRefusal(state);
}

/** Refuses sending work out while the file is broken: it could be hiding `none`. */
export function teamRulesOutgoingWorkRefusal(
  state: TeamRulesState,
  peer: { readonly label?: string | undefined; readonly fingerprint: string | undefined },
): TeamRulesRefusal | null {
  return teamRulesHoldRefusal(state) ?? teamRulesMachineRefusal(state, peer);
}

/** How another machine's rules compare with this machine's, for the Machines page. */
export type TeamRulesDrift = "none" | "same" | "different" | "hold" | "unknown";

const ownKey = (state: TeamRulesState) =>
  state.status === "active" ? state.fingerprint : state.status;

/**
 * `none` when neither machine has rules, so a fleet without them shows nothing.
 * `unknown` is a machine that did not say: older, or not reachable right now.
 */
export function teamRulesDrift(
  state: TeamRulesState,
  peer: TeamRulesPeerRules | undefined,
  peerKnown: boolean,
): TeamRulesDrift {
  if (peer?.status === "hold") return "hold";
  if (peer === undefined) {
    if (state.status === "none") return "none";
    return peerKnown ? "different" : "unknown";
  }
  return peer.fingerprint !== undefined && peer.fingerprint === ownKey(state)
    ? "same"
    : "different";
}

/** What this machine tells others about its rules. Undefined with no file. */
export function teamRulesPeerRules(state: TeamRulesState): TeamRulesPeerRules | undefined {
  if (state.status === "none") return undefined;
  return state.status === "active"
    ? { status: "active", fingerprint: state.fingerprint }
    : { status: "hold" };
}

/** Whether a coordinator's Full access may raise workers and answer their prompts. */
export function teamRulesAllowsFullAccessApprovals(state: TeamRulesState): boolean {
  if (state.status === "hold") return false;
  return !limits(teamRulesCeiling(state));
}

export function teamRulesPin(
  state: TeamRulesState,
  driver: string,
): TeamRulesProviderPin | undefined {
  return state.status === "active" ? state.rules.ai?.pin?.[driver] : undefined;
}

/**
 * Whether rules own what this driver launches with. Below a Full access
 * ceiling, launch flags and a substitute binary could change the mode. Under an
 * allowlist, `--model` or an endpoint could send work somewhere the list never
 * sees. Under a pin, the rules say so outright.
 */
export function teamRulesOwnsProviderLaunch(state: TeamRulesState, driver: string): boolean {
  if (state.status !== "active") return false;
  return (
    limits(state.rules.agents?.ceiling) ||
    state.rules.ai?.providers !== undefined ||
    state.rules.ai?.models !== undefined ||
    teamRulesPin(state, driver) !== undefined
  );
}

/** Instance settings that decide what a provider runs or where it sends work. */
export const TEAM_RULES_LAUNCH_CONFIG_KEYS = [
  "launchArgs",
  "binaryPath",
  "serverUrl",
  "apiEndpoint",
  "commandPath",
  "commandArgs",
] as const;

/**
 * The instance as rules let it start. A driver outside the list stays
 * registered but disabled, so a thread on it reports why instead of vanishing.
 * Never touches settings.json: it shapes what the registry launches.
 */
export function teamRulesInstanceConfig(
  state: TeamRulesState,
  entry: ProviderInstanceConfig,
): ProviderInstanceConfig {
  if (state.status !== "active") return entry;
  const driver = entry.driver as string;
  const allowed = teamRulesProviderAllowed(state, driver);
  const owned = teamRulesOwnsProviderLaunch(state, driver);
  if (allowed && !owned) return entry;
  const blocked = allowed ? {} : { enabled: false };
  if (!owned) return { ...entry, ...blocked };
  const pin = teamRulesPin(state, driver);
  const config: Record<string, unknown> =
    typeof entry.config === "object" && entry.config !== null ? { ...entry.config } : {};
  for (const key of TEAM_RULES_LAUNCH_CONFIG_KEYS) delete config[key];
  const { environment: _environment, ...rest } = entry;
  const environment = Object.entries(pin?.environment ?? {}).map(([name, value]) => ({
    name,
    value,
    sensitive: false,
  }));
  return {
    ...rest,
    ...blocked,
    ...(environment.length === 0
      ? {}
      : {
          environment: environment as unknown as NonNullable<ProviderInstanceConfig["environment"]>,
        }),
    config: {
      ...config,
      ...(pin?.launchArgs === undefined ? {} : { launchArgs: pin.launchArgs }),
      ...(pin?.binaryPath === undefined ? {} : { binaryPath: pin.binaryPath }),
    },
  };
}

/** Refuses starting a driver at all: a hold stops everything, the list stops what it omits. */
export function teamRulesDriverRefusal(
  state: TeamRulesState,
  driver: string,
): TeamRulesRefusal | null {
  return (
    teamRulesHoldRefusal(state) ??
    (teamRulesProviderAllowed(state, driver)
      ? null
      : teamRulesSelectionRefusal(state, { driver, model: "" }))
  );
}

/** The driver behind an instance id; a default instance's id is its driver. */
export function teamRulesInstanceDriver(
  settings: Pick<ServerSettings, "providerInstances">,
  instanceId: string,
): string {
  const entry = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId as keyof typeof settings.providerInstances]
    : undefined;
  return (entry?.driver as string | undefined) ?? instanceId;
}

const selectionsIn = (settings: ServerSettings): ReadonlyArray<ModelSelection> => {
  const fromRule = (rule: {
    readonly defaultModelSelection?: ModelSelection | null | undefined;
    readonly providerLimitFallbackModelSelection?: ModelSelection | null | undefined;
    readonly providerLimitFallbackModels?: ReadonlyArray<ModelSelection> | null | undefined;
    readonly textGenerationModelSelection?: ModelSelection | null | undefined;
    readonly sourceControlWriterModelSelection?: ModelSelection | null | undefined;
    readonly modelLanes?:
      | {
          readonly complex: ReadonlyArray<ModelSelection>;
          readonly routine: ReadonlyArray<ModelSelection>;
        }
      | null
      | undefined;
  }): ReadonlyArray<ModelSelection> => [
    ...(rule.defaultModelSelection ? [rule.defaultModelSelection] : []),
    ...(rule.providerLimitFallbackModelSelection ? [rule.providerLimitFallbackModelSelection] : []),
    ...(rule.providerLimitFallbackModels ?? []),
    ...(rule.textGenerationModelSelection ? [rule.textGenerationModelSelection] : []),
    ...(rule.sourceControlWriterModelSelection ? [rule.sourceControlWriterModelSelection] : []),
    ...(rule.modelLanes?.complex ?? []),
    ...(rule.modelLanes?.routine ?? []),
  ];
  return [
    ...fromRule(settings as Parameters<typeof fromRule>[0]),
    ...Object.values(settings.projectSettingsOverrides ?? {}).flatMap((override) =>
      fromRule(override as Parameters<typeof fromRule>[0]),
    ),
  ];
};

const launchValues = (config: unknown): ReadonlyArray<string> => {
  const values: Record<string, unknown> =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  return TEAM_RULES_LAUNCH_CONFIG_KEYS.map((key) => JSON.stringify(values[key] ?? ""));
};

const environmentShape = (entry: ProviderInstanceConfig | undefined) =>
  JSON.stringify((entry?.environment ?? []).map(({ name, value }) => [name, value]));

/**
 * Whether a write changes how a provider launches. An instance with no stored
 * entry yet is written with its driver's existing values (the settings form
 * fills them in), so those are not a change, and neither is leaving one empty.
 */
const launchChanged = (
  current: ServerSettings,
  previous: ProviderInstanceConfig | undefined,
  entry: ProviderInstanceConfig,
): boolean => {
  if (environmentShape(previous) !== environmentShape(entry)) return true;
  const next = launchValues(entry.config);
  if (previous !== undefined) {
    return JSON.stringify(launchValues(previous.config)) !== JSON.stringify(next);
  }
  const legacy = launchValues(
    (current.providers as unknown as Record<string, unknown>)[entry.driver as string],
  );
  return next.some((value, index) => value !== '""' && value !== legacy[index]);
};

/**
 * Refuses a settings write that would raise anything above the rules. Only
 * what the write changes counts: a value stored before the rules arrived stays
 * until someone edits it, and is checked again at use.
 */
export function teamRulesSettingsRefusal(
  state: TeamRulesState,
  current: ServerSettings,
  next: ServerSettings,
): TeamRulesRefusal | null {
  if (state.status !== "active") return null;

  if (next.defaultRuntimeMode !== current.defaultRuntimeMode) {
    const refused = teamRulesModeRefusal(state, next.defaultRuntimeMode);
    if (refused !== null) return refused;
  }
  for (const [projectId, override] of Object.entries(next.projectSettingsOverrides ?? {})) {
    const mode = override?.defaultRuntimeMode;
    if (
      mode !== undefined &&
      mode !== current.projectSettingsOverrides?.[projectId as never]?.defaultRuntimeMode
    ) {
      const refused = teamRulesModeRefusal(state, mode);
      if (refused !== null) return refused;
    }
  }

  const before = new Set(
    selectionsIn(current).map((selection) => `${selection.instanceId}\u0000${selection.model}`),
  );
  for (const selection of selectionsIn(next)) {
    if (before.has(`${selection.instanceId}\u0000${selection.model}`)) continue;
    const refused = teamRulesSelectionRefusal(state, {
      driver: teamRulesInstanceDriver(next, selection.instanceId),
      model: selection.model,
    });
    if (refused !== null) return refused;
  }

  for (const [instanceId, entry] of Object.entries(next.providerInstances)) {
    if (!teamRulesOwnsProviderLaunch(state, entry.driver as string)) continue;
    const previous = Object.hasOwn(current.providerInstances, instanceId)
      ? current.providerInstances[instanceId as keyof typeof current.providerInstances]
      : undefined;
    if (launchChanged(current, previous, entry)) {
      return refusal(
        state,
        "provider-launch",
        `${setBy(state)} set this provider's launch arguments, environment and binary path.`,
      );
    }
  }

  if (!current.enableAgentComputerAccess && next.enableAgentComputerAccess) {
    const refused = teamRulesToolRefusal(state, "computerUse");
    // A settings error reaches builds that decode only the earlier reasons, and they read the message.
    if (refused !== null) return { ...refused, reason: "telemetry" };
  }

  if (state.rules.telemetry?.export === false) {
    const urls = (settings: ServerSettings) => JSON.stringify(settings.observability);
    const cleared =
      next.observability.otlpTracesUrl === "" &&
      next.observability.otlpMetricsUrl === "" &&
      next.observability.otlpLogsUrl === "";
    if (urls(current) !== urls(next) && !cleared) {
      return refusal(state, "telemetry", `${setBy(state)} turn off telemetry export.`);
    }
  }
  return null;
}

/**
 * What every consumer sees of the providers: fallback, routing, pickers and
 * machines all choose from this list, so a model it omits cannot be picked.
 */
export function teamRulesFilterProviders<
  P extends {
    readonly driver: string;
    readonly enabled: boolean;
    readonly models: ReadonlyArray<{ readonly slug: string }>;
    readonly teamRulesModels?: ReadonlyArray<string>;
  },
>(state: TeamRulesState, providers: ReadonlyArray<P>): ReadonlyArray<P> {
  if (state.status !== "active" || state.rules.ai === undefined) return providers;
  const patterns = state.rules.ai.models;
  return providers.map((provider) =>
    teamRulesProviderAllowed(state, provider.driver)
      ? {
          ...provider,
          ...(patterns === undefined ? {} : { teamRulesModels: patterns }),
          models: provider.models.filter(({ slug }) => teamRulesModelAllowed(state, slug)),
        }
      : { ...provider, enabled: false, models: [], teamRulesModels: [] },
  );
}

/** The summary clients read. Undefined with no rules, so old behaviour stays untouched. */
export function summarizeTeamRules(state: TeamRulesState): TeamRulesSummary | undefined {
  if (state.status === "none") return undefined;
  const named = signature(state);
  if (state.status === "hold") return { status: "hold", ...named, issues: state.issues };
  const { rules } = state;
  const ceiling = rules.agents?.ceiling;
  const routinesCeiling = teamRulesRoutineCeiling(state);
  const pinned = Object.keys(rules.ai?.pin ?? {});
  return {
    status: "active",
    ...named,
    fingerprint: state.fingerprint,
    ...(ceiling === undefined ? {} : { ceiling }),
    ...(routinesCeiling === undefined ? {} : { routinesCeiling }),
    ...(rules.ai?.providers === undefined ? {} : { providers: rules.ai.providers }),
    ...(rules.ai?.models === undefined ? {} : { models: rules.ai.models }),
    ...(pinned.length === 0 ? {} : { pinnedProviders: pinned }),
    ...(limits(ceiling) || rules.ai?.providers !== undefined || rules.ai?.models !== undefined
      ? { ownsProviderLaunch: true }
      : {}),
    ...(rules.telemetry?.export === undefined ? {} : { telemetryExport: rules.telemetry.export }),
    ...(rules.reach === undefined ? {} : { reach: rules.reach }),
    ...(rules.tools === undefined ? {} : { tools: rules.tools }),
  };
}

/** The state a client's summary implies, so clients ask the same questions as the server. */
export function teamRulesStateFromSummary(summary: TeamRulesSummary | undefined): TeamRulesState {
  if (summary === undefined) return TEAM_RULES_NONE;
  if (summary.status === "hold") {
    return {
      status: "hold",
      issues: summary.issues ?? [],
      ...(summary.owner === undefined ? {} : { owner: summary.owner }),
      ...(summary.contact === undefined ? {} : { contact: summary.contact }),
    };
  }
  return {
    status: "active",
    fingerprint: summary.fingerprint ?? "",
    warnings: [],
    rules: {
      version: 1,
      owner: summary.owner ?? "",
      ...(summary.contact === undefined ? {} : { contact: summary.contact }),
      agents: {
        ...(summary.ceiling === undefined ? {} : { ceiling: summary.ceiling }),
        ...(summary.routinesCeiling === undefined ? {} : { routines: summary.routinesCeiling }),
      },
      ai: {
        ...(summary.providers === undefined ? {} : { providers: summary.providers }),
        ...(summary.models === undefined ? {} : { models: summary.models }),
      },
      ...(summary.telemetryExport === undefined
        ? {}
        : { telemetry: { export: summary.telemetryExport } }),
      ...(summary.reach === undefined ? {} : { reach: summary.reach }),
      ...(summary.tools === undefined ? {} : { tools: summary.tools }),
    } as TeamRulesFile,
  };
}

/** The label a locked control shows. */
export const teamRulesSetByLabel = (owner: string | undefined) =>
  owner === undefined || owner.length === 0 ? "Set by your team" : `Set by ${owner}`;

/** Modes a menu may offer, broadest last, with the ones above the ceiling flagged. */
export function teamRulesModeAllowed(state: TeamRulesState, mode: RuntimeMode): boolean {
  return teamRulesModeRefusal(state, mode) === null;
}

/** The broadest allowed mode no wider than `mode`, for offering a switch down. */
export function teamRulesClampMode(state: TeamRulesState, mode: RuntimeMode): RuntimeMode {
  const ceiling = teamRulesCeiling(state);
  return ceiling !== undefined && modeRank(mode) > modeRank(ceiling) ? ceiling : mode;
}

/** The broadest routine mode no wider than `mode`, for a form that has no permission picker. */
export function teamRulesClampRoutineMode(state: TeamRulesState, mode: RuntimeMode): RuntimeMode {
  const ceiling = teamRulesRoutineCeiling(state);
  return ceiling !== undefined && modeRank(mode) > modeRank(ceiling) ? ceiling : mode;
}

/** The one place a machine's rules live. Fixed on purpose: no setting or variable moves it. */
export function teamRulesMachinePath(platform: string): string {
  if (platform === "darwin") {
    return `/Library/Application Support/SpecWithCode/${TEAM_RULES_FILE_NAME}`;
  }
  if (platform === "win32") return `C:\\ProgramData\\SpecWithCode\\${TEAM_RULES_FILE_NAME}`;
  return `/etc/specwithcode/${TEAM_RULES_FILE_NAME}`;
}

/** Export needs no rules, or rules that allow it. A broken file could be hiding `false`. */
export function teamRulesExportAllowed(state: TeamRulesState): boolean {
  if (state.status === "none") return true;
  return state.status === "active" && state.rules.telemetry?.export !== false;
}

/** The same answer from the file's text, for a process with no rules state of its own. */
export function teamRulesExportAllowedByText(text: string): boolean {
  const parsed = parseTeamRulesText(text);
  return parsed.ok && parsed.rules.telemetry?.export !== false;
}
