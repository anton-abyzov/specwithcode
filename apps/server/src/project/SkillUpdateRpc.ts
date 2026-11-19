/**
 * The live wiring behind `projects.skillRepos`, `projects.skillsSearch` and
 * `projects.skillsUpdate`: this machine's `gh`, an anonymous GitHub read,
 * vskill, the Skills view's own read, and the agents' rescan.
 *
 * Every process starts through the platform runner with a fixed argv and no
 * shell. The anonymous read asks only GitHub's API and raw-file hosts.
 *
 * @module project/SkillUpdateRpc
 */
import {
  ProjectSkillsActionError,
  WS_METHODS,
  type ProjectId,
  type ProjectSkillReposInput,
  type ProjectSkillsReadError,
  type ProjectSkillsSearchInput,
  type ProjectSkillsUpdateInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Path from "effect/Path";

import { prepareManagedVskill } from "../machineTools/vskillTool.ts";
import { runsOnGlibc } from "../machineTools/machineTools.ts";
import { makeNodeProvisionHost, type ProvisionHost } from "../provision/host.ts";
import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProcessRunner from "../processRunner.ts";
import { findVskillBinary, makeRunCli, type CliRun } from "./ProjectSkillsActionsCommon.ts";
import type * as ProjectSkillsService from "./ProjectSkillsService.ts";
import { makeSkillRepoSources } from "./SkillRepoSources.ts";
import { makeSkillSearch } from "./SkillSearch.ts";
import { makeSkillRolloutHandlers } from "./SkillRolloutRpc.ts";
import { makeSkillUpdates } from "./SkillUpdate.ts";

const GH_TIMEOUT = "25 seconds";
const GH_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const GET_TIMEOUT = "20 seconds";
const GET_MAX_BYTES = 8 * 1024 * 1024;
const OPEN_TIMEOUT = "10 seconds";
/** Folders rescanned for each agent after a change, newest first. */
const MAX_RESCANNED_FOLDERS = 12;
const GITHUB_READ_HOSTS: ReadonlySet<string> = new Set([
  "api.github.com",
  "raw.githubusercontent.com",
]);

export interface SkillManagementDeps {
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly stateDir: string;
  readonly baseDir?: string;
  readonly skills: ProjectSkillsService.ProjectSkillsService["Service"];
  readonly registry: Pick<
    ProviderRegistry.ProviderRegistry["Service"],
    "getProviders" | "refreshWorkspaceSnapshot"
  >;
  /** This machine's own name, for the generated catalog note. */
  readonly machineName: Effect.Effect<string>;
}

const fromReadError = (error: ProjectSkillsReadError) =>
  new ProjectSkillsActionError({ projectId: error.projectId, reason: error.reason });

/** Whether an anonymous read may ask this address: GitHub's API and raw-file hosts, over https. */
export function isGitHubReadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && GITHUB_READ_HOSTS.has(parsed.host);
  } catch {
    return false;
  }
}

/** The program and argv that hand a link to the operating system. */
export function openLinkCommand(
  platform: NodeJS.Platform,
  url: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32")
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * This machine's connected skill repos with its own GitHub reads (`gh`, else an
 * anonymous read of GitHub's own hosts), and the plain process runner behind them.
 * The fleet worker uses the same reads to check a GitHub source (fleetSkillsGithubSource.ts).
 */
export const makeLiveSkillRepoSources = Effect.fn("SkillManagement.makeLiveSources")(function* (
  deps: Pick<SkillManagementDeps, "home" | "environment" | "stateDir">,
) {
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));

  /** An anonymous GET; an address that is not GitHub's is never asked. */
  const anonymousGet = (
    url: string,
    accept: string,
  ): Effect.Effect<{ readonly status: number; readonly body: string }> =>
    !isGitHubReadUrl(url)
      ? Effect.succeed({ status: 0, body: "" })
      : http
          .execute(
            HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeaders({
                Accept: accept,
                "User-Agent": "skills-reader",
                "X-GitHub-Api-Version": "2022-11-28",
              }),
            ),
          )
          .pipe(
            Effect.flatMap((response) =>
              response.text.pipe(
                Effect.map((body) =>
                  body.length > GET_MAX_BYTES
                    ? { status: 0, body: "" }
                    : { status: response.status, body },
                ),
              ),
            ),
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.timeout(GET_TIMEOUT),
            Effect.orElseSucceed(() => ({ status: 0, body: "" })),
          );

  const runPlain = (
    command: string,
    args: ReadonlyArray<string>,
    timeout: string,
    env: NodeJS.ProcessEnv,
  ): Effect.Effect<CliRun> =>
    runner
      .run({
        command,
        args,
        cwd: deps.home,
        timeout: timeout as never,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: GH_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        env,
      })
      .pipe(
        Effect.map((output): CliRun =>
          // A cut-off answer is no answer: its text would hash and parse wrong.
          output.stdoutTruncated
            ? { exitCode: 1, stdout: "", stderr: "", timedOut: false }
            : {
                exitCode: output.code === null ? null : Number(output.code),
                stdout: output.stdout,
                stderr: output.stderr,
                timedOut: output.timedOut,
              },
        ),
        Effect.orElseSucceed((): CliRun => ({
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
        })),
      );

  const sources = yield* makeSkillRepoSources({
    storePath: path.join(deps.stateDir, "skills", "connected-repos.json"),
    gh: (args) =>
      runPlain("gh", args, GH_TIMEOUT, {
        PATH: deps.environment.PATH ?? "",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        NO_COLOR: "1",
      }),
    get: anonymousGet,
  });
  return { sources, runPlain };
});

/** Acquisition is used only by SkillUpdate's install/apply path, never search or status. */
export const makeSkillInstallRuntime = Effect.fn("SkillManagement.installRuntime")(
  function* (input: {
    readonly home: string;
    readonly baseDir: string;
    readonly platform: NodeJS.Platform;
    readonly environment: NodeJS.ProcessEnv;
    readonly host?: ProvisionHost;
  }) {
    const runner = yield* ProcessRunner.ProcessRunner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const run = yield* makeRunCli;
    let nodeDir: string | undefined;
    const findVskill = Effect.gen(function* () {
      const external = yield* findVskillBinary({
        home: input.home,
        pathEnv: input.environment.PATH,
        platform: input.platform,
        appData: input.environment.APPDATA,
        pathExt: input.environment.PATHEXT,
      });
      if (external !== null) return external;
      const prepared = yield* Effect.tryPromise({
        try: () =>
          prepareManagedVskill({
            host: input.host ?? makeNodeProvisionHost({ env: input.environment }),
            home: input.baseDir,
            glibc: runsOnGlibc(),
            runNpm: async (command, args, options) => {
              const output = await Effect.runPromise(
                runner.run({
                  command,
                  args,
                  timeout: options?.timeoutMs ?? 120_000,
                  timeoutBehavior: "timedOutResult",
                  env: { ...input.environment, ...options?.env },
                  maxOutputBytes: 1024 * 1024,
                  outputMode: "truncate",
                }),
              );
              return {
                code: output.code === null ? null : Number(output.code),
                stdout: output.stdout,
                stderr: output.stderr,
              };
            },
          }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      nodeDir = prepared.nodeDir;
      return prepared.binary;
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    return {
      findVskill,
      run: (request: Parameters<typeof run>[0]) =>
        run({
          ...request,
          env: {
            ...request.env,
            PATH: [nodeDir, request.env?.PATH ?? ""]
              .filter(Boolean)
              .join(input.platform === "win32" ? ";" : ":"),
          },
        }),
    };
  },
);

export const makeSkillManagementHandlers = Effect.fn("SkillManagement.makeHandlers")(function* (
  deps: SkillManagementDeps,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { sources, runPlain } = yield* makeLiveSkillRepoSources(deps);

  const readSnapshot = (input: Parameters<typeof deps.skills.read>[0]) =>
    deps.skills.read(input).pipe(Effect.mapError(fromReadError));

  const search = yield* makeSkillSearch({
    home: deps.home,
    platform: deps.platform,
    environment: deps.environment,
    readSnapshot,
    sources,
    openUrl: (url) => {
      const { command, args } = openLinkCommand(deps.platform, url);
      return runPlain(command, args, OPEN_TIMEOUT, { PATH: deps.environment.PATH ?? "" }).pipe(
        Effect.map((result) => result.exitCode === 0),
      );
    },
  });

  const installer = yield* makeSkillInstallRuntime({
    ...deps,
    baseDir: deps.baseDir ?? path.dirname(deps.stateDir),
  });
  const updates = yield* makeSkillUpdates({
    home: deps.home,
    environment: deps.environment,
    readSnapshot,
    resolveCwd: (input) => deps.skills.resolveCwd(input).pipe(Effect.mapError(fromReadError)),
    invalidate: deps.skills.invalidate,
    sources,
    findVskill: installer.findVskill,
    run: installer.run,
    // A thread's composer reads the scan of its own folder, so each folder an agent
    // has scanned before is scanned again; otherwise it would offer the skill a minute late.
    rescanOpenFolders: (instanceIds) =>
      deps.registry.getProviders.pipe(
        Effect.flatMap((providers) =>
          Effect.forEach(
            providers
              .filter((provider) => instanceIds.includes(provider.instanceId))
              .flatMap((provider) =>
                (provider.workspaceSnapshots ?? [])
                  .toSorted((left, right) => right.checkedAt.localeCompare(left.checkedAt))
                  .slice(0, MAX_RESCANNED_FOLDERS)
                  .map((snapshot) => ({ instanceId: provider.instanceId, cwd: snapshot.cwd })),
              ),
            (target) =>
              deps.registry
                .refreshWorkspaceSnapshot({ ...target, fresh: true })
                .pipe(Effect.ignore),
            { concurrency: 2, discard: true },
          ),
        ),
        Effect.forkDetach,
        Effect.asVoid,
      ),
  });

  const answered =
    <I extends { readonly projectId: ProjectId }, A>(
      handler: (input: I) => Effect.Effect<A, ProjectSkillsActionError>,
    ) =>
    (input: I) =>
      handler(input).pipe(
        Effect.catchDefect((cause) =>
          Effect.fail(
            new ProjectSkillsActionError({
              projectId: input.projectId,
              reason: "read_failed",
              cause,
            }),
          ),
        ),
      );

  const rollout = yield* makeSkillRolloutHandlers({
    home: deps.home,
    environment: deps.environment,
    stateDir: deps.stateDir,
    sources,
    search,
    readUserSkills: (projectId) => readSnapshot({ projectId, userLevel: true }),
    machineName: deps.machineName,
  });

  const handlers = {
    [WS_METHODS.projectsSkillRepos]: answered((input: ProjectSkillReposInput) =>
      sources.repos(input),
    ),
    [WS_METHODS.projectsSkillsSearch]: answered((input: ProjectSkillsSearchInput) =>
      search.search(input),
    ),
    [WS_METHODS.projectsSkillsUpdate]: answered((input: ProjectSkillsUpdateInput) =>
      updates.update(input).pipe(
        // The catalog note follows every change, in the background.
        Effect.tap(() =>
          input.operation === "status"
            ? Effect.void
            : rollout.regenerateCatalog(input.projectId).pipe(Effect.forkDetach, Effect.asVoid),
        ),
      ),
    ),
    [WS_METHODS.projectsSkillsRolloutKeep]: answered(
      rollout.handlers[WS_METHODS.projectsSkillsRolloutKeep],
    ),
    [WS_METHODS.projectsSkillsAdopt]: answered(rollout.handlers[WS_METHODS.projectsSkillsAdopt]),
  };
  return {
    handlers,
    verifyGithubSource: rollout.verifyGithubSource,
    afterPush: rollout.afterPush,
  };
});
