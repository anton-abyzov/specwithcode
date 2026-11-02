/**
 * `specweave-studio rules`: read and explain the machine's Team rules. Reads
 * the file directly, so it works with the service stopped. `--file` judges a
 * candidate before it is deployed and never changes what the service enforces.
 */
import { type RuntimeMode, TEAM_RULES_FILE_NAME } from "@specweave-studio/contracts";
import {
  summarizeTeamRules,
  TEAM_RULES_DECLARED_ONLY,
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

const load = (file: Option.Option<string>) => {
  const path = Option.getOrElse(file, () => machineTeamRulesPath());
  return { path, state: readTeamRulesFile(path), candidate: Option.isSome(file) };
};

const CANNOT_DO = [
  "It is not a sandbox. It decides what the app asks providers for.",
  "A person with administrator rights can edit this file; only device management can stop that.",
  "Provider CLIs run outside the app read their own configuration, including their allow rules.",
  "Inside the app, Claude also loads its user, project and local settings, so its allow rules apply.",
  "A provider's home directory setting can point it at other credentials or configuration.",
  "Host and login-shell environment, such as ANTHROPIC_BASE_URL, still reaches providers.",
  "Version checks, account checks and the Chrome bridge can still run a stored binary path, including during a hold, though not for an agent turn.",
  "Terminals run what the person types.",
  "Older builds ignore these rules. Device application control handles that.",
];

const describeRules = (path: string, state: TeamRulesState): ReadonlyArray<string> => {
  if (state.status === "none") {
    return [`No Team rules at ${path}. Nothing here limits this machine.`];
  }
  if (state.status === "hold") {
    return [
      `Team rules at ${path} have an error, so agents are paused until it is fixed.`,
      ...(state.owner === undefined ? [] : [`Set by: ${state.owner}`]),
      ...state.issues.map((issue) => `  ${issue}`),
    ];
  }
  const { rules, fingerprint } = state;
  const ceiling = teamRulesCeiling(state);
  const routines = teamRulesRoutineCeiling(state);
  const declared = TEAM_RULES_DECLARED_ONLY.filter((section) => rules[section] !== undefined);
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
    ...(teamRulesOwnsProviderLaunch(state, "")
      ? [
          "Provider launch: launch arguments, environment and binary path come only from these rules, so an instance's own values, API keys included, are ignored.",
        ]
      : []),
    `Telemetry export: ${rules.telemetry?.export === false ? "off" : "not limited"}`,
    ...(declared.length === 0 ? [] : [`Declared, not enforced yet: ${declared.join(", ")}`]),
    ...(state.warnings.length === 0
      ? []
      : ["", "Warnings:", ...state.warnings.map((line) => `  ${line}`)]),
    "",
    "What these rules cannot do:",
    ...CANNOT_DO.map((line) => `  ${line}`),
  ];
};

const checkCommand = Command.make("check", { file: fileFlag }).pipe(
  Command.withDescription("Validate the Team rules file. Exits non-zero when it has an error."),
  Command.withHandler(
    Effect.fn("cli.rules.check")(function* (flags) {
      const { path, state, candidate } = load(flags.file);
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
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the client summary as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show the rules in force, what they enforce and what they cannot do."),
  Command.withHandler(
    Effect.fn("cli.rules.show")(function* (flags) {
      const { path, state } = load(flags.file);
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
      const { path, state } = load(flags.file);
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

export const rulesCommand = Command.make("rules").pipe(
  Command.withDescription(
    "Read and explain the machine's Team rules: limits a company sets on permissions, providers and models.",
  ),
  Command.withSubcommands([checkCommand, showCommand, explainCommand]),
);
