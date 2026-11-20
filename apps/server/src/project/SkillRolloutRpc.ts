/**
 * The live wiring behind `projects.skillsRolloutKeep` and `projects.skillsAdopt`,
 * the check "Also add on" makes before sending a GitHub source, and the
 * catalog note regenerated after installs, updates, adoptions and rollouts.
 *
 * @module project/SkillRolloutRpc
 */
import {
  isBuiltInAgentSkill,
  WS_METHODS,
  type ProjectId,
  type ProjectSkillsAdoptInput,
  type ProjectSkillsFleetPushInput,
  type ProjectSkillsFleetPushResult,
  type ProjectSkillsRolloutKeepInput,
  type ProjectSkillsSnapshot,
  type ProjectSkillsActionError,
} from "@specweave-studio/contracts";
import type { StudioFleetSkillSource } from "@specweave-studio/contracts/studioFleet";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import type { CliRun } from "./ProjectSkillsActionsCommon.ts";
import { makeSkillAdopt } from "./SkillAdopt.ts";
import { renderSkillCatalog, writeSkillCatalog } from "./SkillCatalogNote.ts";
import type { SkillRepoSources } from "./SkillRepoSources.ts";
import { makeSkillRolloutKeep, makeSkillRolloutSeen } from "./SkillRolloutKeep.ts";
import type { SkillSearch } from "./SkillSearch.ts";
import { lockRepo } from "./SkillUpdate.ts";

const GH_TIMEOUT = "60 seconds";

export interface SkillRolloutDeps {
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly stateDir: string;
  readonly sources: SkillRepoSources;
  readonly search: SkillSearch;
  /** This machine's user-level skills, as the Skills page reads them. */
  readonly readUserSkills: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectSkillsSnapshot, ProjectSkillsActionError>;
  /** This machine's own name, for the catalog. */
  readonly machineName: Effect.Effect<string>;
}

const readableDate = (millis: number) =>
  new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(millis);

export const makeSkillRolloutHandlers = Effect.fn("SkillRollout.makeHandlers")(function* (
  deps: SkillRolloutDeps,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;

  const gh = (args: ReadonlyArray<string>, stdin?: string): Effect.Effect<CliRun> =>
    runner
      .run({
        command: "gh",
        args,
        cwd: deps.home,
        timeout: GH_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
        ...(stdin === undefined ? {} : { stdin }),
        env: {
          PATH: deps.environment.PATH ?? "",
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          NO_COLOR: "1",
        },
      })
      .pipe(
        Effect.map((output): CliRun => ({
          exitCode: output.code === null ? null : Number(output.code),
          stdout: output.stdout,
          stderr: output.stderr,
          timedOut: output.timedOut,
        })),
        Effect.orElseSucceed((): CliRun => ({
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
        })),
      );

  const keep = yield* makeSkillRolloutKeep({
    storePath: path.join(deps.stateDir, "skills", "rollout-keep.json"),
  });
  const seen = yield* makeSkillRolloutSeen({
    storePath: path.join(deps.stateDir, "skills", "rollout-seen.json"),
  });
  const adopt = yield* makeSkillAdopt({
    home: deps.home,
    stateDir: deps.stateDir,
    connectedIds: deps.sources.connectedIds,
    readRepo: (repo) => deps.sources.readRepo(repo),
    readText: deps.sources.readText,
    gh,
  });

  /** Rewrites the catalog note from this machine's skills; only where a vault exists. */
  const regenerateCatalog = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const snapshot = yield* deps.readUserSkills(projectId);
      const known = yield* seen.read;
      const machine = yield* deps.machineName;
      const labels = new Map(
        snapshot.providers.map((provider) => [provider.instanceId, provider.label]),
      );
      const skills = snapshot.rows
        // Built into an agent (claude.ai sync, Codex system skills): not installable, not listed.
        .filter(
          (row) =>
            row.providers.length === 0 ||
            !row.providers.every((presence) => isBuiltInAgentSkill(presence)),
        )
        .map((row) => {
          const repo = row.lock ? lockRepo(row.lock) : null;
          const sha = row.lock?.sha ?? null;
          const others = known
            .filter(
              (entry) =>
                repo !== null &&
                entry.repo.toLowerCase() === repo.toLowerCase() &&
                entry.skill === row.name &&
                entry.contentHash === sha,
            )
            .map((entry) => entry.machine);
          return {
            name: row.name,
            repo,
            version: row.lock?.version ?? null,
            commit: row.lock?.sourceCommitSha ?? null,
            agents: [
              ...new Set(
                row.providers.map(
                  (presence) => labels.get(presence.instanceId) ?? presence.instanceId,
                ),
              ),
            ],
            machines: [machine, ...new Set(others.filter((name) => name !== machine))],
          };
        });
      const note = renderSkillCatalog({
        machine,
        generatedAt: readableDate(yield* Clock.currentTimeMillis),
        skills,
      });
      return yield* writeSkillCatalog({ vault: deps.search.vault }, note);
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.orElseSucceed(() => "failed" as const),
    );

  /** Whether this machine reads that copy at that commit from a repo connected here. */
  const verifyGithubSource = (input: {
    readonly repo: string;
    readonly name: string;
    readonly source: StudioFleetSkillSource;
    readonly contentHash: string;
  }): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const ids = yield* deps.sources.connectedIds;
      if (!ids.some((id) => id.toLowerCase() === input.repo.toLowerCase()))
        return `${input.repo} is not connected on this machine.`;
      const read = yield* deps.sources.readSkill({
        repo: input.repo,
        name: input.name,
        path: input.source.path,
        branch: input.source.commit,
        refresh: true,
      });
      if (read.state !== "ok")
        return `${input.repo} could not be read at that commit from this machine.`;
      return read.skill.contentHash === input.contentHash
        ? null
        : `${input.repo} at ${input.source.commit.slice(0, 7)} holds another copy of ${input.name}. Check the skill again.`;
    });

  /** Remembers which machines a rollout confirmed, then rewrites the catalog. */
  const afterPush = (input: ProjectSkillsFleetPushInput, result: ProjectSkillsFleetPushResult) =>
    Effect.gen(function* () {
      if (input.github === undefined || input.preview === true) return;
      const [owner, repo, skill] = input.skillId.split("/");
      yield* seen.record(
        result.results
          .filter((entry) => entry.ok && entry.preview !== true)
          .map((entry) => ({
            repo: `${owner}/${repo}`,
            skill: skill!,
            machine: entry.label ?? entry.machineId,
            contentHash: entry.removed === true ? null : (input.contentHash ?? null),
          })),
      );
      yield* regenerateCatalog(input.projectId);
    }).pipe(Effect.ignore);

  const handlers = {
    [WS_METHODS.projectsSkillsRolloutKeep]: (input: ProjectSkillsRolloutKeepInput) =>
      keep.change(input),
    [WS_METHODS.projectsSkillsAdopt]: (input: ProjectSkillsAdoptInput) =>
      adopt
        .adopt(input)
        .pipe(
          Effect.flatMap((result) =>
            result.outcome?.outcome === "adopted"
              ? regenerateCatalog(input.projectId).pipe(
                  Effect.map((state) => ({ ...result, catalog: { state } })),
                )
              : Effect.succeed(result),
          ),
        ),
  };

  return { handlers, regenerateCatalog, verifyGithubSource, afterPush };
});
