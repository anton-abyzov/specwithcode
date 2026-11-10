// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the tests inspect real temp folders.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { parseCrashReport, type CrashReport } from "@specweave-studio/shared/crashReport";
import { TEAM_RULES_NONE } from "@specweave-studio/shared/teamRules";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TeamRules } from "../teamRules/TeamRules.ts";
import * as CrashReporter from "./CrashReporter.ts";
import {
  crashInstallIdPath,
  pendingCrashReportsDir,
  resolveCrashReportPathsSync,
  settingsFileAllowsCrashReports,
  writePendingCrashReportSync,
  buildServerCrashReport,
  recordFatalCrashReportSync,
  MAX_PENDING_CRASH_REPORTS,
} from "./crashReportFiles.ts";

interface SentRequest {
  readonly url: string;
  readonly body: CrashReport;
}

const layerStubClient = (sent: Array<SentRequest>, status = 202) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag === "Uint8Array") {
          sent.push({
            url: request.url,
            body: JSON.parse(new TextDecoder().decode(request.body.body)) as CrashReport,
          });
        }
        return HttpClientResponse.fromWeb(request, new Response(null, { status }));
      }),
    ),
  );

const layerNoTeamRules = Layer.succeed(TeamRules, {
  current: Effect.succeed(TEAM_RULES_NONE),
  forFolder: () => Effect.succeed(TEAM_RULES_NONE),
});

function layerReporter(input: {
  readonly sent: Array<SentRequest>;
  readonly env?: Record<string, string>;
  readonly crashReportsEnabled?: boolean;
  readonly status?: number;
  readonly prefix?: string;
  readonly baseDir?: string;
}) {
  return CrashReporter.layer.pipe(
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(
        process.cwd(),
        input.baseDir ?? { prefix: input.prefix ?? "studio-crash-" },
      ),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest(
        input.crashReportsEnabled === undefined
          ? {}
          : { crashReportsEnabled: input.crashReportsEnabled },
      ),
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input.env ?? {}))),
    Layer.provide(layerStubClient(input.sent, input.status)),
    Layer.provide(layerNoTeamRules),
  );
}

const leakyError = () => {
  const error = new Error(
    "ENOENT: open '/Users/alice/projects/secret-app/notes.txt' token=abcdefgh12345678 mail alice@example.com",
  );
  error.stack = `Error: ENOENT\n    at readNotes (/Users/alice/projects/secret-app/src/notes.ts:10:3)`;
  return error;
};

it("reads only an explicit false from settings.json", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-crash-settings-"));
  try {
    const file = NodePath.join(dir, "settings.json");
    assert.isTrue(settingsFileAllowsCrashReports(file));
    NodeFS.writeFileSync(file, JSON.stringify({ crashReportsEnabled: false }));
    assert.isFalse(settingsFileAllowsCrashReports(file));
    NodeFS.writeFileSync(file, '{"crashReportsEnabled": false, "cut');
    assert.isFalse(settingsFileAllowsCrashReports(file));
    NodeFS.writeFileSync(file, "{}");
    assert.isTrue(settingsFileAllowsCrashReports(file));
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

it("stores a fatal report only when reports are on, up to the pending cap", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-crash-fatal-"));
  try {
    const paths = resolveCrashReportPathsSync({
      argv: ["--base-dir", baseDir],
      env: {},
      homeDir: NodeOS.homedir(),
    });
    const dir = pendingCrashReportsDir(paths.stateDir);
    assert.isFalse(
      recordFatalCrashReportSync({
        kind: "uncaught_exception",
        error: leakyError(),
        paths,
        env: { STUDIO_CRASH_REPORTS: "off" },
      }),
    );
    assert.isFalse(NodeFS.existsSync(dir));
    assert.isFalse(NodeFS.existsSync(crashInstallIdPath(baseDir)));

    for (let index = 0; index < MAX_PENDING_CRASH_REPORTS + 3; index += 1) {
      recordFatalCrashReportSync({
        kind: "unhandled_rejection",
        error: leakyError(),
        paths,
        env: {},
      });
    }
    const files = NodeFS.readdirSync(dir);
    assert.lengthOf(files, MAX_PENDING_CRASH_REPORTS);
    const stored = parseCrashReport(
      JSON.parse(NodeFS.readFileSync(NodePath.join(dir, files[0]!), "utf8")),
    );
    assert.equal(stored?.kind, "unhandled_rejection");
    assert.notInclude(stored?.message ?? "", "alice");

    NodeFS.mkdirSync(paths.stateDir, { recursive: true });
    NodeFS.writeFileSync(paths.settingsPath, JSON.stringify({ crashReportsEnabled: false }));
    NodeFS.rmSync(dir, { recursive: true, force: true });
    assert.isFalse(
      recordFatalCrashReportSync({ kind: "fatal", error: leakyError(), paths, env: {} }),
    );
    assert.isFalse(NodeFS.existsSync(dir));
  } finally {
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
});

it("resolves the same folders as the CLI", () => {
  const home = "/home/tester";
  const defaults = resolveCrashReportPathsSync({ argv: [], env: {}, homeDir: home });
  assert.equal(defaults.stateDir, NodePath.join(defaults.baseDir, "userdata"));
  const explicit = resolveCrashReportPathsSync({
    argv: ["node", "bin", "serve", "--base-dir", "~/studio"],
    env: { VITE_DEV_SERVER_URL: "http://localhost:5173" },
    homeDir: home,
  });
  assert.equal(explicit.baseDir, NodePath.resolve(home, "studio"));
  assert.equal(explicit.stateDir, NodePath.join(explicit.baseDir, "userdata"));
  const dev = resolveCrashReportPathsSync({
    argv: [],
    env: { STUDIO_HOME: "/srv/studio", VITE_DEV_SERVER_URL: "http://localhost:5173" },
    homeDir: home,
  });
  assert.equal(dev.stateDir, NodePath.join(NodePath.resolve("/srv/studio"), "dev"));
  assert.equal(dev.settingsPath, NodePath.join(dev.stateDir, "settings.json"));
});

it("folds repeats per window and caps sends", () => {
  const budget = CrashReporter.makeCrashReportBudget({ windowMs: 1_000, maxSends: 2 });
  assert.equal(budget.admit("a", 10), 1);
  assert.isNull(budget.admit("a", 20));
  assert.isNull(budget.admit("a", 30));
  assert.equal(budget.admit("b", 40), 1);
  // Over the cap: folded too.
  assert.isNull(budget.admit("c", 50));
  // After the window: a carries its two folded repeats, c its one.
  assert.equal(budget.admit("a", 1_100), 3);
  assert.equal(budget.admit("c", 1_200), 2);
});

it.layer(NodeServices.layer)("CrashReporter", (it) => {
  it.effect("sends nothing and writes nothing when the env switch is off", () =>
    Effect.gen(function* () {
      const sent: Array<SentRequest> = [];
      yield* Effect.gen(function* () {
        const reporter = yield* CrashReporter.CrashReporter;
        const config = yield* ServerConfig.ServerConfig;
        assert.deepEqual(yield* reporter.status, { active: false, forcedOff: true });
        yield* reporter.report({ kind: "fatal", error: leakyError() });
        yield* reporter.awaitIdle;
        assert.isFalse(NodeFS.existsSync(crashInstallIdPath(config.baseDir)));
      }).pipe(
        Effect.provide(
          layerReporter({
            sent,
            prefix: "studio-crash-off-",
            env: { STUDIO_CRASH_REPORTS: "false", STUDIO_CRASH_REPORT_SELF_TEST: "1" },
          }),
        ),
      );
      assert.lengthOf(sent, 0);
    }),
  );

  it.effect("sends nothing when the setting is off", () =>
    Effect.gen(function* () {
      const sent: Array<SentRequest> = [];
      yield* Effect.gen(function* () {
        const reporter = yield* CrashReporter.CrashReporter;
        assert.deepEqual(yield* reporter.status, { active: false, forcedOff: false });
        yield* reporter.report({ kind: "fatal", error: leakyError() });
        yield* reporter.awaitIdle;
      }).pipe(
        Effect.provide(
          layerReporter({ sent, prefix: "studio-crash-setting-off-", crashReportsEnabled: false }),
        ),
      );
      assert.lengthOf(sent, 0);
    }),
  );

  it.effect("sends one sanitized report and folds its repeats", () =>
    Effect.gen(function* () {
      const sent: Array<SentRequest> = [];
      yield* Effect.gen(function* () {
        const reporter = yield* CrashReporter.CrashReporter;
        const config = yield* ServerConfig.ServerConfig;
        assert.deepEqual(yield* reporter.status, { active: true, forcedOff: false });
        yield* reporter.report({ kind: "uncaught_exception", error: leakyError() });
        yield* reporter.awaitIdle;
        assert.lengthOf(sent, 1);
        const request = sent[0]!;
        assert.equal(request.url, "https://crash.test/v1/crash-reports");
        const body = request.body;
        assert.isNotNull(parseCrashReport(body));
        assert.equal(body.surface, "server");
        assert.equal(body.kind, "uncaught_exception");
        const installId = NodeFS.readFileSync(crashInstallIdPath(config.baseDir), "utf8").trim();
        assert.equal(body.installId, installId);
        const text = JSON.stringify(body);
        assert.notInclude(text, "alice");
        // Messages lose every path; stacks keep code locations with the home folder as ~.
        assert.notInclude(body.message ?? "", "secret-app");
        assert.include(body.stack ?? "", "~/");
        assert.notInclude(text, "abcdefgh12345678");
        assert.include(body.message ?? "", "<path>");

        // Repeats inside the hour fold; the next send carries the count.
        yield* reporter.report({ kind: "uncaught_exception", error: leakyError() });
        yield* reporter.report({ kind: "uncaught_exception", error: leakyError() });
        yield* reporter.awaitIdle;
        assert.lengthOf(sent, 1);
        yield* TestClock.adjust("61 minutes");
        yield* reporter.report({ kind: "uncaught_exception", error: leakyError() });
        yield* reporter.awaitIdle;
        assert.lengthOf(sent, 2);
        assert.equal(sent[1]!.body.count, 3);
      }).pipe(
        Effect.provide(
          layerReporter({
            sent,
            prefix: "studio-crash-on-",
            env: { STUDIO_CRASH_REPORT_URL: "https://crash.test/ignored-path" },
          }),
        ),
      );
    }),
  );

  it.effect("flushes stored fatal reports at startup and sends the self-test", () =>
    Effect.gen(function* () {
      const sent: Array<SentRequest> = [];
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-crash-pending-"));
      try {
        const stateDir = NodePath.join(baseDir, "userdata");
        const dir = pendingCrashReportsDir(stateDir);
        const report = buildServerCrashReport({
          installId: "6f1c1f3a-2b7e-4d2a-9c39-0d4f7f2b9a10",
          kind: "unhandled_rejection",
          error: leakyError(),
        });
        assert.isTrue(writePendingCrashReportSync(stateDir, report, 1_000_000_000_000));
        // A broken file is removed unsent.
        NodeFS.writeFileSync(NodePath.join(dir, "pending-1000000000001-abc.json"), "not json");
        yield* TestClock.setTime(1_000_000_100_000);
        yield* Effect.gen(function* () {
          yield* (yield* CrashReporter.CrashReporter).awaitIdle;
        }).pipe(
          Effect.provide(
            layerReporter({ sent, baseDir, env: { STUDIO_CRASH_REPORT_SELF_TEST: "1" } }),
          ),
        );
        const kinds = sent.map((request) => request.body.kind).toSorted();
        assert.deepEqual(kinds, ["test", "unhandled_rejection"]);
        assert.equal(
          sent.find((request) => request.body.kind === "test")?.body.category,
          "self_test",
        );
        assert.deepEqual(NodeFS.readdirSync(dir), []);
      } finally {
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps stored reports when the relay is unreachable", () =>
    Effect.gen(function* () {
      const sent: Array<SentRequest> = [];
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-crash-keep-"));
      try {
        const stateDir = NodePath.join(baseDir, "userdata");
        const report = buildServerCrashReport({
          installId: "6f1c1f3a-2b7e-4d2a-9c39-0d4f7f2b9a10",
          kind: "fatal",
          error: new Error("boom"),
        });
        assert.isTrue(writePendingCrashReportSync(stateDir, report, 1_000_000_000_000));
        yield* TestClock.setTime(1_000_000_100_000);
        yield* Effect.gen(function* () {
          yield* (yield* CrashReporter.CrashReporter).awaitIdle;
        }).pipe(Effect.provide(layerReporter({ sent, baseDir, status: 503 })));
        assert.lengthOf(sent, 1);
        assert.lengthOf(NodeFS.readdirSync(pendingCrashReportsDir(stateDir)), 1);
      } finally {
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("deletes stored reports older than seven days without sending them", () =>
    Effect.gen(function* () {
      const sent: Array<SentRequest> = [];
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-crash-expired-"));
      try {
        const stateDir = NodePath.join(baseDir, "userdata");
        const report = buildServerCrashReport({
          installId: "6f1c1f3a-2b7e-4d2a-9c39-0d4f7f2b9a10",
          kind: "fatal",
          error: new Error("boom"),
        });
        assert.isTrue(writePendingCrashReportSync(stateDir, report, 1_000_000_000_000));
        yield* TestClock.setTime(1_000_000_000_000 + 8 * 24 * 60 * 60 * 1000);
        yield* Effect.gen(function* () {
          yield* (yield* CrashReporter.CrashReporter).awaitIdle;
        }).pipe(Effect.provide(layerReporter({ sent, baseDir })));
        assert.lengthOf(sent, 0);
        assert.deepEqual(NodeFS.readdirSync(pendingCrashReportsDir(stateDir)), []);
      } finally {
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
  );
});
