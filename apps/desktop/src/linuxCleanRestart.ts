// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

/**
 * Set on the clean copy, which removes it so its own later relaunches restart
 * cleanly too. Holds the path of the environment file, which the copy deletes.
 */
export const CLEAN_RESTART_ENV = "SPECWITHCODE_CLEAN_RESTART";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_FILE_NAME = /(^|\/)specwithcode-clean-restart-\d+\.env$/;

export const hasNoNewPrivileges = (status: string): boolean => /^NoNewPrivs:\s*1\s*$/m.test(status);

const quote = (value: string): string => `"${value.replace(/[\\"$`]/g, "\\$&")}"`;

/** systemd's EnvironmentFile format: double quotes keep every value literal. */
export function cleanRestartEnvFile(
  env: Readonly<Record<string, string | undefined>>,
  envFilePath: string,
): string {
  const lines = Object.entries(env)
    .filter(([name, value]) => value !== undefined && ENV_NAME.test(name) && name !== "_")
    .filter(([name]) => name !== CLEAN_RESTART_ENV)
    .map(([name, value]) => `${name}=${quote(value ?? "")}`);
  return `${[...lines, `${CLEAN_RESTART_ENV}=${quote(envFilePath)}`].join("\n")}\n`;
}

/** The values go in a private file: a command line is readable by every user. */
export function cleanRestartArgs(input: {
  readonly execPath: string;
  readonly args: ReadonlyArray<string>;
  readonly envFilePath: string;
}): ReadonlyArray<string> {
  return [
    "--user",
    "--collect",
    "--quiet",
    "--same-dir",
    // The update's relaunch helper must outlive this app's quit.
    "--property=KillMode=process",
    // A killed renderer or tool must not stop the whole app with its service.
    "--property=OOMPolicy=continue",
    // As a desktop launch does, so the installer's output reaches the journal.
    "--property=SyslogIdentifier=specweave-studio-desktop.desktop",
    `--property=EnvironmentFile=${input.envFilePath}`,
    input.execPath,
    ...input.args,
  ];
}

/**
 * Electron's relaunch, the updater's too, starts the new process with Linux's
 * no_new_privs flag. pkexec is setuid, so under it pkexec fails at once with
 * "pkexec must be setuid root" (exit 127), before asking for a password, and
 * every install fails until the user fully quits the app. Only a process the
 * session's service manager starts is free of the flag. Returns true when a
 * clean copy was started and this process must exit before it takes the
 * single-instance lock. Where that is not possible this process carries on.
 */
export function restartWithoutNoNewPrivileges(
  input: {
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    readonly execPath: string;
    readonly args: ReadonlyArray<string>;
    readonly isDevelopment: boolean;
    readonly pid: number;
    readonly readStatus: () => string;
    readonly writeEnvFile: (path: string, content: string) => void;
    readonly removeEnvFile: (path: string) => void;
    readonly start: (args: ReadonlyArray<string>) => boolean;
  } = {
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    args: process.argv.slice(1),
    isDevelopment: Boolean((process as { defaultApp?: boolean }).defaultApp),
    pid: process.pid,
    readStatus: () => NodeFS.readFileSync("/proc/self/status", "utf8"),
    writeEnvFile: (path, content) =>
      NodeFS.writeFileSync(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" }),
    removeEnvFile: (path) => NodeFS.rmSync(path, { force: true }),
    start: (args) =>
      NodeChildProcess.spawnSync("systemd-run", [...args], { stdio: "ignore", timeout: 5_000 })
        .status === 0,
  },
): boolean {
  const restartedFrom = input.env[CLEAN_RESTART_ENV];
  delete input.env[CLEAN_RESTART_ENV];
  if (restartedFrom !== undefined) {
    try {
      if (ENV_FILE_NAME.test(restartedFrom)) input.removeEnvFile(restartedFrom);
    } catch {
      // It holds this user's own environment, in this user's private runtime folder.
    }
    return false;
  }
  if (input.platform !== "linux" || input.isDevelopment) return false;
  // An AppImage's mount ends with the process that made it, and it installs without pkexec.
  if (input.env.APPIMAGE !== undefined) return false;
  const runtimeDir = input.env.XDG_RUNTIME_DIR;
  if (!runtimeDir) return false;
  const envFilePath = `${runtimeDir}/specwithcode-clean-restart-${input.pid}.env`;
  try {
    if (!hasNoNewPrivileges(input.readStatus())) return false;
    input.writeEnvFile(envFilePath, cleanRestartEnvFile(input.env, envFilePath));
    if (input.start(cleanRestartArgs({ ...input, envFilePath }))) return true;
  } catch {
    // Carries on below: the next install says to quit and reopen the app.
  }
  try {
    input.removeEnvFile(envFilePath);
  } catch {
    // Same private file as above.
  }
  return false;
}
