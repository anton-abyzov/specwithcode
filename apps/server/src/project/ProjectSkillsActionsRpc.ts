/**
 * The Skills control center's RPC handlers (`WsProjectSkillsActionsRpcGroup`)
 * and the live wiring behind them: rows and folders from ProjectSkillsService,
 * each agent's binary and config folder from its provider instance, Codex's
 * app server, the fleet file and this server's environment id.
 *
 * @module project/ProjectSkillsActionsRpc
 */
import {
  ProjectSkillsActionError,
  type ProjectSkillsFleetPushInput,
  type ProjectSkillsReadError,
  type ProjectSkillsStudioLinkInput,
  WS_METHODS,
  WsProjectSkillsActionsRpcGroup,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { resolveSpawnCommand } from "@specweave-studio/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetTargets from "../fleet/FleetTargets.ts";
import { runFleetSkillInstalls } from "../fleet/fleetSkills.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProcessRunner from "../processRunner.ts";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { makeProjectSkillsActions } from "./ProjectSkillsActions.ts";
import {
  findVskillBinary,
  type ProjectSkillsActionsDeps,
  type SkillTarget,
} from "./ProjectSkillsActionsCommon.ts";
import { makeStudioLink, pushSkillToFleet } from "./ProjectSkillsFleet.ts";
import * as ProjectSkillsService from "./ProjectSkillsService.ts";

const CODEX_START_TIMEOUT = "20 seconds";

const fromReadError = (error: ProjectSkillsReadError) =>
  new ProjectSkillsActionError({ projectId: error.projectId, reason: error.reason });

/** Whether a process with this id is running (one owned by another user counts). */
const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { readonly code?: string }).code === "EPERM";
  }
};

export const layerSkillsActionsRpcHandlers = WsProjectSkillsActionsRpcGroup.middleware(
  RpcInstrumentation,
)
  .toLayer(
    Effect.gen(function* () {
      const skills = yield* ProjectSkillsService.ProjectSkillsService;
      const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
      const registry = yield* ProviderRegistry.ProviderRegistry;
      const fleetTargets = yield* FleetTargets.FleetTargets;
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const config = yield* ServerConfig.ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const platform = yield* HostProcessPlatform;
      const home = expandHomePath("~");

      const resolveRow = (input: SkillTarget) =>
        Effect.gen(function* () {
          const cwd = yield* skills.resolveCwd(input);
          const snapshot = yield* skills.read({
            projectId: input.projectId,
            cwd,
            ...(input.threadId ? { threadId: input.threadId } : {}),
            ...(input.userLevel === true ? { userLevel: true } : {}),
          });
          const row =
            snapshot.rows.find((candidate) => candidate.name === input.skill) ??
            snapshot.rows.find((candidate) => candidate.aliases?.includes(input.skill));
          if (row === undefined)
            return yield* new ProjectSkillsActionError({
              projectId: input.projectId,
              reason: "skill_not_found",
            });
          return {
            projectId: input.projectId,
            cwd,
            row,
            ...(input.userLevel === true ? { userLevel: true } : {}),
          };
        }).pipe(
          Effect.catchTag("ProjectSkillsReadError", (error) => Effect.fail(fromReadError(error))),
        );

      const deps: ProjectSkillsActionsDeps = {
        home,
        environment: hostEnvironment,
        platform,
        backupDir: path.join(config.stateDir, "skills", "backups"),
        resolveRow,
        agentControl: (instanceId) =>
          instances.getInstance(instanceId).pipe(Effect.map((instance) => instance?.skillsControl)),
        codexClient: (control, cwd, projectId) => {
          const unavailable = (cause?: unknown) =>
            new ProjectSkillsActionError({
              projectId,
              reason: "agent_unavailable",
              detail: "Codex's app server could not be started.",
              ...(cause === undefined ? {} : { cause }),
            });
          return withCodexAppServerClient({
            binaryPath: control.binaryPath,
            homePath: control.homePath,
            launchArgs: control.launchArgs,
            cwd,
            environment: control.environment,
          }).pipe(
            Effect.timeoutOption(CODEX_START_TIMEOUT),
            Effect.mapError(unavailable),
            Effect.flatMap((started) =>
              Option.isSome(started)
                ? Effect.succeed(started.value.client)
                : Effect.fail(unavailable()),
            ),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
        },
        afterWrite: ({ projectId, cwd, instanceIds }) =>
          Effect.gen(function* () {
            yield* skills.invalidate({ projectId, cwd });
            // Each agent scans the folder again on its own; the next read waits for it.
            for (const instanceId of new Set(instanceIds))
              yield* registry
                .refreshWorkspaceSnapshot({ instanceId, cwd, fresh: true })
                .pipe(Effect.ignore, Effect.forkDetach);
          }),
      };

      const actions = yield* makeProjectSkillsActions(deps).pipe(
        Effect.provide(ProcessRunner.layer),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const studio = yield* makeStudioLink({
        home,
        resolveCwd: (input: ProjectSkillsStudioLinkInput) =>
          skills
            .resolveCwd(input)
            .pipe(
              Effect.catchTag("ProjectSkillsReadError", (error) =>
                Effect.fail(fromReadError(error)),
              ),
            ),
        isAlive: processAlive,
        startStudio: (cwd) =>
          Effect.gen(function* () {
            const vskill = yield* findVskillBinary({
              home,
              pathEnv: hostEnvironment.PATH,
              platform,
              appData: hostEnvironment.APPDATA,
              pathExt: hostEnvironment.PATHEXT,
            });
            if (vskill === null) return false;
            const env = {
              PATH: [path.dirname(vskill), hostEnvironment.PATH ?? ""].join(
                platform === "win32" ? ";" : ":",
              ),
              NO_COLOR: "1",
            };
            const launch = yield* resolveSpawnCommand(vskill, ["studio", "--root", cwd], {
              env,
              extendEnv: true,
            }).pipe(
              Effect.provideService(HostProcessPlatform, platform),
              Effect.provideService(HostProcessEnvironment, hostEnvironment),
            );
            // Detached and let go: Studio outlives this request and is found again by its lock.
            return yield* spawner
              .spawn(
                ChildProcess.make(launch.command, launch.args, {
                  shell: launch.shell,
                  cwd,
                  detached: true,
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                  env,
                  extendEnv: true,
                }),
              )
              .pipe(
                Effect.flatMap((handle) => handle.unref),
                Effect.scoped,
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
      });

      const fleet = {
        loadFleet: (projectId: SkillTarget["projectId"]) =>
          fleetTargets.load.pipe(
            Effect.map((loaded) =>
              loaded === null
                ? null
                : { machines: loaded.machines, link: FleetTargets.linkOf(fleetTargets) },
            ),
            Effect.mapError(
              (cause) =>
                new ProjectSkillsActionError({
                  projectId,
                  reason: "fleet_unconfigured",
                  detail: "This machine's fleet file could not be read.",
                  cause,
                }),
            ),
          ),
        coordinatorEnvironmentId: environment.getEnvironmentId,
        runInstalls: runFleetSkillInstalls,
        registryVersions: actions.registryVersions,
        lockedVersions: (projectId: SkillTarget["projectId"]) =>
          skills.read({ projectId }).pipe(
            Effect.map((snapshot) =>
              snapshot.rows.flatMap((row) =>
                row.lock?.skillId && row.lock.version
                  ? [{ skillId: row.lock.skillId, version: row.lock.version }]
                  : [],
              ),
            ),
            Effect.orElseSucceed(() => []),
          ),
      };

      return {
        [WS_METHODS.projectsSkillsVersions]: actions.versions,
        [WS_METHODS.projectsSkillsAction]: actions.action,
        [WS_METHODS.projectsSkillsFleetPush]: (input: ProjectSkillsFleetPushInput) =>
          pushSkillToFleet(fleet, input),
        [WS_METHODS.projectsSkillsStudioLink]: studio.link,
      };
    }),
  )
  .pipe(Layer.provide(FleetTargets.layer));
