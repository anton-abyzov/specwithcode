import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { beforeAll, afterAll } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import * as CloudSessions from "./CloudSessions.ts";

const TRUST_SCREEN =
  "Quick\u001b[1Csafety\u001b[1Ccheck:\u001b[1CIs\u001b[1Cthis\u001b[1Ca\u001b[1Cproject\u001b[1Cyou\u001b[1Ccreated?\r\n" +
  "❯\u001b[1CNo,\u001b[1Cexit\r\n\u001b[2CYes,\u001b[1CI\u001b[1Ctrust\u001b[1Cthis\u001b[1Cfolder\r\n";
const CREATED_SCREEN =
  "Created cloud session: Single-word OK reply\r\n" +
  "View: https://claude.ai/code/session_01Kw5qcBaa27jRK3Hjn4zsC2?from=cli&m=0\r\n" +
  "Resume with: claude --teleport session_01Kw5qcBaa27jRK3Hjn4zsC2\r\n";

const projectId = ProjectId.make("project-cloud");
let workspaceRoot: string;
beforeAll(async () => {
  workspaceRoot = await Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).makeTempDirectory({
      prefix: "studio-cloud-checkout-",
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
});
afterAll(async () => {
  if (workspaceRoot !== undefined)
    await Effect.gen(function* () {
      yield* (yield* FileSystem.FileSystem).remove(workspaceRoot, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
});

interface Fixture {
  readonly ahead: string | null;
  readonly remote: string | null;
  readonly calls: Array<{ command: string; args: ReadonlyArray<string>; cwd?: string }>;
  readonly ptyWrites: Array<string>;
  readonly ptyArgs: Array<ReadonlyArray<string>>;
}

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as unknown as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const layerFor = (fixture: Fixture) =>
  CloudSessions.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: (input) =>
            Effect.sync(() => {
              fixture.calls.push({
                command: input.command,
                args: input.args,
                ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
              });
              const joined = input.args.join(" ");
              if (input.command === "claude" && joined === "--version")
                return output("2.1.301 (Claude Code)");
              if (input.command === "claude" && joined === "auth status")
                return output(
                  '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}',
                );
              if (input.command === "claude" && input.args[0] === "-p")
                return output(
                  `{"ok":true,"session_id":"${input.args[3]}","url":"https://claude.ai/code/${input.args[3]}"}`,
                );
              if (input.command === "git" && joined === "rev-parse --abbrev-ref HEAD")
                return output("feat/cloud");
              if (input.command === "git" && joined === "remote get-url origin")
                return fixture.remote === null ? output("", 2) : output(fixture.remote);
              if (input.command === "git" && joined.startsWith("rev-list --count"))
                return fixture.ahead === null ? output("", 128) : output(fixture.ahead);
              return output("", 1);
            }),
        }),
        Layer.mock(PtyAdapter.PtyAdapter)({
          spawn: (input) =>
            Effect.sync(() => {
              fixture.ptyArgs.push(input.args ?? []);
              const dataListeners = new Set<(data: string) => void>();
              const exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
              const emit = (chunk: string) => dataListeners.forEach((listener) => listener(chunk));
              const process: PtyAdapter.PtyProcess = {
                pid: 4242,
                write: (data) => {
                  fixture.ptyWrites.push(data);
                  if (data === "\r") {
                    queueMicrotask(() => {
                      emit(CREATED_SCREEN);
                      exitListeners.forEach((listener) => listener({ exitCode: 0, signal: null }));
                    });
                  }
                },
                resize: () => {},
                kill: () => {},
                onData: (callback) => {
                  dataListeners.add(callback);
                  queueMicrotask(() => emit(TRUST_SCREEN));
                  return () => dataListeners.delete(callback);
                },
                onExit: (callback) => {
                  exitListeners.add(callback);
                  return () => exitListeners.delete(callback);
                },
              };
              return process;
            }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            providers: { claudeAgent: { binaryPath: "claude", homePath: "" } },
          } as never),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              id === projectId
                ? Option.some({
                    id: projectId,
                    title: "Cloud",
                    workspaceRoot,
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-10-16T00:00:00.000Z",
                    updatedAt: "2026-10-16T00:00:00.000Z",
                    deletedAt: null,
                  })
                : Option.none(),
            ),
        }),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-cloud-sessions-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const fixture = (overrides: Partial<Fixture> = {}): Fixture => ({
  ahead: "0",
  remote: "https://github.com/acme/app.git",
  calls: [],
  ptyWrites: [],
  ptyArgs: [],
  ...overrides,
});

describe("CloudSessions", () => {
  it.effect("reports a ready claude.ai sign-in without touching credentials", () =>
    Effect.gen(function* () {
      const cloud = yield* CloudSessions.CloudSessions;
      const availability = yield* cloud.availability();
      expect(availability.status).toBe("ready");
      expect(availability.cliVersion).toBe("2.1.301");
      expect(availability.subscriptionType).toBe("max");
    }).pipe(Effect.provide(layerFor(fixture()))),
  );

  it.effect("refuses a branch with unpushed commits unless upload is set", () =>
    Effect.gen(function* () {
      const cloud = yield* CloudSessions.CloudSessions;
      const refused = yield* cloud
        .create({ task: "Fix the login bug", projectId })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("invalid_request");
      expect(refused.detail).toContain("2 unpushed commits");
    }).pipe(Effect.provide(layerFor(fixture({ ahead: "2" })))),
  );

  it.effect("needs a GitHub remote without upload", () =>
    Effect.gen(function* () {
      const cloud = yield* CloudSessions.CloudSessions;
      const refused = yield* cloud
        .create({ task: "Fix the login bug", projectId })
        .pipe(Effect.flip);
      expect(refused.detail).toContain("not on github.com");
    }).pipe(Effect.provide(layerFor(fixture({ remote: "https://gitlab.com/acme/app.git" })))),
  );

  it.live("answers the trust question, records the session, lists it and sends a follow-up", () =>
    Effect.gen(function* () {
      const state = fixture({ remote: null, ahead: null });
      const cloud = yield* CloudSessions.CloudSessions.pipe(Effect.provide(layerFor(state)));
      const created = yield* cloud.create({
        task: "Reply with OK",
        projectId,
        upload: true,
        createdByThreadId: undefined,
      });
      expect(created.session.sessionId).toBe("session_01Kw5qcBaa27jRK3Hjn4zsC2");
      expect(created.session.url).toBe(
        "https://claude.ai/code/session_01Kw5qcBaa27jRK3Hjn4zsC2?from=cli&m=0",
      );
      expect(created.session.title).toBe("Single-word OK reply");
      expect(created.session.uploaded).toBe(true);
      expect(created.session.branch).toBe("feat/cloud");
      expect(created.teleportCommand).toBe("claude --teleport session_01Kw5qcBaa27jRK3Hjn4zsC2");
      expect(state.ptyArgs[0]).toEqual(["--cloud", "Reply with OK"]);
      expect(state.ptyWrites).toEqual(["\u001b[B", "\r"]);

      const listed = yield* cloud.list({ projectId });
      expect(listed.sessions.map((session) => session.sessionId)).toEqual([
        "session_01Kw5qcBaa27jRK3Hjn4zsC2",
      ]);

      const sent = yield* cloud.send({
        sessionId: "session_01Kw5qcBaa27jRK3Hjn4zsC2",
        message: "Also add a test",
      });
      expect(sent.ok).toBe(true);
      const sendCall = state.calls.find((call) => call.args[0] === "-p");
      expect(sendCall?.args).toEqual([
        "-p",
        "Also add a test",
        "--cloud",
        "session_01Kw5qcBaa27jRK3Hjn4zsC2",
        "--output-format",
        "json",
      ]);
      expect((yield* cloud.list({})).sessions[0]?.lastSentAt).not.toBeNull();
    }),
  );
});
