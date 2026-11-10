// @effect-diagnostics nodeBuiltinImport:off - tests use real temp files for the settings and install id.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { parseCrashReport, type CrashReport } from "@specweave-studio/shared/crashReport";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopCrashReporter from "./DesktopCrashReporter.ts";

interface SentRequest {
  readonly url: string;
  readonly report: CrashReport;
  readonly raw: string;
}

type Listener = (...args: ReadonlyArray<unknown>) => void;

function makeTempHome(settings?: unknown): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "crash-reporter-test-"));
  NodeFS.mkdirSync(NodePath.join(dir, "userdata"), { recursive: true });
  if (settings !== undefined) {
    NodeFS.writeFileSync(NodePath.join(dir, "userdata", "settings.json"), JSON.stringify(settings));
  }
  return dir;
}

function layerElectronApp(listeners: Map<string, Listener>) {
  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("SpecWithCode"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    on: (eventName, listener) =>
      Effect.sync(() => {
        listeners.set(eventName, listener as Listener);
      }),
  } satisfies ElectronApp.ElectronApp["Service"]);
}

const setup = (input: {
  readonly home: string;
  readonly env?: Record<string, string | undefined>;
  readonly status?: number;
}) =>
  Effect.gen(function* () {
    const sent = yield* Queue.unbounded<SentRequest>();
    const listeners = new Map<string, Listener>();
    const hooks = new NodeEvents.EventEmitter();
    let clock = 1_000_000;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body;
        const raw =
          body._tag === "Uint8Array" ? (body.text ?? new TextDecoder().decode(body.body)) : "";
        const report = parseCrashReport(JSON.parse(raw));
        if (report !== null) Queue.offerUnsafe(sent, { url: request.url, report, raw });
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: input.status ?? 202 }),
        );
      }),
    );
    const reporter = yield* DesktopCrashReporter.makeWith({
      env: input.env ?? {},
      baseDir: input.home,
      serverSettingsPath: NodePath.join(input.home, "userdata", "settings.json"),
      pendingDir: NodePath.join(input.home, "userdata", "logs", "crash-reports"),
      appVersion: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      osVersion: "25.0.0",
      hostname: "Antons-Secret-Host.local",
      homeDir: "/Users/someone",
      processHooks: hooks,
      execArgv: [],
      now: () => clock,
      warn: () => undefined,
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(layerElectronApp(listeners)),
    );
    return {
      reporter,
      sent,
      listeners,
      hooks,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  });

const settle = Effect.gen(function* () {
  for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
});

describe("DesktopCrashReporter", () => {
  it.effect("sends nothing and writes nothing when STUDIO_CRASH_REPORTS=false", () =>
    Effect.gen(function* () {
      const home = makeTempHome();
      const { reporter, sent, hooks } = yield* setup({
        home,
        env: { STUDIO_CRASH_REPORTS: "false" },
      });
      yield* reporter.report({ kind: "fatal", error: new Error("boom") });
      hooks.emit("uncaughtExceptionMonitor", new Error("boom"), "uncaughtException");
      yield* settle;
      assert.strictEqual(yield* Queue.size(sent), 0);
      assert.isFalse(NodeFS.existsSync(NodePath.join(home, "crash-install-id")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(home, "userdata", "logs", "crash-reports")));
    }).pipe(Effect.scoped),
  );

  it.effect("sends nothing when the server setting turns reports off", () =>
    Effect.gen(function* () {
      const home = makeTempHome({ crashReportsEnabled: false });
      const { reporter, sent } = yield* setup({ home });
      yield* reporter.report({ kind: "fatal", error: new Error("boom") });
      assert.strictEqual(yield* Queue.size(sent), 0);
      assert.isFalse(NodeFS.existsSync(NodePath.join(home, "crash-install-id")));
    }).pipe(Effect.scoped),
  );

  it.effect("rereads the setting after the cache window", () =>
    Effect.gen(function* () {
      const home = makeTempHome({ crashReportsEnabled: false });
      const { reporter, sent, advance } = yield* setup({ home });
      yield* reporter.report({ kind: "fatal", error: new Error("first") });
      NodeFS.writeFileSync(
        NodePath.join(home, "userdata", "settings.json"),
        JSON.stringify({ crashReportsEnabled: true }),
      );
      yield* reporter.report({ kind: "fatal", error: new Error("second") });
      assert.strictEqual(yield* Queue.size(sent), 0);
      advance(DesktopCrashReporter.SETTINGS_CACHE_MS);
      yield* reporter.report({ kind: "fatal", error: new Error("third") });
      assert.strictEqual(yield* Queue.size(sent), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("sends a sanitized report with a shared install id when enabled", () =>
    Effect.gen(function* () {
      const home = makeTempHome({ someOtherSetting: 1 });
      const { reporter, sent } = yield* setup({ home });
      const error = new Error(
        "open /Users/someone/project/secret.txt failed for me@example.com token sk-abcdefghijklmnopqrstuvwxyz123456",
      );
      error.stack = `Error: boom\n    at run (/Users/someone/app/main.js:1:2)`;
      yield* reporter.report({ kind: "fatal", category: "startup", error });
      const request = yield* Queue.take(sent);
      assert.strictEqual(request.url, "https://relay.spec-weave.com/v1/crash-reports");
      const installId = NodeFS.readFileSync(NodePath.join(home, "crash-install-id"), "utf8").trim();
      assert.match(installId, /^[0-9a-f-]{36}$/u);
      assert.strictEqual(request.report.installId, installId);
      assert.strictEqual(request.report.surface, "desktop");
      assert.strictEqual(request.report.kind, "fatal");
      assert.strictEqual(request.report.appVersion, "1.2.3");
      assert.strictEqual(request.report.os, "darwin");
      assert.strictEqual(request.report.arch, "arm64");
      assert.match(request.report.machine, /^darwin-arm64-[0-9a-f]{12}$/u);
      assert.notInclude(request.raw, "Antons-Secret-Host");
      assert.notInclude(request.raw, "/Users/someone");
      assert.notInclude(request.raw, "me@example.com");
      assert.notInclude(request.raw, "sk-abcdefghijklmnopqrstuvwxyz123456");
    }).pipe(Effect.scoped),
  );

  it.effect("reuses an install id the server already created", () =>
    Effect.gen(function* () {
      const home = makeTempHome();
      const existing = "0f9e5d6c-1b2a-4c3d-8e7f-a1b2c3d4e5f6";
      NodeFS.writeFileSync(NodePath.join(home, "crash-install-id"), `${existing}\n`);
      const { reporter, sent } = yield* setup({ home });
      yield* reporter.report({ kind: "fatal", error: new Error("boom") });
      assert.strictEqual((yield* Queue.take(sent)).report.installId, existing);
    }).pipe(Effect.scoped),
  );

  it.effect("maps render-process-gone and skips clean exits", () =>
    Effect.gen(function* () {
      const home = makeTempHome();
      const { sent, listeners } = yield* setup({ home });
      const onGone = listeners.get("render-process-gone");
      assert.isDefined(onGone);
      const webContents = { getType: () => "window" } as unknown as Electron.WebContents;
      onGone!({}, webContents, { reason: "clean-exit", exitCode: 0 });
      onGone!({}, webContents, { reason: "killed", exitCode: 9 });
      const request = yield* Queue.take(sent);
      assert.strictEqual(request.report.kind, "renderer_gone");
      assert.strictEqual(request.report.category, "killed");
      assert.deepStrictEqual(request.report.detail, { exitCode: 9, surface: "window" });
      yield* settle;
      assert.strictEqual(yield* Queue.size(sent), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("maps child-process-gone", () =>
    Effect.gen(function* () {
      const home = makeTempHome();
      const { sent, listeners } = yield* setup({ home });
      const onGone = listeners.get("child-process-gone")!;
      onGone({}, { type: "GPU", reason: "crashed", exitCode: 139, name: "GPU" });
      const request = yield* Queue.take(sent);
      assert.strictEqual(request.report.kind, "child_process_gone");
      assert.strictEqual(request.report.category, "crashed");
      assert.strictEqual(request.report.detail?.["type"], "GPU");
      assert.strictEqual(request.report.detail?.["exitCode"], 139);
    }).pipe(Effect.scoped),
  );

  it.effect("folds repeats into one report with a count", () =>
    Effect.gen(function* () {
      const home = makeTempHome();
      const { reporter, sent, advance } = yield* setup({ home });
      const event = { kind: "fatal" as const, category: "loop", error: new Error("same") };
      yield* reporter.report(event);
      yield* reporter.report(event);
      yield* reporter.report(event);
      assert.strictEqual(yield* Queue.size(sent), 1);
      assert.isUndefined((yield* Queue.take(sent)).report.count);
      advance(DesktopCrashReporter.FOLD_WINDOW_MS);
      yield* reporter.report(event);
      assert.strictEqual((yield* Queue.take(sent)).report.count, 3);
    }).pipe(Effect.scoped),
  );

  it.effect("caps distinct reports per hour", () =>
    Effect.gen(function* () {
      const home = makeTempHome();
      const { reporter, sent } = yield* setup({ home });
      for (let index = 0; index < DesktopCrashReporter.HOURLY_CAP + 5; index += 1) {
        yield* reporter.report({ kind: "fatal", category: `c${index}` });
      }
      assert.strictEqual(yield* Queue.size(sent), DesktopCrashReporter.HOURLY_CAP);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a server exit with its exit code category", () =>
    Effect.gen(function* () {
      const home = makeTempHome();
      const { reporter, sent } = yield* setup({ home });
      yield* reporter.reportServerExit({ reason: "code=137", instanceId: "primary" });
      const request = yield* Queue.take(sent);
      assert.strictEqual(request.report.kind, "server_exit");
      assert.strictEqual(request.report.category, "exit_code_137");
    }).pipe(Effect.scoped),
  );

  it.effect("writes a pending file for an uncaught exception and removes it once sent", () =>
    Effect.gen(function* () {
      const home = makeTempHome();
      const pendingDir = NodePath.join(home, "userdata", "logs", "crash-reports");
      const { sent, hooks } = yield* setup({ home, status: 500 });
      hooks.emit("uncaughtExceptionMonitor", new TypeError("bad"), "uncaughtException");
      const request = yield* Queue.take(sent);
      assert.strictEqual(request.report.kind, "uncaught_exception");
      assert.strictEqual(request.report.errorName, "TypeError");
      yield* settle;
      // The relay refused it, so the file stays for the next launch.
      assert.strictEqual(NodeFS.readdirSync(pendingDir).length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("flushes pending files left by an earlier run", () =>
    Effect.gen(function* () {
      const home = makeTempHome();
      const pendingDir = NodePath.join(home, "userdata", "logs", "crash-reports");
      const first = yield* setup({ home, status: 500 });
      first.hooks.emit("uncaughtExceptionMonitor", new Error("earlier"), "uncaughtException");
      yield* Queue.take(first.sent);
      yield* settle;
      assert.strictEqual(NodeFS.readdirSync(pendingDir).length, 1);
      const second = yield* setup({ home });
      yield* TestClock.adjust("11 seconds");
      const request = yield* Queue.take(second.sent);
      assert.strictEqual(request.report.kind, "uncaught_exception");
      yield* settle;
      assert.strictEqual(NodeFS.readdirSync(pendingDir).length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("reports unhandled rejections", () =>
    Effect.gen(function* () {
      const home = makeTempHome();
      const { sent, hooks } = yield* setup({ home });
      hooks.emit("unhandledRejection", new Error("nobody caught me"));
      const request = yield* Queue.take(sent);
      assert.strictEqual(request.report.kind, "unhandled_rejection");
    }).pipe(Effect.scoped),
  );

  it.effect("sends a self test report when asked", () =>
    Effect.gen(function* () {
      const home = makeTempHome();
      const { sent } = yield* setup({ home, env: { STUDIO_CRASH_REPORT_SELF_TEST: "1" } });
      yield* TestClock.adjust("4 seconds");
      const request = yield* Queue.take(sent);
      assert.strictEqual(request.report.kind, "test");
    }).pipe(Effect.scoped),
  );
});

describe("crash reporter helpers", () => {
  it("derives server exit categories", () => {
    assert.strictEqual(DesktopCrashReporter.serverExitCategory("code=1"), "exit_code_1");
    assert.strictEqual(DesktopCrashReporter.serverExitCategory("killed by SIGKILL"), "sigkill");
    assert.strictEqual(DesktopCrashReporter.serverExitCategory("something else"), "exit_unknown");
  });

  it("detects a throwing unhandled rejection mode", () => {
    assert.isFalse(DesktopCrashReporter.unhandledRejectionsThrow([], undefined));
    assert.isFalse(
      DesktopCrashReporter.unhandledRejectionsThrow(["--unhandled-rejections=warn"], undefined),
    );
    assert.isTrue(
      DesktopCrashReporter.unhandledRejectionsThrow([], "--unhandled-rejections=strict"),
    );
  });

  it("creates one install id and keeps it", () => {
    const home = makeTempHome();
    const first = DesktopCrashReporter.readOrCreateInstallId(home);
    const second = DesktopCrashReporter.readOrCreateInstallId(home);
    assert.strictEqual(first, second);
    assert.deepStrictEqual(
      NodeFS.readdirSync(home).filter((name) => name.startsWith("crash-install-id")),
      ["crash-install-id"],
    );
  });
});
