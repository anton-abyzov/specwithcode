// @effect-diagnostics nodeBuiltinImport:off - Runs the root update helper against stubbed system tools.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const resource = (name: string) =>
  new URL(`../apps/desktop/resources/linux/${name}`, import.meta.url);
const helperSource = NodeFS.readFileSync(resource("update-helper"), "utf8");
const policy = NodeFS.readFileSync(resource("com.specwithcode.studio.update.policy"), "utf8");

// The helper is a POSIX script for Debian and Ubuntu: Windows has neither its shell nor exec bits.
const isWindows = process.platform === "win32";
const hasGpg = !isWindows && NodeChildProcess.spawnSync("gpg", ["--version"]).status === 0;

interface PackageFields {
  readonly package?: string;
  readonly architecture?: string;
  readonly version?: string;
  readonly installed?: string;
  readonly aptStatus?: number;
}

describe.skipIf(!hasGpg)("update-helper", () => {
  let root: string;
  let goodKeyring: string;
  let otherHome: string;
  let goodHome: string;

  const generate = (home: string) => {
    NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
    const run = (...args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync("gpg", ["--homedir", home, "--batch", "--quiet", ...args], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    run("--passphrase", "", "--quick-generate-key", "Test update signing", "ed25519", "sign");
    return run("--export");
  };
  const sign = (home: string, file: string, out: string) => {
    NodeChildProcess.execFileSync(
      "gpg",
      ["--homedir", home, "--batch", "--quiet", "--yes", "--detach-sign", "-o", out, file],
      { stdio: "ignore" },
    );
  };

  beforeAll(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "uh-"));
    goodHome = NodePath.join(root, "gpg-good");
    otherHome = NodePath.join(root, "gpg-other");
    goodKeyring = NodePath.join(root, "keyring.gpg");
    NodeFS.writeFileSync(goodKeyring, generate(goodHome));
    generate(otherHome);
  });

  afterAll(() => {
    for (const home of [goodHome, otherHome]) {
      NodeChildProcess.spawnSync("gpgconf", ["--homedir", home, "--kill", "gpg-agent"]);
    }
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  /** The helper as shipped, with only its constants and PATH pointed at this test's stubs. */
  const run = (
    fields: PackageFields = {},
    options: { readonly signer?: "good" | "other" | "none"; readonly tamper?: boolean } = {},
    args?: (deb: string, sig: string) => ReadonlyArray<string>,
    env: Record<string, string> = { PKEXEC_UID: String(process.getuid?.() ?? 1000) },
  ) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(root, "run-"));
    const bin = NodePath.join(dir, "bin");
    const work = NodePath.join(dir, "work");
    const aptLog = NodePath.join(dir, "apt.log");
    NodeFS.mkdirSync(bin);
    NodeFS.mkdirSync(work);
    const stub = (name: string, body: string) =>
      NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub("id", 'if [ "$1" = -u ]; then echo 0; else echo 20; fi');
    stub("timeout", 'shift; exec "$@"');
    // The real setpriv changes user; here the flags must be there and the rest runs as it is.
    stub(
      "setpriv",
      'case "$*" in *--reuid=*--regid=*--clear-groups*--no-new-privs*) ;; *) exit 99 ;; esac\n' +
        'while [ "${1#--}" != "$1" ]; do shift; done\nexec "$@"',
    );
    stub(
      "dpkg-deb",
      'case "$3" in\n' +
        `  Package) echo "${fields.package ?? "studio"}" ;;\n` +
        `  Architecture) echo "${fields.architecture ?? "amd64"}" ;;\n` +
        `  Version) echo "${fields.version ?? "1.0.170"}" ;;\n` +
        "esac",
    );
    stub(
      "dpkg",
      'if [ "$1" = --print-architecture ]; then echo amd64; exit 0; fi\n' +
        '[ "$(printf "%s\\n%s\\n" "$2" "$4" | sort -V | tail -n 1)" = "$2" ] && [ "$2" != "$4" ]',
    );
    stub("dpkg-query", `echo "${fields.installed ?? "1.0.169"}"`);
    stub(
      "apt-get",
      `printf '%s\\n' "$*" >> "${aptLog}"\ncat "$(eval echo \\$$#)" > "${aptLog}.installed"\n` +
        'echo "Reading package lists..."\n' +
        `exit ${fields.aptStatus ?? 0}`,
    );

    const script = NodePath.join(dir, "update-helper");
    const pathTools = process.env.PATH ?? "/usr/bin:/bin";
    NodeFS.writeFileSync(
      script,
      helperSource
        .replace("PATH=/usr/sbin:/usr/bin:/sbin:/bin", `PATH="${bin}:${pathTools}"`)
        .replace("KEYRING=/usr/lib/specwithcode/update-key.gpg", `KEYRING=${goodKeyring}`)
        .replace("WORK_ROOT=/var/tmp", `WORK_ROOT=${work}`),
      { mode: 0o755 },
    );

    const deb = NodePath.join(dir, "SpecWithCode.deb");
    const sig = `${deb}.sig`;
    NodeFS.writeFileSync(deb, "package bytes");
    const signer = options.signer ?? "good";
    if (signer !== "none") sign(signer === "good" ? goodHome : otherHome, deb, sig);
    if (options.tamper) NodeFS.appendFileSync(deb, "tampered");

    const result = NodeChildProcess.spawnSync(script, [...(args ? args(deb, sig) : [deb, sig])], {
      encoding: "utf8",
      env: { ...env, HOME: dir },
    });
    const installed = NodeFS.existsSync(`${aptLog}.installed`);
    return {
      status: result.status,
      stderr: result.stderr,
      aptArguments: installed ? NodeFS.readFileSync(aptLog, "utf8") : null,
      aptPackage: installed ? NodeFS.readFileSync(`${aptLog}.installed`, "utf8") : null,
      workLeft: NodeFS.readdirSync(work),
    };
  };

  it("installs a signed newer package from its own copy and cleans up", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.aptPackage).toBe("package bytes");
    expect(result.aptArguments).toContain("install -y --no-remove");
    expect(result.aptArguments).not.toContain("--allow");
    expect(result.workLeft).toEqual([]);
  });

  it("does not install what another key signed", () => {
    const result = run({}, { signer: "other" });
    expect(result.status).toBe(65);
    expect(result.aptPackage).toBeNull();
  });

  it("does not install a package changed after signing", () => {
    const result = run({}, { tamper: true });
    expect(result.status).toBe(65);
    expect(result.aptPackage).toBeNull();
  });

  it("does not install without a signature", () => {
    const result = run({}, { signer: "none" });
    expect(result.status).toBe(64);
    expect(result.aptPackage).toBeNull();
  });

  it.each([
    ["the same version", { version: "1.0.169" }],
    ["an older version", { version: "1.0.100" }],
  ])("refuses %s as not newer", (_label, fields) => {
    const result = run(fields);
    expect(result.status).toBe(3);
    expect(result.aptPackage).toBeNull();
  });

  it("refuses another signed package name", () => {
    const result = run({ package: "something-else" });
    expect(result.status).toBe(66);
    expect(result.aptPackage).toBeNull();
  });

  it("refuses another architecture", () => {
    const result = run({ architecture: "arm64" });
    expect(result.status).toBe(66);
    expect(result.aptPackage).toBeNull();
  });

  it("reports a failed install", () => {
    const result = run({ aptStatus: 100 });
    expect(result.status).toBe(67);
    // The app shows the first line as the reason; apt's progress must not take its place.
    expect(result.stderr.split("\n")[0]).toContain("apt-get could not install 1.0.170");
    expect(result.stderr).toContain("Reading package lists...");
  });

  it("refuses to run without pkexec's caller", () => {
    expect(run({}, {}, undefined, {}).status).toBe(64);
    expect(run({}, {}, undefined, { PKEXEC_UID: "0;id" }).status).toBe(64);
  });

  it("refuses relative paths and a wrong argument count", () => {
    expect(run({}, {}, () => ["relative.deb", "relative.sig"]).status).toBe(64);
    expect(run({}, {}, (deb) => [deb]).status).toBe(64);
  });
});

describe("update polkit action", () => {
  it("names one program and allows it only in an active local session", () => {
    expect(policy.match(/<action /g)).toHaveLength(1);
    expect(policy).toContain(
      '<annotate key="org.freedesktop.policykit.exec.path">/usr/lib/specwithcode/update-helper</annotate>',
    );
    expect(policy).toContain("<allow_active>yes</allow_active>");
    expect(policy).toContain("<allow_any>auth_admin</allow_any>");
    expect(policy).toContain("<allow_inactive>auth_admin</allow_inactive>");
  });

  it("ships the helper as an executable with a fixed PATH and the pinned key's path", () => {
    if (!isWindows) expect(NodeFS.statSync(resource("update-helper")).mode & 0o111).toBe(0o111);
    expect(helperSource).toContain("PATH=/usr/sbin:/usr/bin:/sbin:/bin");
    expect(helperSource).toContain("KEYRING=/usr/lib/specwithcode/update-key.gpg");
    expect(NodeFS.statSync(resource("update-key.gpg")).size).toBeGreaterThan(0);
  });
});
