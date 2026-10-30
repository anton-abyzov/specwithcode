// @effect-diagnostics nodeBuiltinImport:off -- Owned installer fixtures only.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  stageCodexUpdate,
  providerProcessesInUse,
  findProviderProcessesInUse,
  shortProcessLabel,
  type StagedCodexUpdate,
} from "./stagedProviderUpdate.ts";
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cli-update-")));
  homes.push(home);
  const releasesDirectory = path.join(home, "releases");
  const wrapperPath = path.join(home, "bin/codex");
  const nodePath = path.join(home, "node");
  const npmCliPath = path.join(home, "npm-cli.js");
  await fs.mkdir(path.dirname(wrapperPath));
  await fs.mkdir(releasesDirectory);
  await fs.writeFile(wrapperPath, "original-wrapper");
  await fs.writeFile(nodePath, "node");
  await fs.writeFile(npmCliPath, "npm");
  const auth = path.join(home, "auth.json");
  await fs.writeFile(auth, "unchanged-auth");
  const oldRelease = path.join(releasesDirectory, "old.js");
  await fs.writeFile(oldRelease, "running-session-files");
  const input: StagedCodexUpdate = {
    releasesDirectory,
    wrapperPath,
    nodePath,
    npmCliPath,
    expectedWrapper: "original-wrapper",
  };
  const calls: readonly string[][] = [];
  const run = async (_command: string, args: readonly string[]) => {
    (calls as string[][]).push([...args]);
    if (args[0] === npmCliPath) {
      const stage = args[args.indexOf("--prefix") + 1]!;
      const pkg = path.join(stage, "node_modules/@openai/codex");
      await fs.mkdir(path.join(pkg, "bin"), { recursive: true });
      await fs.writeFile(
        path.join(pkg, "package.json"),
        JSON.stringify({ name: "@openai/codex", version: "0.164.0" }),
      );
      await fs.writeFile(path.join(pkg, "bin/codex.js"), "new-entrypoint");
      return "installed";
    }
    return "codex-cli 0.164.0\n";
  };
  return { input, run, calls, auth, oldRelease };
}
describe("staged Codex installer", () => {
  it("verifies a side-by-side package before switching only the wrapper", async () => {
    const f = await fixture();
    await stageCodexUpdate(f.input, "0.164.0", f.run);
    expect(await fs.readFile(f.input.wrapperPath, "utf8")).toContain("codex-0.164.0-");
    expect(await fs.readFile(f.oldRelease, "utf8")).toBe("running-session-files");
    expect(await fs.readFile(f.auth, "utf8")).toBe("unchanged-auth");
    expect(f.calls[0]).toContain("--ignore-scripts");
    expect(f.calls[0]).toContain("--registry=https://registry.npmjs.org");
    expect(f.calls[0]).not.toContain("-g");
  });
  it("preserves the wrapper when install fails", async () => {
    const f = await fixture();
    await expect(
      stageCodexUpdate(f.input, "0.164.0", async () => {
        throw new Error("npm failed");
      }),
    ).rejects.toThrow("npm failed");
    expect(await fs.readFile(f.input.wrapperPath, "utf8")).toBe("original-wrapper");
  });
  it("refuses a mismatched executable version", async () => {
    const f = await fixture();
    await expect(
      stageCodexUpdate(f.input, "0.164.0", async (cmd, args) =>
        args[0] === f.input.npmCliPath ? f.run(cmd, args) : "codex-cli 0.163.0",
      ),
    ).rejects.toThrow("reported");
    expect(await fs.readFile(f.input.wrapperPath, "utf8")).toBe("original-wrapper");
  });
  it("preserves a wrapper changed during install", async () => {
    const f = await fixture();
    await expect(
      stageCodexUpdate(f.input, "0.164.0", async (cmd, args) => {
        const result = await f.run(cmd, args);
        if (args[0] === f.input.npmCliPath)
          await fs.writeFile(f.input.wrapperPath, "another-owner");
        return result;
      }),
    ).rejects.toThrow("wrapper changed");
    expect(await fs.readFile(f.input.wrapperPath, "utf8")).toBe("another-owner");
  });
  it("rejects unknown or prerelease versions before spawning", async () => {
    const f = await fixture();
    for (const version of ["", "latest", "0.164.0-beta.1"])
      await expect(stageCodexUpdate(f.input, version, f.run)).rejects.toThrow("latest stable");
    expect(f.calls).toHaveLength(0);
  });
});

describe("installer process ownership", () => {
  it("catches Node package entrypoints whose filename is not the provider name", () => {
    expect(
      providerProcessesInUse(
        "node /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc",
        "pi",
        [],
        "@earendil-works/pi-coding-agent",
      ),
    ).toBe(true);
  });
  it("catches configured renamed binaries and leaves unrelated commands alone", () => {
    expect(
      providerProcessesInUse("/custom/bin/work-agent --rpc", "pi", ["/custom/bin/work-agent"]),
    ).toBe(true);
    expect(
      providerProcessesInUse(
        "node /app/server.js",
        "pi",
        ["/custom/bin/work-agent"],
        "@earendil-works/pi-coding-agent",
      ),
    ).toBe(false);
  });
  it("reports the matching pid with a short label that drops later arguments", () => {
    const ps = [
      "  101     1 /usr/lib/systemd/systemd --user",
      "638656   101 /usr/bin/node /home/me/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex",
      "638700   101 /home/me/.codex/bin/codex app-server --token secret",
      "638800   101 claude -p 'private prompt'",
    ].join("\n");
    const matches = findProviderProcessesInUse(ps, "codex", [], "@openai/codex");
    expect(matches.map((match) => match.pid)).toEqual([638656, 638700]);
    expect(shortProcessLabel(matches[0]!.command)).toBe("node .../bin/codex");
    expect(shortProcessLabel("/home/me/.codex/bin/codex app-server --token secret")).toBe(
      "codex app-server",
    );
    expect(shortProcessLabel("claude -p 'private prompt'")).toBe("claude");
    // Neither paths nor a package: the bare-name fallback.
    expect(findProviderProcessesInUse(ps, "claudeAgent", [])[0]?.pid).toBe(638800);
    expect(findProviderProcessesInUse(ps, "codex", []).map((match) => match.pid)).toEqual([
      638656, 638700,
    ]);
  });
});

describe("installer in-use names", () => {
  it("matches the CLI by argv0, not the desktop app or a folder named after it", () => {
    const ps = [
      "  10     1 /Applications/Claude.app/Contents/MacOS/Claude",
      "  11    10 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper",
      "  12     1 node /Users/me/Projects/codex/server.js",
      "  13     1 vim /Users/me/work/claude/notes.md",
      "  14     1 /Users/me/.local/bin/claude -p hi",
    ].join("\n");
    expect(findProviderProcessesInUse(ps, "claudeAgent", ["/x/claude"]).map((m) => m.pid)).toEqual([
      14,
    ]);
    expect(findProviderProcessesInUse(ps, "codex", [], "@openai/codex")).toEqual([]);
  });

  it("exempts the managed package store only for Codex, and only as argv0", () => {
    const ps = [
      "  20     1 /home/me/.codex/packages/app-server-daemon/releases/1/bin/codex app-server",
      "  21     1 codex exec -C /home/me/.codex/packages/x",
      "  22     1 claude -p --add-dir /home/me/.codex/packages/x",
    ].join("\n");
    expect(findProviderProcessesInUse(ps, "codex", [], "@openai/codex").map((m) => m.pid)).toEqual([
      21,
    ]);
    expect(
      findProviderProcessesInUse(ps, "claudeAgent", [], "@anthropic-ai/claude-code").map(
        (m) => m.pid,
      ),
    ).toEqual([22]);
  });
});

describe("installer in-use scope", () => {
  const daemon =
    "/home/anton/.codex/packages/app-server-daemon/releases/0.166.0-x86_64-unknown-linux-musl/bin/codex app-server --listen unix:///run/user/1000/codex/app-server.sock --managed-daemon";
  const vendorCodex =
    "/home/anton/.local/share/fnm/node-versions/v24.22.0/installation/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
  const shimCodex = "node /run/user/1000/fnm_multishells/1/bin/codex";

  it("ignores Codex's managed app-server daemon when the npm package is known", () => {
    expect(providerProcessesInUse(`4100 1 ${daemon}`, "codex", [], "@openai/codex")).toBe(false);
    // The daemon still counts for an action that knows neither paths nor a package.
    expect(providerProcessesInUse(`4100 1 ${daemon}`, "codex", [])).toBe(true);
  });

  it("still counts a terminal Codex from the npm package", () => {
    expect(providerProcessesInUse(`4200 4000 ${vendorCodex}`, "codex", [], "@openai/codex")).toBe(
      true,
    );
    expect(providerProcessesInUse(`4300 4000 ${shimCodex}`, "codex", [], "@openai/codex")).toBe(
      true,
    );
    const ps = [`4100 1 ${daemon}`, `4200 4000 ${vendorCodex}`, `4300 4000 ${shimCodex}`].join(
      "\n",
    );
    expect(
      findProviderProcessesInUse(ps, "codex", [], "@openai/codex").map((match) => match.pid),
    ).toEqual([4200, 4300]);
  });

  it("still counts a shell-started bare-name CLI when paths or a package are known", () => {
    const paths = ["/run/user/1000/fnm_multishells/1/bin/codex"];
    const ps = [`4100 1 ${daemon}`, `4300 4000 ${shimCodex}`, "4400 4000 codex exec"].join("\n");
    expect(findProviderProcessesInUse(ps, "codex", paths).map((match) => match.pid)).toEqual([
      4300, 4400,
    ]);
    expect(
      findProviderProcessesInUse(ps, "codex", [], "@openai/codex").map((match) => match.pid),
    ).toEqual([4300, 4400]);
    expect(
      providerProcessesInUse(
        "4500 4000 claude -p 'hi'",
        "claudeAgent",
        [],
        "@anthropic-ai/claude-code",
      ),
    ).toBe(true);
  });

  it("skips this server and every process descended from it", () => {
    const self = 5000;
    const ps = [
      "   1     0 /sbin/init",
      `5000     1 node /opt/specwithcode/server.js`,
      `5100  5000 ${vendorCodex} app-server`,
      `5200  5100 ${shimCodex}`,
      `5300  4000 ${vendorCodex}`,
    ].join("\n");
    expect(
      findProviderProcessesInUse(ps, "codex", [], "@openai/codex", { selfPid: self }).map(
        (match) => match.pid,
      ),
    ).toEqual([5300]);
    expect(
      providerProcessesInUse(ps.split("\n").slice(0, 4).join("\n"), "codex", [], "@openai/codex", {
        selfPid: self,
      }),
    ).toBe(false);
    // Without the server pid the same sessions count.
    expect(
      findProviderProcessesInUse(ps, "codex", [], "@openai/codex").map((match) => match.pid),
    ).toEqual([5100, 5200, 5300]);
  });

  it("counts a server descendant started from an interactive shell (a terminal tab)", () => {
    const self = 5000;
    const ps = [
      `5000     1 node /opt/specwithcode/server.js`,
      `5100  5000 codex app-server`,
      `5150  5000 -zsh`,
      `5200  5150 node /home/me/.nvm/versions/node/v22/bin/codex`,
      `5250  5000 /bin/bash -l`,
      `5260  5250 /usr/bin/env node`,
      `5270  5260 codex exec`,
    ].join("\n");
    expect(
      findProviderProcessesInUse(ps, "codex", [], "@openai/codex", { selfPid: self }).map(
        (match) => match.pid,
      ),
    ).toEqual([5200, 5270]);
  });

  it("tolerates a cyclic parent map", () => {
    const ps = [`10 11 ${vendorCodex}`, `11 10 ${vendorCodex}`].join("\n");
    expect(
      findProviderProcessesInUse(ps, "codex", [], "@openai/codex", { selfPid: 99 }).map(
        (match) => match.pid,
      ),
    ).toEqual([10, 11]);
  });
});
