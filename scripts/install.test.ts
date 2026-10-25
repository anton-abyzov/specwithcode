// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer against a local HTTP release fixture.
import { HostProcessArchitecture, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const INSTALLER = NodePath.resolve(import.meta.dirname, "install.sh");
const FLEET = NodePath.resolve(import.meta.dirname, "studio-fleet");
const VERSION = "1.2.3";
const COMMIT12 = "0123456789ab";
const COORDINATOR = "approved-main-environment";
const INVITE = "swc-machine-fixture";

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly bin: string;
  readonly stubs: string;
  readonly node: string;
  readonly log: string;
  readonly baseUrl: string;
  readonly requests: Array<string>;
  resumeDownload: () => void;
  close(): Promise<void>;
}

const fixtures: Array<Fixture> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

/**
 * A release with the published layout: the server archive holds its files at the archive root
 * with a studio-manifest.json naming version, platform and arch, and is listed in SHA256SUMS
 * among the other assets, served as releases/download/v<version>/<asset>. The Node.js stand-in
 * records what it runs to a path baked into it, because the launchers clear the environment.
 */
async function makeFixture(options: {
  readonly platform: "linux" | "darwin";
  readonly arch: string;
  readonly corruptChecksum?: boolean;
  readonly gate?: boolean;
  readonly failArchive?: boolean;
}): Promise<Fixture> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-install-"));
  const home = NodePath.join(root, "home");
  const stubs = NodePath.join(root, "stubs");
  const tree = NodePath.join(root, "tree");
  const log = NodePath.join(root, "node.log");
  for (const directory of [home, stubs, tree]) await NodeFSP.mkdir(directory);
  await NodeFSP.writeFile(NodePath.join(tree, "bin.mjs"), "// fixture\n");
  await NodeFSP.writeFile(NodePath.join(tree, "payload"), NodeCrypto.randomBytes(64 * 1024));
  const manifest = {
    schemaVersion: 1,
    version: VERSION,
    platform: options.platform,
    arch: options.arch,
  };
  await NodeFSP.writeFile(
    NodePath.join(tree, "studio-manifest.json"),
    `${JSON.stringify({ ...manifest, runtime: "Node22.20.0", files: [] }, null, 2)}\n`,
  );
  const archiveName =
    options.platform === "darwin"
      ? `studio-${VERSION}-${COMMIT12}.tar.gz`
      : `studio-${VERSION}-linux-${options.arch}-${COMMIT12}.tar.gz`;
  NodeChildProcess.execFileSync("tar", ["-czf", NodePath.join(root, archiveName), "-C", tree, "."]);
  const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
  const checksum = options.corruptChecksum
    ? "0".repeat(64)
    : NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const sums = [
    `${"1".repeat(64)}  SpecWithCode-${VERSION}-arm64.dmg`,
    `${"2".repeat(64)}  studio-${VERSION}-deployment-helpers-${COMMIT12}.tar.gz`,
    `${checksum}  ${archiveName}`,
    `${"3".repeat(64)}  studio-update.json`,
    "",
  ].join("\n");
  const node = NodePath.join(stubs, "node");
  await NodeFSP.writeFile(
    node,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      'if [ "$1" = --version ]; then echo v22.20.0; exit 0; fi',
      "shift",
      'case "$*" in',
      `  --version) echo "\${STUDIO_CLI_NAME:-specweave-studio} v${VERSION}" ;;`,
      "  'service install') echo 'Installed SpecWithCode service.' ;;",
      `  'fleet invite --coordinator ${COORDINATOR}') echo 'On your primary machine, run:'; echo "  \${STUDIO_CLI_NAME} fleet add ${INVITE}" ;;`,
      "  *) exit 3 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const requests: Array<string> = [];
  const fixture: Fixture = {
    root,
    home,
    bin: NodePath.join(home, ".local/bin"),
    stubs,
    node,
    log,
    baseUrl: "",
    requests,
    resumeDownload: () => {},
    close: async () => {},
  };
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === `/v${VERSION}/SHA256SUMS`) {
      response.end(sums);
    } else if (request.url === `/v${VERSION}/${archiveName}` && options.failArchive) {
      response.writeHead(500).end();
    } else if (request.url === `/v${VERSION}/${archiveName}`) {
      response.writeHead(200, { "Content-Length": archive.length });
      if (options.gate) {
        fixture.resumeDownload = () =>
          response.end(archive.subarray(Math.floor(archive.length / 2)));
        response.write(archive.subarray(0, Math.floor(archive.length / 2)));
      } else {
        response.end(archive);
      }
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  Object.assign(fixture, {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  });
  fixtures.push(fixture);
  return fixture;
}

/** A stand-in on PATH, ahead of the real tools. */
async function stub(fixture: Fixture, name: string, body: string) {
  await NodeFSP.writeFile(NodePath.join(fixture.stubs, name), `#!/bin/sh\n${body}\n`, {
    mode: 0o755,
  });
}

const AS_MAC = 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) /usr/bin/uname "$@" ;; esac';

function installerEnv(fixture: Fixture, env: Record<string, string>): Record<string, string> {
  return {
    PATH: `${fixture.stubs}:/usr/bin:/bin`,
    HOME: fixture.home,
    SHELL: "/bin/zsh",
    TMPDIR: fixture.root,
    STUDIO_VERSION: VERSION,
    STUDIO_NODE: fixture.node,
    STUDIO_RELEASE_BASE_URL: fixture.baseUrl,
    ...env,
  };
}

function runInstaller(
  fixture: Fixture,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("sh", [INSTALLER, ...args], {
      env: installerEnv(fixture, env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** scripts/studio-fleet/launcher.py, the fleet installer's and service updater's renderer. */
function launcherPy(script: string, args: ReadonlyArray<string>, input = ""): string {
  return NodeChildProcess.execFileSync(
    "python3",
    [
      "-B",
      "-c",
      `import json, pathlib, shlex, sys\nsys.path.insert(0, ${JSON.stringify(FLEET)})\n${script}`,
      ...args,
    ],
    { input, encoding: "utf8" },
  );
}

/** What launcher.render_cli writes for the command in this wrapper, with its runtime_path. */
function rerenderedByLauncherPy(home: string, wrapper: string): string {
  return launcherPy(
    [
      "from launcher import render_cli, runtime_path",
      "text = sys.stdin.read()",
      "last = text.rstrip('\\n').split('\\n')[-1]",
      "prefix = [p for p in shlex.split(last[len('exec '):-len(' \"$@\"')]) if p != 'STUDIO_CLI_NAME=${0##*/}']",
      "assert prefix[5] == 'PATH=' + runtime_path(pathlib.Path(sys.argv[1]), pathlib.Path(prefix[-2]))",
      "sys.stdout.write(render_cli(prefix))",
    ].join("\n"),
    [home],
    wrapper,
  );
}

const nodeLog = (fixture: Fixture) =>
  NodeFS.existsSync(fixture.log) ? NodeFS.readFileSync(fixture.log, "utf8") : "";

const hostArch = HostProcessArchitecture.defaultValue();

// The installer is POSIX sh; its macOS steps run here with uname, Tailscale and Node stand-ins.
describe.skipIf(
  HostProcessPlatform.defaultValue() !== "linux" || !["x64", "arm64"].includes(hostArch),
)("install.sh", () => {
  it("unpacks the archive into the home and writes launchers in launcher.py's format", async () => {
    const fixture = await makeFixture({ platform: "linux", arch: hostArch });
    const first = await runInstaller(fixture, ["--no-service"]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toContain("Installed SpecWithCode 1.2.3");
    expect(first.stderr).toContain("Background service not installed: --no-service was given.");
    expect(first.stderr).toContain(
      `echo 'export PATH="${fixture.bin}:$PATH"' >> ${fixture.home}/.zshrc`,
    );

    const versionDir = NodePath.join(fixture.home, ".specwithcode/runtime/versions", VERSION);
    expect(await NodeFSP.readFile(NodePath.join(versionDir, ".install-complete"), "utf8")).toBe(
      "1.2.3\n",
    );
    // What `service install` pins and the service runs: bin.mjs under the chosen Node.js.
    expect(await NodeFSP.readFile(NodePath.join(versionDir, "specweave-studio"), "utf8")).toContain(
      `exec '${fixture.node}' '${versionDir}/bin.mjs' "$@"`,
    );
    const wrapper = await NodeFSP.readFile(NodePath.join(fixture.bin, "specwithcode"), "utf8");
    expect(await NodeFSP.readFile(NodePath.join(fixture.bin, "specweave-studio"), "utf8")).toBe(
      wrapper,
    );
    expect(NodeFS.lstatSync(NodePath.join(fixture.bin, "specwithcode")).isSymbolicLink()).toBe(
      false,
    );
    expect(rerenderedByLauncherPy(fixture.home, wrapper)).toBe(wrapper);
    expect(wrapper).toContain(` STUDIO_HOME=${fixture.home}/.specwithcode `);
    const launched = NodeChildProcess.execFileSync(
      NodePath.join(fixture.bin, "specwithcode"),
      ["--version"],
      {
        encoding: "utf8",
      },
    );
    expect(launched.trim()).toBe("specwithcode v1.2.3");
    expect(nodeLog(fixture)).not.toContain("service");

    // Again: nothing is downloaded twice and the files stay the same.
    const archives = () => fixture.requests.filter((url) => url.endsWith(".tar.gz")).length;
    const before = archives();
    const second = await runInstaller(fixture, ["--no-service"]);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toContain("SpecWithCode 1.2.3 is already downloaded.");
    expect(archives()).toBe(before);
    expect(await NodeFSP.readFile(NodePath.join(fixture.bin, "specwithcode"), "utf8")).toBe(
      wrapper,
    );
    expect(
      await NodeFSP.readdir(NodePath.join(fixture.home, ".specwithcode/runtime/versions")),
    ).toEqual([VERSION]);
  });

  it("on a Mac, installs and starts the service, then prints the fleet invitation", async () => {
    const fixture = await makeFixture({ platform: "darwin", arch: "arm64" });
    await stub(fixture, "uname", AS_MAC);
    await stub(
      fixture,
      "tailscale",
      `[ "$1 $2" = "status --json" ] && printf '{\\n  "Version": "1.0",\\n  "BackendState": "Running"\\n}\\n'`,
    );
    const result = await runInstaller(fixture, ["--join", "--coordinator", COORDINATOR]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`specwithcode fleet add ${INVITE}`);
    expect(result.stderr).toContain("Next: on your main machine");
    const calls = nodeLog(fixture)
      .split("\n")
      .filter((line) => line.includes("bin.mjs") && !line.endsWith("--version"))
      .map((line) => line.replace(/^\S+bin\.mjs /, ""));
    expect(calls).toEqual(["service install", `fleet invite --coordinator ${COORDINATOR}`]);
  });

  it("checks Tailscale before downloading anything", async () => {
    const fixture = await makeFixture({ platform: "darwin", arch: "arm64" });
    await stub(fixture, "uname", AS_MAC);
    await stub(fixture, "tailscale", `printf '{"BackendState":"NeedsLogin"}'`);
    const result = await runInstaller(fixture, ["--join", "--coordinator", COORDINATOR]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Tailscale is not signed in");
    expect(fixture.requests).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(fixture.home, ".specwithcode"))).toBe(false);
  });

  it("signs a signed-out Tailscale in and opens the sign-in page before joining", async () => {
    const fixture = await makeFixture({ platform: "darwin", arch: "arm64" });
    await stub(fixture, "uname", AS_MAC);
    const signedIn = NodePath.join(fixture.root, "signed-in");
    const opened = NodePath.join(fixture.root, "opened");
    await stub(
      fixture,
      "tailscale",
      [
        `if [ "$1" = up ]; then printf 'To authenticate, visit:\\n\\n\\thttps://login.tailscale.com/a/fixture\\n'; touch '${signedIn}'; exit 0; fi`,
        `if [ -e '${signedIn}' ]; then printf '{"BackendState": "Running"}'; else printf '{"BackendState": "NeedsLogin"}'; fi`,
      ].join("\n"),
    );
    await stub(fixture, "open", `printf '%s\\n' "$*" >> '${opened}'`);
    const result = await runInstaller(fixture, [
      "--join",
      "--coordinator",
      COORDINATOR,
      "--no-service",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("https://login.tailscale.com/a/fixture");
    expect(result.stderr).toContain("Tailscale is signed in.");
    expect(await NodeFSP.readFile(opened, "utf8")).toBe("https://login.tailscale.com/a/fixture\n");
    expect(result.stdout).toContain(`specwithcode fleet add ${INVITE}`);
  });

  it("asks before installing Tailscale and installs nothing without an answer", async () => {
    const fixture = await makeFixture({ platform: "darwin", arch: "arm64" });
    await stub(fixture, "uname", AS_MAC);
    const result = await runInstaller(fixture, ["--join", "--coordinator", COORDINATOR]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--join needs Tailscale");
    expect(result.stderr).toContain("--yes");
    expect(fixture.requests).toEqual([]);

    const plan = await runInstaller(fixture, ["--join", "--coordinator", COORDINATOR, "--dry-run"]);
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.stdout).toContain(
      "Join:      install Tailscale with Tailscale's signed macOS installer",
    );
  });

  it("uses a managed install's own command instead of installing a second copy", async () => {
    const fixture = await makeFixture({ platform: "linux", arch: hostArch });
    await stub(fixture, "tailscale", `printf '{"BackendState": "Running"}'`);
    const release = NodePath.join(
      fixture.home,
      ".specwithcode/install/releases/0123456789abcdef0123",
    );
    const managed = launcherPy(
      "from launcher import render_cli\nsys.stdout.write(render_cli(json.loads(sys.argv[1])))",
      [
        JSON.stringify([
          "/usr/bin/env",
          "-i",
          `HOME=${fixture.home}`,
          `STUDIO_HOME=${fixture.home}/.specwithcode/m1`,
          fixture.node,
          `${release}/bin.mjs`,
        ]),
      ],
    );
    await NodeFSP.mkdir(fixture.bin, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(fixture.bin, "specwithcode"), managed, { mode: 0o700 });
    const result = await runInstaller(fixture, ["--join", "--coordinator", COORDINATOR]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      "Nothing to install: a managed SpecWithCode install already provides",
    );
    expect(result.stdout).toContain(`fleet add ${INVITE}`);
    expect(fixture.requests).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(fixture.home, ".specwithcode/runtime"))).toBe(false);
    expect(await NodeFSP.readFile(NodePath.join(fixture.bin, "specwithcode"), "utf8")).toBe(
      managed,
    );

    // The fleet installer's wrapper in ~/.local/bin is found when another bin directory is set.
    const elsewhere = NodePath.join(fixture.root, "other-bin");
    const again = await runInstaller(fixture, ["--join", "--coordinator", COORDINATOR], {
      STUDIO_INSTALL_BIN_DIR: elsewhere,
    });
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr).toContain(`already provides ${fixture.bin}/specwithcode`);
    expect(again.stdout).toContain(`fleet add ${INVITE}`);
    expect(NodeFS.existsSync(elsewhere)).toBe(false);
  });

  it("reuses the desktop app unless --standalone is given", async () => {
    const fixture = await makeFixture({ platform: "darwin", arch: "arm64" });
    await stub(fixture, "uname", AS_MAC);
    const app = NodePath.join(fixture.home, "Applications/SpecWithCode.app/Contents/MacOS");
    await NodeFSP.mkdir(app, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(app, "SpecWithCode"), "#!/bin/sh\n", { mode: 0o755 });

    const reused = await runInstaller(fixture, ["--no-service"]);
    expect(reused.code, reused.stderr).toBe(0);
    expect(reused.stderr).toContain("Nothing to install: the SpecWithCode desktop app");
    expect(reused.stderr).toContain(`--version ${VERSION} was not installed`);
    expect(reused.stderr).toContain("To add this machine to your main one, run ");
    expect(reused.stderr).toContain("ELECTRON_RUN_AS_NODE=1 STUDIO_CLI_NAME=specwithcode ");
    expect(reused.stderr).toContain("fleet invite --coordinator '<main-machine-environment-id>'");
    expect(reused.stderr).toContain("Settings > Connections on your main machine");
    expect(fixture.requests).toEqual([]);

    const standalone = await runInstaller(fixture, ["--standalone", "--no-service"]);
    expect(standalone.code, standalone.stderr).toBe(0);
    expect(standalone.stderr).toContain("Installed SpecWithCode 1.2.3");
    expect(NodeFS.existsSync(NodePath.join(fixture.bin, "specwithcode"))).toBe(true);
  });

  it("leaves a launcher it did not write alone", async () => {
    const fixture = await makeFixture({ platform: "linux", arch: hostArch });
    await NodeFSP.mkdir(fixture.bin, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(fixture.bin, "specweave-studio"),
      "#!/bin/sh\necho mine\n",
    );
    const result = await runInstaller(fixture, ["--no-service"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "specweave-studio already exists and is not a SpecWithCode launcher",
    );
    expect(await NodeFSP.readFile(NodePath.join(fixture.bin, "specweave-studio"), "utf8")).toBe(
      "#!/bin/sh\necho mine\n",
    );
    expect(fixture.requests).toEqual([]);
  });

  it("refuses an archive whose checksum does not match and keeps nothing", async () => {
    const fixture = await makeFixture({ platform: "linux", arch: hostArch, corruptChecksum: true });
    const result = await runInstaller(fixture, ["--no-service"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(
      await NodeFSP.readdir(NodePath.join(fixture.home, ".specwithcode/runtime/versions")),
    ).toEqual([]);
    expect(NodeFS.existsSync(fixture.bin)).toBe(false);
  });

  it("names a platform the release has no archive for", async () => {
    const fixture = await makeFixture({ platform: "linux", arch: hostArch });
    await stub(fixture, "uname", AS_MAC);
    const result = await runInstaller(fixture, ["--no-service"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("publishes no server archive for darwin-arm64");
  });

  it("changes nothing in a dry run", async () => {
    const fixture = await makeFixture({ platform: "linux", arch: hostArch });
    const result = await runInstaller(fixture, ["--dry-run"], { STUDIO_NODE: "" });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Dry run: nothing was installed or changed.");
    expect(result.stdout).toContain(
      `/v${VERSION}/studio-${VERSION}-linux-${hostArch}-${COMMIT12}.tar.gz`,
    );
    expect(result.stdout).toContain(
      `would download https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-${hostArch}.tar.gz`,
    );
    expect(fixture.requests).toEqual([`/v${VERSION}/SHA256SUMS`]);
    expect(await NodeFSP.readdir(fixture.home)).toEqual([]);
  });

  // util-linux's script gives the real installer a terminal without a browser or extra packages.
  it.each([false, true])(
    "shows download progress on a terminal (HTTP failure: %s)",
    async (failArchive) => {
      const fixture = await makeFixture({
        platform: "linux",
        arch: hostArch,
        gate: !failArchive,
        failArchive,
      });
      let output = "";
      let sawPartialProgress = false;
      const quoted = INSTALLER.replaceAll("'", "'\\''");
      const child = NodeChildProcess.spawn(
        "script",
        ["-qec", `sh '${quoted}' --no-service`, "/dev/null"],
        {
          // script(1) runs the command with $SHELL.
          env: installerEnv(fixture, { TERM: "xterm", NO_COLOR: "1", SHELL: "/bin/sh" }),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sawPartialProgress && /\b[1-9]\d?%/.test(output)) {
          sawPartialProgress = true;
          fixture.resumeDownload();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      const versions = NodePath.join(fixture.home, ".specwithcode/runtime/versions");
      if (failArchive) {
        expect(code).not.toBe(0);
        expect(output).toContain("500");
        expect(output).not.toContain("100%");
        expect(output).not.toContain("Installed SpecWithCode");
        expect(await NodeFSP.readdir(versions)).toEqual([]);
      } else {
        expect(code, output).toBe(0);
        expect(sawPartialProgress).toBe(true);
        expect(output).toContain("100%");
        expect(output).toContain("0.1 / 0.1 MB");
        expect(output).toContain("Installed SpecWithCode 1.2.3");
        expect(await NodeFSP.readdir(versions)).toEqual([VERSION]);
      }
    },
  );
});

// These dispatch-only probes never run installer discovery, services, downloads or sign-in.
describe.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "printed enrollment commands",
  () => {
    for (const kind of ["desktop", "managed", "standalone"] as const) {
      for (const mode of ["retry", "dry-run", "recovery"] as const) {
        it(`executes the ${kind} ${mode} command without a CLI on PATH`, async () => {
          const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "invite-replay-"));
          try {
            const home = NodePath.join(root, "home");
            // Both executable and entrypoint need shell quoting, independently of the ID.
            const app = NodePath.join(root, "synthetic app's", "SpecWithCode.app");
            const executable =
              kind === "desktop"
                ? NodePath.join(app, "Contents/MacOS/SpecWithCode")
                : NodePath.join(root, "synthetic bin's", "specwithcode");
            const entrypoint = NodePath.join(
              app,
              "Contents/Resources/app.asar/apps/server/dist/bin.mjs",
            );
            const log = NodePath.join(root, "arguments");
            const marker = NodePath.join(root, "unexpected-execution");
            const coordinator = `approved '${"$(touch " + marker + ")"}; \\ main\n環境`;
            await NodeFSP.mkdir(home);
            await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
            await NodeFSP.writeFile(
              executable,
              [
                "#!/bin/sh",
                'printf "%s\\0" "${ELECTRON_RUN_AS_NODE:-}" "${STUDIO_CLI_NAME:-}" "$@" > "$PROBE_LOG"',
                'if [ "${PROBE_FAIL:-}" = 1 ]; then printf "Synthetic invitation failure\\n" >&2; exit 1; fi',
                "",
              ].join("\n"),
              { mode: 0o700 },
            );
            const env = {
              PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
              HOME: home,
              TMPDIR: root,
              TEST_ROOT: root,
              TEST_KIND: kind,
              TEST_MODE: mode,
              TEST_APP: app,
              TEST_EXECUTABLE: executable,
              PROBE_LOG: log,
              PROBE_FAIL: "1",
              STUDIO_INSTALL_BIN_DIR:
                kind === "standalone"
                  ? NodePath.dirname(executable)
                  : NodePath.join(root, "unused bin"),
              LC_ALL: "C",
              // macOS /bin/sh is bash, which fills an unset SHELL from the account's login shell,
              // and the PATH hint branches on it. Pin it so every host takes the same branch.
              SHELL: "/bin/bash",
            };
            const definitions = (await NodeFSP.readFile(INSTALLER, "utf8")).replace(
              /main "\$@"\s*$/,
              "",
            );
            const hook = `
setup_output() {
  reset='' bold='' green=''
  clear_line() { :; }
  step() { :; }
  scratch="$TEST_ROOT"
  # main sets these before any of the paths below.
  platform=linux arch=x64
  if [ "$TEST_KIND" = standalone ]; then
    if [ "$TEST_MODE" = retry ]; then run_invite 1 "$TEST_EXECUTABLE"
    elif [ "$TEST_MODE" = dry-run ]; then
      version=fixture base_url=fixture archive=fixture archive_sha256=fixture
      node_download=false node=fixture target_dir="$TEST_ROOT/runtime" service_skip=fixture
      print_plan
    else service_state=installed; print_next_steps; fi
  else
    existing="$TEST_KIND" existing_app="$TEST_APP" existing_cli="$TEST_EXECUTABLE"
    existing_reason='synthetic enrollment fixture'
    use_existing_install
  fi
  exit 0
}
main "$@"
`;
            const result = NodeChildProcess.spawnSync(
              "/bin/sh",
              [
                "-c",
                definitions + hook,
                "installer-probe",
                ...(mode === "recovery" ? [] : ["--join"]),
                "--coordinator",
                coordinator,
                ...(mode === "dry-run" ? ["--dry-run"] : []),
              ],
              { env, encoding: "utf8", timeout: 5000 },
            );
            expect(result.error).toBeUndefined();
            const output = result.stdout + result.stderr;
            expect(result.status, `${kind} ${mode}:\n${output}`).toBe(mode === "retry" ? 1 : 0);
            const command =
              mode === "retry"
                ? /then run `([\s\S]*?)`\./.exec(output)?.[1]
                : mode === "dry-run"
                  ? /  Join:      ([\s\S]*)\n$/.exec(result.stdout)?.[1]
                  : /, (?:sign in to Tailscale and )?run ([\s\S]*?)\.\n/.exec(result.stderr)?.[1];
            expect(command, output).toBeDefined();
            const expectedArguments = [
              ...(kind === "desktop" ? ["1", "specwithcode", entrypoint] : ["", ""]),
              "fleet",
              "invite",
              "--coordinator",
              coordinator,
            ];
            if (mode === "retry") {
              expect((await NodeFSP.readFile(log, "utf8")).split("\0").slice(0, -1)).toEqual(
                expectedArguments,
              );
            }
            // Remove the failed invocation's log, so replay must actually execute the fixture.
            await NodeFSP.rm(log, { force: true });
            const replay = NodeChildProcess.spawnSync("/bin/sh", ["-c", command!], {
              env: { ...env, PROBE_FAIL: "" },
              encoding: "utf8",
              timeout: 5000,
            });
            expect(replay.error).toBeUndefined();
            expect(replay.status, replay.stderr).toBe(0);
            expect((await NodeFSP.readFile(log, "utf8")).split("\0").slice(0, -1)).toEqual(
              expectedArguments,
            );
            expect(NodeFS.existsSync(marker)).toBe(false);
          } finally {
            await NodeFSP.rm(root, { recursive: true, force: true });
          }
        });
      }
    }
  },
);
