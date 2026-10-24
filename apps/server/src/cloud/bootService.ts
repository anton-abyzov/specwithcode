import {
  HostProcessArchitecture,
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@specweave-studio/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import * as Schema from "effect/Schema";

import { CLI_RELEASE_BASE_URL_ENV } from "@specweave-studio/shared/cliRelease";

import {
  findNpmPackageRuntime,
  type NpmPackageRuntime,
} from "../environment/ServerReleaseManifest.ts";
import * as ProcessRunner from "../processRunner.ts";
import { userBusCandidates, userBusEnv } from "../systemdUserBus.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  pinnedRuntimePaths,
  pinnedRuntimeVersionsDir,
  PinnedRuntimeInstallError,
  resolvesWithin,
} from "./pinnedRuntime.ts";
import {
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STATE_FILE,
  compareExactServiceVersions,
  parseServiceState,
  serviceStateActiveVersion,
  serviceStateHasPendingUpdate,
  type ServiceState,
} from "./serviceProtocol.ts";

const BOOT_SERVICE_NAME = "studio";
const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
// `.service` suffix keeps the label distinct from the desktop app's bundle id
// (com.specweave.studio), so launchd and TCC records never collide.
const BOOT_SERVICE_LAUNCHD_LABEL = "com.specweave.studio.service";
const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`;
const BOOT_SERVICE_UNIT_ENV = "STUDIO_BOOT_SERVICE_UNIT";
const BOOT_SERVICE_TASK_FILE = "studio-service.xml";
const BOOT_SERVICE_TASK_SCRIPT_FILE = "studio-service.cmd";
const BOOT_SERVICE_TASK_NAME = "SpecWithCode Service";
/** File in the logs dir that receives the service's stdout and stderr. `specweave-studio triage` points agents at it. */
export const BOOT_SERVICE_LOG_FILE = "boot-service.log";

/** systemd expands `%` specifiers, including in unquoted append-log paths. */
function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

/**
 * Reads `STUDIO_HOME` back out of a rendered unit or plist. Only values this
 * file writes are expected, so a quoted systemd value is unquoted and
 * unescaped the same way `quoteSystemdValue` produced it.
 */
export function bootServiceBaseDirOf(contents: string): string | undefined {
  const systemd = /^Environment=STUDIO_HOME=(.*)$/m.exec(contents)?.[1];
  if (systemd !== undefined) {
    const raw = systemd.trim();
    const unquoted =
      raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
        : raw;
    return unquoted.replaceAll("%%", "%");
  }
  const plist = /<key>STUDIO_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(contents)?.[1];
  if (plist !== undefined) {
    return plist.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  }
  const script = /^set "STUDIO_HOME=([^"\r\n]*)"\r?$/m.exec(contents)?.[1];
  if (script !== undefined) {
    return script.replaceAll("%%", "%");
  }
  return undefined;
}

export interface BootServicePlan {
  /**
   * What the service manager executes. npm-distributed runtimes run the
   * standalone launcher script with the installing Node; archive-distributed
   * runtimes run their own executable, which hosts the launcher as a hidden
   * subcommand so the machine never needs Node.
   */
  readonly program: ReadonlyArray<string>;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
}

/** Pure renderer: service units cannot rely on the user's shell or PATH. */
export function renderBootServiceUnit(plan: BootServicePlan): string {
  // The user manager has no reliable network-online target; server networking retries itself.
  return [
    "[Unit]",
    "Description=SpecWeave Studio server",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    `Environment=STUDIO_HOME=${quoteSystemdValue(plan.baseDir)}`,
    `Environment=${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `ExecStart=${plan.program.map(quoteSystemdValue).join(" ")}`,
    // Let the launcher mark an explicit stop before it signals the server.
    // systemd still SIGKILLs the whole cgroup if graceful shutdown times out.
    "KillMode=mixed",
    // Agent tool calls run as children of the server, so they share this cgroup.
    // With the systemd default of OOMPolicy=stop, the kernel killing one greedy
    // child stops the whole unit: the server, every live agent, and the user's
    // connection. Keep running and let Restart=always cover the main process.
    "OOMPolicy=continue",
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Plist values are emitted as XML text nodes; only these three need escaping. */
function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Pure renderer: launch agents cannot rely on the user's shell or PATH. */
export function renderBootServicePlist(
  plan: BootServicePlan,
  options: { readonly homeDir: string; readonly environmentPath: string },
): string {
  // KeepAlive + ThrottleInterval mirror Restart=always + RestartSec=5. launchd
  // has no StartLimitBurst analog; a hard crash loop respawns every 5s forever.
  // ExitTimeOut 90 matches systemd's default TimeoutStopSec. A plain stop
  // completes within the launcher's 5s child grace, but a stop that queues
  // behind an in-flight update transition can take much longer; launchd's
  // system-defined default (5s on current macOS) would SIGKILL the launcher
  // (and, with it, the process group) mid-handoff.
  // ProcessType Interactive opts out of background-job resource throttling.
  // AbandonProcessGroup stays at its default (false): launchd reaps leftover
  // process-group members only when the launcher itself exits — the analog of
  // KillMode=mixed's final cgroup kill — and not when the launcher restarts its
  // child, so agent children survive server updates.
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${BOOT_SERVICE_LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...plan.program.map((argument) => `    <string>${escapeXmlText(argument)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${escapeXmlText(options.environmentPath)}</string>`,
    `    <key>STUDIO_HOME</key>`,
    `    <string>${escapeXmlText(plan.baseDir)}</string>`,
    `    <key>${BOOT_SERVICE_UNIT_ENV}</key>`,
    `    <string>${BOOT_SERVICE_PLIST_FILE}</string>`,
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXmlText(options.homeDir)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>5</integer>`,
    `  <key>ExitTimeOut</key>`,
    `  <integer>90</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Interactive</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** A batch file expands `%`, even inside quotes; `%%` is a literal one. */
function escapeBatchValue(value: string): string {
  return value.replaceAll("%", "%%");
}

/**
 * Pure renderer for the batch file the scheduled task runs. Task Scheduler
 * can neither set environment variables nor redirect output, so this file
 * does both, the way the unit and plist do for systemd and launchd.
 * `chcp 65001` makes cmd read the rest of the file as UTF-8, so a home under
 * a non-ASCII user name survives.
 */
export function renderBootServiceTaskScript(plan: BootServicePlan): string {
  const quote = (value: string) => `"${escapeBatchValue(value)}"`;
  return [
    "@echo off",
    "chcp 65001 >nul",
    `set "STUDIO_HOME=${escapeBatchValue(plan.baseDir)}"`,
    `set "${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_TASK_FILE}"`,
    `${plan.program.map(quote).join(" ")} >>${quote(plan.logPath)} 2>&1`,
    "",
  ].join("\r\n");
}

/**
 * Pure renderer for the Task Scheduler definition. Why Task Scheduler and not
 * an HKCU Run key: both need no administrator, but only a task can be
 * stopped, started and queried by name (`schtasks`), restarts a launcher
 * that dies, and never runs twice (IgnoreNew). A Run key fires once at
 * logon and leaves supervision, stop and status to us.
 *
 * - A LogonTrigger and principal scoped to this user is what a standard user
 *   may register; "any user" triggers and S4U logons need elevation, so like
 *   the macOS LaunchAgent it runs while the user is signed in.
 * - RestartOnFailure covers a launcher that fails to start. A launcher that
 *   exits later is not a task failure, so the trigger also repeats every
 *   minute: while the launcher runs IgnoreNew drops the repeat, and once it
 *   is gone the repeat starts it again, the way KeepAlive and Restart=always
 *   do with a coarser one-minute floor.
 * - conhost --headless gives the console executable a console no one sees,
 *   so no window opens at logon. Children inherit it.
 * - ExecutionTimeLimit PT0S lifts the 72-hour default that would kill a
 *   long-running server; priority 5 is normal rather than the background
 *   default of 7, the analog of ProcessType Interactive.
 */
export function renderBootServiceTask(
  plan: BootServicePlan,
  options: { readonly userId: string; readonly scriptPath: string; readonly homeDir: string },
): string {
  const userId = escapeXmlText(options.userId);
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Description>SpecWithCode background service</Description>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    `    <LogonTrigger>`,
    `      <Repetition>`,
    `        <Interval>PT1M</Interval>`,
    `        <StopAtDurationEnd>false</StopAtDurationEnd>`,
    `      </Repetition>`,
    `      <Enabled>true</Enabled>`,
    `      <UserId>${userId}</UserId>`,
    `    </LogonTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <UserId>${userId}</UserId>`,
    `      <LogonType>InteractiveToken</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <AllowHardTerminate>true</AllowHardTerminate>`,
    `    <StartWhenAvailable>true</StartWhenAvailable>`,
    `    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>`,
    `    <IdleSettings>`,
    `      <StopOnIdleEnd>false</StopOnIdleEnd>`,
    `      <RestartOnIdle>false</RestartOnIdle>`,
    `    </IdleSettings>`,
    `    <AllowStartOnDemand>true</AllowStartOnDemand>`,
    `    <Enabled>true</Enabled>`,
    `    <Hidden>false</Hidden>`,
    `    <RunOnlyIfIdle>false</RunOnlyIfIdle>`,
    `    <WakeToRun>false</WakeToRun>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `    <Priority>5</Priority>`,
    `    <RestartOnFailure>`,
    `      <Interval>PT1M</Interval>`,
    `      <Count>999</Count>`,
    `    </RestartOnFailure>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>conhost.exe</Command>`,
    `      <Arguments>--headless cmd.exe /d /c "${escapeXmlText(options.scriptPath)}"</Arguments>`,
    `      <WorkingDirectory>${escapeXmlText(options.homeDir)}</WorkingDirectory>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\r\n");
}

export interface BootServiceStep {
  readonly step: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * Non-zero exit is logged and ignored. Reserved for steps whose common
   * failures (not loaded, already enabled) leave a state a later strict step
   * either tolerates or fails loudly on.
   */
  readonly optional?: boolean;
  /** Override the ProcessRunner default (60s) for steps that block longer. */
  readonly timeout?: Duration.Input;
}

/**
 * Stop commands block until the service manager gives up: 90s by default for
 * systemd's TimeoutStopSec, and ExitTimeOut=90 in the rendered plist. This
 * must stay above both, or the runner cancels the stop mid-shutdown and the
 * next step races a still-loaded service.
 */
const STOP_STEP_TIMEOUT = Duration.seconds(120);

/**
 * Platform service-manager integration as data: paths, a pure renderer, and
 * the command steps each flow runs. install/uninstall/status consume this and
 * never branch on platform.
 */
export interface BootServiceManager {
  readonly kind: "systemd" | "launchd" | "taskScheduler";
  readonly unitPath: string;
  readonly render: (plan: BootServicePlan) => string;
  /**
   * A second file the unit runs, written before the unit and removed after
   * it. When present it is also the file that names the Studio home.
   */
  readonly companion?: {
    readonly path: string;
    readonly render: (plan: BootServicePlan) => string;
  };
  /** Before rewriting files, when a unit is already installed. */
  readonly stop: ReadonlyArray<BootServiceStep>;
  /** After files are written. The last entry starts the service. */
  readonly activate: ReadonlyArray<BootServiceStep>;
  /** Best-effort recovery after a failed repair of an installed service. */
  readonly restart: ReadonlyArray<BootServiceStep>;
  /** Uninstall, before the unit file is removed. */
  readonly deactivate: ReadonlyArray<BootServiceStep>;
  /** Uninstall, after the unit file is removed. */
  readonly finalize: ReadonlyArray<BootServiceStep>;
}

function systemdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
}): BootServiceManager {
  const unitPath = input.path.join(
    input.homeDir,
    ".config",
    "systemd",
    "user",
    BOOT_SERVICE_UNIT_FILE,
  );
  return {
    kind: "systemd",
    unitPath,
    render: renderBootServiceUnit,
    stop: [
      {
        step: "stopping the installed service",
        command: "systemctl",
        args: ["--user", "stop", BOOT_SERVICE_UNIT_FILE],
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    activate: [
      {
        step: "reloading systemd user units",
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      },
      {
        step: "enabling the service",
        command: "systemctl",
        args: ["--user", "enable", BOOT_SERVICE_UNIT_FILE],
      },
      // Start last. No administrative state write occurs after this succeeds.
      {
        step: "starting the service",
        command: "systemctl",
        args: ["--user", "restart", BOOT_SERVICE_UNIT_FILE],
      },
    ],
    restart: [
      {
        step: "restarting the service after a failed update",
        command: "systemctl",
        args: ["--user", "restart", BOOT_SERVICE_UNIT_FILE],
      },
    ],
    deactivate: [
      {
        step: "stopping the service",
        command: "systemctl",
        args: ["--user", "disable", "--now", BOOT_SERVICE_UNIT_FILE],
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    finalize: [
      {
        step: "reloading systemd user units",
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      },
    ],
  };
}

function launchdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
  readonly uid: number;
  readonly environmentPath: string;
}): BootServiceManager {
  const unitPath = input.path.join(
    input.homeDir,
    "Library",
    "LaunchAgents",
    BOOT_SERVICE_PLIST_FILE,
  );
  const domainTarget = `gui/${input.uid}`;
  const serviceTarget = `${domainTarget}/${BOOT_SERVICE_LAUNCHD_LABEL}`;
  // bootout/enable are optional: they fail on not-loaded states that are fine
  // to proceed from. The strict `bootstrap` runs last and is also the start:
  // loading a RunAtLoad/KeepAlive plist starts the job, so a separate
  // kickstart would kill and restart a server it just booted. A lingering job
  // that survived bootout, or a gui domain with nobody logged in at the
  // screen (SSH install), makes bootstrap fail the flow loudly rather than
  // silently keeping a stale server.
  return {
    kind: "launchd",
    unitPath,
    render: (plan) =>
      renderBootServicePlist(plan, {
        homeDir: input.homeDir,
        environmentPath: input.environmentPath,
      }),
    // Without --wait, bootout returns in milliseconds while the job drains
    // for up to ExitTimeOut, and a bootstrap during the drain fails EIO.
    // --wait (present on modern macOS, absent from the man page) blocks until
    // the job is removed from the domain; STOP_STEP_TIMEOUT outlives it.
    stop: [
      {
        step: "stopping the installed launch agent",
        command: "launchctl",
        args: ["bootout", "--wait", serviceTarget],
        optional: true,
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    activate: [
      // A persisted `launchctl disable` override refuses bootstrap; clear it.
      {
        step: "enabling the launch agent",
        command: "launchctl",
        args: ["enable", serviceTarget],
        optional: true,
      },
      // Start last. No administrative state write occurs after this succeeds.
      {
        step: "starting the service",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    restart: [
      {
        step: "restarting the service after a failed update",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    // No `launchctl disable` here: a persisted override would sabotage a
    // later reinstall. Removing the plist is what stops the next login load.
    // A bootout that fails for a reason other than "not loaded" leaves the
    // job running until logout; the failure is in the boot-service log.
    deactivate: [
      {
        step: "stopping the service",
        command: "launchctl",
        args: ["bootout", "--wait", serviceTarget],
        optional: true,
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    finalize: [],
  };
}

/** PowerShell reads `-EncodedCommand` as base64 UTF-16LE, which sidesteps command-line quoting. */
function encodePowerShell(script: string): string {
  let binary = "";
  for (let index = 0; index < script.length; index += 1) {
    const code = script.charCodeAt(index);
    binary += String.fromCharCode(code & 0xff, code >> 8);
  }
  return btoa(binary);
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function powerShellStep(
  step: string,
  script: string,
  options?: Pick<BootServiceStep, "optional" | "timeout">,
): BootServiceStep {
  return {
    step,
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(script),
    ],
    ...options,
  };
}

/** The task name is machine-wide, so it carries the user it belongs to. */
export function bootServiceTaskName(userName: string): string {
  return userName === "" ? BOOT_SERVICE_TASK_NAME : `${BOOT_SERVICE_TASK_NAME} - ${userName}`;
}

/**
 * Ends the launcher and everything under it. Ending the task alone is not
 * enough: Task Scheduler terminates only the process it started (conhost),
 * and Windows does not take children down with a parent, so the launcher,
 * the server and agent processes would keep running and hold the port. The
 * launcher is found by its own command line and its executable inside this
 * home's runtime versions, so a CLI or a foreground server is left alone.
 */
export function renderBootServiceStopScript(input: {
  readonly taskName: string;
  readonly versionsDir: string;
}): string {
  const root = input.versionsDir.endsWith("\\") ? input.versionsDir : `${input.versionsDir}\\`;
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$root = ${quotePowerShell(root)}`,
    "Get-CimInstance Win32_Process -Filter \"Name = 'specweave-studio.exe'\" |",
    "  Where-Object { $_.CommandLine -like '*__service-launcher*' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) } |",
    "  ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId | Out-Null }",
    `& schtasks.exe /End /TN ${quotePowerShell(input.taskName)} 2>&1 | Out-Null`,
    "exit 0",
  ].join("\n");
}

function taskSchedulerManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
  readonly userName: string;
  readonly userDomain: string;
  readonly versionsDir: string;
}): BootServiceManager {
  const directory = input.path.join(input.homeDir, "AppData", "Local", "SpecWithCode");
  const unitPath = input.path.join(directory, BOOT_SERVICE_TASK_FILE);
  const scriptPath = input.path.join(directory, BOOT_SERVICE_TASK_SCRIPT_FILE);
  const taskName = bootServiceTaskName(input.userName);
  const userId =
    input.userDomain === "" ? input.userName : `${input.userDomain}\\${input.userName}`;
  const stopLauncher = powerShellStep(
    "stopping the installed service",
    renderBootServiceStopScript({ taskName, versionsDir: input.versionsDir }),
    { timeout: STOP_STEP_TIMEOUT },
  );
  const run: BootServiceStep = {
    step: "starting the service",
    command: "schtasks.exe",
    args: ["/Run", "/TN", taskName],
  };
  return {
    kind: "taskScheduler",
    unitPath,
    render: (plan) => renderBootServiceTask(plan, { userId, scriptPath, homeDir: input.homeDir }),
    companion: { path: scriptPath, render: renderBootServiceTaskScript },
    // Disabled first so neither the one-minute repeat nor RestartOnFailure
    // brings the old launcher back between the stop and the new start.
    // Optional: there is nothing to disable before the first install.
    stop: [
      {
        step: "pausing the installed task",
        command: "schtasks.exe",
        args: ["/Change", "/TN", taskName, "/DISABLE"],
        optional: true,
      },
      stopLauncher,
    ],
    activate: [
      // Register-ScheduledTask takes the definition as a string, so the file
      // can stay UTF-8; `schtasks /Create /XML` wants it UTF-16. -Force
      // replaces a previous registration, which also re-enables it.
      powerShellStep(
        "registering the scheduled task",
        [
          "$ErrorActionPreference = 'Stop'",
          `$xml = [System.IO.File]::ReadAllText(${quotePowerShell(unitPath)})`,
          `Register-ScheduledTask -TaskName ${quotePowerShell(taskName)} -Xml $xml -Force | Out-Null`,
        ].join("\n"),
        { timeout: Duration.seconds(60) },
      ),
      // Start last. No administrative state write occurs after this succeeds.
      run,
    ],
    restart: [
      {
        step: "re-enabling the task after a failed update",
        command: "schtasks.exe",
        args: ["/Change", "/TN", taskName, "/ENABLE"],
        optional: true,
      },
      { ...run, step: "restarting the service after a failed update" },
    ],
    // Deleted before the stop so no trigger can start it again in between.
    deactivate: [
      {
        step: "removing the scheduled task",
        command: "schtasks.exe",
        args: ["/Delete", "/TN", taskName, "/F"],
        optional: true,
      },
      { ...stopLauncher, step: "stopping the service" },
    ],
    finalize: [],
  };
}

/** Prints the task state: Running, Ready, Disabled, or fails when it is not registered. */
function taskStateProbeArgs(taskName: string): ReadonlyArray<string> {
  return powerShellStep(
    "reading the task state",
    [
      "$ErrorActionPreference = 'Stop'",
      `(Get-ScheduledTask -TaskName ${quotePowerShell(taskName)}).State.ToString()`,
    ].join("\n"),
  ).args;
}

/** Undefined means this host cannot run the background service. */
function selectBootServiceManager(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly uid: number | undefined;
  readonly path: Path.Path;
  readonly environmentPath: string;
  readonly userName: string;
  readonly userDomain: string;
  readonly versionsDir: string;
}): BootServiceManager | undefined {
  if (input.homeDir === "") {
    return undefined;
  }
  if (input.platform === "linux") {
    return systemdManager({ path: input.path, homeDir: input.homeDir });
  }
  if (input.platform === "win32" && input.userName !== "") {
    return taskSchedulerManager({
      path: input.path,
      homeDir: input.homeDir,
      userName: input.userName,
      userDomain: input.userDomain,
      versionsDir: input.versionsDir,
    });
  }
  if (input.platform === "darwin" && input.uid !== undefined) {
    return launchdManager({
      path: input.path,
      homeDir: input.homeDir,
      uid: input.uid,
      environmentPath: input.environmentPath,
    });
  }
  return undefined;
}

export class BootServiceUnsupportedError extends Schema.TaggedError<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup supports Linux with systemd, macOS with launchd and Windows with Task Scheduler; this machine reports '${this.platform}'.`;
  }
}

export class BootServiceCommandError extends Schema.TaggedError<BootServiceCommandError>()(
  "BootServiceCommandError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Background setup failed while ${this.step}.`
      : `Background setup failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class BootServiceInstallError extends Schema.TaggedError<BootServiceInstallError>()(
  "BootServiceInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set up the SpecWithCode background service.";
  }
}

const BootServiceProblem = Schema.Literals([
  "user-manager-unavailable",
  "linger-unavailable",
  "linger-disabled",
  "service-disabled",
  "service-stopped",
  "restart-pending",
]);
type BootServiceProblem = typeof BootServiceProblem.Type;

/** These codes and recovery steps are documented in docs/user/background-service.md. */
export function formatBootServiceProblem(problem: BootServiceProblem): string {
  switch (problem) {
    case "user-manager-unavailable":
      return "Cannot reach the systemd user manager. Run `systemctl --user status` in a login session for the service user. Install your distribution's systemd user-session support if it is missing; do not run SpecWithCode with sudo.";
    case "linger-unavailable":
      return 'Cannot check whether this user can run services after logout. Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.';
    case "linger-disabled":
      return 'Lingering is disabled. SpecWithCode will stop when your last login session ends and will not start at boot. Run `sudo loginctl enable-linger "$(id -un)"` on this machine, then retry the service command as your normal user.';
    case "service-disabled":
      return "The service is not enabled to start automatically. Run `specweave-studio service install` to repair it.";
    case "service-stopped":
      return "The service is not running. Check the service log (on Linux also `systemctl --user status studio.service`), then run `specweave-studio service install`.";
    case "restart-pending":
      return "A newer version is installed but the service is still running the previous one. Run `specweave-studio service restart` to switch.";
  }
}

export class BootServicePrerequisiteError extends Schema.TaggedError<BootServicePrerequisiteError>()(
  "BootServicePrerequisiteError",
  { problem: BootServiceProblem, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `[${this.problem}] ${formatBootServiceProblem(this.problem)}`;
  }
}

export class BootServiceUpdatePendingError extends Schema.TaggedError<BootServiceUpdatePendingError>()(
  "BootServiceUpdatePendingError",
  {},
) {
  override get message(): string {
    return "A remote server update is still pending. Wait for it to finish, then retry.";
  }
}

export class BootServiceDowngradeRefusedError extends Schema.TaggedError<BootServiceDowngradeRefusedError>()(
  "BootServiceDowngradeRefusedError",
  {
    installedVersion: Schema.String,
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to replace specweave-studio@${this.installedVersion} with older specweave-studio@${this.targetVersion}. Run the command again with --allow-downgrade to continue.`;
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceInstallError
  | BootServicePrerequisiteError
  | BootServiceUpdatePendingError
  | BootServiceDowngradeRefusedError;

export interface BootServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly current: boolean;
  readonly installedVersion?: string;
  /**
   * The Studio home the installed unit serves. The unit name is fixed per user,
   * so a caller working against another base dir must not treat this service
   * as its own; `specweave-studio update --base-dir` learned that by restarting the live
   * server of the machine it ran on.
   */
  readonly installedBaseDir?: string;
  readonly problems?: ReadonlyArray<BootServiceProblem>;
  readonly unitPath: string;
  readonly logPath: string;
}

export class BootService extends Context.Service<
  BootService,
  {
    readonly install: (options?: {
      readonly allowDowngrade?: boolean;
      /**
       * Write the unit for this version but leave the service on whatever it
       * is running now. `specweave-studio update` uses this when the user declines the
       * restart, so a later `specweave-studio service restart` lands on the new version.
       */
      readonly start?: boolean;
    }) => Effect.Effect<BootServicePlan, BootServiceError>;
    /**
     * Stop and start the installed service on the version its unit names.
     * Only when the unit serves this base dir: the unit name is per user, so
     * another home's service is left alone. Resolves false when nothing was
     * restarted.
     */
    readonly restart: Effect.Effect<boolean, BootServiceError>;
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("specweave-studio/cloud/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
}

export const make = Effect.fn("cloud.boot_service.make")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
  /**
   * The installed npm package this CLI runs from; detected when omitted, null
   * for none. A package of `cliVersion` is pinned by copying it rather than
   * downloading a release archive.
   */
  readonly npmPackage?: NpmPackageRuntime | null;
}) {
  const hostExecPath = yield* HostProcessExecutablePath;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const uid = yield* HostProcessUserId;
  const httpClient = yield* HttpClient.HttpClient;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  // Windows sets USERPROFILE; HOME is there only when a Unix-style shell exported it.
  const homeDir =
    (yield* Config.String("HOME").pipe(Config.withDefault(""))) ||
    (platform === "win32" ? yield* Config.String("USERPROFILE").pipe(Config.withDefault("")) : "");
  const windowsUser =
    platform === "win32"
      ? {
          name: yield* Config.String("USERNAME").pipe(Config.withDefault("")),
          domain: yield* Config.String("USERDOMAIN").pipe(Config.withDefault("")),
        }
      : { name: "", domain: "" };
  const installerPath = yield* Config.String("PATH").pipe(Config.withDefault(""));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  // The launchers start from `env -i`, so `systemctl --user` and `loginctl` would miss the user bus.
  const busEnvironment = {
    XDG_RUNTIME_DIR: Option.getOrUndefined(
      yield* Config.String("XDG_RUNTIME_DIR").pipe(Config.option),
    ),
    DBUS_SESSION_BUS_ADDRESS: Option.getOrUndefined(
      yield* Config.String("DBUS_SESSION_BUS_ADDRESS").pipe(Config.option),
    ),
  };
  const busPresent = new Set<string>();
  if (platform === "linux")
    for (const candidate of userBusCandidates(busEnvironment, uid))
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
        busPresent.add(candidate);
  const userBus = userBusEnv(busEnvironment, uid, (candidate) => busPresent.has(candidate));
  const userManagerEnv = (command: string) =>
    (command === "systemctl" || command === "loginctl") && Object.keys(userBus).length > 0
      ? { env: userBus }
      : {};
  const host = input.host ?? { execPath: hostExecPath };
  const npmPackage =
    input.npmPackage === undefined ? yield* findNpmPackageRuntime() : input.npmPackage;
  // A CLI started from a pinned copy finds that copy as its npm package; it is
  // the install target, not a source to pin from.
  const npmPackageIsPinnedCopy =
    npmPackage != null &&
    (yield* resolvesWithin(
      fs,
      path,
      npmPackage.dir,
      pinnedRuntimeVersionsDir(path, input.baseDir),
    ));
  // Windows runs the release's specweave-studio.exe; a copied npm package has
  // only a POSIX shell launcher there, so the service pins the release instead.
  const localBundleDir =
    platform !== "win32" && npmPackage?.version === input.cliVersion && !npmPackageIsPinnedCopy
      ? npmPackage.dir
      : undefined;
  const xmlSafeInstallerDirectories = installerPath.split(":").filter(
    (directory) =>
      directory.length > 0 &&
      Array.from(directory).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
      }),
  );
  const environmentPath = Array.from(
    new Set([
      ...xmlSafeInstallerDirectories,
      path.dirname(host.execPath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ).join(":");

  const detectedManager = selectBootServiceManager({
    platform,
    homeDir,
    uid,
    path,
    environmentPath,
    userName: windowsUser.name,
    userDomain: windowsUser.domain,
    versionsDir: pinnedRuntimeVersionsDir(path, input.baseDir),
  });
  const unitPath = detectedManager?.unitPath ?? "";
  // The file that names the Studio home the installed service serves.
  const homeFilePath = detectedManager?.companion?.path ?? unitPath;
  const logPath = path.join(input.logsDir, BOOT_SERVICE_LOG_FILE);
  const statePath = path.join(input.baseDir, "runtime", SERVICE_STATE_FILE);
  const restartPendingPath = path.join(input.baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, input.cliVersion, platform);
  const writeDurably = (filePath: string, contents: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        yield* fs.makeDirectory(directory, { recursive: true });
        const tempPath = yield* fs.makeTempFileScoped({ directory, prefix: ".service-write-" });
        yield* fs.writeFileString(tempPath, contents, { mode: 0o600 });
        // Opened read-write: Windows refuses to flush a handle without write access.
        yield* (yield* fs.open(tempPath, { flag: "r+" })).sync;
        yield* fs.rename(tempPath, filePath);
        // Windows has no directory fsync (EPERM); NTFS journals the rename.
        yield* (yield* fs.open(directory, { flag: "r" })).sync.pipe(
          Effect.catchIf(
            (error) => (error.reason.cause as NodeJS.ErrnoException | undefined)?.code === "EPERM",
            () => Effect.void,
          ),
        );
      }),
    ).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
  // The executable hosts the launcher as a hidden subcommand of itself, so
  // the unit runs the pinned runtime directly.
  const plan: BootServicePlan = {
    program: [runtimePaths.entryPath, "__service-launcher"],
    baseDir: input.baseDir,
    logPath,
    unitPath,
  };

  const requireManager = Effect.suspend(() =>
    detectedManager === undefined
      ? new BootServiceUnsupportedError({ platform })
      : Effect.succeed(detectedManager),
  );

  const logFailure = (error: { readonly message: string }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, { flag: "a" }),
      ),
      Effect.ignore,
    );

  const runStep = Effect.fn("cloud.boot_service.run_step")(function* (
    step: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeout?: Duration.Input },
  ) {
    return yield* runner
      .run({ command, args, timeout: options?.timeout, ...userManagerEnv(command) })
      .pipe(
        Effect.mapError((cause) => new BootServiceCommandError({ step, cause })),
        Effect.filterOrFail(
          (result) => result.code === 0,
          (result) =>
            new BootServiceCommandError({
              step,
              exitCode: Number(result.code),
              stdoutLength: result.stdout.length,
              stderrLength: result.stderr.length,
            }),
        ),
        Effect.tapError(logFailure),
      );
  });

  const runSteps = (steps: ReadonlyArray<BootServiceStep>) =>
    Effect.forEach(
      steps,
      (entry) => {
        const run = runStep(
          entry.step,
          entry.command,
          entry.args,
          entry.timeout === undefined ? undefined : { timeout: entry.timeout },
        );
        // runStep's tapError already appends the failure to the log, so an
        // ignored optional step still leaves a trace.
        return entry.optional === true ? run.pipe(Effect.ignore) : run.pipe(Effect.asVoid);
      },
      { discard: true },
    );

  const probe = (
    command: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Input = Duration.seconds(5),
  ) => runner.run({ command, args, timeout, ...userManagerEnv(command) }).pipe(Effect.option);
  const succeeded = (result: Option.Option<ProcessRunner.ProcessRunOutput>) =>
    Option.isSome(result) && result.value.code === 0;
  const lingerArgs = [
    "show-user",
    ...(uid === undefined ? [] : [String(uid)]),
    "--property=Linger",
    "--value",
  ];
  const readSystemdProblems = Effect.fn("cloud.boot_service.read_systemd_problems")(function* (
    includeService: boolean,
  ) {
    const [manager, linger] = yield* Effect.all(
      [probe("systemctl", ["--user", "show-environment"]), probe("loginctl", lingerArgs)],
      { concurrency: "unbounded" },
    );
    const problems: BootServiceProblem[] = [];
    if (!succeeded(manager)) problems.push("user-manager-unavailable");
    const lingering = succeeded(linger) && Option.isSome(linger) ? linger.value.stdout.trim() : "";
    if (lingering !== "yes") {
      problems.push(lingering === "no" ? "linger-disabled" : "linger-unavailable");
    }
    if (includeService && succeeded(manager)) {
      const [enabled, active] = yield* Effect.all(
        [
          probe("systemctl", ["--user", "is-enabled", BOOT_SERVICE_UNIT_FILE]),
          probe("systemctl", ["--user", "is-active", BOOT_SERVICE_UNIT_FILE]),
        ],
        { concurrency: "unbounded" },
      );
      if (
        !succeeded(enabled) ||
        (Option.isSome(enabled) && enabled.value.stdout.trim() !== "enabled")
      ) {
        problems.push("service-disabled");
      }
      if (!succeeded(active)) problems.push("service-stopped");
    }
    return problems;
  });

  const readTaskSchedulerProblems = Effect.fn("cloud.boot_service.read_task_scheduler_problems")(
    function* () {
      // A cold PowerShell start alone can take a few seconds.
      const state = yield* probe(
        "powershell.exe",
        taskStateProbeArgs(bootServiceTaskName(windowsUser.name)),
        Duration.seconds(20),
      );
      const value = succeeded(state) && Option.isSome(state) ? state.value.stdout.trim() : "";
      const problems: BootServiceProblem[] = [];
      // Not registered, or registered but disabled: nothing starts it at logon.
      if (value === "" || value === "Disabled") problems.push("service-disabled");
      if (value !== "Running") problems.push("service-stopped");
      return problems;
    },
  );

  const requireSystemdPrerequisites = Effect.gen(function* () {
    const problems = yield* readSystemdProblems(false);
    const unavailable = problems.find((problem) => problem !== "linger-disabled");
    if (unavailable) return yield* new BootServicePrerequisiteError({ problem: unavailable });
    if (!problems.includes("linger-disabled")) return;
    yield* runStep("enabling lingering for this user", "loginctl", [
      "enable-linger",
      "--no-ask-password",
      ...(uid === undefined ? [] : [String(uid)]),
    ]).pipe(
      Effect.mapError(
        (cause) => new BootServicePrerequisiteError({ problem: "linger-disabled", cause }),
      ),
    );
    const remaining = yield* readSystemdProblems(false);
    if (remaining[0]) return yield* new BootServicePrerequisiteError({ problem: remaining[0] });
  });

  const install = Effect.fn("cloud.boot_service.install")(function* (options?: {
    readonly allowDowngrade?: boolean;
    readonly start?: boolean;
  }) {
    const manager = yield* requireManager;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    // A permissions failure must not leave a partial install or stop a working server.
    if (manager.kind === "systemd") {
      yield* requireSystemdPrerequisites.pipe(Effect.tapError(logFailure));
    }

    // Prepare every immutable artifact before stopping the installed unit.
    yield* ensurePinnedRuntimeInstalled({
      baseDir: input.baseDir,
      version: input.cliVersion,
      fs,
      path,
      runner,
      httpClient,
      platform,
      arch,
      releaseBaseUrl,
      localBundleDir,
      validate: (runtime) =>
        runner
          .run({
            command: pinnedRuntimeCommand(runtime).command,
            args: [...pinnedRuntimeCommand(runtime).args, "--version"],
            timeout: Duration.seconds(30),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PinnedRuntimeInstallError({
                  step: "verifying the pinned specweave-studio runtime",
                  cause,
                }),
            ),
            Effect.flatMap((result) => {
              const reportedVersion = /\bv(\S+)\s*$/.exec(result.stdout)?.[1];
              return result.code === 0 && reportedVersion === input.cliVersion
                ? Effect.void
                : Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "verifying the pinned specweave-studio runtime",
                      exitCode: Number(result.code),
                      stdoutLength: result.stdout.length,
                      stderrLength: result.stderr.length,
                    }),
                  );
            }),
          ),
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "PinnedRuntimeInstallError"
          ? new BootServiceCommandError({
              step: error.step,
              exitCode: error.exitCode,
              stdoutLength: error.stdoutLength,
              stderrLength: error.stderrLength,
              cause: error,
            })
          : new BootServiceInstallError({ cause: error }),
      ),
    );
    const installed = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    // With start=false the service keeps running while its files change. The
    // launcher reads the state file once at startup and the unit only matters
    // on the next start, so that is safe as long as the launcher is not in
    // the middle of a remote update, which is the one time it writes the
    // state file itself. That case is refused below, before anything is
    // written, from the same read the downgrade check uses; the stop that
    // normally serialises against the launcher is skipped on purpose.
    const start = options?.start !== false;
    if (installed && start) {
      yield* runSteps(manager.stop);
    }

    yield* Effect.gen(function* () {
      if (installed) {
        const previousStateText = yield* fs.readFileString(statePath).pipe(Effect.option);
        if (Option.isSome(previousStateText)) {
          if (serviceStateHasPendingUpdate(previousStateText.value)) {
            return yield* new BootServiceUpdatePendingError();
          }
          // A remote update can finish after the CLI checks status. Read its
          // final version after the launcher stops and before changing files.
          const installedVersion = serviceStateActiveVersion(previousStateText.value);
          if (
            installedVersion !== undefined &&
            options?.allowDowngrade !== true &&
            compareExactServiceVersions(input.cliVersion, installedVersion) < 0
          ) {
            return yield* new BootServiceDowngradeRefusedError({
              installedVersion,
              targetVersion: input.cliVersion,
            });
          }
        }
      }
      yield* fs
        .makeDirectory(path.dirname(unitPath), { recursive: true })
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      if (!start && installed) {
        // Written first: once the files below name the new version, the
        // running service is behind them, and a failure between the two
        // writes must not leave it looking current. The launcher removes the
        // marker when it starts, `restart` and a started install do too.
        yield* fs.writeFileString(restartPendingPath, `${input.cliVersion}\n`, { mode: 0o600 });
      }
      yield* writeDurably(
        statePath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned document.
        `${JSON.stringify(
          {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: input.cliVersion,
          } satisfies ServiceState,
          null,
          2,
        )}\n`,
      );
      if (!start && installed) {
        // The launcher only writes this file while a remote update is in
        // flight. One that began after the check above lands either before
        // this write (then the launcher's copy in memory is what it keeps
        // acting on, and its next write puts its own outcome back) or after
        // it, which this read catches: the file no longer says what was just
        // written, so stop here before repointing the unit.
        const written = yield* fs.readFileString(statePath);
        if (serviceStateActiveVersion(written) !== input.cliVersion) {
          return yield* new BootServiceUpdatePendingError();
        }
      }
      if (manager.companion !== undefined) {
        yield* writeDurably(manager.companion.path, manager.companion.render(plan));
      }
      yield* writeDurably(unitPath, manager.render(plan));

      if (start) {
        yield* runSteps(manager.activate);
        yield* fs.remove(restartPendingPath, { force: true });
      }
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
      ),
      Effect.tapError(() =>
        installed && start ? runSteps(manager.restart).pipe(Effect.ignore) : Effect.void,
      ),
    );
    return plan;
  });

  const restart: BootService["Service"]["restart"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    if (!(yield* fs.exists(unitPath))) return false;
    const unit = yield* fs.readFileString(homeFilePath).pipe(Effect.option);
    if (Option.isNone(unit)) return false;
    const installedBaseDir = bootServiceBaseDirOf(unit.value);
    if (
      installedBaseDir === undefined ||
      path.resolve(installedBaseDir) !== path.resolve(input.baseDir)
    ) {
      return false;
    }
    yield* runSteps(manager.stop);
    yield* runSteps(manager.activate).pipe(
      // Same recovery as a failed repair: a service that was running should
      // not be left stopped because daemon-reload or enable failed.
      Effect.tapError(() => runSteps(manager.restart).pipe(Effect.ignore)),
    );
    yield* fs.remove(restartPendingPath, { force: true });
    return true;
  }).pipe(
    Effect.mapError((cause) =>
      cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
    ),
    Effect.withSpan("cloud.boot_service.restart"),
  );

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    if (
      !(yield* fs
        .exists(unitPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))))
    )
      return false;
    yield* runSteps(manager.deactivate);
    yield* fs
      .remove(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    if (manager.companion !== undefined) {
      yield* fs
        .remove(manager.companion.path, { force: true })
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    }
    yield* runSteps(manager.finalize);
    return true;
  }).pipe(Effect.withSpan("cloud.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    if (detectedManager === undefined) {
      return { supported: false, installed: false, current: false, unitPath, logPath };
    }
    if (!(yield* fs.exists(unitPath))) {
      return { supported: true, installed: false, current: false, unitPath, logPath };
    }
    const companion = detectedManager.companion;
    const [unit, companionText, runtimeEntryExists, runtimeSentinel, stateText] = yield* Effect.all(
      [
        fs.readFileString(unitPath),
        companion === undefined
          ? Effect.succeed(Option.none<string>())
          : fs.readFileString(companion.path).pipe(Effect.option),
        fs.exists(runtimePaths.entryPath),
        fs.readFileString(runtimePaths.sentinelPath).pipe(Effect.option),
        fs.readFileString(statePath).pipe(Effect.option),
      ],
    );
    const state = Option.isSome(stateText) ? parseServiceState(stateText.value) : undefined;
    const installedVersion = Option.isSome(stateText)
      ? serviceStateActiveVersion(stateText.value)
      : undefined;
    const installedBaseDir =
      companion === undefined
        ? bootServiceBaseDirOf(unit)
        : Option.isSome(companionText)
          ? bootServiceBaseDirOf(companionText.value)
          : undefined;
    const companionCurrent =
      companion === undefined ||
      (Option.isSome(companionText) && companionText.value === companion.render(plan));
    const normalizeUnit = (contents: string) =>
      detectedManager.kind === "launchd"
        ? contents.replace(/(<key>PATH<\/key>\n\s*<string>)[^<]*(<\/string>)/, "$1$2")
        : contents;
    const problems: BootServiceProblem[] =
      detectedManager.kind === "systemd"
        ? [...(yield* readSystemdProblems(true))]
        : detectedManager.kind === "taskScheduler"
          ? [...(yield* readTaskSchedulerProblems())]
          : [];
    if (yield* fs.exists(restartPendingPath)) problems.push("restart-pending");
    return {
      supported: true,
      installed: true,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      ...(installedBaseDir === undefined ? {} : { installedBaseDir }),
      problems,
      current:
        problems.length === 0 &&
        normalizeUnit(unit) === normalizeUnit(detectedManager.render(plan)) &&
        companionCurrent &&
        runtimeEntryExists &&
        Option.isSome(runtimeSentinel) &&
        runtimeSentinel.value.trim() === input.cliVersion &&
        state?.activeVersion === input.cliVersion &&
        state?.update?.status !== "pending",
      unitPath,
      logPath,
    };
  }).pipe(
    Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    Effect.withSpan("cloud.boot_service.status"),
  );

  return BootService.of({ install, restart, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input));
