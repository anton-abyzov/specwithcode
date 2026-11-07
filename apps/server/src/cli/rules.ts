/**
 * `specweave-studio rules`: read and explain the machine's Team rules. Reads
 * the file directly, so it works with the service stopped. `--file` judges a
 * candidate before it is deployed and never changes what the service enforces.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - a CLI that reads a candidate file and writes companion files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type RuntimeMode, TEAM_RULES_FILE_NAME } from "@specweave-studio/contracts";
import {
  parseTeamRulesRepositoryText,
  summarizeTeamRules,
  teamRulesCeiling,
  teamRulesModeLabel,
  teamRulesModeRefusal,
  teamRulesOwnsProviderLaunch,
  teamRulesRoutineCeiling,
  teamRulesRoutineRefusal,
  teamRulesSelectionRefusal,
  type TeamRulesState,
} from "@specweave-studio/shared/teamRules";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Flag, Command } from "effect/cli";

import { machineTeamRulesPath, readTeamRulesFile } from "../teamRules/TeamRules.ts";
import { readTeamRulesFolderState } from "../teamRules/TeamRulesScope.ts";
import { COMPANION_PATHS, teamRulesCompanion } from "../teamRules/companion.ts";
import { teamRulesRecordLines, writeTeamRulesRecordsFile } from "../teamRules/TeamRulesRecords.ts";
import { baseDirFlag } from "./config.ts";
import { resolveDatabasePath } from "./db.ts";

export class CliTeamRulesError extends Schema.TaggedError<CliTeamRulesError>()(
  "CliTeamRulesError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const fileFlag = Flag.String("file").pipe(
  Flag.withDescription(
    `Judge this candidate file instead of the machine's ${TEAM_RULES_FILE_NAME}. It changes nothing the service enforces.`,
  ),
  Flag.optional,
);

const repositoryFlag = Flag.String("repository").pipe(
  Flag.withDescription(
    "Also apply this folder's zones and its repository's committed rules, read from the default branch's remote-tracking ref.",
  ),
  Flag.optional,
);

const load = (file: Option.Option<string>) => {
  const path = Option.getOrElse(file, () => machineTeamRulesPath());
  return { path, state: readTeamRulesFile(path), candidate: Option.isSome(file) };
};

const loadFolder = (file: Option.Option<string>, repository: Option.Option<string>) =>
  Effect.gen(function* () {
    const loaded = load(file);
    if (Option.isNone(repository)) return loaded;
    const state = yield* Effect.promise(() =>
      readTeamRulesFolderState(loaded.state, repository.value),
    );
    return { ...loaded, state };
  });

const CANNOT_DO = [
  "It is not a sandbox. It decides what the app asks providers for.",
  "A person with administrator rights can edit this file; only device management can stop that.",
  "Provider CLIs run outside the app read their own configuration, including their allow rules.",
  "Inside the app, Claude also loads its user, project and local settings, so its allow rules apply.",
  "A provider's home directory setting can point it at other credentials or configuration.",
  "Host and login-shell environment, such as ANTHROPIC_BASE_URL, still reaches providers.",
  "Version checks, account checks and the Chrome bridge can still run a stored binary path, including during a hold, though not for an agent turn.",
  "Terminals run what the person types.",
  "same-rules compares fingerprints a machine reports about itself. It catches drift, not a hostile machine.",
  "A client reports its own device type, so phone rules cannot catch a client that lies; phone links are always caught.",
  "Links a person drives from a browser name no rules, so same-rules checks the machine they came through.",
  "iPadOS Safari reports itself as a Mac, so reach.phones treats it as a desktop unless it paired through a phone link.",
  "Browser sessions opened through a coordinator meet same-rules when they start, and folder copies check only none and a hold.",
  "Codex's own browser and computer tools are not turned off by tools.chrome or tools.computerUse.",
  "A machine with a grant can claim to have set a carried ceiling itself, which drops it there. Grant work only to machines you trust.",
  "A carried ceiling limits the permission mode. The model list stays with each machine's own rules.",
  "A restart during a hold restores a stored Connect tunnel; the rules stop it again once the file is fixed.",
  "Older builds ignore these rules. Device application control handles that.",
  "Repository rules bind only people using SpecWithCode on that repository. They are a team agreement, not a security boundary.",
  "A repository's rules can only tighten. They cannot set reach, tools, telemetry, updates, zones or a pin, and they reach a machine only after a fetch updates its remote-tracking ref.",
  "Anyone who can run a shell in the repository, agents included, can move that ref or change its remotes, so repository rules and zones bind cooperative use.",
  "Zones match the Git remotes of a thread's working folder. A folder that is not a Git repository matches nothing, even if it holds a client's repository. A zone cannot set a pin.",
  "connections covers project connections and turning on native ones. Provider CLIs load their own configured servers, so use rules companion for those.",
  "updates.feed stops updates from the public feed. It does not download from your feed; your own deployment installs those.",
  "rules companion files bind a provider CLI only where you deploy them, and only for what that provider can express.",
  "Records are not tamper evident while agents run as the same OS user as the database. Person and device come from the client's session, and records begin when machine rules appear.",
];

const describeSwitches = (section: object) =>
  Object.entries(section)
    .map(([name, value]) => `${name} ${value === false ? "off" : value === true ? "on" : value}`)
    .join(", ");

const describeRules = (path: string, state: TeamRulesState): ReadonlyArray<string> => {
  if (state.status === "none") {
    return [`No Team rules at ${path}. Nothing here limits this machine.`];
  }
  if (state.status === "hold") {
    return [
      state.holdScope === undefined
        ? `Team rules at ${path} have an error, so agents are paused until it is fixed.`
        : "This folder's rules could not be read, so agents are paused in this folder until that is fixed.",
      ...(state.owner === undefined ? [] : [`Set by: ${state.owner}`]),
      ...state.issues.map((issue) => `  ${issue}`),
    ];
  }
  const { rules, fingerprint } = state;
  const ceiling = teamRulesCeiling(state);
  const routines = teamRulesRoutineCeiling(state);
  return [
    `Team rules at ${path}`,
    `Set by: ${rules.owner}`,
    ...(rules.contact === undefined ? [] : [`Contact: ${rules.contact}`]),
    `Fingerprint: ${fingerprint}`,
    "",
    `Broadest permission: ${ceiling === undefined ? "not limited" : teamRulesModeLabel(ceiling)}`,
    `Broadest for routines: ${routines === undefined ? "not limited" : teamRulesModeLabel(routines)}`,
    `Approved providers: ${rules.ai?.providers?.join(", ") ?? "any"}`,
    `Approved models: ${rules.ai?.models?.join(", ") ?? "any"}`,
    `Pinned providers: ${Object.keys(rules.ai?.pin ?? {}).join(", ") || "none"}`,
    ...(rules.reach === undefined ? [] : [`Reach: ${describeSwitches(rules.reach)}`]),
    ...(rules.tools === undefined ? [] : [`Tools: ${describeSwitches(rules.tools)}`]),
    ...(teamRulesOwnsProviderLaunch(state, "")
      ? [
          "Provider launch: launch arguments, environment and binary path come only from these rules, so an instance's own values, API keys included, are ignored.",
        ]
      : []),
    `Telemetry export: ${rules.telemetry?.export === false ? "off" : "not limited"}`,
    ...(rules.connections?.allow === undefined
      ? []
      : [`Approved connections: ${rules.connections.allow.join(", ") || "none"}`]),
    ...(rules.updates === undefined
      ? []
      : [
          `Updates: ${[
            ...(rules.updates.automatic === undefined
              ? []
              : [rules.updates.automatic ? "automatic, locked on" : "automatic off, locked"]),
            ...(rules.updates.feed === undefined
              ? []
              : [`delivered from ${rules.updates.feed}, public feed off`]),
          ].join("; ")}`,
        ]),
    ...(rules.zones === undefined
      ? []
      : [`Zones: ${rules.zones.map((zone) => zone.remote).join(", ")}`]),
    ...(state.sources ?? []).map((source) =>
      source.source === "repository"
        ? `Repository rules from ${source.owner}: a team agreement, not a security boundary.`
        : `A zone set by ${source.owner} applies to this folder.`,
    ),
    ...(state.warnings.length === 0
      ? []
      : ["", "Warnings:", ...state.warnings.map((line) => `  ${line}`)]),
    "",
    "What these rules cannot do:",
    ...CANNOT_DO.map((line) => `  ${line}`),
  ];
};

const checkCommand = Command.make("check", {
  file: fileFlag,
  repository: repositoryFlag,
  repositoryFile: Flag.String("repository-file").pipe(
    Flag.withDescription("Judge this file as a candidate for a repository's committed rules."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Validate the Team rules file. Exits non-zero when it has an error."),
  Command.withHandler(
    Effect.fn("cli.rules.check")(function* (flags) {
      if (Option.isSome(flags.repositoryFile)) {
        const path = flags.repositoryFile.value;
        const text = yield* Effect.try({
          try: () => NodeFS.readFileSync(path, "utf8"),
          catch: () => new CliTeamRulesError({ reason: `Could not read ${path}.` }),
        });
        const parsed = parseTeamRulesRepositoryText(text);
        if (!parsed.ok) {
          return yield* new CliTeamRulesError({
            reason: [`${path} is invalid:`, ...parsed.issues.map((line) => `  ${line}`)].join("\n"),
          });
        }
        yield* Console.log(`${path} is valid repository rules. Set by ${parsed.rules.owner}.`);
        return;
      }
      const { path, state, candidate } = yield* loadFolder(flags.file, flags.repository);
      if (state.status === "hold") {
        return yield* new CliTeamRulesError({
          reason: [
            `${path} is invalid${candidate ? "" : ", so agents on this machine are paused"}:`,
            ...state.issues.map((issue) => `  ${issue}`),
          ].join("\n"),
        });
      }
      if (state.status === "none") {
        if (candidate) {
          return yield* new CliTeamRulesError({ reason: `${path} does not exist.` });
        }
        yield* Console.log(`No Team rules at ${path}.`);
        return;
      }
      yield* Console.log(`${path} is valid. Set by ${state.rules.owner}, ${state.fingerprint}.`);
      for (const warning of state.warnings) yield* Console.log(`Warning: ${warning}`);
    }),
  ),
);

const showCommand = Command.make("show", {
  file: fileFlag,
  repository: repositoryFlag,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the client summary as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show the rules in force, what they enforce and what they cannot do."),
  Command.withHandler(
    Effect.fn("cli.rules.show")(function* (flags) {
      const { path, state } = yield* loadFolder(flags.file, flags.repository);
      if (flags.json) {
        yield* Console.log(
          // @effect-diagnostics-next-line preferSchemaOverJson:off - prints a plain summary for people and scripts.
          JSON.stringify({ path, ...(summarizeTeamRules(state) ?? { status: "none" }) }, null, 2),
        );
        return;
      }
      yield* Console.log(describeRules(path, state).join("\n"));
    }),
  ),
);

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

const explainCommand = Command.make("explain", {
  file: fileFlag,
  repository: repositoryFlag,
  mode: Flag.Literals("mode", RUNTIME_MODES).pipe(
    Flag.withDescription("A permission mode to judge."),
    Flag.optional,
  ),
  routine: Flag.Boolean("routine").pipe(
    Flag.withDescription("Judge the mode for a routine instead of a chat."),
    Flag.withDefault(false),
  ),
  provider: Flag.String("provider").pipe(
    Flag.withDescription("A provider driver to judge, such as claudeAgent."),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(Flag.withDescription("A model to judge."), Flag.optional),
}).pipe(
  Command.withDescription("Say whether a permission mode, provider or model is allowed, and why."),
  Command.withHandler(
    Effect.fn("cli.rules.explain")(function* (flags) {
      const { path, state } = yield* loadFolder(flags.file, flags.repository);
      if (state.status === "none") {
        yield* Console.log(`Allowed: no Team rules at ${path}.`);
        return;
      }
      if (state.status === "hold") {
        yield* Console.log(`Refused: the rules at ${path} have an error, so agents are paused.`);
        return;
      }
      const lines: Array<string> = [];
      if (Option.isSome(flags.mode)) {
        const mode = flags.mode.value;
        const refused = flags.routine
          ? teamRulesRoutineRefusal(state, mode)
          : teamRulesModeRefusal(state, mode);
        lines.push(
          refused === null
            ? `Allowed: ${teamRulesModeLabel(mode)} is within ${state.rules.owner}'s rules.`
            : `Refused: ${refused.message}`,
        );
      }
      if (Option.isSome(flags.provider) || Option.isSome(flags.model)) {
        const refused = teamRulesSelectionRefusal(state, {
          driver: Option.getOrElse(flags.provider, () => state.rules.ai?.providers?.[0] ?? ""),
          model: Option.getOrElse(flags.model, () => ""),
        });
        const modelOnly = Option.isNone(flags.model);
        const judged =
          refused !== null && !(modelOnly && refused.reason === "model") ? refused : null;
        lines.push(
          judged === null
            ? `Allowed: ${[
                Option.getOrUndefined(flags.provider),
                Option.getOrUndefined(flags.model),
              ]
                .filter((part) => part !== undefined)
                .join(" ")} is within ${state.rules.owner}'s rules.`
            : `Refused: ${judged.message}`,
        );
      }
      if (lines.length === 0) lines.push(...describeRules(path, state));
      yield* Console.log(lines.join("\n"));
    }),
  ),
);

const companionCommand = Command.make("companion", {
  file: fileFlag,
  output: Flag.String("output").pipe(
    Flag.withDescription("Write managed-settings.json and requirements.toml into this new folder."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Print the Claude Code managed-settings.json and Codex requirements.toml matching these rules, for device management.",
  ),
  Command.withHandler(
    Effect.fn("cli.rules.companion")(function* (flags) {
      const { path, state } = load(flags.file);
      if (state.status === "none") {
        yield* Console.log(`No Team rules at ${path}, so there is nothing to print.`);
        return;
      }
      if (state.status === "hold") {
        return yield* new CliTeamRulesError({
          reason: [`${path} is invalid:`, ...state.issues.map((line) => `  ${line}`)].join("\n"),
        });
      }
      const companion = teamRulesCompanion(state.rules);
      const notes =
        companion.notes.length === 0
          ? []
          : ["", "Not carried over:", ...companion.notes.map((note) => `  ${note}`)];
      const where = (paths: { darwin: string; linux: string; win32: string }) =>
        `macOS ${paths.darwin}, Linux ${paths.linux}, Windows ${paths.win32}`;
      if (Option.isSome(flags.output)) {
        const output = flags.output.value;
        yield* Effect.try({
          try: () => {
            NodeFS.mkdirSync(output);
            NodeFS.writeFileSync(
              NodePath.join(output, "managed-settings.json"),
              companion.managedSettings,
            );
            NodeFS.writeFileSync(
              NodePath.join(output, "requirements.toml"),
              companion.requirements,
            );
          },
          catch: () =>
            new CliTeamRulesError({
              reason: `Could not create ${output}. It must be a new folder.`,
            }),
        });
        yield* Console.log(
          [
            `Wrote managed-settings.json and requirements.toml to ${output}.`,
            `Deploy managed-settings.json to: ${where(COMPANION_PATHS.managedSettings)}.`,
            `Deploy requirements.toml to: ${where(COMPANION_PATHS.requirements)}.`,
            ...notes,
          ].join("\n"),
        );
        return;
      }
      yield* Console.log(
        [
          `# managed-settings.json (${where(COMPANION_PATHS.managedSettings)})`,
          companion.managedSettings.trimEnd(),
          "",
          `# requirements.toml (${where(COMPANION_PATHS.requirements)})`,
          companion.requirements.trimEnd(),
          ...notes,
        ].join("\n"),
      );
    }),
  ),
);

const dateFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);

const isoFrom = (name: string, value: Option.Option<string>) =>
  Option.match(value, {
    onNone: () => Effect.succeed(undefined as string | undefined),
    onSome: (text) =>
      Number.isNaN(Date.parse(text))
        ? Effect.fail(new CliTeamRulesError({ reason: `--${name} must be a date.` }))
        : // A bare --until date includes that whole day.
          Effect.succeed(
            new Date(
              name === "until" && /^\d{4}-\d{2}-\d{2}$/u.test(text)
                ? `${text}T23:59:59.999Z`
                : text,
            ).toISOString(),
          ),
  });

const recordsCommand = Command.make("records", {
  baseDir: baseDirFlag,
  since: dateFlag("since", "Only records at or after this date."),
  until: dateFlag("until", "Only records at or before this date."),
  output: Flag.String("output").pipe(
    Flag.withDescription("Write to this new private file instead of printing."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Export who did what as JSON lines: events and settings changes with person and device, never message text or setting values.",
  ),
  Command.withHandler(
    Effect.fn("cli.rules.records")(function* (flags) {
      const dbPath = yield* resolveDatabasePath(flags.baseDir);
      const since = yield* isoFrom("since", flags.since);
      const until = yield* isoFrom("until", flags.until);
      const query = { dbPath, since, until };
      if (Option.isSome(flags.output)) {
        const output = flags.output.value;
        const count = yield* Effect.try({
          try: () => writeTeamRulesRecordsFile(query, output),
          catch: (cause) =>
            new CliTeamRulesError({
              reason: `Could not write ${output}: ${(cause as NodeJS.ErrnoException).code ?? "export failed"}. It must be a new file.`,
            }),
        });
        yield* Console.log(`Wrote ${count} records to ${output}.`);
        return;
      }
      const lines = teamRulesRecordLines(query);
      while (true) {
        const next = yield* Effect.try({
          try: () => lines.next(),
          catch: () => new CliTeamRulesError({ reason: "Could not read the database." }),
        });
        if (next.done === true) return;
        yield* Console.log(next.value);
      }
    }),
  ),
);

export const rulesCommand = Command.make("rules").pipe(
  Command.withDescription(
    "Read and explain the machine's Team rules: limits a company sets on permissions, providers and models.",
  ),
  Command.withSubcommands([
    checkCommand,
    showCommand,
    explainCommand,
    companionCommand,
    recordsCommand,
  ]),
);
