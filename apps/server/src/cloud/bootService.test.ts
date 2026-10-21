import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessArchitecture,
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@specweave-studio/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";
import {
  parseServiceState,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";

const linuxRuntime = "/home/dev/.specweave-studio/runtime/versions/1.2.3/specweave-studio";
const linuxPlan = {
  program: [linuxRuntime, "__service-launcher"],
  baseDir: "/home/dev/.specweave-studio",
  logPath: "/home/dev/.specweave-studio/userdata/logs/boot-service.log",
  unitPath: "/home/dev/.config/systemd/user/studio.service",
};

it("runs the pinned runtime's own executable as the systemd launcher", () => {
  const unit = BootService.renderBootServiceUnit(linuxPlan);

  expect(unit).toContain(`ExecStart=${linuxRuntime} __service-launcher`);
  expect(unit).toContain("KillMode=mixed");
  expect(unit).not.toContain("node");
});

it("reads the served Studio home back out of a rendered unit or plist", () => {
  const plan = (baseDir: string) => ({
    program: [`${baseDir}/runtime/versions/1.2.3/specweave-studio`, "__service-launcher"],
    baseDir,
    logPath: `${baseDir}/userdata/logs/boot-service.log`,
    unitPath: "/home/dev/.config/systemd/user/studio.service",
  });

  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServiceUnit(plan("/home/dev/.specweave-studio")),
    ),
  ).toBe("/home/dev/.specweave-studio");
  // Spaces and specifiers are quoted and escaped on the way in.
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServiceUnit(plan("/home/dev/Studio Data/100%")),
    ),
  ).toBe("/home/dev/Studio Data/100%");
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServicePlist(plan("/Users/dev/a&b"), {
        homeDir: "/Users/dev",
        environmentPath: "/usr/bin",
      }),
    ),
  ).toBe("/Users/dev/a&b");
  expect(BootService.bootServiceBaseDirOf("[Service]\nExecStart=/x\n")).toBeUndefined();
});

it("survives the kernel OOM-killing a greedy agent child", () => {
  const unit = BootService.renderBootServiceUnit(linuxPlan);

  expect(unit).toContain("OOMPolicy=continue");
});

const macRuntime = "/Users/dev/.specweave-studio/runtime/versions/1.2.3/specweave-studio";
const macPlan = {
  program: [macRuntime, "__service-launcher"],
  baseDir: "/Users/dev/.specweave-studio",
  logPath: "/Users/dev/.specweave-studio/userdata/logs/boot-service.log",
  unitPath: "/Users/dev/Library/LaunchAgents/com.specweave.studio.service.plist",
};
const macInstallerPath =
  "/opt/homebrew/bin:/Users/dev/.npm-global/bin:/Users/dev/.nvm/versions/node/v22.16.0/bin:/usr/bin:/bin";
const macRenderOptions = { homeDir: "/Users/dev", environmentPath: macInstallerPath };

it("runs the pinned runtime's own executable as the launch agent", () => {
  const plist = BootService.renderBootServicePlist(macPlan, macRenderOptions);

  expect(plist).toContain(
    `  <array>\n    <string>${macRuntime}</string>\n    <string>__service-launcher</string>\n  </array>`,
  );
  expect(plist).not.toContain("node</string>");
});

it("preserves the installer's provider search path in the launch agent", () => {
  const plist = BootService.renderBootServicePlist(macPlan, macRenderOptions);

  expect(plist).toContain(`    <key>PATH</key>\n    <string>${macInstallerPath}</string>`);
});

it("restarts the launch agent on the systemd cadence", () => {
  const plist = BootService.renderBootServicePlist(macPlan, macRenderOptions);

  expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>5</integer>");
  expect(plist).toContain("<key>ExitTimeOut</key>\n  <integer>90</integer>");
});

it("appends both stdio streams to the boot service log", () => {
  const plist = BootService.renderBootServicePlist(macPlan, macRenderOptions);

  expect(plist).toContain(
    "<key>StandardOutPath</key>\n  <string>/Users/dev/.specweave-studio/userdata/logs/boot-service.log</string>",
  );
  expect(plist).toContain(
    "<key>StandardErrorPath</key>\n  <string>/Users/dev/.specweave-studio/userdata/logs/boot-service.log</string>",
  );
});

it("escapes XML in host paths", () => {
  const plist = BootService.renderBootServicePlist(
    { ...macPlan, baseDir: "/Users/dev/Studio & <Co>" },
    { homeDir: "/Users/dev", environmentPath: "/Users/dev/Tools & <Scripts>:/usr/bin" },
  );

  expect(plist).toContain("<string>/Users/dev/Studio &amp; &lt;Co&gt;</string>");
  expect(plist).toContain("<string>/Users/dev/Tools &amp; &lt;Scripts&gt;:/usr/bin</string>");
});

const makeHarness = Effect.fn("test.make_boot_service_harness")(function* (
  platform: NodeJS.Platform = "linux",
  installerPath = macInstallerPath,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "studio-boot-service-test-" });
  const baseDir = path.join(home, ".specweave-studio");
  const statePath = path.join(baseDir, "runtime", "service-state.json");
  // A complete pinned runtime is already present, so install only validates
  // it and never downloads a release archive.
  const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3", platform);
  yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
  yield* fs.writeFileString(runtime.entryPath, "#!/bin/sh\n");
  yield* fs.writeFileString(runtime.sentinelPath, "1.2.3\n");

  const commands: string[] = [];
  const timeouts = new Map<string, unknown>();
  const envs = new Map<string, NodeJS.ProcessEnv | undefined>();
  const control: {
    failCommand: string | undefined;
    stateAfterStop?: string;
    linger: string;
    enabled: boolean;
    active: boolean;
  } = {
    failCommand: undefined,
    linger: "yes",
    enabled: true,
    active: true,
  };
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("test.run_boot_service_command")(function* (
      input: ProcessRunner.ProcessRunInput,
    ) {
      const command = `${input.command} ${input.args.join(" ")}`;
      commands.push(command);
      timeouts.set(command, input.timeout);
      envs.set(command, input.env);
      const failed = command === control.failCommand;
      if (!failed && command === "loginctl enable-linger --no-ask-password 501")
        control.linger = "yes";
      if (!failed && command === "systemctl --user enable studio.service") control.enabled = true;
      if (!failed && command === "systemctl --user restart studio.service") control.active = true;
      if (
        control.stateAfterStop !== undefined &&
        (command === "systemctl --user stop studio.service" ||
          command.startsWith("launchctl bootout --wait "))
      ) {
        yield* fs.writeFileString(statePath, control.stateAfterStop).pipe(Effect.orDie);
      }
      return {
        stdout:
          input.args[0] === "--version"
            ? // The runtime under test reports the version of the directory it
              // was launched from, like the real executable.
              `specweave-studio v${/versions\/([^/]+)\//.exec(input.command)?.[1] ?? "1.2.3"}\n`
            : input.command === "loginctl" && input.args[0] === "show-user"
              ? `${control.linger}\n`
              : input.args[1] === "is-enabled"
                ? control.enabled
                  ? "enabled\n"
                  : "disabled\n"
                : "",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(
          failed || (input.args[1] === "is-active" && !control.active) ? 1 : 0,
        ),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    }),
  });
  const makeService = (
    environmentPath: string | undefined = installerPath,
    cliVersion = "1.2.3",
    serviceBaseDir = baseDir,
    extraEnv: Record<string, string> = {},
  ) =>
    Effect.gen(function* () {
      // Every version the tests install is present and verified on disk, so
      // install never downloads.
      const paths = pinnedRuntimePaths(path, serviceBaseDir, cliVersion, platform);
      yield* fs.makeDirectory(path.dirname(paths.entryPath), { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "#!/bin/sh\n");
      yield* fs.writeFileString(paths.sentinelPath, `${cliVersion}\n`);
      return yield* BootService.make({
        baseDir: serviceBaseDir,
        logsDir: path.join(serviceBaseDir, "userdata", "logs"),
        cliVersion,
        host: { execPath: "/usr/bin/specweave-studio" },
      });
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcessPlatform, platform),
          Layer.succeed(HostProcessUserId, 501),
          Layer.succeed(HostProcessExecutablePath, "/usr/bin/specweave-studio"),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("no release download expected")),
          ),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                HOME: home,
                ...extraEnv,
                ...(environmentPath === undefined || environmentPath === ""
                  ? {}
                  : { PATH: environmentPath }),
              },
            }),
          ),
        ),
      ),
    );
  const service = yield* makeService();
  return { service, makeService, fs, statePath, commands, timeouts, envs, control, runtime };
});

it.layer(NodeServices.layer)("boot service install", (it) => {
  it.effect(
    "fails before installing files or validating a runtime when lingering needs an administrator",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control, runtime } = yield* makeHarness();
        const before = yield* service.status;
        control.linger = "no";
        control.failCommand = "loginctl enable-linger --no-ask-password 501";
        yield* fs.remove(runtime.sentinelPath);

        const error = yield* service.install().pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "BootServicePrerequisiteError",
          problem: "linger-disabled",
        });
        expect(error.message).toContain('sudo loginctl enable-linger "$(id -un)"');
        expect(error.message).toContain("last login session ends");
        expect(yield* fs.exists(before.unitPath)).toBe(false);
        expect(yield* fs.exists(statePath)).toBe(false);
        expect(commands.some((command) => command.includes("--version"))).toBe(false);
        expect(
          commands.some(
            (command) => command.includes("daemon-reload") || command.includes("restart"),
          ),
        ).toBe(false);
        expect(yield* fs.readFileString(before.logPath)).toContain("[linger-disabled]");
      }),
  );

  it.effect(
    "detects a partial install and preserves the running service when repair lacks permission",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control } = yield* makeHarness();
        const plan = yield* service.install();
        const before = yield* fs.readFileString(statePath);
        const unit = yield* fs.readFileString(plan.unitPath);
        control.linger = "no";
        control.failCommand = "loginctl enable-linger --no-ask-password 501";

        expect(yield* service.status).toMatchObject({
          current: false,
          problems: ["linger-disabled"],
        });
        commands.length = 0;
        expect((yield* service.install().pipe(Effect.flip))._tag).toBe(
          "BootServicePrerequisiteError",
        );
        expect(yield* fs.readFileString(statePath)).toBe(before);
        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        expect(commands).not.toContain("systemctl --user stop studio.service");
      }),
  );

  it.effect("enables lingering before installing and repairs stopped or disabled services", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      control.linger = "no";
      yield* service.install();
      expect(control.linger).toBe("yes");
      expect(commands.indexOf("loginctl enable-linger --no-ask-password 501")).toBeLessThan(
        commands.indexOf("systemctl --user daemon-reload"),
      );

      control.enabled = false;
      control.active = false;
      expect(yield* service.status).toMatchObject({
        current: false,
        problems: ["service-disabled", "service-stopped"],
      });
      yield* service.install();
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("gives systemctl and loginctl the user bus an `env -i` launcher dropped", () =>
    Effect.gen(function* () {
      const { makeService, fs, envs } = yield* makeHarness();
      const runtimeDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-user-bus-" });
      yield* fs.writeFileString(`${runtimeDir}/bus`, "");
      const service = yield* makeService(macInstallerPath, "1.2.3", undefined, {
        XDG_RUNTIME_DIR: runtimeDir,
      });
      yield* service.install();
      yield* service.status;
      const bus = { DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` };
      for (const command of [
        "systemctl --user show-environment",
        "loginctl show-user 501 --property=Linger --value",
        "systemctl --user restart studio.service",
        "systemctl --user is-active studio.service",
      ])
        expect(envs.get(command)).toEqual(bus);
      for (const [command, env] of envs)
        if (!/^(systemctl|loginctl) /u.test(command)) expect(env).toBeUndefined();
    }),
  );

  it.effect.each([
    { command: "systemctl --user show-environment", problem: "user-manager-unavailable" },
    { command: "loginctl show-user 501 --property=Linger --value", problem: "linger-unavailable" },
  ])("reports failed prerequisite probes without installing: $command", ({ command, problem }) =>
    Effect.gen(function* () {
      const { service, fs, statePath, control } = yield* makeHarness();
      control.failCommand = command;
      expect(yield* service.install().pipe(Effect.flip)).toMatchObject({
        _tag: "BootServicePrerequisiteError",
        problem,
      });
      expect(yield* fs.exists(statePath)).toBe(false);
    }),
  );

  it.effect("installs, reports current state, and uninstalls", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, timeouts, runtime } = yield* makeHarness();
      const plan = yield* service.install();

      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(plan.program).toEqual([runtime.entryPath, "__service-launcher"]);
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `ExecStart=${runtime.entryPath} __service-launcher`,
      );
      expect(yield* service.status).toMatchObject({
        current: true,
        installedVersion: "1.2.3",
      });
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
        update: {
          id: "u",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          dbPath: "/tmp/state.sqlite",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      expect((yield* service.status).current).toBe(false);
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      // The stop can block up to systemd's 90s TimeoutStopSec; the runner's
      // 60s default would cancel it mid-shutdown.
      expect(timeouts.get("systemctl --user disable --now studio.service")).toEqual(
        Duration.seconds(120),
      );
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "reports the installed version across launcher protocols on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, statePath } = yield* makeHarness(platform);
        yield* service.install();

        for (const protocol of [SERVICE_LAUNCHER_PROTOCOL - 1, SERVICE_LAUNCHER_PROTOCOL + 1]) {
          yield* fs.writeFileString(
            statePath,
            `{"protocol":${protocol},"activeVersion":"1.2.4-nightly.1","update":{"status":"unknown"}}`,
          );
          expect(yield* service.status).toMatchObject({
            current: false,
            installedVersion: "1.2.4-nightly.1",
          });
        }
      }),
  );

  it.effect("reports an unknown version for invalid service state", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();

      for (const stateText of [
        "{",
        '{"activeVersion":"latest"}',
        '{"activeVersion":"1.2"}',
        '{"activeVersion":123}',
      ]) {
        yield* fs.writeFileString(statePath, stateText);
        const status = yield* service.status;
        expect(status.current).toBe(false);
        expect(status.installedVersion).toBeUndefined();
      }
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "preserves a newer version that finishes updating during stop on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control } = yield* makeHarness(platform);
        const plan = yield* service.install();
        const unit = yield* fs.readFileString(plan.unitPath);
        control.stateAfterStop = `{"protocol":${SERVICE_LAUNCHER_PROTOCOL + 1},"activeVersion":"1.2.4"}`;
        commands.length = 0;

        const error = yield* service.install().pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "BootServiceDowngradeRefusedError",
          installedVersion: "1.2.4",
          targetVersion: "1.2.3",
        });
        expect(yield* fs.readFileString(statePath)).toBe(control.stateAfterStop);
        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        expect(
          commands.filter(
            (command) =>
              command.startsWith(platform === "linux" ? "systemctl " : "launchctl ") &&
              !command.includes("show-environment"),
          ),
        ).toEqual(
          platform === "linux"
            ? ["systemctl --user stop studio.service", "systemctl --user restart studio.service"]
            : [
                "launchctl bootout --wait gui/501/com.specweave.studio.service",
                `launchctl bootstrap gui/501 ${plan.unitPath}`,
              ],
        );
      }),
  );

  it.effect("allows an explicit downgrade", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      yield* fs.writeFileString(
        statePath,
        `{"protocol":${SERVICE_LAUNCHER_PROTOCOL},"activeVersion":"1.2.4"}`,
      );

      yield* service.install({ allowDowngrade: true });

      expect(parseServiceState(yield* fs.readFileString(statePath))?.activeVersion).toBe("1.2.3");
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("repairs versions with equal SemVer precedence without an override", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      yield* fs.writeFileString(
        statePath,
        `{"protocol":${SERVICE_LAUNCHER_PROTOCOL},"activeVersion":"1.2.3+previous-build"}`,
      );

      yield* service.install();

      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("install with start=false rewrites the files and marks a restart pending", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, makeService } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;

      const newer = yield* makeService(undefined, "1.2.4");
      const plan = yield* newer.install({ start: false });

      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.4",
      });
      expect(yield* fs.readFileString(plan.unitPath)).toContain("versions/1.2.4/specweave-studio");
      expect(
        commands.filter(
          (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
        ),
      ).toEqual([]);
      // The files say 1.2.4 but the process is still 1.2.3: not current, and
      // the reason is named so `specweave-studio service status` can point at restart.
      const status = yield* newer.status;
      expect(status.current).toBe(false);
      expect(status.problems).toContain("restart-pending");

      commands.length = 0;
      expect(yield* newer.restart).toBe(true);
      expect((yield* newer.status).problems).not.toContain("restart-pending");
      expect((yield* newer.status).current).toBe(true);
    }),
  );

  it.effect("install with start=false keeps the marker when a later write fails", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, makeService } = yield* makeHarness();
      const path = yield* Path.Path;
      yield* service.install();
      const newer = yield* makeService(undefined, "1.2.4");
      // A non-empty directory in the unit's place: it still counts as an
      // installed unit, and the rename that writes the new unit fails.
      const unitPath = (yield* service.status).unitPath;
      yield* fs.remove(unitPath);
      yield* fs.makeDirectory(unitPath);
      yield* fs.writeFileString(path.join(unitPath, "occupied"), "");

      const error = yield* newer.install({ start: false }).pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceInstallError");
      expect(
        yield* fs.exists(path.join(path.dirname(statePath), SERVICE_RESTART_PENDING_FILE)),
      ).toBe(true);
    }),
  );

  it.effect("install with start=false refuses while a remote update is pending", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
        update: {
          id: "u",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          dbPath: "/tmp/state.sqlite",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);

      const error = yield* service.install({ start: false }).pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceUpdatePendingError");
      expect(yield* fs.readFileString(statePath)).toBe(pendingState);
    }),
  );

  it.effect("restart stops and starts an installed service, and is a no-op otherwise", () =>
    Effect.gen(function* () {
      const { service, commands } = yield* makeHarness();
      expect(yield* service.restart).toBe(false);
      yield* service.install();
      commands.length = 0;

      expect(yield* service.restart).toBe(true);
      expect(
        commands.filter(
          (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
        ),
      ).toEqual([
        "systemctl --user stop studio.service",
        "systemctl --user daemon-reload",
        "systemctl --user enable studio.service",
        "systemctl --user restart studio.service",
      ]);
    }),
  );

  it.effect("restart leaves a service that serves another Studio home alone", () =>
    Effect.gen(function* () {
      const { service, fs, commands, makeService } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;
      const path = yield* Path.Path;
      const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "studio-other-home-" });

      const other = yield* makeService(
        undefined,
        "1.2.3",
        path.join(otherHome, ".specweave-studio"),
      );
      expect(yield* other.restart).toBe(false);
      expect(commands.filter((command) => command.startsWith("systemctl "))).toEqual([]);
    }),
  );

  it.effect("restart brings the service back when activation fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;
      control.failCommand = "systemctl --user daemon-reload";

      const error = yield* service.restart.pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(
        commands.filter(
          (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
        ),
      ).toEqual([
        "systemctl --user stop studio.service",
        "systemctl --user daemon-reload",
        "systemctl --user restart studio.service",
      ]);
    }),
  );

  it.effect("restarts an installed service when repair fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;
      control.failCommand = "systemctl --user daemon-reload";

      const error = yield* service.install().pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(
        commands.filter(
          (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
        ),
      ).toEqual([
        "systemctl --user stop studio.service",
        "systemctl --user daemon-reload",
        "systemctl --user restart studio.service",
      ]);
    }),
  );

  it.effect("restarts without overwriting a pending remote update", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      yield* service.install();
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL - 1,
        activeVersion: "1.2.3",
        update: {
          id: "remote-update",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      for (const allowDowngrade of [false, true]) {
        commands.length = 0;

        expect((yield* service.install({ allowDowngrade }).pipe(Effect.flip))._tag).toBe(
          "BootServiceUpdatePendingError",
        );
        expect(serviceStateHasPendingUpdate(yield* fs.readFileString(statePath))).toBe(true);
        expect(
          commands.filter(
            (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
          ),
        ).toEqual([
          "systemctl --user stop studio.service",
          "systemctl --user restart studio.service",
        ]);
      }
    }),
  );

  it.effect("fails closed on Windows", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness("win32");
      expect((yield* service.status).supported).toBe(false);
      expect((yield* service.install().pipe(Effect.flip))._tag).toBe("BootServiceUnsupportedError");
    }),
  );

  it.effect("installs, reports current state, and uninstalls on macOS", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, timeouts, runtime } = yield* makeHarness("darwin");
      const path = yield* Path.Path;
      const plan = yield* service.install();

      expect(
        plan.unitPath.endsWith(
          path.join("Library", "LaunchAgents", "com.specweave.studio.service.plist"),
        ),
      ).toBe(true);
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `    <key>PATH</key>\n    <string>${macInstallerPath}:/usr/local/bin:/usr/sbin:/sbin</string>`,
      );
      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `    <string>${runtime.entryPath}</string>\n    <string>__service-launcher</string>`,
      );
      expect(yield* service.status).toMatchObject({
        current: true,
        installedVersion: "1.2.3",
      });
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      expect(commands.some((command) => command.startsWith("systemctl "))).toBe(false);
      // A bootout can block up to the plist's 90s ExitTimeOut; the runner's
      // 60s default would cancel it and let bootstrap race a loaded job.
      expect(timeouts.get("launchctl bootout --wait gui/501/com.specweave.studio.service")).toEqual(
        Duration.seconds(120),
      );
    }),
  );

  it.effect("restarts the launch agent when repair fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness("darwin");
      yield* service.install();
      const plistPath = (yield* service.status).unitPath;
      commands.length = 0;
      control.failCommand = `launchctl bootstrap gui/501 ${plistPath}`;

      const error = yield* service.install().pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(commands.filter((command) => command.startsWith("launchctl "))).toEqual([
        "launchctl bootout --wait gui/501/com.specweave.studio.service",
        "launchctl enable gui/501/com.specweave.studio.service",
        `launchctl bootstrap gui/501 ${plistPath}`,
        `launchctl bootstrap gui/501 ${plistPath}`,
      ]);
    }),
  );

  it.effect("reconstructs a launch agent search path when the installer has no PATH", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness("darwin", "");
      const plan = yield* service.install();

      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        "    <key>PATH</key>\n    <string>/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin</string>",
      );
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("adds missing provider directories to a minimal installer PATH", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness("darwin", "/usr/bin:/bin");
      const plan = yield* service.install();

      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        "    <key>PATH</key>\n    <string>/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin</string>",
      );
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("keeps an installed launch agent current when the process PATH changes", () =>
    Effect.gen(function* () {
      const { service, makeService } = yield* makeHarness("darwin");
      yield* service.install();

      const restartedService = yield* makeService("/usr/local/bin:/usr/bin:/bin");
      expect((yield* restartedService.status).current).toBe(true);
    }),
  );

  it.effect("drops PATH directories that cannot be represented in a launch agent plist", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness(
        "darwin",
        "/opt/homebrew/bin:/Users/dev/\u0001invalid:/usr/bin",
      );
      const plan = yield* service.install();
      const plist = yield* fs.readFileString(plan.unitPath);

      expect(plist).toContain(
        "    <key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin</string>",
      );
      expect(plist).not.toContain("\u0001");
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("ignores a bootout for an agent that is not loaded", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness("darwin");
      yield* service.install();
      control.failCommand = "launchctl bootout --wait gui/501/com.specweave.studio.service";

      yield* service.install();
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("restarts without overwriting a pending remote update on macOS", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness("darwin");
      yield* service.install();
      const plistPath = (yield* service.status).unitPath;
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL - 1,
        activeVersion: "1.2.3",
        update: {
          id: "remote-update",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      for (const allowDowngrade of [false, true]) {
        commands.length = 0;

        expect((yield* service.install({ allowDowngrade }).pipe(Effect.flip))._tag).toBe(
          "BootServiceUpdatePendingError",
        );
        expect(serviceStateHasPendingUpdate(yield* fs.readFileString(statePath))).toBe(true);
        expect(commands.filter((command) => command.startsWith("launchctl "))).toEqual([
          "launchctl bootout --wait gui/501/com.specweave.studio.service",
          `launchctl bootstrap gui/501 ${plistPath}`,
        ]);
      }
    }),
  );
});

it.layer(NodeServices.layer)("boot service install from the npm package", (it) => {
  it.effect(
    "pins the installed npm package on macOS and downloads nothing (specwithcode@1.0.43 regression)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "studio-boot-service-npm-" });
        const baseDir = path.join(home, ".specwithcode");
        // What `npm i -g specwithcode` leaves on disk, reduced to what the service needs.
        const npmDir = path.join(home, "npm", "lib", "node_modules", "specwithcode");
        yield* fs.makeDirectory(path.join(npmDir, "node_modules", "dep"), { recursive: true });
        yield* fs.writeFileString(
          path.join(npmDir, "bin.mjs"),
          "console.log(`${process.env.STUDIO_CLI_NAME} v1.2.3`);\n",
        );
        yield* fs.writeFileString(path.join(npmDir, "node_modules", "dep", "index.js"), "");
        const commands: string[] = [];
        const requests: string[] = [];
        const runner = ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Effect.gen(function* () {
              commands.push(`${input.command} ${input.args.join(" ")}`);
              // Run the generated launcher for real; launchctl stays a fake.
              const stdout =
                input.command === "launchctl"
                  ? ""
                  : yield* Effect.promise(async () => {
                      const { execFileSync } = await import("node:child_process");
                      return execFileSync(input.command, [...input.args], { encoding: "utf8" });
                    });
              return {
                stdout,
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        });
        const service = yield* BootService.make({
          baseDir,
          logsDir: path.join(baseDir, "userdata", "logs"),
          cliVersion: "1.2.3",
          host: { execPath: process.execPath },
          npmPackage: { dir: npmDir, version: "1.2.3" },
        }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HostProcessPlatform, "darwin"),
              Layer.succeed(HostProcessArchitecture, "arm64"),
              Layer.succeed(HostProcessUserId, 501),
              Layer.succeed(HostProcessExecutablePath, process.execPath),
              // 1.0.43 fetched updates.studio.invalid here, and no darwin archive is published.
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) => {
                  requests.push(request.url);
                  return Effect.die("no release download expected");
                }),
              ),
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { HOME: home, PATH: "/usr/bin" } }),
              ),
            ),
          ),
        );

        const plan = yield* service.install();

        const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3", "darwin");
        expect(requests).toEqual([]);
        expect(plan.program).toEqual([runtime.entryPath, "__service-launcher"]);
        const plist = yield* fs.readFileString(plan.unitPath);
        expect(plist).toContain(`<string>${runtime.entryPath}</string>`);
        expect(yield* fs.readFileString(runtime.sentinelPath)).toBe("1.2.3\n");
        expect(
          yield* fs.exists(path.join(runtime.versionDir, "node_modules", "dep", "index.js")),
        ).toBe(true);
        expect(commands).toContain(`launchctl bootstrap gui/501 ${plan.unitPath}`);
        // The pinned copy keeps working after npm replaces or removes the package.
        yield* fs.remove(npmDir, { recursive: true });
        const output = yield* Effect.promise(async () => {
          const { execFileSync } = await import("node:child_process");
          return execFileSync(runtime.entryPath, ["--version"], { encoding: "utf8" });
        });
        expect(output.trim()).toBe("specweave-studio v1.2.3");
        expect((yield* service.status).current).toBe(true);
      }),
  );

  it.effect("ignores an npm package of another version and falls back to the release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "studio-boot-service-npm-old-" });
      const requests: string[] = [];
      const service = yield* BootService.make({
        baseDir: path.join(home, ".specwithcode"),
        logsDir: path.join(home, ".specwithcode", "userdata", "logs"),
        cliVersion: "1.2.4",
        npmPackage: { dir: path.join(home, "npm"), version: "1.2.3" },
      }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({ run: () => Effect.die("no command expected") }),
        ),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "darwin"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
            Layer.succeed(HostProcessUserId, 501),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                requests.push(request.url);
                return Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response("", { status: 404 })),
                );
              }),
            ),
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
          ),
        ),
      );

      const error = yield* service.install().pipe(Effect.flip);

      expect(error.message).toContain("downloading the specweave-studio release checksums");
      expect(requests).toEqual([
        "https://github.com/anton-abyzov/specwithcode/releases/download/v1.2.4/SHA256SUMS",
      ]);
    }),
  );
  it.effect("does not pin from the pinned copy the CLI itself runs from", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "studio-boot-service-npm-pin-" });
      const baseDir = path.join(home, ".specwithcode");
      // installFromLocalBundle copied the npm manifest, so the pin looks like the npm package.
      const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3", "darwin");
      yield* fs.makeDirectory(runtime.versionDir, { recursive: true });
      yield* fs.writeFileString(path.join(runtime.versionDir, "bin.mjs"), "");
      const requests: string[] = [];
      const service = yield* BootService.make({
        baseDir,
        logsDir: path.join(baseDir, "userdata", "logs"),
        cliVersion: "1.2.3",
        npmPackage: { dir: runtime.versionDir, version: "1.2.3" },
      }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({ run: () => Effect.die("no command expected") }),
        ),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "darwin"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
            Layer.succeed(HostProcessUserId, 501),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                requests.push(request.url);
                return Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response("", { status: 404 })),
                );
              }),
            ),
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
          ),
        ),
      );

      const error = yield* service.install().pipe(Effect.flip);

      // The pin is treated as the install target and the release is fetched instead.
      expect(error.message).toContain("downloading the specweave-studio release checksums");
      expect(requests).toEqual([
        "https://github.com/anton-abyzov/specwithcode/releases/download/v1.2.3/SHA256SUMS",
      ]);
    }),
  );
});
