// @effect-diagnostics nodeBuiltinImport:off - the home folder the shell must start in.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { describe, expect, it } from "vite-plus/test";

import { TERMINAL_VARIABLES } from "./catalog.ts";
import {
  captureScript,
  parseTerminalEnvironment,
  readTerminalEnvironment,
  runShell,
  type ShellRun,
  TERMINAL_ENV_FRESH_GAP_MS,
  TERMINAL_ENV_KEEP_MS,
  TERMINAL_ENV_TIMEOUT_MS,
  type TerminalEnvironment,
  TerminalEnvironmentCache,
} from "./terminalEnv.ts";

const MARK = "__SPECWITHCODE_TERMINAL_ENV__";
const printed = (path: string, xdg = "") =>
  `Welcome back!\n${MARK}${path}\n${MARK}${xdg}${xdg === "" ? "" : "\n"}${MARK}`;

describe("parseTerminalEnvironment", () => {
  it("reads the PATH and XDG_CONFIG_HOME between the marks, whatever a startup file printed", () => {
    expect(parseTerminalEnvironment(printed("/opt/homebrew/bin:/usr/bin"))).toEqual({
      path: "/opt/homebrew/bin:/usr/bin",
      xdgConfigHome: null,
      variables: {},
    });
    expect(parseTerminalEnvironment(printed("/usr/bin", "/Users/me/.xdg"))).toEqual({
      path: "/usr/bin",
      xdgConfigHome: "/Users/me/.xdg",
      variables: {},
    });
  });

  it("reads the listed variables the shell has set, by name, and no others", () => {
    const names = ["HTTPS_PROXY", "GH_TOKEN", "SSH_AUTH_SOCK", "bad name; rm -rf"];
    const output = `${MARK}/usr/bin\n${MARK}${MARK}http://proxy:8080\n${MARK}${MARK}/tmp/agent.sock\n${MARK}`;
    expect(parseTerminalEnvironment(output, names)).toEqual({
      path: "/usr/bin",
      xdgConfigHome: null,
      // GH_TOKEN is not set in that shell, so it is not there at all.
      variables: { HTTPS_PROXY: "http://proxy:8080", SSH_AUTH_SOCK: "/tmp/agent.sock" },
    });
    // A value over several lines is not one a tool was given.
    expect(
      parseTerminalEnvironment(`${MARK}/usr/bin\n${MARK}${MARK}one\ntwo\n${MARK}`, ["GH_TOKEN"])
        ?.variables,
    ).toEqual({});
    // Only a plain name is ever put in the script the shell runs.
    const script = captureScript(names);
    expect(script).toContain("printenv GH_TOKEN");
    expect(script).not.toContain("rm -rf");
    for (const name of TERMINAL_VARIABLES) expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    expect(TERMINAL_VARIABLES).toEqual(
      expect.arrayContaining(["HTTPS_PROXY", "SSH_AUTH_SOCK", "CLOUDFLARE_API_TOKEN", "GH_TOKEN"]),
    );
  });

  it("gives nothing for a shell that printed no marks or no PATH", () => {
    expect(parseTerminalEnvironment("")).toBeNull();
    expect(parseTerminalEnvironment("command not found: printenv")).toBeNull();
    expect(parseTerminalEnvironment(printed(""))).toBeNull();
    expect(parseTerminalEnvironment(`${MARK}/usr/bin`)).toBeNull();
  });
});

describe("readTerminalEnvironment", () => {
  it("asks a login shell, interactive, with a time limit, and takes the first that answers", async () => {
    const asked: Array<{ shell: string; args: ReadonlyArray<string>; timeoutMs: number }> = [];
    const run: ShellRun = async (shell, args, timeoutMs) => {
      asked.push({ shell, args, timeoutMs });
      return asked.length === 1 ? null : printed("/Users/me/.npm-global/bin:/usr/bin");
    };
    expect(await readTerminalEnvironment("darwin", "/opt/own/fish", run, [])).toEqual({
      path: "/Users/me/.npm-global/bin:/usr/bin",
      xdgConfigHome: null,
      variables: {},
    });
    expect(asked.length).toBe(2);
    expect(asked[0]!.shell).toBe("/opt/own/fish");
    expect(asked[0]!.args[0]).toBe("-ilc");
    expect(asked[0]!.args[1]).toContain("printenv PATH");
    expect(asked[0]!.timeoutMs).toBe(TERMINAL_ENV_TIMEOUT_MS);
  });

  it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "starts the shell in the home folder, not wherever the server runs",
    async () => {
      const printed = await runShell("/bin/sh", ["-c", "pwd -P"], TERMINAL_ENV_TIMEOUT_MS);
      expect(printed?.trim()).toBe(await NodeFSP.realpath(NodeOS.homedir()));
    },
  );

  it("gives nothing on Windows, and nothing when no shell answers", async () => {
    let ran = 0;
    const run: ShellRun = async () => {
      ran += 1;
      return null;
    };
    expect(await readTerminalEnvironment("win32", undefined, run)).toBeNull();
    expect(ran).toBe(0);
    expect(await readTerminalEnvironment("linux", "/bin/bash", run)).toBeNull();
    expect(ran).toBeGreaterThan(0);
  });
});

describe("TerminalEnvironmentCache", () => {
  const environment = (path: string): TerminalEnvironment => ({
    path,
    xdgConfigHome: null,
    variables: {},
  });

  it("keeps a read for a minute, and reads again for a check the person asked for", async () => {
    let now = 1_000_000;
    let reads = 0;
    const cache = new TerminalEnvironmentCache(
      async () => environment(`/read/${(reads += 1)}`),
      () => now,
    );
    expect((await cache.get(false))?.path).toBe("/read/1");
    now += TERMINAL_ENV_KEEP_MS - 1;
    expect((await cache.get(false))?.path).toBe("/read/1");
    // The person may just have installed the tool: their check asks the shell again.
    expect((await cache.get(true))?.path).toBe("/read/2");
    // Not for every click in a row: each read runs the whole shell startup.
    now += TERMINAL_ENV_FRESH_GAP_MS - 1;
    expect((await cache.get(true))?.path).toBe("/read/2");
    now += 1;
    expect((await cache.get(true))?.path).toBe("/read/3");
    now += TERMINAL_ENV_KEEP_MS;
    expect((await cache.get(false))?.path).toBe("/read/4");
  });

  it("never reads twice at once, and keeps a failed read as no answer", async () => {
    let reads = 0;
    let finish: (value: TerminalEnvironment) => void = () => {};
    const cache = new TerminalEnvironmentCache(
      () => {
        reads += 1;
        return new Promise<TerminalEnvironment>((resolve) => {
          finish = resolve;
        });
      },
      () => 5_000_000,
    );
    const both = Promise.all([cache.get(true), cache.get(true), cache.get(false)]);
    finish(environment("/once"));
    expect((await both).map((value) => value?.path)).toEqual(["/once", "/once", "/once"]);
    expect(reads).toBe(1);
    const failing = new TerminalEnvironmentCache(
      () => Promise.reject(new Error("no shell")),
      () => 5_000_000,
    );
    expect(await failing.get(true)).toBeNull();
  });
});
