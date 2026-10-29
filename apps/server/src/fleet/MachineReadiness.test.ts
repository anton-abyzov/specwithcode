// @effect-diagnostics nodeBuiltinImport:off globalDate:off - disposable scratch repositories only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { git } from "./folderTransfer/folderFixture.testkit.ts";
import {
  checkMachineReadiness,
  credentialHelperReadiness,
  commandsIn,
  findRepositories,
  gitHubReadiness,
  scrubDetail,
} from "./MachineReadiness.ts";

let base: string;
let root: string;
let bin: string;

beforeAll(() => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-ready-")));
  root = NodePath.join(base, "project");
  bin = NodePath.join(base, "bin");
  const origin = NodePath.join(base, "origin.git");
  git(base, "init", "-q", "--bare", origin);
  NodeFS.mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "remote", "add", "origin", origin);
  NodeFS.mkdirSync(NodePath.join(root, "repositories"));
  git(NodePath.join(root, "repositories"), "init", "-q", "local-only");
  git(NodePath.join(root, "repositories"), "init", "-q", "gone");
  git(
    NodePath.join(root, "repositories/gone"),
    "remote",
    "add",
    "origin",
    `https://user:hunter2@127.0.0.1:9/${"missing"}.git`,
  );
  NodeFS.mkdirSync(NodePath.join(root, "node_modules/pkg"), { recursive: true });
  git(NodePath.join(root, "node_modules/pkg"), "init", "-q");
  NodeFS.symlinkSync(NodePath.join(root, "repositories"), NodePath.join(root, "linked"));
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(NodePath.join(bin, "present-tool"), "#!/bin/sh\n", { mode: 0o755 });
  NodeFS.writeFileSync(NodePath.join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
});
afterAll(() => NodeFS.rmSync(base, { recursive: true, force: true }));

describe("gitHubReadiness", () => {
  it("reads gh's sign-in without its tokens", async () => {
    const signedIn = await gitHubReadiness(async () => ({
      code: 0,
      missing: false,
      stdout: JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "octo",
              tokenSource: "keyring",
            },
          ],
        },
      }),
    }));
    expect(signedIn).toEqual({
      status: "signed-in",
      accounts: [{ host: "github.com", login: "octo" }],
      detail: null,
    });
    const out = await gitHubReadiness(async () => ({
      code: 1,
      missing: false,
      stdout: JSON.stringify({ hosts: {} }),
    }));
    expect(out.status).toBe("signed-out");
    expect(out.heldHosts).toBeUndefined();
    const broken = await gitHubReadiness(async () => ({
      code: 1,
      missing: false,
      stdout: JSON.stringify({
        hosts: {
          "github.com": [
            { state: "error", active: true, host: "github.com", login: "old", error: "expired" },
          ],
        },
      }),
    }));
    expect(broken).toMatchObject({ status: "signed-out", heldHosts: ["github.com"] });
    // Only gh rejecting --json is "too old"; a timeout or other noise is just unknown.
    expect(
      await gitHubReadiness(async () => ({
        code: 1,
        missing: false,
        stdout: "",
        stderr: "unknown flag: --json\n",
      })),
    ).toMatchObject({ status: "unknown", outdated: true });
    const timedOut = await gitHubReadiness(async () => ({
      code: null,
      missing: false,
      stdout: "",
    }));
    expect(timedOut).toMatchObject({
      status: "unknown",
      detail: "gh did not answer in time; check again.",
    });
    expect(timedOut.outdated).toBeUndefined();
    expect(
      (await gitHubReadiness(async () => ({ code: null, missing: true, stdout: "" }))).status,
    ).toBe("not-installed");
    expect(
      (await gitHubReadiness(async () => ({ code: 1, missing: false, stdout: "nope" }))).status,
    ).toBe("unknown");
  });
});

describe("findRepositories", () => {
  it("finds nested repositories, skips dependencies and never follows links", async () => {
    const found = await findRepositories(root);
    expect(found.paths.sort()).toEqual([".", "repositories/gone", "repositories/local-only"]);
    expect(found.truncated).toBe(false);
  });
});

describe("commandsIn", () => {
  it("takes the program of each step and skips shell words and assignments", () => {
    expect(
      commandsIn("cd web && NODE_ENV=dev pnpm install && ./run.sh | tee log; echo ok"),
    ).toEqual(["pnpm", "./run.sh", "tee"]);
    expect(commandsIn("env FOO=1 uv run app")).toEqual(["uv"]);
    expect(commandsIn("$(which node) x")).toEqual([]);
  });
});

describe("checkMachineReadiness", () => {
  it("checks every origin with this machine's own access and the tools the actions use", async () => {
    const report = await checkMachineReadiness({
      folder: root,
      scripts: [
        { name: "Setup", command: "present-tool && missing-tool-xyz" },
        { name: "Run", command: "./run.sh" },
      ],
      env: { ...process.env, PATH: bin },
      ghAuthStatus: async () => ({ code: null, missing: true, stdout: "" }),
      now: () => new Date("2026-10-20T00:00:00.000Z"),
    });
    expect(report.checkedAt).toBe("2026-10-20T00:00:00.000Z");
    expect(report.github.status).toBe("not-installed");
    const byPath = Object.fromEntries(report.repositories.map((repo) => [repo.path, repo]));
    expect(byPath["."]?.status).toBe("ok");
    expect(byPath["repositories/local-only"]).toMatchObject({ status: "no-origin", origin: null });
    expect(byPath["repositories/gone"]?.status).toBe("no-access");
    expect(JSON.stringify(report)).not.toContain("hunter2");
    expect(report.tools).toEqual([
      { name: "present-tool", action: "Setup", found: true },
      { name: "missing-tool-xyz", action: "Setup", found: false },
      { name: "./run.sh", action: "Run", found: true },
    ]);
  }, 60_000);

  it("checks the machine alone without a folder", async () => {
    const report = await checkMachineReadiness({
      folder: null,
      scripts: [],
      ghAuthStatus: async () => ({
        code: 1,
        missing: false,
        stdout: JSON.stringify({ hosts: {} }),
      }),
      gitCredentialHelper: async () => ({ code: 1, stdout: "" }),
    });
    expect(report.repositories).toEqual([]);
    expect(report.credentialHelper).toEqual({ status: "missing", usesGh: false });
    expect(report.github.status).toBe("signed-out");
  });
});

describe("credentialHelperReadiness", () => {
  it("says whether git hands GitHub credentials to gh, never the helper's text", async () => {
    expect(
      await credentialHelperReadiness(async () => ({
        code: 0,
        stdout: "\n!/opt/homebrew/bin/gh auth git-credential\n",
      })),
    ).toEqual({ status: "configured", usesGh: true });
    const other = await credentialHelperReadiness(async () => ({
      code: 0,
      stdout: "osxkeychain\n",
    }));
    expect(other).toEqual({ status: "configured", usesGh: false });
    expect(JSON.stringify(other)).not.toContain("osxkeychain");
    expect(await credentialHelperReadiness(async () => ({ code: 1, stdout: "" }))).toEqual({
      status: "missing",
      usesGh: false,
    });
    expect(
      await credentialHelperReadiness(async () => {
        throw new Error("no git");
      }),
    ).toEqual({ status: "unknown", usesGh: false });
  });
});

describe("scrubDetail", () => {
  it("drops credentials from tool output", () => {
    expect(
      scrubDetail("fatal: https://me:pw@host/x.git token=abc ghp_ABCDEFGHIJKLMNOP denied"),
    ).toBe("fatal: https://host/x.git token=[redacted] [redacted] denied");
  });
});
