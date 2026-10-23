// @effect-diagnostics nodeBuiltinImport:off -- Owned installer fixtures only.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  stageCodexUpdate,
  providerProcessesInUse,
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
});
