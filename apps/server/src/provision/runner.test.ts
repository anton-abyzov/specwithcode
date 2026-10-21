// @effect-diagnostics globalDate:off - ProvisionHost.now is a plain Date clock.
import type { ProvisionItem } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ExecResult, ProvisionHost } from "./host.ts";
import { ChecksumMismatchError } from "./host.ts";
import { formatReadback } from "./format.ts";
import { installFailureReason } from "./install.ts";
import {
  CLAUDE_VERSION,
  codexDownload,
  GH_VERSION,
  NODE_VERSION,
  nodeDownload,
} from "./manifest.ts";
import { ProvisionRunError, runProvision, type ProvisionOptions } from "./runner.ts";
import { checkTarget } from "./target.ts";

const HOME = "/home/ada";
const SW = `${HOME}/.specwithcode`;
const BIN = `${HOME}/.local/bin`;
const SERVER = "1.0.63";
const CODEX = codexDownload("linux-x64").version;
const UBUNTU_2404 =
  'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nPRETTY_NAME="Ubuntu 24.04.5 LTS"\n';

type Answer =
  | ExecResult
  | ((
      args: ReadonlyArray<string>,
      env?: Readonly<Record<string, string | undefined>>,
    ) => ExecResult);
const out = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: "" });

interface Fake extends ProvisionHost {
  files: Map<string, { text: string; mode: number }>;
  links: Map<string, string>;
  answers: Map<string, Answer>;
  calls: string[];
  downloads: string[];
  failDownload?: Error;
}

function fakeHost(platform: "linux" | "darwin" = "linux"): Fake {
  const files = new Map<string, { text: string; mode: number }>();
  const links = new Map<string, string>();
  const answers = new Map<string, Answer>();
  const calls: string[] = [];
  const downloads: string[] = [];
  const resolve = (path: string) => links.get(path) ?? path;
  const isExec = (path: string) => ((files.get(resolve(path))?.mode ?? 0) & 0o111) !== 0;
  const host: Fake = {
    files,
    links,
    answers,
    calls,
    downloads,
    platform,
    arch: platform === "darwin" ? "arm64" : "x64",
    home: platform === "darwin" ? "/Users/ada" : HOME,
    user: "ada",
    uid: 1000,
    env: { PATH: "/usr/bin:/bin" },
    interactive: false,
    exec: async (command, args, execOptions) => {
      const key = `${command} ${args.join(" ")}`;
      calls.push(key);
      const answer = answers.get(key) ?? answers.get(command);
      if (answer) return typeof answer === "function" ? answer(args, execOptions?.env) : answer;
      if (args[0] === "--version" && isExec(command)) {
        const text = files.get(resolve(command))!.text;
        return out(/version (\S+)/u.exec(text)?.[1] ?? "");
      }
      return { code: 127, stdout: "", stderr: `${command}: not found` };
    },
    readText: async (path) => files.get(resolve(path))?.text ?? null,
    listDir: async (path) =>
      [...files.keys(), ...links.keys()]
        .filter((entry) => entry.startsWith(`${path}/`))
        .map((entry) => entry.slice(path.length + 1).split("/")[0]!),
    writeText: async (path, text, mode = 0o644) => {
      files.set(path, { text, mode });
    },
    appendText: async (path, text, mode = 0o644) => {
      files.set(path, { text: (files.get(path)?.text ?? "") + text, mode });
    },
    exists: async (path) =>
      files.has(path) ||
      links.has(path) ||
      [...files.keys()].some((entry) => entry.startsWith(`${path}/`)),
    isExecutable: async (path) => isExec(path),
    readLink: async (path) => links.get(path) ?? null,
    realPath: async (path) => resolve(path),
    mkdirp: async () => {},
    remove: async (path) => {
      files.delete(path);
      links.delete(path);
    },
    rename: async (from, to) => {
      const file = files.get(from);
      if (file) files.set(to, file);
      files.delete(from);
    },
    symlink: async (target, link) => {
      links.set(link, target);
    },
    chmod: async () => {},
    download: async (url) => {
      downloads.push(url);
      if (host.failDownload) throw host.failDownload;
    },
    downloadSigned: async (url) => {
      downloads.push(url);
    },
    fetchText: async () => ({ ok: false, status: 404, text: "" }),
    sha256File: async () => "0".repeat(64),
    sha256Text: () => "0".repeat(64),
    which: async (name, pathValue) => {
      for (const dir of pathValue.split(":")) if (isExec(`${dir}/${name}`)) return `${dir}/${name}`;
      return null;
    },
    now: () => new Date(Date.UTC(2026, 9, 20, 12)),
  };
  return host;
}

/** A program at `path` that answers --version with `version`. */
function program(host: Fake, path: string, version: string) {
  host.files.set(path, { text: `#!/bin/sh\n# version ${version}\n`, mode: 0o755 });
}

function linuxFacts(host: Fake) {
  host.files.set("/etc/os-release", { text: UBUNTU_2404, mode: 0o644 });
  host.files.set("/run/systemd/system/.keep", { text: "", mode: 0o644 });
  host.files.set("/proc/version", { text: "Linux version 6.8.0 (buildd@ubuntu)", mode: 0o644 });
  host.answers.set("ldd --version", out("ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39"));
  host.answers.set("systemctl is-enabled sleep.target", out("masked"));
}

/** Everything a worker needs, at the pinned versions, installed by provisioning. */
function provisionedLinux(): Fake {
  const host = fakeHost();
  linuxFacts(host);
  program(host, "/usr/bin/git", "2.43.0");
  program(host, "/usr/bin/tailscale", "1.90.1");
  host.answers.set("/usr/bin/tailscale version", out("1.90.1"));
  host.answers.set("/usr/bin/tailscale status --json", out('{"BackendState": "Running"}'));
  program(host, `${SW}/tools/gh/${GH_VERSION}/bin/gh`, GH_VERSION);
  host.links.set(`${BIN}/gh`, `${SW}/tools/gh/${GH_VERSION}/bin/gh`);
  program(host, `${HOME}/.local/share/claude/versions/${CLAUDE_VERSION}`, CLAUDE_VERSION);
  host.links.set(`${BIN}/claude`, `${HOME}/.local/share/claude/versions/${CLAUDE_VERSION}`);
  host.files.set(`${BIN}/codex`, {
    text: `#!/bin/sh\n# specwithcode-provision launcher\n# version ${CODEX}\n`,
    mode: 0o755,
  });
  program(host, `${BIN}/specwithcode`, SERVER);
  program(host, `${BIN}/specweave-studio`, SERVER);
  host.files.set(`${HOME}/.config/systemd/user/studio.service`, {
    text: `[Service]\nEnvironment="STUDIO_HOME=${SW}"\nExecStart=${SW}/runtime/versions/${SERVER}/bin/node\n`,
    mode: 0o644,
  });
  host.answers.set("systemctl --user is-active studio.service", out("active"));
  host.answers.set("loginctl show-user ada -p Linger --value", out("yes"));
  host.answers.set(`${BIN}/gh auth status`, out("Logged in"));
  return host;
}

function options(overrides: Partial<ProvisionOptions> = {}): ProvisionOptions {
  return {
    dryRun: false,
    resume: false,
    manifestVersion: SERVER,
    mode: "cli",
    loginShellPath: () => `${BIN}:/usr/bin:/bin`,
    runtime: { version: `v${NODE_VERSION}`, execPath: "/usr/bin/node" },
    ...overrides,
  };
}

const byId = (items: ReadonlyArray<ProvisionItem>, id: string) =>
  items.find((entry) => entry.id === id)!;

describe("checkTarget", () => {
  const facts = {
    platform: "linux",
    arch: "x64",
    osRelease: UBUNTU_2404,
    macosVersion: null,
    libc: "glibc" as const,
    systemd: true,
    wsl: false,
  };

  it("supports Ubuntu 24.04 on x64", () => {
    const target = checkTarget(facts);
    expect(target.supported).toBe(true);
    expect(target.key).toBe("linux-x64");
    expect(target.codename).toBe("noble");
  });

  it("refuses musl, 32-bit ARM and old macOS, naming the nearest supported target", () => {
    for (const refused of [
      checkTarget({ ...facts, libc: "musl" }),
      checkTarget({ ...facts, arch: "arm" }),
      checkTarget({
        ...facts,
        platform: "darwin",
        arch: "arm64",
        osRelease: null,
        macosVersion: "13.6",
        libc: "darwin",
      }),
    ]) {
      expect(refused.supported).toBe(false);
      expect(refused.key).toBeNull();
      expect(refused.nearest).toBeTruthy();
    }
  });

  it("stops an unsupported machine before any change", async () => {
    const host = fakeHost();
    host.files.set("/etc/os-release", { text: "ID=alpine\nVERSION_ID=3.20\n", mode: 0o644 });
    host.files.set("/etc/alpine-release", { text: "3.20", mode: 0o644 });
    const error = await runProvision(host, options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProvisionRunError);
    expect((error as ProvisionRunError).code).toBe("unsupported");
    expect(host.downloads).toEqual([]);
    expect([...host.files.keys()].some((path) => path.startsWith(SW))).toBe(false);
  });
});

describe("runProvision", () => {
  it("changes nothing on a provisioned machine, run after run", async () => {
    const host = provisionedLinux();
    for (let run = 0; run < 2; run += 1) {
      const readback = await runProvision(host, options());
      expect(readback.summary).toBe("Nothing to change: this machine is already provisioned.");
      expect(readback.changed).toBe(false);
      expect(readback.ok).toBe(true);
      expect(readback.items.every((entry) => entry.status === "ok")).toBe(true);
    }
    expect(host.downloads).toEqual([]);
    expect(host.calls.some((call) => call.startsWith("sudo"))).toBe(false);
  });

  it("plans a clean machine in a dry run and writes nothing", async () => {
    const host = fakeHost();
    linuxFacts(host);
    const before = [...host.files.keys()];
    const readback = await runProvision(host, options({ dryRun: true }));
    for (const id of ["git", "tailscale", "gh", "claude", "codex", "server", "service", "linger"])
      expect(byId(readback.items, id).status).toBe("planned");
    expect(byId(readback.items, "node").status).toBe("ok");
    expect(readback.rootStep?.items).toEqual(
      expect.arrayContaining(["git", "tailscale", "linger"]),
    );
    expect([...host.files.keys()]).toEqual(before);
    expect(host.links.size).toBe(0);
    expect(host.downloads).toEqual([]);
  });

  it("keeps a newer version and never downgrades", async () => {
    const host = provisionedLinux();
    program(host, `${SW}/tools/gh/${GH_VERSION}/bin/gh`, "9.0.0");
    program(host, `${BIN}/specwithcode`, "2.0.0");
    const readback = await runProvision(host, options({ dryRun: true }));
    expect(byId(readback.items, "gh").status).toBe("kept-newer");
    expect(byId(readback.items, "server").status).toBe("kept-newer");
  });

  it("reads an fnm codex script's version with the agents' PATH, not a per-shell folder", async () => {
    const host = provisionedLinux();
    host.files.delete(`${BIN}/codex`);
    const fnm = `${HOME}/.local/share/fnm`;
    const shellDir = "/run/user/1000/fnm_multishells/123_456/bin";
    for (const dir of [`${fnm}/aliases/default/bin`, shellDir]) {
      host.files.set(`${dir}/codex`, { text: "#!/usr/bin/env node\n", mode: 0o755 });
      // `#!/usr/bin/env node` only starts when node's folder is on its PATH.
      host.answers.set(`${dir}/codex --version`, (_args, env) =>
        (env?.PATH ?? "").split(":").includes(`${fnm}/aliases/default/bin`)
          ? out("codex-cli 0.163.0")
          : { code: 127, stdout: "", stderr: "/usr/bin/env: 'node': No such file or directory" },
      );
    }
    const readback = await runProvision(
      host,
      options({
        dryRun: true,
        loginShellPath: () => `${shellDir}:${fnm}/aliases/default/bin:/usr/bin:/bin`,
      }),
    );
    const codex = byId(readback.items, "codex");
    expect(codex.status).toBe("kept-newer");
    expect(codex.found).toBe("0.163.0");
    expect(readback.providers.find((entry) => entry.id === "codex")?.path).toBe(
      `${fnm}/aliases/default/bin/codex`,
    );
  });

  it("leaves an older install it did not make to the user instead of shadowing it", async () => {
    const host = provisionedLinux();
    host.links.delete(`${BIN}/gh`);
    program(host, "/usr/bin/gh", "2.45.0");
    const gh = byId((await runProvision(host, options({ dryRun: true }))).items, "gh");
    expect(gh.status).toBe("user-action");
    expect(gh.detail).toContain("/usr/bin/gh");
    expect(gh.command).toContain("/usr/bin/gh");

    host.files.delete("/usr/bin/gh");
    program(host, "/home/linuxbrew/.linuxbrew/bin/gh", "2.45.0");
    const brewHost = { ...host, env: { PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin" } };
    const brew = byId((await runProvision(brewHost, options({ dryRun: true }))).items, "gh");
    expect(brew.command).toBe("brew upgrade gh");
  });

  it("marks a checksum mismatch failed, keeps the run resumable and resumes it", async () => {
    const host = provisionedLinux();
    host.links.delete(`${BIN}/gh`);
    host.failDownload = new ChecksumMismatchError("https://github.com/cli/cli/gh.tar.gz", "a", "b");
    const failed = await runProvision(host, options());
    const gh = byId(failed.items, "gh");
    expect(gh.status).toBe("failed");
    expect(gh.command).toBe("specwithcode provision --resume");
    expect(failed.ok).toBe(false);
    expect(failed.summary).toMatch(/^Failed: gh\./u);
    expect(JSON.parse(host.files.get(`${SW}/provision/state.json`)!.text).finished).toBe(false);
    expect(host.links.has(`${BIN}/gh`)).toBe(false);

    host.failDownload = new Error("still offline");
    const resumed = await runProvision(host, options({ resume: true }));
    expect(resumed.resumed).toBe(true);
    expect(resumed.runId).toBe(failed.runId);
  });

  it("does not start the service when the server did not install", async () => {
    const host = provisionedLinux();
    for (const name of ["specwithcode", "specweave-studio"]) host.files.delete(`${BIN}/${name}`);
    host.failDownload = new Error("fetch failed");
    const readback = await runProvision(host, options());
    expect(byId(readback.items, "server").status).toBe("failed");
    for (const id of ["service", "legacy-names"]) {
      const item = byId(readback.items, id);
      if (item.status !== "ok") expect(item.detail).toMatch(/^Waits for the SpecWithCode server/u);
    }
    expect(host.calls.some((call) => /service install/u.test(call))).toBe(false);
  });

  it("names why install.sh failed instead of a stack-trace tail", () => {
    const stderr = [
      "[22:04:37.844] ERROR (#15): BootServicePrerequisiteError: [user-manager-unavailable] Cannot reach the systemd user manager.",
      "    at cloud.boot_service.install (file:///x/binCli.mjs:1:2)",
      "specwithcode install: the background service did not install",
    ].join("\n");
    expect(installFailureReason({ stdout: "", stderr })).toMatch(
      /^ERROR \(#15\): BootServicePrerequisiteError: \[user-manager-unavailable\]/u,
    );
    expect(installFailureReason({ stdout: "done\nlast words", stderr: "" })).toBe("last words");
  });

  it("installs the service through the release entry, which keeps the session environment", async () => {
    const host = provisionedLinux();
    host.files.delete(`${HOME}/.config/systemd/user/studio.service`);
    host.answers.delete("systemctl --user is-active studio.service");
    const entry = `${SW}/runtime/versions/${SERVER}/specweave-studio`;
    program(host, entry, SERVER);
    await runProvision(host, options());
    expect(host.calls).toContain(`${entry} service install`);
    expect(host.calls).not.toContain(`${BIN}/specwithcode service install`);
  });

  it("reaches the user manager from an `env -i` launcher through /run/user/<uid>", async () => {
    const host = provisionedLinux();
    host.files.set("/run/user/1000/bus", { text: "", mode: 0o666 });
    const envs: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
    const busAnswer =
      (stdout: string) =>
      (_args: ReadonlyArray<string>, env?: Readonly<Record<string, string | undefined>>) => {
        envs.push(env);
        return env?.XDG_RUNTIME_DIR === "/run/user/1000" &&
          env.DBUS_SESSION_BUS_ADDRESS === "unix:path=/run/user/1000/bus"
          ? out(stdout)
          : { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" };
      };
    host.answers.set("systemctl --user is-active studio.service", busAnswer("active"));
    for (let run = 0; run < 2; run += 1) {
      const readback = await runProvision(host, options());
      expect(byId(readback.items, "service").status).toBe("ok");
      expect(byId(readback.items, "service").detail).toMatch(/is running\.$/u);
      expect(readback.changed).toBe(false);
      expect(readback.ok).toBe(true);
    }
    expect(envs.length).toBeGreaterThan(0);
    expect(host.calls).not.toContain("systemctl --user start studio.service");
  });

  it("reports an unreachable user manager instead of planning to start a running service", async () => {
    const host = provisionedLinux();
    host.answers.set("systemctl --user is-active studio.service", {
      code: 1,
      stdout: "",
      stderr: "Failed to connect to bus: No medium found",
    });
    const dry = await runProvision(host, options({ dryRun: true }));
    const planned = byId(dry.items, "service");
    expect(planned.status).toBe("failed");
    expect(planned.detail).toMatch(
      /^Cannot reach the systemd user manager \(Failed to connect to bus: No medium found\)/u,
    );
    expect(planned.detail).not.toMatch(/Starts the installed service/u);
    expect(dry.service.managerError).toBe("Failed to connect to bus: No medium found");
    expect(formatReadback(dry)).toMatch(/service unknown \(user manager unreachable\)/u);
    const real = await runProvision(host, options());
    expect(real.ok).toBe(false);
    expect(byId(real.items, "server").status).toBe("ok");
    expect(host.calls.some((call) => /^systemctl --user (start|restart)/u.test(call))).toBe(false);
  });

  it("still plans to start a service that is installed and stopped", async () => {
    const host = provisionedLinux();
    host.answers.set("systemctl --user is-active studio.service", out("inactive", 3));
    const readback = await runProvision(host, options({ dryRun: true }));
    expect(byId(readback.items, "service").status).toBe("planned");
    expect(byId(readback.items, "service").detail).toBe("Starts the installed service.");
    expect(readback.service.managerError).toBeUndefined();
  });

  it("refuses --resume when there is no unfinished run", async () => {
    const host = provisionedLinux();
    const error = await runProvision(host, options({ resume: true })).catch(
      (caught: unknown) => caught,
    );
    expect((error as ProvisionRunError).code).toBe("no-run-to-resume");
  });

  it("refuses a second run while another one holds the lock", async () => {
    const host = provisionedLinux();
    host.files.set(`${SW}/provision/run.lock`, { text: `${process.ppid}\n`, mode: 0o600 });
    const error = await runProvision(host, options()).catch((caught: unknown) => caught);
    expect((error as ProvisionRunError).code).toBe("busy");
  });

  it("collects root steps into one line to run when sudo needs a password", async () => {
    const host = provisionedLinux();
    host.files.delete("/usr/bin/git");
    host.answers.set("sudo -n true", out("", 1));
    const readback = await runProvision(host, options());
    const git = byId(readback.items, "git");
    expect(git.status).toBe("needs-root");
    expect(git.command).toMatch(/^sudo sh '.+'$/u);
    expect(readback.rootStep?.ran).toBe(false);
    expect(readback.userSteps[0]?.id).toBe("root");
    expect(host.calls.filter((call) => call.startsWith("sudo"))).toEqual(["sudo -n true"]);
  });

  it("never replaces the running server from the app", async () => {
    const host = provisionedLinux();
    program(host, `${BIN}/specwithcode`, "1.0.60");
    program(host, `${BIN}/specweave-studio`, "1.0.60");
    const readback = await runProvision(
      host,
      options({ mode: "remote", serverPath: `${BIN}:/usr/bin:/bin` }),
    );
    expect(byId(readback.items, "server").status).toBe("user-action");
    expect(host.calls.some((call) => /install\.sh/u.test(call))).toBe(false);
    expect(readback.userSteps.some((step) => step.id === "join")).toBe(false);
  });

  it("never grants workers, signs in or turns on billing; lists them as the user's steps", async () => {
    const host = provisionedLinux();
    host.answers.set(`${BIN}/gh auth status`, out("", 1));
    const readback = await runProvision(host, options());
    const ids = readback.userSteps.map((step) => step.id);
    expect(ids).toEqual(expect.arrayContaining(["gh-signin", "claude-signin", "allow-workers"]));
    expect(host.calls.some((call) => /auth login|fleet allow|billing/u.test(call))).toBe(false);
  });

  it("leaves the server to the desktop app on a Mac", async () => {
    const host = fakeHost("darwin");
    host.answers.set("sw_vers -productVersion", out("15.4"));
    host.answers.set("xcode-select -p", out("/Library/Developer/CommandLineTools"));
    program(host, "/usr/bin/git", "2.50.1");
    host.files.set("/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode", {
      text: "",
      mode: 0o755,
    });
    host.files.set("/Applications/SpecWithCode.app/Contents/Info.plist", {
      text: "<dict><key>CFBundleShortVersionString</key>\n<string>1.0.62</string></dict>",
      mode: 0o644,
    });
    const readback = await runProvision(host, options({ dryRun: true }));
    const server = byId(readback.items, "server");
    expect(server.status).toBe("user-action");
    expect(server.found).toBe("1.0.62");
    expect(server.detail).toContain("desktop app");
    expect(byId(readback.items, "service").status).toBe("ok");
    expect(byId(readback.items, "node").status).toBe("ok");
    expect(nodeDownload("darwin-arm64").stem).toContain(NODE_VERSION);

    const standalone = await runProvision(host, options({ dryRun: true, standalone: true }));
    expect(byId(standalone.items, "server").status).toBe("planned");
  });
});
