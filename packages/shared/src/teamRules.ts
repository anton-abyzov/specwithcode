/**
 * Team rules engine. Pure: the server reads the file and enforces the answers,
 * clients render them. Rules only tighten and never rewrite stored settings,
 * so a person's own choices come back when the rules are removed.
 *
 * @module teamRules
 */
import {
  DEFAULT_SERVER_SETTINGS,
  TEAM_RULES_FILE_NAME,
  type ModelSelection,
  type ProviderInstanceConfig,
  type RuntimeMode,
  type ServerSettings,
  TEAM_RULES_MAX_BYTES,
  type TeamRulesCarried,
  TeamRulesFile,
  TeamRulesRepositoryFile,
  type TeamRulesMachines,
  type TeamRulesPeerRules,
  type TeamRulesProviderPin,
  type TeamRulesRefusal,
  type TeamRulesScopedAi,
  type TeamRulesAgents,
  type TeamRulesConnections,
  type TeamRulesSource,
  type TeamRulesSummary,
  type TeamRulesUpdates,
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
      /** The zones and repository narrowing this state for one working folder. */
      readonly sources?: ReadonlyArray<TeamRulesSource>;
      /** Who set a limit, when it was not the machine's own rules. */
      readonly setBy?: TeamRulesSetBy;
      /** The folder's lists, kept so a refusal names the source that left a provider out. */
      readonly providerLists?: ReadonlyArray<TeamRulesList>;
      /** Further lists a value must also fit: two glob lists do not intersect into one. */
      readonly modelLists?: ReadonlyArray<TeamRulesList>;
      readonly connectionLists?: ReadonlyArray<TeamRulesList>;
    }
  | {
      readonly status: "hold";
      readonly issues: ReadonlyArray<string>;
      /** From a file that parsed far enough to name them. */
      readonly owner?: string;
      readonly contact?: string;
      /** Set when only one working folder is on hold, not the machine. */
      readonly holdScope?: TeamRulesSource["source"];
    };

export interface TeamRulesList {
  readonly patterns: ReadonlyArray<string>;
  readonly by: TeamRulesSource;
}

export type TeamRulesSetBy = {
  readonly ceiling?: TeamRulesSource;
  readonly routines?: TeamRulesSource;
};

/** What a zone or repository adds for one working folder. */
export type TeamRulesLayer =
  | {
      readonly status: "active";
      readonly source: TeamRulesSource;
      readonly agents?: TeamRulesAgents;
      readonly ai?: TeamRulesScopedAi;
      readonly connections?: TeamRulesConnections;
    }
  | {
      readonly status: "hold";
      readonly source: TeamRulesSource["source"];
      readonly issues: ReadonlyArray<string>;
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
  if (rules.updates?.feed !== undefined && !/^https:\/\//iu.test(rules.updates.feed)) {
    warnings.push("updates.feed is not an https address.");
  }
  return { ok: true, rules, warnings };
}

const REPOSITORY_FORBIDDEN = ["reach", "tools", "telemetry", "updates", "zones"] as const;
const REPOSITORY_NAME_LIMIT = 200;
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "gu");

/** Repository text reaches terminals and screens, and anyone with commit rights wrote it. */
const withoutControls = (text: string) => text.replace(CONTROL_CHARACTERS, " ");

export type TeamRulesRepositoryParse =
  | { readonly ok: true; readonly rules: TeamRulesRepositoryFile }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<string>;
      readonly owner?: string;
      readonly contact?: string;
    };

/** Parses a repository's file. What only a machine may set is an error, never ignored. */
export function parseTeamRulesRepositoryText(text: string): TeamRulesRepositoryParse {
  if (text.length > TEAM_RULES_MAX_BYTES) {
    return { ok: false, issues: [`The file is larger than ${TEAM_RULES_MAX_BYTES} bytes.`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      issues: ["Not valid JSON. Run a JSON validator on the file to find the error."],
    };
  }
  const named = (() => {
    const owner = objectText(json, "owner");
    const contact = objectText(json, "contact");
    const short = (value: string | undefined) =>
      value === undefined || value.length > REPOSITORY_NAME_LIMIT
        ? undefined
        : withoutControls(value);
    const safeOwner = short(owner);
    const safeContact = short(contact);
    return {
      ...(safeOwner === undefined ? {} : { owner: safeOwner }),
      ...(safeContact === undefined ? {} : { contact: safeContact }),
    };
  })();
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const forbidden = [
    ...REPOSITORY_FORBIDDEN.filter((key) => Object.hasOwn(record, key)).map(
      (key) => `at ["${key}"]: only a machine's rules can set this, not a repository's.`,
    ),
    ...(typeof record.ai === "object" && record.ai !== null && Object.hasOwn(record.ai, "pin")
      ? [`at ["ai"]["pin"]: only a machine's rules can set this, not a repository's.`]
      : []),
  ];
  if (forbidden.length > 0) return { ok: false, issues: forbidden, ...named };
  const decoded = Schema.decodeUnknownResult(TeamRulesRepositoryFile)(json, {
    errors: "all",
    onExcessProperty: "error",
  });
  if (Result.isFailure(decoded)) {
    return {
      ok: false,
      issues: issueLines(decoded.failure.message).map(withoutControls),
      ...named,
    };
  }
  const rules = decoded.success;
  const strings = [
    rules.owner,
    rules.contact ?? "",
    ...(rules.ai?.models ?? []),
    ...(rules.connections?.allow ?? []),
  ];
  if (strings.some((value) => withoutControls(value) !== value)) {
    return { ok: false, issues: ["The file has control characters in its text."], ...named };
  }
  if (
    rules.owner.length > REPOSITORY_NAME_LIMIT ||
    (rules.contact?.length ?? 0) > REPOSITORY_NAME_LIMIT
  ) {
    return {
      ok: false,
      issues: [`owner and contact must be at most ${REPOSITORY_NAME_LIMIT} characters.`],
      ...named,
    };
  }
  return { ok: true, rules };
}

/** The limits a parsed repository file adds. */
export function teamRulesRepositoryLayer(parsed: TeamRulesRepositoryParse): TeamRulesLayer {
  if (!parsed.ok) {
    return {
      status: "hold",
      source: "repository",
      issues: parsed.issues,
      ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
      ...(parsed.contact === undefined ? {} : { contact: parsed.contact }),
    };
  }
  const { rules } = parsed;
  return {
    status: "active",
    source: {
      source: "repository",
      owner: rules.owner,
      ...(rules.contact === undefined ? {} : { contact: rules.contact }),
    },
    ...(rules.agents === undefined ? {} : { agents: rules.agents }),
    ...(rules.ai === undefined ? {} : { ai: rules.ai }),
    ...(rules.connections === undefined ? {} : { connections: rules.connections }),
  };
}

/**
 * A Git remote as a zone matches it: `github.com/acme/payments`, whichever of
 * SSH or HTTPS it uses. The user part is dropped, since it can hold a token.
 */
export function teamRulesNormalizeRemote(remote: string): string {
  const trimmed = remote.trim();
  // Remotes come from a repository's own config, so nothing here may backtrack.
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(trimmed);
  if (scheme !== null) {
    const rest = trimmed.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/u, "");
    const path = slash === -1 ? "" : rest.slice(slash);
    if (host.length > 0 && !host.includes(":")) return remoteOf(host, path);
    if (authority.includes("@")) return withoutGitSuffix(trimSlashes(`${host}${path}`, false));
  }
  const scp = /^(?:[^/@]+@)?([^/:]+):(?!\/\/)(.+)$/su.exec(trimmed);
  if (scp !== null) return remoteOf(scp[1] ?? "", scp[2] ?? "");
  return withoutGitSuffix(trimSlashes(trimmed, false));
}

const trimSlashes = (text: string, leading: boolean) => {
  let start = 0;
  let end = text.length;
  while (leading && start < end && text[start] === "/") start += 1;
  while (end > start && text[end - 1] === "/") end -= 1;
  return text.slice(start, end);
};

const withoutGitSuffix = (path: string) =>
  path.toLowerCase().endsWith(".git") ? path.slice(0, -4) : path;

const remoteOf = (host: string, path: string) =>
  `${host.toLowerCase()}/${withoutGitSuffix(trimSlashes(path, true))}`;

/** Whether a zone applies. Every remote counts, so adding a remote can only tighten. */
export function teamRulesZoneLayers(
  machine: TeamRulesState,
  remotes: ReadonlyArray<string>,
): ReadonlyArray<TeamRulesLayer> {
  if (machine.status !== "active") return [];
  const normalized = remotes.map(teamRulesNormalizeRemote);
  return (machine.rules.zones ?? [])
    .filter((zone) => normalized.some((remote) => patternMatches(zone.remote, remote)))
    .map((zone) => ({
      status: "active" as const,
      source: {
        source: "zone" as const,
        owner: machine.rules.owner,
        ...(machine.rules.contact === undefined ? {} : { contact: machine.rules.contact }),
      },
      ...(zone.agents === undefined ? {} : { agents: zone.agents }),
      ...(zone.ai === undefined ? {} : { ai: zone.ai }),
      ...(zone.connections === undefined ? {} : { connections: zone.connections }),
    }));
}

/** Whether this machine's own file has zones, so a folder's remotes must be known. */
export const teamRulesHasZones = (machine: TeamRulesState) =>
  machine.status === "active" && (machine.rules.zones?.length ?? 0) > 0;

/**
 * The rules for one working folder: the strictest value of every source. A
 * machine hold wins outright, and the fingerprint stays the machine's, since
 * `same-rules` compares machines and never one folder's view. With nothing to
 * add it returns the machine's state as it was.
 */
export function teamRulesCombine(
  machine: TeamRulesState,
  layers: ReadonlyArray<TeamRulesLayer>,
): TeamRulesState {
  if (machine.status === "hold" || layers.length === 0) return machine;
  const held = layers.find((layer) => layer.status === "hold");
  if (held !== undefined && held.status === "hold") {
    return {
      status: "hold",
      issues: held.issues,
      holdScope: held.source,
      ...(held.owner === undefined ? {} : { owner: held.owner }),
      ...(held.contact === undefined ? {} : { contact: held.contact }),
    };
  }
  const active = layers.flatMap((layer) => (layer.status === "active" ? [layer] : []));
  const first = active[0];
  if (first === undefined) return machine;
  const base = machine.status === "active" ? machine.rules : undefined;
  let ceiling = base?.agents?.ceiling;
  let routines = base?.agents?.routines;
  let providers = base?.ai?.providers;
  let setBy: TeamRulesSetBy = {};
  const providerLists: Array<TeamRulesList> = [];
  const modelLists: Array<TeamRulesList> = [];
  const connectionLists: Array<TeamRulesList> = [];
  for (const { source, agents, ai, connections } of active) {
    const nextCeiling = teamRulesStricterMode(ceiling, agents?.ceiling);
    if (nextCeiling !== ceiling) setBy = { ...setBy, ceiling: source };
    ceiling = nextCeiling;
    const nextRoutines = teamRulesStricterMode(routines, agents?.routines);
    if (nextRoutines !== routines) setBy = { ...setBy, routines: source };
    routines = nextRoutines;
    if (ai?.providers !== undefined) {
      const listed = ai.providers;
      providers =
        providers === undefined ? listed : providers.filter((name) => listed.includes(name));
      providerLists.push({ patterns: listed, by: source });
    }
    if (ai?.models !== undefined) modelLists.push({ patterns: ai.models, by: source });
    if (connections?.allow !== undefined) {
      connectionLists.push({ patterns: connections.allow, by: source });
    }
  }
  const {
    ai: baseAi,
    agents: baseAgents,
    ...restOfBase
  } = base ?? {
    version: 1 as const,
    owner: first.source.owner,
    ...(first.source.contact === undefined ? {} : { contact: first.source.contact }),
  };
  const agentsOut = {
    ...baseAgents,
    ...(ceiling === undefined ? {} : { ceiling }),
    ...(routines === undefined ? {} : { routines }),
  };
  const aiOut = { ...baseAi, ...(providers === undefined ? {} : { providers }) };
  return {
    status: "active",
    rules: {
      ...restOfBase,
      ...(Object.keys(agentsOut).length === 0 ? {} : { agents: agentsOut }),
      ...(Object.keys(aiOut).length === 0 ? {} : { ai: aiOut }),
    } as TeamRulesFile,
    fingerprint: machine.status === "active" ? machine.fingerprint : "",
    warnings: machine.status === "active" ? machine.warnings : [],
    sources: active.map((layer) => layer.source),
    ...(Object.keys(setBy).length === 0 ? {} : { setBy }),
    ...(providerLists.length === 0 ? {} : { providerLists }),
    ...(modelLists.length === 0 ? {} : { modelLists }),
    ...(connectionLists.length === 0 ? {} : { connectionLists }),
  };
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
  by?: TeamRulesSource,
): TeamRulesRefusal => {
  const named =
    by === undefined
      ? signature(state)
      : { owner: by.owner, ...(by.contact === undefined ? {} : { contact: by.contact }) };
  const contact = named.contact === undefined ? "" : ` See ${named.contact}.`;
  return {
    reason,
    message: `${message}${contact}`,
    ...named,
    ...(allowedMode === undefined ? {} : { allowedMode }),
  };
};

const setBy = (state: TeamRulesState, by?: TeamRulesSource) => {
  if (by !== undefined) {
    return by.source === "repository"
      ? `${by.owner}'s repository rules`
      : `${by.owner}'s rules for this repository`;
  }
  const { owner } = signature(state);
  return owner === undefined ? "Your team's rules" : `${owner}'s rules`;
};

const limitBy = (state: TeamRulesState, limit: keyof TeamRulesSetBy) =>
  state.status === "active" ? state.setBy?.[limit] : undefined;

/** Refuses every agent turn while the rules file is broken. */
export function teamRulesHoldRefusal(state: TeamRulesState): TeamRulesRefusal | null {
  if (state.status !== "hold") return null;
  const { owner } = signature(state);
  if (state.holdScope === "repository") {
    return refusal(
      state,
      "hold",
      `Agents are paused in this repository because its team rules file has an error${
        owner === undefined ? "" : `, set by ${owner}`
      }. Run specweave-studio rules check --repository . to see it.`,
    );
  }
  if (state.holdScope === "zone") {
    return refusal(
      state,
      "hold",
      `Agents are paused in this folder because its Git remotes could not be read, and ${owner ?? "your team"} limits some repositories. ${state.issues.join(" ")}`,
    );
  }
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
  const by = limitBy(state, "ceiling");
  return refusal(
    state,
    "ceiling",
    `${setBy(state, by)} allow up to ${teamRulesModeLabel(ceiling)}, so ${teamRulesModeLabel(mode)} is not available.`,
    ceiling,
    by,
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
  const routineLimit = state.status === "active" ? state.rules.agents?.routines : undefined;
  const by = limitBy(state, ceiling === routineLimit ? "routines" : "ceiling");
  return refusal(
    state,
    "routine-ceiling",
    `${setBy(state, by)} allow routines up to ${teamRulesModeLabel(ceiling)}, so this routine cannot run in ${teamRulesModeLabel(mode)}.`,
    ceiling,
    by,
  );
}

/**
 * `*` matches any text, ignoring case. A walk and not a regular expression:
 * a committed pattern comes from anyone with commit rights, and must not be
 * able to stall the server with backtracking.
 */
function patternMatches(pattern: string, text: string): boolean {
  const wanted = pattern.toLowerCase();
  const value = text.toLowerCase();
  let patternAt = 0;
  let valueAt = 0;
  let starAt = -1;
  let resumeAt = 0;
  while (valueAt < value.length) {
    if (wanted[patternAt] === "*") {
      starAt = patternAt++;
      resumeAt = valueAt;
    } else if (wanted[patternAt] === value[valueAt]) {
      patternAt++;
      valueAt++;
    } else if (starAt >= 0) {
      patternAt = starAt + 1;
      valueAt = ++resumeAt;
    } else {
      return false;
    }
  }
  while (wanted[patternAt] === "*") patternAt++;
  return patternAt === wanted.length;
}

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
  return (
    teamRulesModelMatches(state.rules.ai?.models, model) &&
    (state.modelLists ?? []).every(({ patterns }) => teamRulesModelMatches(patterns, model))
  );
}

/** Refuses a final provider and model outside the allowlist. */
export function teamRulesSelectionRefusal(
  state: TeamRulesState,
  selection: { readonly driver: string; readonly model: string },
): TeamRulesRefusal | null {
  if (!teamRulesProviderAllowed(state, selection.driver)) {
    const by =
      state.status === "active"
        ? state.providerLists?.find(({ patterns }) => !patterns.includes(selection.driver))?.by
        : undefined;
    return refusal(
      state,
      "provider",
      `${setBy(state, by)} do not approve the provider ${selection.driver}.`,
      undefined,
      by,
    );
  }
  if (!teamRulesModelAllowed(state, selection.model)) {
    const by =
      state.status === "active" && teamRulesModelMatches(state.rules.ai?.models, selection.model)
        ? state.modelLists?.find(
            ({ patterns }) => !teamRulesModelMatches(patterns, selection.model),
          )?.by
        : undefined;
    return refusal(
      state,
      "model",
      `${setBy(state, by)} do not approve the model ${selection.model}.`,
      undefined,
      by,
    );
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
  const by = limitBy(state, "ceiling");
  const contact = by === undefined ? state.rules.contact : by.contact;
  return {
    ceiling: own!,
    owner: by?.owner ?? state.rules.owner,
    ...(contact === undefined ? {} : { contact }),
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
    (state.modelLists?.length ?? 0) > 0 ||
    teamRulesPin(state, driver) !== undefined
  );
}

/** Whether a connection fits every list; no list allows everything. A hold allows nothing new. */
export function teamRulesConnectionRefusal(
  state: TeamRulesState,
  names: ReadonlyArray<string>,
): TeamRulesRefusal | null {
  if (state.status === "hold") return { ...teamRulesHoldRefusal(state)!, reason: "tools" };
  if (state.status !== "active") return null;
  const fits = (patterns: ReadonlyArray<string>) =>
    names.some((name) => patterns.some((pattern) => patternMatches(pattern, name)));
  const label = names.find((name) => name.length > 0) ?? "this connection";
  const machineList = state.rules.connections?.allow;
  if (machineList !== undefined && !fits(machineList)) {
    return refusal(state, "tools", `${setBy(state)} do not approve the connection ${label}.`);
  }
  const failed = state.connectionLists?.find(({ patterns }) => !fits(patterns));
  if (failed === undefined) return null;
  return refusal(
    state,
    "tools",
    `${setBy(state, failed.by)} do not approve the connection ${label}.`,
    undefined,
    failed.by,
  );
}

/** Whether no list limits connections, so an action naming none of them is safe. */
export function teamRulesConnectionAllowsAny(state: TeamRulesState): boolean {
  if (state.status === "none") return true;
  return (
    state.status === "active" &&
    state.rules.connections?.allow === undefined &&
    (state.connectionLists?.length ?? 0) === 0
  );
}

export interface TeamRulesUpdatePolicy {
  /** What the rules force; undefined leaves it to the person. */
  readonly automatic: boolean | undefined;
  readonly feed: string | undefined;
  readonly owner: string | undefined;
}

const NO_UPDATE_POLICY: TeamRulesUpdatePolicy = {
  automatic: undefined,
  feed: undefined,
  owner: undefined,
};

/** What the rules say about updates. A broken file could be hiding `false`, so a hold turns off automatic ones. */
export function teamRulesUpdatePolicy(state: TeamRulesState): TeamRulesUpdatePolicy {
  if (state.status === "none") return NO_UPDATE_POLICY;
  if (state.status === "hold") {
    return { automatic: false, feed: undefined, owner: state.owner };
  }
  const updates: TeamRulesUpdates | undefined = state.rules.updates;
  return updates === undefined
    ? NO_UPDATE_POLICY
    : { automatic: updates.automatic, feed: updates.feed, owner: state.rules.owner };
}

/** The same answer from the file's text, for a process with no rules state of its own. */
export function teamRulesUpdatePolicyByText(text: string): TeamRulesUpdatePolicy {
  const parsed = parseTeamRulesText(text);
  if (!parsed.ok) return { automatic: false, feed: undefined, owner: parsed.owner };
  const updates = parsed.rules.updates;
  return updates === undefined
    ? NO_UPDATE_POLICY
    : { automatic: updates.automatic, feed: updates.feed, owner: parsed.rules.owner };
}

/** Why the app must not update itself from the public feed, or null when it may. */
export function teamRulesUpdateFeedReason(policy: TeamRulesUpdatePolicy): string | null {
  if (policy.feed === undefined) return null;
  return `${policy.owner ?? "Your team"} delivers updates to this machine from ${policy.feed}, so the app does not use its public feed.`;
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

/**
 * Refuses a turn in a folder whose rules own a provider's launch when the
 * machine's rules do not. The registry starts one instance for every folder, so
 * it cannot apply a folder's limits; an instance with launch values of its own
 * could change the mode or the endpoint, so it does not run here.
 */
export function teamRulesFolderLaunchRefusal(
  folder: TeamRulesState,
  machine: TeamRulesState,
  driver: string,
  launchValues: boolean,
): TeamRulesRefusal | null {
  if (!launchValues || folder.status !== "active" || folder === machine) return null;
  if (teamRulesOwnsProviderLaunch(machine, driver)) return null;
  if (!teamRulesOwnsProviderLaunch(folder, driver)) return null;
  const by =
    folder.setBy?.ceiling ??
    folder.providerLists?.[0]?.by ??
    folder.modelLists?.[0]?.by ??
    folder.sources?.[0];
  return refusal(
    folder,
    "provider-launch",
    `${setBy(folder, by)} limit this folder, and this provider has its own launch arguments, environment or binary path, which could get around them. Use an instance without them here.`,
    undefined,
    by,
  );
}

/**
 * Whether an instance launches with values of its own, rather than its driver's
 * defaults. The settings form fills in the default binary name, so that does
 * not count. Environment variables, including API keys, always do.
 */
export function teamRulesInstanceHasLaunchValues(
  settings: Pick<ServerSettings, "providerInstances" | "providers">,
  instanceId: string,
  driver: string,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = {},
): boolean {
  const entry = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId as keyof typeof settings.providerInstances]
    : undefined;
  const providers = settings.providers as unknown as Record<string, Record<string, unknown>>;
  const defaults = (
    DEFAULT_SERVER_SETTINGS.providers as unknown as Record<string, Record<string, unknown>>
  )[driver];
  const stored = (config: unknown) =>
    typeof config === "object" && config !== null
      ? TEAM_RULES_LAUNCH_CONFIG_KEYS.some((key) => {
          const value = (config as Record<string, unknown>)[key];
          if (value === undefined || value === null || value === "") return false;
          if (Array.isArray(value) && value.length === 0) return false;
          return value !== defaults?.[key];
        })
      : false;
  return (
    (entry?.environment?.length ?? 0) > 0 ||
    stored(entry?.config) ||
    (entry === undefined && stored(providers[driver])) ||
    (driver === "codex" && Boolean(environment.STUDIO_CODEX_LAUNCH_ARGS?.trim()))
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
  if (state.status !== "active") return providers;
  if (state.rules.ai === undefined && (state.modelLists?.length ?? 0) === 0) return providers;
  const patterns = state.rules.ai?.models;
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
  if (state.status === "hold") {
    return {
      status: "hold",
      ...named,
      issues: state.issues,
      ...(state.holdScope === undefined ? {} : { holdScope: state.holdScope }),
    };
  }
  const { rules } = state;
  const ceiling = rules.agents?.ceiling;
  const routinesCeiling = teamRulesRoutineCeiling(state);
  const pinned = Object.keys(rules.ai?.pin ?? {});
  return {
    status: "active",
    ...named,
    fingerprint: state.fingerprint,
    ...(ceiling === undefined ? {} : { ceiling }),
    ...(state.setBy?.ceiling === undefined ? {} : { ceilingBy: state.setBy.ceiling }),
    ...(routinesCeiling === undefined ? {} : { routinesCeiling }),
    ...(rules.ai?.providers === undefined ? {} : { providers: rules.ai.providers }),
    ...(rules.ai?.models === undefined ? {} : { models: rules.ai.models }),
    ...(pinned.length === 0 ? {} : { pinnedProviders: pinned }),
    ...(limits(ceiling) ||
    rules.ai?.providers !== undefined ||
    rules.ai?.models !== undefined ||
    (state.modelLists?.length ?? 0) > 0
      ? { ownsProviderLaunch: true }
      : {}),
    ...(rules.telemetry?.export === undefined ? {} : { telemetryExport: rules.telemetry.export }),
    ...(rules.reach === undefined ? {} : { reach: rules.reach }),
    ...(rules.tools === undefined ? {} : { tools: rules.tools }),
    ...(rules.connections?.allow === undefined ? {} : { connections: rules.connections.allow }),
    ...(rules.updates === undefined ? {} : { updates: rules.updates }),
    ...(state.modelLists === undefined
      ? {}
      : { modelLists: state.modelLists.map(({ patterns }) => patterns) }),
    ...(state.connectionLists === undefined
      ? {}
      : { connectionLists: state.connectionLists.map(({ patterns }) => patterns) }),
    ...(state.sources === undefined ? {} : { sources: state.sources }),
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
      ...(summary.holdScope === undefined ? {} : { holdScope: summary.holdScope }),
    };
  }
  const by = summary.sources?.[0] ?? { source: "repository" as const, owner: summary.owner ?? "" };
  const lists = (patterns: ReadonlyArray<ReadonlyArray<string>> | undefined) =>
    (patterns ?? []).map((list) => ({ patterns: list, by }));
  return {
    status: "active",
    fingerprint: summary.fingerprint ?? "",
    warnings: [],
    ...(summary.sources === undefined ? {} : { sources: summary.sources }),
    ...(summary.ceilingBy === undefined ? {} : { setBy: { ceiling: summary.ceilingBy } }),
    ...(summary.modelLists === undefined ? {} : { modelLists: lists(summary.modelLists) }),
    ...(summary.connectionLists === undefined
      ? {}
      : { connectionLists: lists(summary.connectionLists) }),
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
      ...(summary.connections === undefined ? {} : { connections: { allow: summary.connections } }),
      ...(summary.updates === undefined ? {} : { updates: summary.updates }),
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
