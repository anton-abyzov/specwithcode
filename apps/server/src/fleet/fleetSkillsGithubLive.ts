/**
 * The live `FleetSkillGithubReads`: the repos connected on this machine (its
 * Skills settings' saved list) and one SKILL.md read at one commit through
 * this machine's own GitHub access, as the Skills page reads them.
 *
 * @module fleet/fleetSkillsGithubLive
 */
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { makeLiveSkillRepoSources } from "../project/SkillUpdateRpc.ts";
import * as FleetSkills from "./fleetSkills.ts";
import { FleetSkillGithubReads } from "./fleetSkillsGithubSource.ts";

export const layer = Layer.effect(
  FleetSkillGithubReads,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const { sources } = yield* makeLiveSkillRepoSources({
      home: expandHomePath("~"),
      environment: yield* HostProcessEnvironment,
      stateDir: config.stateDir,
    });
    return FleetSkillGithubReads.of({
      connectedRepos: sources.connectedIds,
      readSkill: ({ repo, name, path, commit }) =>
        sources.readSkill({ repo, name, path, branch: commit, refresh: true }),
    });
  }),
);

/** The fleet skill worker with this machine's GitHub reads, as the server mounts it. */
export const fleetSkillsLayer = FleetSkills.layer.pipe(Layer.provide(layer));
