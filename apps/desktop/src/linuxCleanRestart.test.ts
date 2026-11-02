import { describe, expect, it, vi } from "vite-plus/test";

import {
  CLEAN_RESTART_ENV,
  cleanRestartArgs,
  cleanRestartEnvFile,
  hasNoNewPrivileges,
  restartWithoutNoNewPrivileges,
} from "./linuxCleanRestart.ts";

const FLAGGED = "Name:\tapp\nNoNewPrivs:\t1\nSeccomp:\t0\n";
const CLEAN = "Name:\tapp\nNoNewPrivs:\t0\nSeccomp:\t0\n";

const input = (overrides: Partial<Parameters<typeof restartWithoutNoNewPrivileges>[0]> = {}) => ({
  platform: "linux" as const,
  env: { DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv,
  execPath: "/opt/SpecWithCode/specweave-studio-desktop",
  args: ["--flag"],
  isDevelopment: false,
  pid: 42,
  readStatus: () => FLAGGED,
  writeEnvFile: vi.fn(),
  removeEnvFile: vi.fn(),
  start: vi.fn(() => true),
  ...overrides,
});

describe("restartWithoutNoNewPrivileges", () => {
  it("reads the flag from the process status", () => {
    expect(hasNoNewPrivileges(FLAGGED)).toBe(true);
    expect(hasNoNewPrivileges(CLEAN)).toBe(false);
  });

  it("starts a clean copy when relaunched with the flag", () => {
    const run = input();
    expect(restartWithoutNoNewPrivileges(run)).toBe(true);
    expect(run.start).toHaveBeenCalledTimes(1);
    expect(run.writeEnvFile).toHaveBeenCalledWith(
      "/run/user/1000/specwithcode-clean-restart-42.env",
      expect.stringContaining('DISPLAY=":0"'),
    );
    expect(run.removeEnvFile).not.toHaveBeenCalled();
  });

  it("carries on when the app was started cleanly", () => {
    const run = input({ readStatus: () => CLEAN });
    expect(restartWithoutNoNewPrivileges(run)).toBe(false);
    expect(run.start).not.toHaveBeenCalled();
  });

  it("carries on and removes the file when the service manager cannot start it", () => {
    const refused = input({ start: () => false });
    expect(restartWithoutNoNewPrivileges(refused)).toBe(false);
    expect(refused.removeEnvFile).toHaveBeenCalledTimes(1);
    const thrown = input({
      start: () => {
        throw new Error("spawn failed");
      },
    });
    expect(restartWithoutNoNewPrivileges(thrown)).toBe(false);
    expect(thrown.removeEnvFile).toHaveBeenCalledTimes(1);
  });

  it("restarts once, deletes its file, and its own later relaunches can restart again", () => {
    const envFile = "/run/user/1000/specwithcode-clean-restart-7.env";
    const run = input({ env: { [CLEAN_RESTART_ENV]: envFile } });
    expect(restartWithoutNoNewPrivileges(run)).toBe(false);
    expect(run.start).not.toHaveBeenCalled();
    expect(run.removeEnvFile).toHaveBeenCalledWith(envFile);
    expect(run.env[CLEAN_RESTART_ENV]).toBeUndefined();
  });

  it("never deletes a file that is not its own", () => {
    const run = input({ env: { [CLEAN_RESTART_ENV]: "/home/me/notes.txt" } });
    expect(restartWithoutNoNewPrivileges(run)).toBe(false);
    expect(run.removeEnvFile).not.toHaveBeenCalled();
  });

  it("carries on without a runtime folder", () => {
    const run = input({ env: {} });
    expect(restartWithoutNoNewPrivileges(run)).toBe(false);
    expect(run.start).not.toHaveBeenCalled();
  });

  it("leaves other platforms, AppImages and development runs alone", () => {
    for (const run of [
      input({ platform: "darwin" }),
      input({ env: { APPIMAGE: "/tmp/app.AppImage", XDG_RUNTIME_DIR: "/run/user/1000" } }),
      input({ isDevelopment: true }),
    ]) {
      expect(restartWithoutNoNewPrivileges(run)).toBe(false);
      expect(run.start).not.toHaveBeenCalled();
    }
  });
});

describe("cleanRestartArgs", () => {
  it("keeps environment values off the command line", () => {
    const args = cleanRestartArgs({
      execPath: "/opt/app",
      args: ["--flag"],
      envFilePath: "/run/user/1000/specwithcode-clean-restart-7.env",
    });
    expect(args.slice(-2)).toEqual(["/opt/app", "--flag"]);
    expect(args.some((arg) => arg.startsWith("--setenv"))).toBe(false);
    expect(args).toContain(
      "--property=EnvironmentFile=/run/user/1000/specwithcode-clean-restart-7.env",
    );
    expect(args).toContain("--property=KillMode=process");
    expect(args).toContain("--property=OOMPolicy=continue");
  });
});

describe("cleanRestartEnvFile", () => {
  it("quotes its own path too", () => {
    expect(cleanRestartEnvFile({}, '/run/odd"dir/f.env')).toBe(
      `${CLEAN_RESTART_ENV}="/run/odd\\"dir/f.env"\n`,
    );
  });

  it("quotes values literally and skips names systemd would refuse", () => {
    const file = cleanRestartEnvFile(
      { A: 'x "y" $HOME `z` \\n', _: "/bin/sh", "BAD=NAME": "x", [CLEAN_RESTART_ENV]: "old" },
      "/run/user/1000/f.env",
    );
    expect(file).toBe(
      `A="x \\"y\\" \\$HOME \\\`z\\\` \\\\n"\n${CLEAN_RESTART_ENV}="/run/user/1000/f.env"\n`,
    );
  });
});
