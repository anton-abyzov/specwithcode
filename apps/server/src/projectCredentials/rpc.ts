// @effect-diagnostics nodeBuiltinImport:off - this machine's home folder and environment for the probes.
/**
 * Credentials over RPC. The source machine lists what a project uses and saves
 * that list in the project; the destination machine says which ones it has.
 * Results are returned to the caller and written nowhere: no log line, span
 * attribute or stored record carries a status or a file name from here.
 */
import {
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
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeNodeProvisionHost } from "../provision/host.ts";
import { credentialEntry } from "./catalog.ts";
import { ManifestRefusal, readManifest, writeManifest } from "./manifest.ts";
import { ProbeBusy, ProbeGate, type ProbeMachine, probeFolders, spawnProbe } from "./probe.ts";
import { credentialRows, scanProjectCredentials } from "./scan.ts";

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

    const machine = async (projectRoots: ReadonlyArray<string>): Promise<ProbeMachine> => {
      const host = makeNodeProvisionHost();
      const home = NodeOS.homedir();
      const managed = await existingManagedToolDirs(host, {
        home: config.baseDir,
        platform: host.platform,
        arch: host.arch,
        glibc: runsOnGlibc(),
      }).catch(() => [] as ReadonlyArray<string>);
      const platform = host.platform as NodeJS.Platform;
      return {
        platform,
        home,
        folders: probeFolders({ platform, managed }),
        projectRoots,
        // Read once per batch and filtered to a short list in probe.ts.
        inherited: process.env,
        spawn: spawnProbe,
      };
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
          const shells = yield* projects
            .listShells()
            .pipe(
              Effect.catch(() => Effect.succeed([] as ReadonlyArray<{ workspaceRoot: string }>)),
            );
          const results = yield* Effect.tryPromise({
            try: async () =>
              gate.run(
                await machine(shells.map((shell) => shell.workspaceRoot)),
                input.ids,
                input.fresh === true,
              ),
            catch: failed,
          });
          return { results };
        }),
    };
  }),
);
