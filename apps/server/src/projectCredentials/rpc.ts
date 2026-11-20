// @effect-diagnostics nodeBuiltinImport:off - this machine's home folder and environment for the probes.
// @effect-diagnostics globalDate:off - how old the last read of the Terminal's environment is.
/**
 * Credentials over RPC. The source machine lists what a project uses and saves
 * that list in the project; the destination machine says which ones it has.
 * Results are returned to the caller and written nowhere: no log line, span
 * attribute or stored record carries a status or a file name from here.
 */
import {
  type ProjectCredentialId,
  ProjectCredentialsError,
  type ProjectCredentialsProbeInput,
  type ProjectCredentialsSaveInput,
  type ProjectCredentialsScanInput,
  PROJECT_CREDENTIALS_RPC_METHODS,
  type ProjectId,
  WsProjectCredentialsRpcGroup,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import { existingManagedToolDirs, runsOnGlibc } from "../machineTools/machineTools.ts";
import { terminalCommandsDir } from "../machineTools/terminalPath.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeNodeProvisionHost } from "../provision/host.ts";
import { credentialEntry } from "./catalog.ts";
import { ManifestRefusal, readManifest, writeManifest } from "./manifest.ts";
import { type MachineSources, probeMachine } from "./machine.ts";
import { ProbeBusy, type ProbeContext, ProbeGate, spawnProbe } from "./probe.ts";
import { credentialRows, scanProjectCredentials } from "./scan.ts";
import { readTerminalEnvironment, TerminalEnvironmentCache } from "./terminalEnv.ts";

const failed = (cause: unknown) =>
  cause instanceof ManifestRefusal
    ? new ProjectCredentialsError({ code: "refused", reason: cause.message.slice(0, 590) })
    : cause instanceof ProbeBusy
      ? new ProjectCredentialsError({ code: "busy", reason: cause.message.slice(0, 590) })
      : new ProjectCredentialsError({
          code: "failed",
          // A system error can name paths; the caller gets the kind of failure only.
          reason: "The project folder could not be read or written.",
        });

export const layerRpcHandlers = WsProjectCredentialsRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const projects = yield* ProjectService.ProjectService;
    const gate = new ProbeGate();

    const rootOf = (projectId: ProjectId) =>
      projects.getById(projectId).pipe(
        Effect.mapError(
          () =>
            new ProjectCredentialsError({
              code: "failed",
              reason: "The project could not be read.",
            }),
        ),
        Effect.flatMap((found) =>
          Option.isNone(found)
            ? Effect.fail(
                new ProjectCredentialsError({
                  code: "not_found",
                  reason: "The project is no longer on this machine.",
                }),
              )
            : Effect.succeed(found.value.workspaceRoot),
        ),
      );

    const host = makeNodeProvisionHost();
    const platform = host.platform as NodeJS.Platform;
    // One shared read of the Terminal's environment: a slow shell startup runs once, not per request.
    const terminal = new TerminalEnvironmentCache(
      () => readTerminalEnvironment(platform, process.env["SHELL"]),
      Date.now,
    );
    const sources: MachineSources = {
      platform,
      home: NodeOS.homedir(),
      baseDir: config.baseDir,
      appFolders: async () => [
        terminalCommandsDir(config.baseDir),
        ...(await existingManagedToolDirs(host, {
          home: config.baseDir,
          platform: host.platform,
          arch: host.arch,
          glibc: runsOnGlibc(),
        }).catch(() => [] as ReadonlyArray<string>)),
      ],
      terminal: (fresh) => terminal.get(fresh),
      serverEnv: process.env,
      spawn: spawnProbe,
    };

    return {
      [PROJECT_CREDENTIALS_RPC_METHODS.projectCredentialsScan]: (
        input: ProjectCredentialsScanInput,
      ) =>
        rootOf(input.projectId).pipe(
          Effect.flatMap((root) =>
            Effect.tryPromise({
              try: async () => {
                const [scan, saved] = await Promise.all([
                  scanProjectCredentials(root),
                  readManifest(root),
                ]);
                return {
                  rows: credentialRows(scan, saved !== null && saved.ok ? saved.manifest : null),
                  manifestProblem: saved !== null && !saved.ok ? saved.problem.slice(0, 390) : null,
                  truncated: scan.truncated,
                };
              },
              catch: failed,
            }),
          ),
        ),
      [PROJECT_CREDENTIALS_RPC_METHODS.projectCredentialsSave]: (
        input: ProjectCredentialsSaveInput,
      ) =>
        rootOf(input.projectId).pipe(
          Effect.flatMap((root) =>
            Effect.tryPromise({
              try: async () => ({
                path: await writeManifest(root, {
                  version: 1,
                  credentials: input.credentials.map((entry) => ({
                    id: entry.id,
                    ...(entry.skip ? { skip: true } : {}),
                    ...(entry.note ? { note: entry.note } : {}),
                  })),
                }),
              }),
              catch: failed,
            }),
          ),
        ),
      [PROJECT_CREDENTIALS_RPC_METHODS.projectCredentialsProbe]: (
        input: ProjectCredentialsProbeInput,
      ) =>
        Effect.gen(function* () {
          // The schema already limits ids to the list; this holds if the list and schema drift.
          if (input.ids.some((id) => credentialEntry(id) === undefined))
            return yield* new ProjectCredentialsError({
              code: "invalid",
              reason: "That is not a credential SpecWithCode checks.",
            });
          // Without the list of projects nothing says which tools are a project's own: no check runs.
          const shells = yield* projects.listShells().pipe(
            Effect.mapError(
              () =>
                new ProjectCredentialsError({
                  code: "failed",
                  reason: "The projects on this machine could not be read.",
                }),
            ),
          );
          // This machine's own copy of the project, when the caller names one it has.
          const project =
            input.projectId === undefined
              ? Option.none()
              : yield* projects
                  .getById(input.projectId)
                  .pipe(Effect.catch(() => Effect.succeedNone));
          const context: ProbeContext = {
            packages: new Map<ProjectCredentialId, ReadonlyArray<string>>(
              (input.packages ?? [])
                .filter((entry) => input.ids.includes(entry.id))
                .map((entry) => [entry.id, entry.folders]),
            ),
            sshHosts: input.sshHosts ?? [],
            projectTools: input.projectTools === true,
          };
          const fresh = input.fresh === true;
          const results = yield* Effect.tryPromise({
            try: async () =>
              gate.run(
                await probeMachine(
                  sources,
                  shells.map((shell) => shell.workspaceRoot),
                  Option.isSome(project) ? project.value.workspaceRoot : null,
                  fresh,
                ),
                input.ids,
                fresh,
                context,
              ),
            catch: failed,
          });
          return { results };
        }),
    };
  }),
);
