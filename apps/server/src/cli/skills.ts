/**
 * `specwithcode skills [path]` - which skills each agent loads in a
 * folder, joined with vskill's lockfiles. Read-only and offline: it runs the
 * same discovery the providers use, with each agent's default settings, and
 * never starts a turn or changes a file.
 */
import {
  ProviderDriverKind,
  ProviderInstanceId,
  summarizeProjectSkills,
  type ProjectSkillsProviderState,
  ProjectSkillsSnapshot,
  type ServerProviderSkill,
} from "@specweave-studio/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";

import { expandHomePath } from "../os-jank.ts";
import { probeCodexSkillsForCwd } from "../provider/CodexProvider.ts";
import {
  discoverAntigravitySkills,
  resolveAntigravityUserHome,
} from "../provider/Drivers/AntigravitySkills.ts";
import { discoverClaudeSkills } from "../provider/Drivers/ClaudeSkills.ts";
import { probeCursorSkills } from "../provider/Drivers/CursorSkills.ts";
import { discoverGrokSkills } from "../provider/Drivers/GrokSkills.ts";
import type { ProviderSkillSource } from "../project/projectSkillsInventory.ts";
import { gatherProjectSkills } from "../project/projectSkillsScan.ts";

const PROVIDER_TIMEOUT_MS = 20_000;

const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(ProjectSkillsSnapshot));

const encodeSnapshotJson = (snapshot: ProjectSkillsSnapshot) =>
  encodeSnapshot(snapshot).pipe(Effect.orDie);

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function shorten(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

/** Plain-text rendering of a snapshot: a summary line, a table, then problems. */
export function formatProjectSkillsText(snapshot: ProjectSkillsSnapshot): string {
  const lines = [`${snapshot.cwd}: ${summarizeProjectSkills(snapshot.rows)}`, ""];
  const header = ["STATUS", "SKILL", "PROVIDERS", "SCOPE", "VERSION", "TIER", "SOURCE"];
  const table = snapshot.rows.map((row) => [
    row.status,
    row.name,
    row.providers.length === 0
      ? "-"
      : [...new Set(row.providers.map((presence) => presence.label))].join(","),
    row.scopes.join(",") || "-",
    row.lock?.version ?? "-",
    row.lock?.tier ?? "-",
    shorten(row.lock?.source ?? "-", 48),
  ]);
  const widths = header.map((title, column) =>
    Math.min(48, Math.max(title.length, ...table.map((cells) => cells[column]!.length))),
  );
  const render = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : pad(cell, widths[column]!)))
      .join("  ")
      .trimEnd();
  lines.push(render(header));
  for (const cells of table) lines.push(render(cells));

  const problems = snapshot.rows.filter((row) => row.attention);
  if (problems.length > 0) {
    lines.push("", "Needs attention:");
    for (const row of problems) {
      lines.push(`  ${row.name} (${row.status})`);
      for (const issue of row.issues) lines.push(`    - ${issue}`);
      if (row.path) lines.push(`    ${row.path}`);
    }
  }

  lines.push("", "Providers:");
  for (const provider of snapshot.providers) {
    lines.push(
      `  ${provider.label}: ${provider.skills} skill${provider.skills === 1 ? "" : "s"} (${provider.state})${
        provider.message ? ` - ${provider.message}` : ""
      }`,
    );
  }
  lines.push(
    "Lockfiles:",
    ...(snapshot.locks.length === 0
      ? ["  none found"]
      : snapshot.locks.map((lock) => `  ${lock.path} (${lock.scope}, ${lock.skills} skills)`)),
    `vskill doctor: ${snapshot.doctor}`,
    "",
  );
  return lines.join("\n");
}

type Discovery = Effect.Effect<
  ReadonlyArray<ServerProviderSkill>,
  Error,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
>;

const discoverAll = Effect.fn("skillsCli.discoverAll")(function* (cwd: string) {
  const environment = process.env;
  const platform = yield* HostProcessPlatform;
  const discoveries: ReadonlyArray<{
    readonly driver: string;
    readonly label: string;
    readonly run: Discovery;
  }> = [
    {
      driver: "claudeAgent",
      label: "Claude",
      run: discoverClaudeSkills({ homePath: "" }, cwd, environment),
    },
    {
      driver: "codex",
      label: "Codex",
      run: probeCodexSkillsForCwd({ binaryPath: "codex", cwd, environment }).pipe(Effect.scoped),
    },
    {
      driver: "grok",
      label: "Grok",
      run: discoverGrokSkills({ binaryPath: "" }, environment, cwd),
    },
    { driver: "cursor", label: "Cursor", run: probeCursorSkills(cwd, environment) },
    {
      driver: "antigravity",
      label: "Antigravity",
      run: discoverAntigravitySkills({
        cwd,
        userHome: resolveAntigravityUserHome(platform, environment),
      }),
    },
  ];
  return yield* Effect.forEach(
    discoveries,
    (discovery) =>
      Effect.gen(function* () {
        const exit = yield* discovery.run.pipe(
          Effect.timeoutOption(PROVIDER_TIMEOUT_MS),
          Effect.exit,
        );
        const skills =
          Exit.isSuccess(exit) && Option.isSome(exit.value) ? exit.value.value : undefined;
        const instanceId = ProviderInstanceId.make(discovery.driver);
        const driver = ProviderDriverKind.make(discovery.driver);
        const state: ProjectSkillsProviderState = {
          instanceId,
          driver,
          label: discovery.label,
          state: skills ? "ok" : Exit.isSuccess(exit) ? "timeout" : "error",
          skills: skills?.length ?? 0,
          ...(skills
            ? {}
            : {
                message: Exit.isSuccess(exit)
                  ? "Discovery did not finish in time."
                  : "Not installed or discovery failed.",
              }),
        };
        const source: ProviderSkillSource = {
          instanceId,
          driver,
          label: discovery.label,
          skills: skills ?? [],
        };
        return { source, state };
      }),
    { concurrency: "unbounded" },
  );
});

export type SkillsDiscovery = (cwd: string) => Effect.Effect<
  ReadonlyArray<{
    readonly source: ProviderSkillSource;
    readonly state: ProjectSkillsProviderState;
  }>,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
>;

export interface SkillsCommandOptions {
  /** Provider discovery; defaults to every agent's own skill scan. */
  readonly discover?: SkillsDiscovery;
  /** Home folder for user-scope vskill locks; defaults to the OS home. */
  readonly homeDir?: string;
  /** Run `vskill doctor --json` when the installed vskill has it. Default true. */
  readonly doctor?: boolean;
}

/**
 * `specwithcode skills [path] [--json]`: the rows of the project Skills view
 * for any folder, from the terminal. Both bins (`specweave-studio` and
 * `specwithcode`) run the same entry, so both expose it.
 */
export const makeSkillsCommand = (options: SkillsCommandOptions = {}) =>
  Command.make("skills", {
    path: Argument.String("path").pipe(
      Argument.withDescription("Project folder. Default: the current directory."),
      Argument.optional,
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the snapshot as JSON instead of a table."),
      Flag.withDefault(false),
    ),
  }).pipe(
    Command.withDescription(
      "List the skills each agent loads in a folder, with vskill versions and drift. Read-only.",
    ),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = path.resolve(
          Option.isSome(flags.path) ? yield* expandHomePath(flags.path.value) : process.cwd(),
        );
        const discovered = yield* (options.discover ?? discoverAll)(cwd);
        const snapshot = yield* gatherProjectSkills({
          cwd,
          providers: discovered.map((entry) => entry.source),
          providerStates: discovered.map((entry) => entry.state),
          ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
          ...(options.doctor === undefined ? {} : { doctor: options.doctor }),
        });
        yield* Console.log(
          flags.json ? yield* encodeSnapshotJson(snapshot) : formatProjectSkillsText(snapshot),
        );
      }),
    ),
  );

export const skillsCommand = makeSkillsCommand();
