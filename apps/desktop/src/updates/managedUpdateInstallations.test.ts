// @effect-diagnostics nodeBuiltinImport:off -- Synthetic owned receipts and helper-child fixtures only.
import * as FS from "node:fs";
import * as ChildProcess from "node:child_process";
import * as OS from "node:os";
import * as Path from "node:path";
import { ManagedUpdateError } from "@specweave-studio/contracts";
import { MAC_SERVICE_UPDATER_FILES } from "../../../../scripts/lib/studio-service-updater.ts";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AttachedLocalService } from "../backend/DesktopLocalService.ts";
import {
  controllerFromAttachedBearer,
  decodeManagedUpdateHelperReply,
  findManagedUpdateInstallations,
  invokeManagedUpdateHelper,
  isManagedInstallationId,
  isOwnedManagedPath,
  parseManagedLocalInstallation,
  selectAttachedManagedInstallation,
  selectManagedUpdateHelper,
  validateAttachedManagedRuntime,
  type ManagedInstallationOwner,
} from "./managedUpdateInstallations.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => {
    throw new Error("Unexpected live process probe in test");
  }),
}));

const owner: ManagedInstallationOwner = {
  uid: 502,
  user: "owner",
  homeDirectory: "/Users/Owner Space",
};
const receipt = (id = "work-mac", who = owner) => {
  const home = Path.join(who.homeDirectory, ".specweave-studio", id);
  return {
    schemaVersion: 1,
    identity: id,
    uid: who.uid,
    user: who.user,
    studioHome: home,
    stateDir: Path.join(home, "userdata"),
    host: "127.0.0.1",
    port: 8320,
    version: "1.0.17",
    cliWrapper: Path.join(
      who.homeDirectory,
      ".local/bin",
      `specweave-studio${["m4", "m1", "m3"].includes(id) ? "" : `-${id}`}`,
    ),
    service: { installed: true, label: `com.specweave.studio.${id}`, domain: `gui/${who.uid}` },
    archiveSha256: "a".repeat(64),
    release: Path.join(who.homeDirectory, ".local/share/specweave-studio/releases", "a".repeat(20)),
    webSessionPolicy: "worker-relay",
  };
};
const parse = (record: object, id = "work-mac", who = owner) =>
  parseManagedLocalInstallation(JSON.stringify(record), id, who);
const service = (id = "work-mac"): AttachedLocalService => ({
  baseDir: Path.join(owner.homeDirectory, ".specweave-studio", id),
  runtime: { pid: 77, port: 8320, origin: "http://127.0.0.1:8320", serviceManaged: true },
  descriptor: {
    environmentId: "environment-7",
    label: "same label",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "1.0.17",
    capabilities: {},
  } as AttachedLocalService["descriptor"],
  httpBaseUrl: new URL("http://127.0.0.1:8320"),
});
const status = {
  environmentId: "environment-7",
  installationId: "work-mac",
  support: "supported",
  localAutomation: "disabled",
  remoteConsent: "enrolled",
  revision: 1,
  operation: "idle",
  currentVersion: "1.0.17",
  availableVersion: null,
  checkedAt: null,
};
const token = (changes: object = {}) =>
  `${Buffer.from(
    JSON.stringify({
      v: 1,
      kind: "session",
      sid: "session-from-main",
      sub: "browser",
      method: "bearer-access-token",
      scopes: ["environment:maintain"],
      exp: 2000,
      ...changes,
    }),
  ).toString("base64url")}.fixture`;

describe("managed update installation candidates", () => {
  it("supports a generic installation under UID502 with spaces and a receipt-bound port", () => {
    expect(parse(receipt())).toEqual({
      installationId: "work-mac",
      studioHome: `${owner.homeDirectory}/.specweave-studio/work-mac`,
      stateDir: `${owner.homeDirectory}/.specweave-studio/work-mac/userdata`,
      release: receipt().release,
      port: 8320,
      version: "1.0.17",
    });
  });
  it("accepts safe slugs even when they match JavaScript object property names", () => {
    expect(parse(receipt("constructor"), "constructor")?.installationId).toBe("constructor");
  });
  it("keeps legacy receipts without adding a policy or rewriting them", () => {
    for (const id of ["m1", "m3", "m4"]) {
      const { webSessionPolicy: _, ...legacy } = receipt(id);
      expect(parse(legacy, id)?.installationId).toBe(id);
    }
  });
  it.each(["stage", "backups", "../m4", "Work", "-bad", "bad-", "a".repeat(65), "a/b"])(
    "rejects private/reserved/unsafe identity %s",
    (id) => {
      expect(isManagedInstallationId(id)).toBe(false);
      expect(parse(receipt(id), id)).toBeNull();
    },
  );
  it.each([
    { uid: 501 },
    { user: "another" },
    { studioHome: "/tmp/foreign" },
    { stateDir: "/tmp/db" },
    { cliWrapper: "/tmp/cli" },
    { host: "0.0.0.0" },
    { port: 1023 },
    { port: 65536 },
    { port: 8319.5 },
    { webSessionPolicy: undefined },
    { webSessionPolicy: "both" },
    { archiveSha256: "bad" },
    { release: "/tmp/release" },
    { service: { installed: false } },
    { service: { installed: true, label: "com.specweave.studio.work-mac", domain: "gui/501" } },
  ])("rejects mismatched owner/path/service/policy binding %j", (change) => {
    expect(parse({ ...receipt(), ...change })).toBeNull();
  });
  it("rejects a changed legacy heartbeat policy", () => {
    expect(parse(receipt("m4"), "m4")).toBeNull();
  });
  it("selects the exact attached installation among equal labels, never the first candidate", () => {
    const first = parse(receipt("alpha"), "alpha")!;
    const second = parse(receipt())!;
    expect(
      selectAttachedManagedInstallation([first, second], service(), {
        installationId: "work-mac",
        environmentId: "environment-7",
      }),
    ).toBe(second);
    expect(() =>
      selectAttachedManagedInstallation([first, second], service(), {
        installationId: "alpha",
        environmentId: "environment-7",
      }),
    ).toThrow(ManagedUpdateError);
  });
  it("accepts a fleet service without the unrelated Node IPC launcher flag", () => {
    const installation = parse(receipt())!;
    expect(
      selectAttachedManagedInstallation(
        [installation],
        {
          ...service(),
          runtime: { ...service().runtime, serviceManaged: false },
        },
        { installationId: "work-mac", environmentId: "environment-7" },
      ),
    ).toBe(installation);
  });
  it("rejects another environment, port, origin, runtime and duplicate installation", () => {
    const installation = parse(receipt())!;
    for (const changed of [
      { ...service(), descriptor: { ...service().descriptor, environmentId: "other" as never } },
      { ...service(), runtime: { ...service().runtime, port: 8319 } },
      { ...service(), runtime: { ...service().runtime, pid: 0 } },
      { ...service(), httpBaseUrl: new URL("http://example.com:8320") },
      { ...service(), httpBaseUrl: new URL("http://127.0.0.1:8320/path") },
    ])
      expect(() =>
        selectAttachedManagedInstallation([installation], changed, {
          installationId: "work-mac",
          environmentId: "environment-7",
        }),
      ).toThrow(ManagedUpdateError);
    expect(() =>
      selectAttachedManagedInstallation([installation, installation], service(), {
        installationId: "work-mac",
        environmentId: "environment-7",
      }),
    ).toThrow(ManagedUpdateError);
  });
  it("discovers owned receipts without following foreign directory or helper symlinks", () => {
    const home = FS.realpathSync(
      FS.mkdtempSync(Path.join(OS.userInfo().homedir, ".managed-installations-test-")),
    );
    try {
      const actual = { ...owner, uid: process.getuid!(), homeDirectory: home };
      for (const id of ["alpha", "beta", "stage"]) {
        const record = receipt(id, actual);
        FS.mkdirSync(record.studioHome, { recursive: true });
        FS.writeFileSync(Path.join(record.studioHome, "installation.json"), JSON.stringify(record));
      }
      FS.symlinkSync(
        Path.join(home, ".specweave-studio/alpha"),
        Path.join(home, ".specweave-studio/alias"),
      );
      expect(findManagedUpdateInstallations(actual).map((value) => value.installationId)).toEqual([
        "alpha",
        "beta",
      ]);
      expect(
        isOwnedManagedPath(Path.join(home, ".specweave-studio/alias/installation.json"), actual),
      ).toBe(false);
      const helper = Path.join(home, "managed_updates.py");
      for (const name of MAC_SERVICE_UPDATER_FILES)
        FS.writeFileSync(Path.join(home, name), "# inert", { mode: 0o600 });
      FS.writeFileSync(helper, "# inert", { mode: 0o600 });
      FS.symlinkSync(helper, `${helper}.link`);
      expect(selectManagedUpdateHelper([`${helper}.link`, helper], actual)).toBe(helper);
      for (const name of MAC_SERVICE_UPDATER_FILES) {
        const sibling = Path.join(home, name);
        const parked = `${sibling}.saved`;
        FS.renameSync(sibling, parked);
        expect(selectManagedUpdateHelper([helper], actual)).toBeNull();
        FS.symlinkSync(parked, sibling);
        expect(selectManagedUpdateHelper([helper], actual)).toBeNull();
        FS.unlinkSync(sibling);
        FS.renameSync(parked, sibling);
        FS.chmodSync(sibling, 0o666);
        expect(selectManagedUpdateHelper([helper], actual)).toBeNull();
        FS.chmodSync(sibling, 0o600);
      }
      FS.chmodSync(helper, 0o666);
      expect(selectManagedUpdateHelper([helper], actual)).toBeNull();
    } finally {
      FS.rmSync(home, { recursive: true, force: true });
    }
  });
  it("rejects writable ancestors for installed and bundled helpers, including the home", () => {
    const root = FS.realpathSync(
      FS.mkdtempSync(Path.join(OS.userInfo().homedir, ".managed-helper-trust-test-")),
    );
    try {
      const home = Path.join(root, "home");
      FS.mkdirSync(home, { mode: 0o700 });
      const actual = { ...owner, uid: process.getuid!(), homeDirectory: home };
      for (const directory of [
        Path.join(home, ".local/share/specweave-studio/updater"),
        Path.join(root, "Applications/Fixture.app/Contents/Resources/studio-updater"),
      ]) {
        FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const helper = Path.join(directory, "managed_updates.py");
        for (const name of new Set([...MAC_SERVICE_UPDATER_FILES, "managed_updates.py"]))
          FS.writeFileSync(Path.join(directory, name), "# inert", { mode: 0o600 });
        expect(selectManagedUpdateHelper([helper], actual)).toBe(helper);
        for (
          let ancestor = directory;
          ancestor !== Path.dirname(root);
          ancestor = Path.dirname(ancestor)
        ) {
          const originalMode = FS.statSync(ancestor).mode & 0o777;
          try {
            for (const mode of [0o702, 0o720, 0o777]) {
              FS.chmodSync(ancestor, mode);
              expect(
                selectManagedUpdateHelper([helper], actual),
                `${ancestor}: ${mode.toString(8)}`,
              ).toBeNull();
            }
          } finally {
            FS.chmodSync(ancestor, originalMode);
          }
        }
        const alias = `${directory}-alias`;
        FS.symlinkSync(directory, alias);
        expect(
          selectManagedUpdateHelper([Path.join(alias, "managed_updates.py")], actual),
        ).toBeNull();
        expect(
          selectManagedUpdateHelper(
            [`${directory}/../${Path.basename(directory)}/managed_updates.py`],
            actual,
          ),
        ).toBeNull();
      }
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("current fleet launchd binding", () => {
  function liveFixture() {
    const home = FS.realpathSync(
      FS.mkdtempSync(Path.join(OS.userInfo().homedir, ".managed-live-test-")),
    );
    const actual = { ...owner, uid: process.getuid!(), homeDirectory: home };
    const installation = parse(receipt("work-mac", actual), "work-mac", actual)!;
    const attached = {
      ...service(),
      baseDir: installation.studioHome,
      runtime: { ...service().runtime, serviceManaged: false },
    };
    const runtimePath = Path.join(installation.stateDir, "server-runtime.json");
    const environmentPath = Path.join(installation.stateDir, "environment-id");
    const plist = Path.join(home, "Library/LaunchAgents/com.specweave.studio.work-mac.plist");
    FS.mkdirSync(installation.stateDir, { recursive: true, mode: 0o700 });
    FS.mkdirSync(Path.dirname(plist), { recursive: true, mode: 0o700 });
    const runtime = { pid: 77, port: 8320, origin: "http://127.0.0.1:8320" };
    FS.writeFileSync(runtimePath, JSON.stringify(runtime), { mode: 0o600 });
    FS.writeFileSync(environmentPath, "environment-7\n", { mode: 0o600 });
    FS.writeFileSync(plist, "synthetic owned LaunchAgent", { mode: 0o600 });
    const job = `state = running\npid = 77\npath = ${plist}\n`;
    const run = vi.spyOn(ChildProcess, "execFileSync").mockImplementation((command, args) => {
      if (
        command === "/bin/launchctl" &&
        JSON.stringify(args) ===
          JSON.stringify(["print", `gui/${actual.uid}/com.specweave.studio.work-mac`])
      )
        return job;
      if (
        command === "/bin/ps" &&
        JSON.stringify(args) === JSON.stringify(["-p", "77", "-o", "uid="])
      )
        return `${actual.uid}\n`;
      throw new Error("unexpected process probe");
    });
    return {
      home,
      actual,
      installation,
      attached,
      runtimePath,
      environmentPath,
      plist,
      runtime,
      job,
      run,
      verify: () => validateAttachedManagedRuntime(installation, attached, actual),
      close: () => {
        run.mockRestore();
        FS.rmSync(home, { recursive: true, force: true });
      },
    };
  }
  it("accepts an owned live fleet job when the runtime omits the internal launcher flag", () => {
    const f = liveFixture();
    try {
      expect(f.verify).not.toThrow();
      expect(f.run).toHaveBeenCalledTimes(2);
    } finally {
      f.close();
    }
  });
  it.each([
    { pid: 78 },
    { port: 8321 },
    { origin: "http://localhost:8320" },
    { origin: "http://127.0.0.1:8320/path" },
    { pid: "77" },
  ])("rejects a changed current runtime %j before process probes", (change) => {
    const f = liveFixture();
    try {
      FS.writeFileSync(f.runtimePath, JSON.stringify({ ...f.runtime, ...change }));
      expect(f.verify).toThrow(ManagedUpdateError);
      expect(f.run).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it.each(["missing", "symlink", "writable", "oversize", "invalid", "environment"])(
    "rejects unsafe or changed metadata: %s",
    (change) => {
      const f = liveFixture();
      try {
        if (change === "missing") FS.unlinkSync(f.runtimePath);
        if (change === "symlink") {
          FS.renameSync(f.runtimePath, `${f.runtimePath}.saved`);
          FS.symlinkSync(`${f.runtimePath}.saved`, f.runtimePath);
        }
        if (change === "writable") FS.chmodSync(f.runtimePath, 0o666);
        if (change === "oversize") FS.writeFileSync(f.runtimePath, "x".repeat(65537));
        if (change === "invalid") FS.writeFileSync(f.runtimePath, "{");
        if (change === "environment") FS.writeFileSync(f.environmentPath, "another-environment");
        expect(f.verify).toThrow(ManagedUpdateError);
        expect(f.run).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );
  it.each(["pid", "stopped", "path", "uid", "error", "race"])(
    "rejects an unbound running service: %s",
    (change) => {
      const f = liveFixture();
      try {
        f.run.mockImplementation((command) => {
          if (change === "error") throw new Error("private diagnostic");
          if (command === "/bin/launchctl")
            return change === "pid"
              ? f.job.replace("pid = 77", "pid = 88")
              : change === "stopped"
                ? f.job.replace("running", "waiting")
                : change === "path"
                  ? f.job.replace(f.plist, "/tmp/foreign.plist")
                  : f.job;
          if (change === "race") FS.writeFileSync(f.environmentPath, "replaced");
          return `${change === "uid" ? f.actual.uid + 1 : f.actual.uid}\n`;
        });
        expect(f.verify).toThrow(ManagedUpdateError);
      } finally {
        f.close();
      }
    },
  );
});

describe("trusted controller metadata and helper wire", () => {
  it("extracts only the trusted two-part bearer session metadata", () => {
    expect(controllerFromAttachedBearer(token(), 1000)).toEqual({
      sessionId: "session-from-main",
      subject: "browser",
    });
  });
  it.each([
    { v: 3 },
    { kind: "websocket" },
    { method: "browser-session-cookie" },
    { exp: 1000 },
    { exp: "3000" },
    { sid: "" },
    { sub: "" },
    { scopes: ["orchestration:read"] },
  ])("rejects invalid or insufficient session metadata %j", (change) => {
    expect(() => controllerFromAttachedBearer(token(change), 1000)).toThrow(ManagedUpdateError);
  });
  it("rejects malformed, three-part and oversized tokens", () => {
    for (const value of ["not a token", "head.body.signature", "a".repeat(20000)]) {
      expect(() => controllerFromAttachedBearer(value, 1000)).toThrow(ManagedUpdateError);
    }
  });
  it("requires a successful exit and exact status wire, with bounded sanitized failures", () => {
    expect(decodeManagedUpdateHelperReply(JSON.stringify({ ok: true, status }), false)).toEqual(
      status,
    );
    for (const [body, failed] of [
      [JSON.stringify({ ok: true, status }), true],
      ["{}", false],
      ["secret stderr", true],
    ] as const) {
      expect(() => decodeManagedUpdateHelperReply(body, failed)).toThrow(ManagedUpdateError);
    }
    try {
      decodeManagedUpdateHelperReply(
        '{"ok":false,"error":{"code":"conflict","secret":"redacted"}}',
        true,
      );
    } catch (error) {
      expect(error).toMatchObject({ code: "conflict" });
      expect(String(error)).not.toContain("redacted");
    }
  });
  it("passes only controller metadata over bounded helper stdin, with exact state-dir argv", async () => {
    const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "managed-helper-"));
    try {
      const fixture = Path.join(home, "fixture.py");
      const installation = parse(receipt())!;
      FS.writeFileSync(
        fixture,
        `import sys,json,os\nr=json.load(sys.stdin)\nassert sys.argv[1:]==['--state-dir',${JSON.stringify(installation.stateDir)}]\nassert sys.flags.ignore_environment and sys.flags.no_user_site and sys.flags.dont_write_bytecode\nassert r['controller']=={'sessionId':'trusted-session','subject':'browser'}\nassert r['action']=='enroll-local'\nassert 'SECRET_FIXTURE' not in os.environ\nprint(${JSON.stringify(JSON.stringify({ ok: true, status }))})\n`,
      );
      const result = await invokeManagedUpdateHelper(
        fixture,
        installation,
        { ...owner, homeDirectory: home },
        {
          action: "enroll-local",
          environmentId: "environment-7",
          controller: { sessionId: "trusted-session", subject: "browser" },
          input: {
            installationId: "work-mac",
            environmentId: "environment-7",
            expectedRevision: 0,
            consent: true,
          },
          approval: {
            kind: "native-owner",
            confirmed: true,
            installationId: "work-mac",
            environmentId: "environment-7",
            expectedRevision: 0,
          },
        },
      );
      expect(result).toEqual(status);
    } finally {
      FS.rmSync(home, { recursive: true, force: true });
    }
  });
});
