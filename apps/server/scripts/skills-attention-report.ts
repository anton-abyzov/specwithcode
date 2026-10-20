#!/usr/bin/env node
// @effect-diagnostics preferSchemaOverJson:off - a read-only report script that reads and writes loose JSON files.
/**
 * Print the project Skills view's rows for a folder, the way Settings >
 * Skills builds them from Claude, Codex and Grok, and end with
 * `attention N`. Read-only: it runs each agent's own skill discovery, reads
 * vskill lockfiles and runs `vskill doctor --json`.
 *
 *   npx tsx apps/server/scripts/skills-attention-report.ts <cwd>
 *     [--codex-json <file>]  Codex `skills/list` output to use when the live probe fails
 *     [--src <studio root>]  run another checkout's server code (for before/after numbers)
 *     [--json <file>]        also write the snapshot as JSON
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  ProjectSkillRow,
  ProjectSkillsSnapshot,
  ServerProviderSkill,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

type ClaudeSkillsModule = typeof import("../src/provider/Drivers/ClaudeSkills.ts");
type GrokSkillsModule = typeof import("../src/provider/Drivers/GrokSkills.ts");
type CodexProviderModule = typeof import("../src/provider/CodexProvider.ts");
type ProjectSkillsScanModule = typeof import("../src/project/projectSkillsScan.ts");

const PROVIDER_TIMEOUT_MS = 60_000;
const VALUE_FLAGS = new Set(["--codex-json", "--src", "--json"]);

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function rowLine(row: ProjectSkillRow): string {
  const providers = [...new Set(row.providers.map((presence) => presence.label))].join(",") || "-";
  const fileVersions = [
    ...new Set(
      row.providers.flatMap((presence) => presence.pluginVersion ?? presence.fileVersion ?? []),
    ),
  ];
  return [
    row.attention ? "!" : " ",
    row.status.padEnd(9),
    row.name.padEnd(36),
    providers.padEnd(18),
    `lock ${row.lock?.version ?? "-"}`.padEnd(12),
    `file ${fileVersions.join("/") || "-"}`.padEnd(18),
    row.staleLock ? "stale lock entry" : "",
    row.aliases?.length ? `aka ${row.aliases.join(", ")}` : "",
    row.attention ? `| ${row.issues.join(" / ")}` : "",
  ]
    .filter((cell) => cell !== "")
    .join("  ");
}

/** A provider's skills, or undefined when its discovery failed or timed out. */
const settle = <E, R>(
  run: Effect.Effect<ReadonlyArray<ServerProviderSkill>, E, R>,
): Effect.Effect<ReadonlyArray<ServerProviderSkill> | undefined, never, R> =>
  run.pipe(
    Effect.timeoutOption(PROVIDER_TIMEOUT_MS),
    Effect.exit,
    Effect.map((exit) =>
      Exit.isSuccess(exit) && Option.isSome(exit.value) ? exit.value.value : undefined,
    ),
  );

const report = (cwdArgument: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = path.resolve(cwdArgument);
    const here = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
    const root = path.resolve(argument("--src") ?? path.join(here, "../../.."));
    const load = <Module>(relative: string) =>
      Effect.promise(() => import(path.join(root, "apps/server/src", relative)) as Promise<Module>);
    const { discoverClaudeSkills } = yield* load<ClaudeSkillsModule>(
      "provider/Drivers/ClaudeSkills.ts",
    );
    const { discoverGrokSkills } = yield* load<GrokSkillsModule>("provider/Drivers/GrokSkills.ts");
    const { probeCodexSkillsForCwd } = yield* load<CodexProviderModule>(
      "provider/CodexProvider.ts",
    );
    const { gatherProjectSkills } = yield* load<ProjectSkillsScanModule>(
      "project/projectSkillsScan.ts",
    );

    const environment = process.env;
    const [claude, codexLive, grok] = yield* Effect.all(
      [
        settle(discoverClaudeSkills({ homePath: "" }, cwd, environment)),
        settle(
          probeCodexSkillsForCwd({ binaryPath: "codex", cwd, environment }).pipe(Effect.scoped),
        ),
        settle(discoverGrokSkills({ binaryPath: "" }, environment, cwd)),
      ],
      { concurrency: "unbounded" },
    );
    let codex = codexLive;
    const codexFile = argument("--codex-json");
    if (!codex && codexFile) {
      const raw = JSON.parse(yield* fs.readFileString(codexFile)) as {
        data: ReadonlyArray<{ cwd: string; skills: ReadonlyArray<ServerProviderSkill> }>;
      };
      const entry = raw.data.find((candidate) => candidate.cwd === cwd);
      codex = (entry ? entry.skills : raw.data.flatMap((candidate) => candidate.skills)).map(
        (skill) => ({
          name: skill.name,
          path: skill.path,
          enabled: skill.enabled,
          ...(skill.description ? { description: skill.description } : {}),
          ...(skill.scope ? { scope: skill.scope } : {}),
        }),
      );
    }
    const discovered = [
      { id: "claudeAgent", label: "Claude", skills: claude },
      { id: "codex", label: "Codex", skills: codex },
      { id: "grok", label: "Grok", skills: grok },
    ];
    const providers = discovered.map((provider) => ({
      instanceId: provider.id as never,
      driver: provider.id as never,
      label: provider.label,
      skills: provider.skills ?? [],
    }));
    const snapshot: ProjectSkillsSnapshot = yield* gatherProjectSkills({
      cwd,
      providers,
      providerStates: discovered.map((provider) => ({
        instanceId: provider.id as never,
        driver: provider.id as never,
        label: provider.label,
        state: provider.skills ? "ok" : "error",
        skills: provider.skills?.length ?? 0,
      })),
    });

    // Rows that load the same file after links: each extra one is a phantom.
    const namesByFile = new Map<string, Set<string>>();
    for (const row of snapshot.rows) {
      for (const presence of row.providers) {
        const real = yield* fs
          .realPath(presence.path)
          .pipe(Effect.orElseSucceed(() => presence.path));
        const names = namesByFile.get(real) ?? new Set<string>();
        names.add(row.name);
        namesByFile.set(real, names);
      }
    }
    const phantom = [...namesByFile.values()].reduce((sum, names) => sum + names.size - 1, 0);
    const output = argument("--json");
    if (output) yield* fs.writeFileString(output, JSON.stringify(snapshot, null, 1));

    return [
      `cwd ${cwd}`,
      `src ${root}`,
      `providers ${snapshot.providers
        .map(
          (provider) =>
            `${provider.label}=${provider.skills}${provider.state === "ok" ? "" : `(${provider.state})`}`,
        )
        .join(" ")}${codexLive ? "" : codex ? " (codex from file)" : ""}`,
      `doctor ${snapshot.doctor}`,
      ...snapshot.rows.map(rowLine),
      `rows ${snapshot.rows.length}`,
      `phantom ${phantom}`,
      `attention ${snapshot.rows.filter((row) => row.attention).length}`,
    ];
  });

const cwdArgument = process.argv
  .slice(2)
  .find((value, index, all) => !value.startsWith("--") && !VALUE_FLAGS.has(all[index - 1] ?? ""));
if (!cwdArgument) {
  process.stderr.write(
    "usage: skills-attention-report.ts <cwd> [--codex-json <file>] [--src <root>] [--json <file>]\n",
  );
  process.exit(2);
}
const lines = await Effect.runPromise(report(cwdArgument).pipe(Effect.provide(NodeServices.layer)));
process.stdout.write(`${lines.join("\n")}\n`);
