import {
  type CloudSessionAvailability,
  type CloudSessionCreateInput,
  type CloudSessionCreateResult,
  CloudSessionRecord,
  type CloudSessionSendInput,
  type CloudSessionSendResult,
  type CloudSessionsSnapshot,
  cloudSessionTeleportCommand,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as Config from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import {
  availabilityFrom,
  detectCloudCliPrompt,
  detectCloudCreateFailure,
  parseClaudeAuthStatus,
  parseClaudeVersion,
  parseCloudSendOutput,
  parseCloudSessionCreated,
  stripTerminalOutput,
} from "./cliOutput.ts";

/**
 * Anthropic cloud sessions driven through the user's own Claude Code CLI.
 * Creation is interactive on the CLI's side (`-p` rejects `--cloud` with a
 * task), so it runs under a pseudo-terminal and the output is read for the
 * session URL; follow-ups and the sign-in check are plain commands. Nothing
 * here reads a credential: the CLI holds the claude.ai login, and the only
 * state kept is the list of sessions this server started.
 */

export const CloudSessionErrorReason = Schema.Literals([
  "unavailable",
  "invalid_request",
  "not_found",
  "cli_failed",
  "timeout",
  "storage",
]);
export type CloudSessionErrorReason = typeof CloudSessionErrorReason.Type;

export class CloudSessionError extends Schema.TaggedError<CloudSessionError>()(
  "CloudSessionError",
  { reason: CloudSessionErrorReason, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface CloudSessionsShape {
  /** What the installed CLI and its sign-in allow, cached for a minute unless `refresh` is set. */
  readonly availability: (options?: {
    readonly refresh?: boolean;
  }) => Effect.Effect<CloudSessionAvailability>;
  readonly list: (input: {
    readonly projectId?: ProjectId | undefined;
  }) => Effect.Effect<CloudSessionsSnapshot>;
  readonly create: (
    input: CloudSessionCreateInput & { readonly createdByThreadId?: ThreadId | undefined },
  ) => Effect.Effect<CloudSessionCreateResult, CloudSessionError>;
  readonly send: (
    input: CloudSessionSendInput,
  ) => Effect.Effect<CloudSessionSendResult, CloudSessionError>;
}

export class CloudSessions extends Context.Service<CloudSessions, CloudSessionsShape>()(
  "specweave-studio/cloudSessions/CloudSessions",
) {}

const AVAILABILITY_TTL_MS = 60_000;
const CLI_PROBE_TIMEOUT = Duration.seconds(15);
const SEND_TIMEOUT = Duration.seconds(90);
/** Cloning, a setup script and the VM itself; Anthropic caches setup that fits in five minutes. */
const CREATE_TIMEOUT = Duration.minutes(6);
const EXIT_GRACE = Duration.seconds(5);
const MAX_RECORDS = 200;
const TASK_EXCERPT = 2_000;
const OUTPUT_TAIL = 800;
const STORE_FILE = "cloud-sessions.json";

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Array(CloudSessionRecord),
});
const decodeStore = Schema.decodeUnknownOption(Schema.fromJsonString(StoreFile));
const encodeStore = Schema.encodeSync(Schema.fromJsonString(StoreFile));

const isoNow = Effect.map(DateTime.now, DateTime.formatIso);

const GITHUB_REMOTE = /(^|[/@:])github\.com[/:]/i;

export const make = Effect.gen(function* () {
  const config = yield* Config.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const pty = yield* PtyAdapter.PtyAdapter;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseEnv = yield* HostProcessEnvironment;
  const storePath = path.join(config.stateDir, STORE_FILE);
  const storeLock = Semaphore.makeUnsafe(1);
  const createLock = Semaphore.makeUnsafe(2);

  let cached: { readonly at: number; readonly value: CloudSessionAvailability } | null = null;

  const claudeLaunch = Effect.gen(function* () {
    const claude = (yield* settings.getSettings).providers.claudeAgent;
    const env = yield* makeClaudeEnvironment(claude, baseEnv);
    const binaryPath = claude.binaryPath.trim().length > 0 ? claude.binaryPath.trim() : "claude";
    return { binaryPath, env };
  }).pipe(
    Effect.orElseSucceed(() => ({ binaryPath: "claude", env: baseEnv })),
    Effect.provideService(Path.Path, path),
  );

  const runClaude = (
    args: ReadonlyArray<string>,
    options: { cwd?: string; timeout: Duration.Input },
  ) =>
    Effect.gen(function* () {
      const launch = yield* claudeLaunch;
      return yield* runner.run({
        command: launch.binaryPath,
        args,
        env: launch.env,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        timeout: options.timeout,
        timeoutBehavior: "timedOutResult",
      });
    });

  const probeAvailability = Effect.gen(function* () {
    const checkedAt = yield* isoNow;
    const version = yield* runClaude(["--version"], { timeout: CLI_PROBE_TIMEOUT }).pipe(
      Effect.result,
    );
    if (version._tag === "Failure" || version.success.timedOut)
      return availabilityFrom({ cliFound: false, cliVersion: null, auth: null, checkedAt });
    const cliVersion = parseClaudeVersion(version.success.stdout);
    const status = yield* runClaude(["auth", "status"], { timeout: CLI_PROBE_TIMEOUT }).pipe(
      Effect.result,
    );
    const auth =
      status._tag === "Failure" || status.success.timedOut
        ? null
        : parseClaudeAuthStatus(status.success.stdout);
    return availabilityFrom({ cliFound: true, cliVersion, auth, checkedAt });
  });

  const availability: CloudSessionsShape["availability"] = (options) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (options?.refresh !== true && cached !== null && now - cached.at < AVAILABILITY_TTL_MS)
        return cached.value;
      const value = yield* probeAvailability;
      cached = { at: now, value };
      return value;
    });

  const readStore = Effect.gen(function* () {
    const exists = yield* fs.exists(storePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [] as ReadonlyArray<CloudSessionRecord>;
    const text = yield* fs.readFileString(storePath).pipe(Effect.orElseSucceed(() => ""));
    const decoded = decodeStore(text);
    return Option.isSome(decoded) ? decoded.value.sessions : [];
  });

  const writeStore = (sessions: ReadonlyArray<CloudSessionRecord>) =>
    writeFileStringAtomically({
      filePath: storePath,
      contents: encodeStore({ version: 1, sessions: sessions.slice(-MAX_RECORDS) }),
    }).pipe(
      Effect.mapError(
        () =>
          new CloudSessionError({
            reason: "storage",
            detail: `The cloud session list could not be saved to ${storePath}.`,
          }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const updateStore = (
    update: (sessions: ReadonlyArray<CloudSessionRecord>) => ReadonlyArray<CloudSessionRecord>,
  ) =>
    storeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* readStore;
        yield* writeStore(update(current));
      }),
    );

  const list: CloudSessionsShape["list"] = ({ projectId }) =>
    Effect.gen(function* () {
      const all = yield* readStore;
      const sessions =
        projectId === undefined ? all : all.filter((session) => session.projectId === projectId);
      return {
        availability: yield* availability(),
        sessions: [...sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
      };
    });

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    runner.run({ command: "git", args, cwd, timeout: Duration.seconds(20) }).pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout.trim() : null)),
      Effect.orElseSucceed(() => null),
    );

  const invalid = (detail: string) => new CloudSessionError({ reason: "invalid_request", detail });

  const resolveCheckout = (input: CloudSessionCreateInput) =>
    Effect.gen(function* () {
      if (input.projectId === undefined)
        return yield* invalid(
          "projectId is required: the cloud session starts from that project's checkout.",
        );
      const project = yield* projects
        .getById(input.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(project))
        return yield* new CloudSessionError({
          reason: "not_found",
          detail: "The project was not found.",
        });
      const root = path.resolve(project.value.workspaceRoot);
      const requested = input.worktreePath === undefined ? root : path.resolve(input.worktreePath);
      const relative = path.relative(root, requested);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* invalid(
          `worktreePath must be inside the project's checkout (${root}); use the project's own worktrees.`,
        );
      const exists = yield* fs.exists(requested).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return yield* invalid(`${requested} does not exist on this machine.`);
      return { project: project.value, cwd: requested };
    });

  /**
   * Runs `claude --cloud <task>` on a pseudo-terminal, answers the folder
   * trust question if the CLI asks it, and resolves once the session URL is
   * on screen. The CLI exits on its own after printing it; it is killed if
   * it lingers.
   */
  const spawnCreate = (input: {
    readonly binaryPath: string;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly task: string;
  }) =>
    Effect.gen(function* () {
      const process = yield* pty
        .spawn({
          shell: input.binaryPath,
          args: ["--cloud", input.task],
          cwd: input.cwd,
          cols: 120,
          rows: 40,
          env: input.env,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new CloudSessionError({
                reason: "cli_failed",
                detail: `Claude Code could not be started: ${error.message}`,
              }),
          ),
        );
      const outcome = yield* Deferred.make<
        { readonly sessionId: string; readonly url: string; readonly title: string | null },
        CloudSessionError
      >();
      const exited = yield* Deferred.make<void>();
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      let trustReply: Fiber.Fiber<void> | undefined;
      let raw = "";
      let trustAnswered = false;
      const stopData = process.onData((chunk) => {
        raw = (raw + chunk).slice(-64_000);
        const plain = stripTerminalOutput(raw);
        const created = parseCloudSessionCreated(plain);
        if (created !== null) {
          Deferred.doneUnsafe(outcome, Effect.succeed(created));
          return;
        }
        const failure = detectCloudCreateFailure(plain);
        if (failure !== null) {
          Deferred.doneUnsafe(
            outcome,
            Effect.fail(new CloudSessionError({ reason: "cli_failed", detail: failure })),
          );
          return;
        }
        if (!trustAnswered && detectCloudCliPrompt(plain) === "trust_folder") {
          trustAnswered = true;
          // The trust question starts on "No, exit": move down one row, then confirm.
          process.write("\u001b[B");
          trustReply = runFork(
            Effect.sleep(Duration.millis(200)).pipe(
              Effect.andThen(() => Effect.sync(() => process.write("\r"))),
            ),
          );
        }
      });
      const stopExit = process.onExit(() => {
        Deferred.doneUnsafe(exited, Effect.void);
        const plain = stripTerminalOutput(raw);
        const created = parseCloudSessionCreated(plain);
        Deferred.doneUnsafe(
          outcome,
          created !== null
            ? Effect.succeed(created)
            : Effect.fail(
                new CloudSessionError({
                  reason: "cli_failed",
                  detail:
                    detectCloudCreateFailure(plain) ??
                    `Claude Code exited before it reported a cloud session. Last output: ${tail(plain)}`,
                }),
              ),
        );
      });
      const result = yield* Deferred.await(outcome).pipe(
        Effect.timeoutOrElse({
          duration: CREATE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new CloudSessionError({
                reason: "timeout",
                detail: `Claude Code did not report a cloud session within ${Duration.toMinutes(CREATE_TIMEOUT)} minutes. Last output: ${tail(stripTerminalOutput(raw))}`,
              }),
            ),
        }),
        Effect.ensuring(
          Effect.gen(function* () {
            if (trustReply !== undefined) yield* Fiber.interrupt(trustReply);
            // Give the CLI a moment to finish on its own, then stop it either way.
            yield* Deferred.await(exited).pipe(Effect.timeoutOption(EXIT_GRACE));
            stopData();
            stopExit();
            if (!(yield* Deferred.isDone(exited))) {
              try {
                process.kill();
              } catch {
                // Already gone.
              }
            }
          }),
        ),
      );
      return result;
    });

  const create: CloudSessionsShape["create"] = (input) =>
    createLock.withPermits(1)(
      Effect.gen(function* () {
        const ready = yield* availability();
        if (ready.status !== "ready")
          return yield* new CloudSessionError({
            reason: "unavailable",
            detail: `${ready.reason}${ready.fix === null ? "" : ` ${ready.fix}`}`,
          });
        const { project, cwd } = yield* resolveCheckout(input);
        const branch = yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
        const remoteUrl = yield* git(cwd, ["remote", "get-url", "origin"]);
        const upload = input.upload === true;
        if (!upload) {
          if (remoteUrl === null || !GITHUB_REMOTE.test(remoteUrl))
            return yield* invalid(
              remoteUrl === null
                ? "This checkout has no origin remote. Cloud sessions clone from GitHub; pass upload:true to send the committed files instead (the session then cannot push back)."
                : `The origin remote (${remoteUrl}) is not on github.com. Pass upload:true to send the committed files instead (the session then cannot push back).`,
            );
          const ahead = yield* git(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]);
          if (ahead === null)
            return yield* invalid(
              `Branch ${branch ?? "HEAD"} has no upstream on origin. Push it first (the cloud VM clones the remote branch, not this checkout) or pass upload:true.`,
            );
          if (ahead !== "0")
            return yield* invalid(
              `Branch ${branch ?? "HEAD"} has ${ahead} unpushed commit${ahead === "1" ? "" : "s"}. Push first, or pass upload:true to send the committed files instead.`,
            );
        }
        const launch = yield* claudeLaunch;
        const created = yield* spawnCreate({
          binaryPath: launch.binaryPath,
          env: {
            ...launch.env,
            TERM: "xterm-256color",
            ...(upload ? { CCR_FORCE_BUNDLE: "1" } : {}),
          },
          cwd,
          task: input.task,
        });
        const createdAt = yield* isoNow;
        const record: CloudSessionRecord = {
          sessionId: created.sessionId,
          url: created.url,
          title: input.title?.trim() || created.title || excerpt(input.task, 80),
          task: excerpt(input.task, TASK_EXCERPT),
          repositoryPath: cwd,
          branch,
          remoteUrl,
          uploaded: upload,
          projectId: project.id,
          createdByThreadId: input.createdByThreadId ?? null,
          createdAt,
          lastSentAt: null,
        };
        yield* updateStore((sessions) => [
          ...sessions.filter((session) => session.sessionId !== record.sessionId),
          record,
        ]);
        return { session: record, teleportCommand: cloudSessionTeleportCommand(record.sessionId) };
      }),
    );

  const send: CloudSessionsShape["send"] = (input) =>
    Effect.gen(function* () {
      const ready = yield* availability();
      if (ready.status !== "ready")
        return yield* new CloudSessionError({
          reason: "unavailable",
          detail: `${ready.reason}${ready.fix === null ? "" : ` ${ready.fix}`}`,
        });
      const known = (yield* readStore).find((session) => session.sessionId === input.sessionId);
      const result = yield* runClaude(
        ["-p", input.message, "--cloud", input.sessionId, "--output-format", "json"],
        { timeout: SEND_TIMEOUT, ...(known ? { cwd: known.repositoryPath } : {}) },
      ).pipe(
        Effect.mapError(
          (error) =>
            new CloudSessionError({
              reason: "cli_failed",
              detail: `Claude Code could not be started: ${error.message}`,
            }),
        ),
      );
      if (result.timedOut)
        return yield* new CloudSessionError({
          reason: "timeout",
          detail: "Claude Code did not confirm the message within 90 seconds.",
        });
      const parsed = parseCloudSendOutput(result.stdout, result.stderr, Number(result.code ?? -1));
      if (parsed.ok && known !== undefined) {
        const lastSentAt = yield* isoNow;
        yield* updateStore((sessions) =>
          sessions.map((session) =>
            session.sessionId === input.sessionId ? { ...session, lastSentAt } : session,
          ),
        ).pipe(Effect.ignore);
      }
      return {
        ok: parsed.ok,
        sessionId: input.sessionId,
        url: parsed.url ?? known?.url ?? null,
        error: parsed.error,
      };
    });

  return { availability, list, create, send } satisfies CloudSessionsShape;
});

const excerpt = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};
const tail = (plain: string) => {
  const flat = plain.replace(/\s+/g, " ").trim();
  return flat.length <= OUTPUT_TAIL ? flat : `…${flat.slice(-OUTPUT_TAIL)}`;
};

export const layer = Layer.effect(CloudSessions, make);
